import { readFileSync } from "node:fs"
import { addCounts, countText, emptyCounts } from "./count"
import { formatTable, type Row } from "./format"

type Io = { out(text: string): void; err(text: string): void }

/** `wc`-style counter: `bun src/cli.ts FILE...`. Exit 0 on success, 2 on a usage or read error. */
export function run(argv: string[], io: Io): number {
  const options = argv.filter((arg) => arg.startsWith("--"))
  const files = argv.filter((arg) => !arg.startsWith("--"))
  if (options.length > 0) {
    io.err(`unknown option ${options[0]}\n`)
    return 2
  }
  if (files.length === 0) {
    io.err("usage: wc FILE...\n")
    return 2
  }
  const rows: Row[] = []
  let total = emptyCounts
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      io.err(`cannot read ${file}\n`)
      return 2
    }
    const counts = countText(text)
    rows.push({ file, ...counts })
    total = addCounts(total, counts)
  }
  io.out(formatTable(rows, total))
  return 0
}

if (import.meta.main) {
  const code = run(process.argv.slice(2), {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  })
  process.exit(code)
}
