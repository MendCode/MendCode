import { FAILURE_LINE, type OutputFilter } from "./types"

/** Runs of three or more identical lines fold to one with a count; blank runs shrink to one blank line. Failure lines stay as printed. */
export const repeats: OutputFilter = {
  id: "repeats",
  matches: () => true,
  apply(text) {
    const lines = text.split("\n")
    const out: string[] = []
    for (let i = 0; i < lines.length;) {
      const line = lines[i]!.replace(/[ \t]+$/, "")
      let end = i + 1
      while (end < lines.length && lines[end]!.replace(/[ \t]+$/, "") === line) end++
      const run = end - i
      if (line === "") out.push("")
      else if (run >= 3 && !FAILURE_LINE.test(line)) out.push(`${line}  [x${run}]`)
      else for (let k = 0; k < run; k++) out.push(line)
      i = end
    }
    return out.join("\n")
  },
}
