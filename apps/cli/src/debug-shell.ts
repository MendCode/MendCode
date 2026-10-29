import { createInterface } from "node:readline"

export async function* terminalSqlLines(out: { write(text: string): unknown }) {
  const tty = Boolean(process.stdin.isTTY)
  const input = createInterface({ input: process.stdin, ...(tty ? { output: process.stdout, terminal: true } : {}) })
  if (tty) { out.write("Read-only SQL · .tables · .schema · .quit\n"); input.setPrompt("sqlite> "); input.prompt() }
  try {
    for await (const line of input) { yield line; if (tty) input.prompt() }
  } finally { input.close() }
}
