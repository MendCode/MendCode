import { readFileSync } from "node:fs"
import { ingest } from "./ingest"
import { dailyTotals, grandTotal } from "./report"

const file = process.argv[2]
if (!file) {
  process.stderr.write("usage: bun src/main.ts FEED.csv\n")
  process.exit(2)
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z")
const { accepted, skipped } = ingest(readFileSync(file, "utf8"))
process.stderr.write(`${stamp()} INFO  ingest start source=${file}\n`)
for (const entry of skipped) process.stderr.write(`${stamp()} WARN  skip record id=${entry.id} reason="${entry.reason}" raw="${entry.raw}"\n`)
const totals = dailyTotals(accepted)
process.stderr.write(`${stamp()} INFO  ingest done accepted=${accepted.length} skipped=${skipped.length} total_cents=${grandTotal(totals)}\n`)
for (const [day, cents] of Object.entries(totals).sort()) process.stdout.write(`${day} ${cents}\n`)
