/** Runs a program to completion and returns its output; the one place a client command spawns a child process. */
export type ProcessResult = { code: number; stdout: string; stderr: string }
export type ProcessOptions = { env?: Record<string, string | undefined>; input?: string | Uint8Array; stderr?: "pipe" | "ignore" }

/** A program that cannot start reports exit code 127 with the reason as stderr, like a shell. */
export async function runProcess(argv: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(argv, {
      stdout: "pipe", stderr: options.stderr ?? "pipe", stdin: options.input === undefined ? "ignore" : "pipe",
      ...(options.env ? { env: options.env } : {}),
    })
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${argv[0]}: ${error instanceof Error ? error.message : "cannot start"}` }
  }
  if (options.input !== undefined) {
    const stdin = child.stdin as import("bun").FileSink
    stdin.write(options.input)
    await stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    options.stderr === "ignore" ? Promise.resolve("") : new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}
