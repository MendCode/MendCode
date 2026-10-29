import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { median, percentile, present, ratio, sum } from "./stats"
import type { RunRecord } from "./types"

export const METRICS = [
  { key: "inputTokens", label: "input tokens", unit: "tokens" },
  { key: "outputTokens", label: "output tokens", unit: "tokens" },
  { key: "toolCalls", label: "tool calls", unit: "count" },
  { key: "failedToolCalls", label: "failed tool calls", unit: "count" },
  { key: "compactions", label: "compactions", unit: "count" },
  { key: "wallSeconds", label: "wall time (s)", unit: "seconds" },
] as const
export type MetricKey = (typeof METRICS)[number]["key"]

export type MetricSummary = { n: number; median: number | null; p90: number | null }
export type CacheSummary = { n: number; aggregatePct: number | null; medianPct: number | null }

export type HarnessReport = {
  harness: string
  runs: number
  solved: number
  timeouts: number
  harnessErrors: number
  byCategory: Record<string, { solved: number; total: number }>
  all: Record<MetricKey, MetricSummary>
  solvedOnly: Record<MetricKey, MetricSummary>
  cache: CacheSummary
  cacheSolvedOnly: CacheSummary
}

export type TaskRow = {
  taskId: string
  category: string
  /** harness -> one letter per repeat in repeat order: S solved, F failed, T timeout, E harness error. */
  outcomes: Record<string, string>
  medianInputTokens: Record<string, number | null>
}

export type ModelReport = {
  model: string
  efforts: string[]
  harnesses: HarnessReport[]
  tasks: TaskRow[]
  paired: { harnesses: [string, string]; tasks: number; medianInputRatio: number | null; medianOutputRatio: number | null } | null
  notComparable: string[]
}

export type FullReport = { generatedAt: string; runs: number; models: ModelReport[] }

const LETTER: Record<RunRecord["outcome"], string> = { solved: "S", failed: "F", timeout: "T", error: "E" }

/** Every `result.json` under the out dir (any depth). Unreadable files are reported, never silently dropped. */
export function loadRecords(outDir: string): { records: RunRecord[]; skipped: string[] } {
  const records: RunRecord[] = []
  const skipped: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name === "result.json") {
        try {
          const parsed = JSON.parse(readFileSync(full, "utf8")) as RunRecord
          if (typeof parsed.harness !== "string" || typeof parsed.model !== "string" || typeof parsed.taskId !== "string" || typeof parsed.usage !== "object") throw new Error("not a run record")
          records.push(parsed)
        } catch {
          skipped.push(full)
        }
      }
    }
  }
  if (existsSync(outDir)) walk(outDir)
  return { records, skipped }
}

const metricValue = (record: RunRecord, key: MetricKey): number | null => {
  // A run whose harness never started has no meaningful duration.
  if (key === "wallSeconds") return record.outcome === "error" ? null : record.agentMs / 1000
  return record.usage[key]
}

function summarize(records: readonly RunRecord[], key: MetricKey): MetricSummary {
  const values = records.map((record) => metricValue(record, key))
  return { n: present(values).length, median: median(values), p90: percentile(values, 90) }
}

function cacheOf(records: readonly RunRecord[]): CacheSummary {
  const usable = records.filter((record) => record.usage.inputTokens !== null && record.usage.inputTokens > 0 && record.usage.cachedReadTokens !== null)
  if (usable.length === 0) return { n: 0, aggregatePct: null, medianPct: null }
  const aggregate = ratio(sum(usable.map((record) => record.usage.cachedReadTokens)), sum(usable.map((record) => record.usage.inputTokens)))
  const perRun = usable.map((record) => (record.usage.cachedReadTokens! / record.usage.inputTokens!) * 100)
  return { n: usable.length, aggregatePct: aggregate === null ? null : aggregate * 100, medianPct: median(perRun) }
}

function summarizeAll(records: readonly RunRecord[]): Record<MetricKey, MetricSummary> {
  return Object.fromEntries(METRICS.map((metric) => [metric.key, summarize(records, metric.key)])) as Record<MetricKey, MetricSummary>
}

function harnessReport(harness: string, records: readonly RunRecord[]): HarnessReport {
  const byCategory: HarnessReport["byCategory"] = {}
  for (const record of records) {
    const entry = (byCategory[record.category] ??= { solved: 0, total: 0 })
    entry.total++
    if (record.solved) entry.solved++
  }
  const solvedRecords = records.filter((record) => record.solved)
  return {
    harness,
    runs: records.length,
    solved: solvedRecords.length,
    timeouts: records.filter((record) => record.outcome === "timeout").length,
    harnessErrors: records.filter((record) => record.outcome === "error").length,
    byCategory,
    all: summarizeAll(records),
    solvedOnly: summarizeAll(solvedRecords),
    cache: cacheOf(records),
    cacheSolvedOnly: cacheOf(solvedRecords),
  }
}

