import { sandboxCommand, type SandboxBackend, type SandboxPolicy } from "@mendcode/tools"

/** JSONL over the stdio of one `pi --mode rpc` process. Records end at LF only (U+2028 and U+2029 are valid inside JSON strings). stderr is kept as a short tail for error messages. */
export type PiTransport = {
  write(line: string): void
  lines: AsyncIterable<string>
  close(): void
  exited: Promise<number>
  stderrTail(): string
}

const STDERR_TAIL = 4_000
const STDERR_DRAIN_MS = 500

/** Splits a byte stream into LF-terminated records, dropping one trailing CR and empty lines. A last record without LF is kept. */
export async function* jsonLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  // An unfinished record is kept as chunks and joined once: appending and searching one string copied a long record at every read.
  let pending: string[] = []
  for await (const chunk of chunks) {
    let text = decoder.decode(chunk, { stream: true })
    let newline = text.indexOf("\n")
    while (newline >= 0) {
      const line = (pending.length ? pending.join("") + text.slice(0, newline) : text.slice(0, newline)).replace(/\r$/, "")
      pending = []
      text = text.slice(newline + 1)
      if (line.trim()) yield line
      newline = text.indexOf("\n")
    }
    if (text) pending.push(text)
  }
  pending.push(decoder.decode())
  const rest = pending.join("").replace(/\r$/, "")
  if (rest.trim()) yield rest
}

/**
 * Starts the program with an argument array (no shell). The environment is the daemon's plus `env`; pi finds its own
 * login and settings itself, MendCode never reads them.
 */
export function spawnPi(options: { command: string; args: string[]; env: Record<string, string>; cwd: string; sandbox?: SandboxPolicy; /** Tests only: null simulates an unavailable backend. */ sandboxBackend?: SandboxBackend | null }): PiTransport {
  const wrapped = sandboxCommand({ argv: [options.command, ...options.args], policy: options.sandbox, ...(options.sandboxBackend !== undefined ? { backend: options.sandboxBackend } : {}) })
  if (!wrapped.ok) throw new Error(wrapped.error)
  const proc = Bun.spawn(wrapped.argv, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  let tail = ""
  const stderrRead = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL)
  })().catch(() => {})
  // stdout can end a moment before the last of stderr is read, and the end of `lines` is what reports the exit: the records end
  // only once stderr has been read to its end too (or shortly after, when a grandchild keeps it open), so the exit carries pi's last words.
  async function* records() {
    yield* jsonLines(proc.stdout)
    await Promise.race([stderrRead, new Promise((resolve) => setTimeout(resolve, STDERR_DRAIN_MS))])
  }
  return {
    write(line) {
      try {
        proc.stdin.write(`${line}\n`)
        proc.stdin.flush()
      } catch {
        // The process is gone; the reader reports the exit.
      }
    },
    lines: records(),
    close: () => proc.kill(),
    exited: proc.exited,
    stderrTail: () => tail.trim(),
  }
}
