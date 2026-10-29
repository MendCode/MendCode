import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { killProcessTree } from "./platform-shell"
import { errorMessage, truncateHeadTail } from "./util"

const KILL_GRACE_MS = 2_000
const EXIT_DRAIN_MS = 150
const KEEP_HEAD_CHARS = 1_000_000
const KEEP_TAIL_CHARS = 3_000_000

export type ManagedResult = {
  output: string
  truncated: boolean
  exitCode: number
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  /** Set when the process could not be started at all. */
  spawnError?: string
}

/**
 * Runs `argv` in its own process group with merged, bounded output (head + tail kept), an optional stdin payload,
 * a timeout and cancellation; SIGTERM to the group, SIGKILL after 2 s. Never throws.
 */
export function runManaged({
  argv,
  cwd,
  env,
  stdin,
  timeoutMs,
  signal,
  onOutput,
  onStream,
}: {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  stdin?: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (chunk: string) => void
  /** Like `onOutput` but says which stream a chunk came from (the merged `output` stays as it is). */
  onStream?: (stream: "stdout" | "stderr", chunk: string) => void
}): Promise<ManagedResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const [binary, ...args] = argv
    const child = spawn(binary as string, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const pid = child.pid
    let head = ""
    let tail = ""
    let dropped = 0
    let timedOut = false
    let cancelled = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }

    const append = (text: string, stream: "stdout" | "stderr") => {
      if (text === "") return
      onOutput?.(text)
      onStream?.(stream, text)
      if (head.length < KEEP_HEAD_CHARS) {
        const room = KEEP_HEAD_CHARS - head.length
        head += text.slice(0, room)
        text = text.slice(room)
      }
      if (text === "") return
      tail += text
      if (tail.length > KEEP_TAIL_CHARS) {
        dropped += tail.length - KEEP_TAIL_CHARS
        tail = tail.slice(tail.length - KEEP_TAIL_CHARS)
      }
    }
    const killGroup = (sig: NodeJS.Signals) => killProcessTree({ pid, signal: sig, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
    const terminate = () => {
      killGroup("SIGTERM")
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => ((timedOut = true), terminate()), timeoutMs)
    const onAbort = () => ((cancelled = true), terminate())
    signal.addEventListener("abort", onAbort, { once: true })

    const finish = (exitCode: number, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener("abort", onAbort)
      killGroup("SIGKILL")
      child.stdout?.destroy()
      child.stderr?.destroy()
      append(decoders.stdout.end(), "stdout")
      append(decoders.stderr.end(), "stderr")
      const capped = truncateHeadTail({ text: dropped > 0 ? `${head}\n… output omitted …\n${tail}` : head + tail })
      resolve({ output: capped.text, truncated: capped.truncated, exitCode, timedOut, cancelled, durationMs: Date.now() - started, ...(spawnError ? { spawnError } : {}) })
    }

    child.stdin?.on("error", () => undefined)
    child.stdin?.end(stdin ?? "")
    child.stdout?.on("data", (chunk: Buffer) => append(decoders.stdout.write(chunk), "stdout"))
    child.stderr?.on("data", (chunk: Buffer) => append(decoders.stderr.write(chunk), "stderr"))
    child.on("error", (error) => finish(-1, `cannot run ${binary}: ${errorMessage(error)}`))
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finish(code ?? -1), EXIT_DRAIN_MS)
    })
    child.on("close", (code) => finish(code ?? -1))
  })
}