export function notComparableNotes(harnesses: readonly HarnessReport[]): string[] {
  const notes: string[] = []
  if (harnesses.length === 0) return notes
  for (const metric of METRICS) {
    const reporting = harnesses.filter((harness) => harness.all[metric.key].n > 0)
    const silent = harnesses.filter((harness) => harness.all[metric.key].n === 0)
    if (silent.length === harnesses.length) notes.push(`${metric.label}: not reported by any harness in these runs.`)
    else if (silent.length > 0) notes.push(`${metric.label}: NOT COMPARABLE, ${silent.map((harness) => harness.harness).join(", ")} did not report it (shown as n/a, not zero); ${reporting.map((harness) => harness.harness).join(", ")} did.`)
    for (const harness of reporting) {
      const count = harness.all[metric.key].n
      if (count < harness.runs) notes.push(`${metric.label}: ${harness.harness} reported it in ${count} of ${harness.runs} runs only; its statistics cover those runs.`)
    }
  }
  for (const harness of harnesses) {
    if (harness.cache.n === 0) notes.push(`cache hit %: NOT COMPARABLE for ${harness.harness} (no cached-read counter reported).`)
  }
  if (harnesses.length > 1) {
    notes.push("tool calls and failed tool calls count different things per harness (each product has its own tool set; Codex counts a command that exits non-zero as failed, MendCode counts a tool item that ended in error): read them as indicative, not as equivalent units.")
    notes.push("input tokens are normalized to all prompt tokens billed (cached included) for every harness; output tokens include reasoning. Per-call overhead of each product's system prompt and tool schemas is part of what is being measured.")
  }
  return notes
}

export function buildReport(records: readonly RunRecord[]): FullReport {
  const models = [...new Set(records.map((record) => record.model))].sort()
  return {
    generatedAt: new Date().toISOString(),
    runs: records.length,
    models: models.map((model) => modelReport(model, records.filter((record) => record.model === model))),
  }
}

function modelReport(model: string, records: readonly RunRecord[]): ModelReport {
  const harnessNames = [...new Set(records.map((record) => record.harness))].sort()
  const harnesses = harnessNames.map((name) => harnessReport(name, records.filter((record) => record.harness === name)))
  const taskIds = [...new Set(records.map((record) => record.taskId))].sort()
  const tasks: TaskRow[] = taskIds.map((taskId) => {
    const rows = records.filter((record) => record.taskId === taskId)
    const outcomes: Record<string, string> = {}
    const medianInputTokens: Record<string, number | null> = {}
    for (const harness of harnessNames) {
      const own = rows.filter((record) => record.harness === harness).sort((a, b) => a.repeat - b.repeat)
      outcomes[harness] = own.map((record) => LETTER[record.outcome]).join("")
      medianInputTokens[harness] = median(own.map((record) => record.usage.inputTokens))
    }
    return { taskId, category: rows[0]?.category ?? "", outcomes, medianInputTokens }
  })
  let paired: ModelReport["paired"] = null
  if (harnessNames.includes("mendcode") && harnessNames.includes("codex")) {
    const solvedBy = (harness: string, taskId: string) => records.filter((record) => record.harness === harness && record.taskId === taskId && record.solved)
    const inputRatios: number[] = []
    const outputRatios: number[] = []
    for (const taskId of taskIds) {
      const mend = solvedBy("mendcode", taskId)
      const codex = solvedBy("codex", taskId)
      if (mend.length === 0 || codex.length === 0) continue
      const input = ratio(median(mend.map((record) => record.usage.inputTokens)), median(codex.map((record) => record.usage.inputTokens)))
      const output = ratio(median(mend.map((record) => record.usage.outputTokens)), median(codex.map((record) => record.usage.outputTokens)))
      if (input !== null) inputRatios.push(input)
      if (output !== null) outputRatios.push(output)
    }
    paired = { harnesses: ["mendcode", "codex"], tasks: Math.max(inputRatios.length, outputRatios.length), medianInputRatio: median(inputRatios), medianOutputRatio: median(outputRatios) }
  }
  return { model, efforts: [...new Set(records.map((record) => record.effort))].sort(), harnesses, tasks, paired, notComparable: notComparableNotes(harnesses) }
}

// ---- rendering -------------------------------------------------------------------------------------------------

