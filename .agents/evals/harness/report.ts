#!/usr/bin/env bun
/**
 * Reads the out dir of run.ts and prints one table set per model; also writes results.json and summary.md there.
 *   bun .agents/evals/harness/report.ts --out <dir>
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs, rejectUnknown, requiredFlag } from "./lib/args"
import { buildReport, loadRecords, renderReport } from "./lib/report"

const args = parseArgs(process.argv.slice(2))
rejectUnknown(args, ["out"])
const outDir = path.resolve(requiredFlag(args, "out"))
const { records, skipped } = loadRecords(outDir)
if (records.length === 0) {
  console.error(`no result.json files under ${outDir}`)
  process.exit(1)
}
const report = buildReport(records)
const markdown = renderReport(report, skipped)
writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(path.join(outDir, "summary.md"), markdown)
console.log(markdown)
