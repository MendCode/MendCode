import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

let captures = 0
/** How often a running child's output size is checked against the limit (one `fstat` each). */
const WATCH_MS = 10

export type CaptureOptions = {
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
  /** Standard input in full; the child gets none when absent. */
  stdin?: string | Uint8Array | undefined
  /** `capture` keeps standard error (at most `limit` bytes) in `err`; the default throws it away. */
  stderr?: "ignore" | "capture" | undefined
  signal?: AbortSignal | undefined
  /** The most bytes of standard output (and of standard error) to take. */
  limit: number
  timeoutMs: number
  /** Past the limit the child is stopped and `out` holds the first `limit` bytes; by default `out` is empty then. */
  keepOnLimit?: boolean | undefined
}

/** `stopped`: the time limit, a cancel or (without `keepOnLimit`) the size limit ended it and `out` is empty. `truncated`: more than `limit` bytes were written. */
export type Captured = { code: number; stopped: boolean; truncated: boolean; out: string; err: string }

const temporary = () => path.join(tmpdir(), `mendcode-capture-${process.pid}-${captures++}`)
const open = (file: string) => openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600)

function head(fd: number, limit: number) {
  const size = Math.min(fstatSync(fd).size, limit)
  const buffer = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const count = readSync(fd, buffer, read, size - read, read)
    if (count === 0) break
    read += count
  }
  return buffer.subarray(0, read).toString("utf8")
}

/**
 * Runs `argv` and returns its standard output (and optionally its standard error), each at most `limit` bytes, within
 * `timeoutMs`. The output goes through private temporary files removed afterwards, not pipes: Bun holds about 0.2 MB of
 * native buffer for every piped child that the system does not take back, which a burst of git or rg children turns
 * into tens of megabytes. Use it when the whole output is wanted at the end; a child whose output is shown while it
 * runs keeps a pipe. A program that cannot start throws, as `Bun.spawn` does.
 */
export async function captureOutput(argv: string[], options: CaptureOptions): Promise<Captured> {
  const files = { out: temporary(), err: options.stderr === "capture" ? temporary() : undefined }
  const fds: { out?: number; err?: number } = {}
  try {
    fds.out = open(files.out)
    if (files.err) fds.err = open(files.err)
    const child = Bun.spawn(argv, {
      stdin: options.stdin === undefined ? "ignore" : typeof options.stdin === "string" ? Buffer.from(options.stdin) : options.stdin,
      stdout: fds.out,
      stderr: fds.err ?? "ignore",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
    let timedOut = false
    let aborted = false
    let over = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
    const sizes = () => Math.max(fds.out === undefined ? 0 : fstatSync(fds.out).size, fds.err === undefined ? 0 : fstatSync(fds.err).size)
    // A file has no backpressure: its size is watched while the child runs.
    const watch = setInterval(() => { try { if (sizes() > options.limit) { over = true; child.kill() } } catch { /* closed */ } }, WATCH_MS)
    const cancel = () => { aborted = true; child.kill() }
    options.signal?.addEventListener("abort", cancel, { once: true })
    if (options.signal?.aborted) cancel()
    try {
      const code = await child.exited
      if (sizes() > options.limit) over = true
      const stopped = timedOut || aborted || (over && options.keepOnLimit !== true)
      return { code, stopped, truncated: over, out: stopped ? "" : head(fds.out, options.limit), err: stopped || fds.err === undefined ? "" : head(fds.err, options.limit) }
    } finally {
      clearTimeout(timer)
      clearInterval(watch)
      options.signal?.removeEventListener("abort", cancel)
    }
  } finally {
    if (fds.out !== undefined) closeSync(fds.out)
    if (fds.err !== undefined) closeSync(fds.err)
    for (const file of [files.out, files.err]) if (file) try { unlinkSync(file) } catch { /* never created */ }
  }
}