const NA = "n/a"
const int = (value: number | null) => (value === null ? NA : Math.round(value).toLocaleString("en-US"))
const one = (value: number | null) => (value === null ? NA : value.toFixed(1))
const pct = (value: number | null) => (value === null ? NA : `${value.toFixed(1)}%`)

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)))
  const line = (cells: string[]) => `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`
  return [line(headers), `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map(line)].join("\n")
}

const pair = (summary: MetricSummary, format: (value: number | null) => string) => (summary.n === 0 ? NA : `${format(summary.median)} / ${format(summary.p90)}`)
const count = (value: number | null) => (value === null ? NA : Number.isInteger(value) ? String(value) : value.toFixed(1))
const formatterFor = (key: MetricKey) => (key === "wallSeconds" ? one : key === "inputTokens" || key === "outputTokens" ? int : count)

export function renderModel(report: ModelReport): string {
  const out: string[] = []
  out.push(`## Model ${report.model} (effort ${report.efforts.join(", ") || NA})`, "")
  const categories = [...new Set(report.harnesses.flatMap((harness) => Object.keys(harness.byCategory)))].sort()
  out.push("### Solved", "")
  out.push(
    table(
      ["harness", "solved", "rate", ...categories, "timeouts", "harness errors"],
      report.harnesses.map((harness) => [
        harness.harness,
        `${harness.solved}/${harness.runs}`,
        harness.runs === 0 ? NA : pct((harness.solved / harness.runs) * 100),
        ...categories.map((category) => {
          const entry = harness.byCategory[category]
          return entry ? `${entry.solved}/${entry.total}` : "-"
        }),
        String(harness.timeouts),
        String(harness.harnessErrors),
      ]),
    ),
    "",
  )
  const costTable = (title: string, pick: (harness: HarnessReport) => Record<MetricKey, MetricSummary>, cache: (harness: HarnessReport) => CacheSummary) => {
    out.push(`### ${title}`, "", "Each cell is median / p90 over the runs that reported the metric.", "")
    out.push(
      table(
        ["harness", "input tokens", "cache hit % (aggregate, median)", "output tokens", "tool calls", "failed tool calls", "compactions", "wall time (s)"],
        report.harnesses.map((harness) => {
          const metrics = pick(harness)
          const cacheSummary = cache(harness)
          return [
            harness.harness,
            pair(metrics.inputTokens, formatterFor("inputTokens")),
            cacheSummary.n === 0 ? NA : `${pct(cacheSummary.aggregatePct)}, ${pct(cacheSummary.medianPct)}`,
            pair(metrics.outputTokens, formatterFor("outputTokens")),
            pair(metrics.toolCalls, formatterFor("toolCalls")),
            pair(metrics.failedToolCalls, formatterFor("failedToolCalls")),
            pair(metrics.compactions, formatterFor("compactions")),
            pair(metrics.wallSeconds, formatterFor("wallSeconds")),
          ]
        }),
      ),
      "",
    )
  }
  costTable("Cost, all runs", (harness) => harness.all, (harness) => harness.cache)
  costTable("Cost, solved runs only", (harness) => harness.solvedOnly, (harness) => harness.cacheSolvedOnly)
  if (report.paired) {
    out.push(
      "### Paired comparison",
      "",
      `On the ${report.paired.tasks} tasks both mendcode and codex solved at least once: median ratio mendcode/codex of per-task median input tokens = ${report.paired.medianInputRatio === null ? NA : report.paired.medianInputRatio.toFixed(2)}, output tokens = ${report.paired.medianOutputRatio === null ? NA : report.paired.medianOutputRatio.toFixed(2)}. Below 1 means mendcode used fewer.`,
      "",
    )
  }
  const harnessNames = report.harnesses.map((harness) => harness.harness)
  out.push("### Per task", "", "Outcomes per repeat, in order: S solved, F check failed, T timeout, E harness error. Last columns: median input tokens.", "")
  out.push(
    table(
      ["task", "category", ...harnessNames, ...harnessNames.map((name) => `in:${name}`)],
      report.tasks.map((task) => [task.taskId, task.category, ...harnessNames.map((name) => task.outcomes[name] || "-"), ...harnessNames.map((name) => int(task.medianInputTokens[name] ?? null))]),
    ),
    "",
  )
  out.push("### Not comparable", "")
  out.push(...(report.notComparable.length === 0 ? ["Nothing flagged."] : report.notComparable.map((note) => `- ${note}`)), "")
  return out.join("\n")
}

export function renderReport(report: FullReport, skipped: readonly string[] = []): string {
  const out = [`# Harness evaluation summary`, "", `Generated ${report.generatedAt}; ${report.runs} runs.`, ""]
  for (const model of report.models) out.push(renderModel(model))
  out.push("Percentiles use nearest rank (p90 = smallest value with at least 90% of the sample at or below it). A metric a harness cannot report is shown as n/a and never counted as zero.", "")
  if (skipped.length > 0) out.push(`Unreadable result files (ignored): ${skipped.join(", ")}`, "")
  return out.join("\n")
}
