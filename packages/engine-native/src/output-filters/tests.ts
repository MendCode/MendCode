import { FAILURE_LINE, type OutputFilter } from "./types"

const RUNNER = /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|mocha|node\s+--test)\b/
/** One passing test per line: bun `(pass)`, jest/vitest `✓`, go `--- PASS`, cargo `... ok`, jest `PASS file`. */
const PASSING = /^\s*(?:\(pass\)|[✓✔]|PASS\b|--- PASS:|=== RUN\b|test .+ \.\.\. ok$|ok\s+\S+\s+[\d.]+s)/

/** Passing test lines fold to a count; failures, stack traces and the summary stay verbatim. */
export const tests: OutputFilter = {
  id: "tests",
  matches: ({ tool, command }) => (tool === "shell" || tool === "shell_output") && RUNNER.test(command),
  apply(text) {
    const out: string[] = []
    let passing = 0
    const flush = () => {
      if (passing > 0) out.push(`· ${passing} passing test line${passing === 1 ? "" : "s"} omitted`)
      passing = 0
    }
    for (const line of text.split("\n")) {
      if (PASSING.test(line) && !FAILURE_LINE.test(line)) { passing++; continue }
      flush()
      out.push(line)
    }
    flush()
    return out.join("\n")
  },
}
