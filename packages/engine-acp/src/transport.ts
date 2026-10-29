/** JSON lines over the stdio of one agent process. stderr is kept as a short tail for error messages. */
export type AcpTransport = {
  write(line: string): void
  lines: AsyncIterable<string>
  close(): void
  exited: Promise<number>
  stderrTail(): string
}

const STDERR_TAIL = 4_000

export function spawnAcp(options: { command: string; args: string[]; env: Record<string, string>; cwd: string }): AcpTransport {
  const proc = Bun.spawn([options.command, ...options.args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  let tail = ""
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL)
  })().catch(() => {})
  // An unfinished line is kept as chunks and joined once: appending and searching one string copied a long line at every read.
  async function* lines() {
    const decoder = new TextDecoder()
    let pending: string[] = []
    for await (const chunk of proc.stdout) {
      let text = decoder.decode(chunk, { stream: true })
      let newline = text.indexOf("\n")
      while (newline >= 0) {
        const line = pending.length ? pending.join("") + text.slice(0, newline) : text.slice(0, newline)
        pending = []
        text = text.slice(newline + 1)
        if (line.trim()) yield line
        newline = text.indexOf("\n")
      }
      if (text) pending.push(text)
    }
  }
  return {
    write(line) {
      proc.stdin.write(`${line}\n`)
      proc.stdin.flush()
    },
    lines: lines(),
    close: () => proc.kill(),
    exited: proc.exited,
    stderrTail: () => tail.trim(),
  }
}
