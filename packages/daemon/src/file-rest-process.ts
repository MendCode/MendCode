export class FileApiError extends Error {
  constructor(message: string, readonly code: "invalid_command" | "forbidden" | "unsupported" = "invalid_command") { super(message) }
}

/** Bound both pipes before buffering; tools never consult user rg config or Git diff drivers. */
export async function fileProcess(command: string[], cwd: string, signal: AbortSignal, input?: string, maxBytes = 8 * 1024 * 1024) {
  signal.throwIfAborted()
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }
  delete (env as Record<string, string | undefined>).RIPGREP_CONFIG_PATH
  const child = Bun.spawn(command, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
  let overflow = false
  const kill = () => { child.kill() }
  signal.addEventListener("abort", kill, { once: true })
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") { child.stdin.write(input); child.stdin.end() }
  async function collect(stream: ReadableStream<Uint8Array>, limit: number) {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > limit) { overflow = true; kill() }
      else chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout, maxBytes), collect(child.stderr, 16_000), child.exited])
    signal.throwIfAborted()
    if (overflow) throw new FileApiError("File API output limit exceeded")
    return { stdout, stderr, code }
  } finally { signal.removeEventListener("abort", kill) }
}
