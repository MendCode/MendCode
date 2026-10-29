import type { OutputFilter } from "./types"

const COMPILER = /(?:^|[\s;&|(])(?:tsc|tsgo|bunx?\s+tsc|npx\s+tsc|pnpm\s+(?:exec\s+)?tsc)\b/
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/

/** `src/a.ts(3,5): error TS2322: …` repeated for one file becomes the file once and `3:5 TS2322 …` under it. */
export const tsc: OutputFilter = {
  id: "tsc",
  matches: ({ tool, command }) => (tool === "shell" || tool === "shell_output") && COMPILER.test(command),
  apply(text) {
    const lines = text.split("\n")
    if (lines.filter((line) => DIAGNOSTIC.test(line)).length < 4) return text
    const out: string[] = []
    let current = ""
    for (const line of lines) {
      const hit = DIAGNOSTIC.exec(line)
      if (!hit) {
        // Continuation lines (indented) belong to the diagnostic above; anything else ends the group.
        if (!/^\s/.test(line)) current = ""
        out.push(line)
        continue
      }
      const [, file, row, column, kind, code, message] = hit
      if (file !== current) {
        current = file!
        out.push(`${file}:`)
      }
      out.push(`  ${row}:${column} ${kind === "warning" ? "warning " : ""}${code} ${message}`)
    }
    return out.join("\n")
  },
}
