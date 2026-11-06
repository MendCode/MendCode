import type { UsageAuxiliary, UsageAuxiliaryDay, UsageDay, UsageHarness, UsageModel, UsageReport } from "@mendcode/protocol"
import type { Line, Span } from "../ui/theme"
import { compact, thousands } from "./format"
import { ATTRIBUTION_ROLES } from "./usage-auxiliary"
import { addDays, dayTokens } from "./usage-heatmap"
import { textWidth } from "./wrap"

/**
 * /usage totals over every kind of call (docs/usage.md, "Every harness"): the turns of every harness (`days`), the calls outside
 * turns (`auxiliaryDays`) and usage imported from a harness's log (already inside `days`). Pure helpers for the Tokens and Models
 * tabs and `mendcode usage`/`stats`; nothing here is read at start-up.
 */

export type Totals = { tokens: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; calls: number; costMicros: number; unpriced: number }

type Counted = { input: number; output: number; reasoning?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined; calls: number; costMicros: number; costUnknownCalls?: number | undefined }

export function totalsOf(rows: Iterable<Counted>): Totals {
  const out: Totals = { tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costMicros: 0, unpriced: 0 }
  for (const row of rows) {
    out.input += row.input
    out.output += row.output
    out.reasoning += row.reasoning ?? 0
    out.cacheRead += row.cacheRead ?? 0
    out.cacheWrite += row.cacheWrite ?? 0
    out.calls += row.calls
    out.costMicros += row.costMicros
    out.unpriced += row.costUnknownCalls ?? 0
  }
  out.tokens = dayTokens(out)
  return out
}

/** The sum of rows already totalled (a table's total row). */
export function sumTotals(rows: Iterable<Totals>): Totals {
  return totalsOf([...rows].map((row) => ({ ...row, costUnknownCalls: row.unpriced })))
}

/** The report's days with the calls outside turns added in (a day with only such calls gets a row, with no sessions). */
export function daysWithAuxiliary(days: readonly UsageDay[], auxiliary: readonly UsageAuxiliaryDay[] | undefined): UsageDay[] {
  if (!auxiliary?.length) return [...days]
  const byDay = new Map(days.map((day) => [day.day, { ...day }]))
  for (const extra of auxiliary) {
    const day = byDay.get(extra.day) ?? byDay.set(extra.day, { day: extra.day, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0, calls: 0, sessions: 0 }).get(extra.day)!
    day.input += extra.input
    day.output += extra.output
    day.reasoning += extra.reasoning
    day.cacheRead += extra.cacheRead
    day.cacheWrite += extra.cacheWrite
    day.calls += extra.calls
    day.costMicros += extra.costMicros
    day.costUnknownCalls += extra.costUnknownCalls
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** Today, the last 7 and 30 days (each ending today), and the whole range, over every call. */
export function periodTotals(report: UsageReport, today: string, range: { label: string; from: string }): Array<{ label: string; totals: Totals }> {
  const days = daysWithAuxiliary(report.days, report.auxiliaryDays)
  const since = (from: string) => totalsOf(days.filter((day) => day.day >= from && day.day <= today))
  return [
    { label: "Today", totals: since(today) },
    { label: "7 days", totals: since(addDays(today, -6)) },
    { label: "30 days", totals: since(addDays(today, -29)) },
    { label: range.label, totals: since(range.from) },
  ]
}

/** Share of the prompt the provider served from its cache: read / (new input + read + written). */
export function cacheHit(row: { input: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }) {
  const prompt = row.input + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0)
  return prompt > 0 ? `${Math.round(((row.cacheRead ?? 0) / prompt) * 100)}%` : "—"
}

function dollars(micros: number) {
  const value = micros / 1e6
  if (value > 0 && value < 0.01) return "<$0.01"
  return `$${value >= 1000 ? thousands(value) : value.toFixed(2)}`
}

/** A known cost, `$x+` when some calls have no price, `unknown` when none has one (never a guessed $0.00). */
export function costText(costMicros: number, unpriced: number, calls: number, tokens = 1) {
  if (calls === 0 && tokens === 0) return "—"
  if (calls > 0 && unpriced === 0) return dollars(costMicros)
  return costMicros > 0 ? `${dollars(costMicros)}+` : "unknown"
}

const NAMES: Record<string, string> = { native: "Native", "claude-code": "Claude Code", codex: "Codex", pi: "pi", unattributed: "Deleted sessions", acp: "ACP" }

export function harnessLabel(harness: string) {
  if (NAMES[harness]) return NAMES[harness]!
  if (harness.startsWith("acp:")) return `ACP · ${harness.slice(4)}`
  if (harness.startsWith("imported:")) return `Imported · ${harness.slice(9)}`
  return harness
}

type Column = { head: string; width: number; value(row: Totals): string }

const COLUMNS: Column[] = [
  { head: "tokens", width: 8, value: (row) => compact(row.tokens) },
  { head: "cost", width: 10, value: (row) => costText(row.costMicros, row.unpriced, row.calls, row.tokens) },
  { head: "input", width: 8, value: (row) => compact(row.input) },
  { head: "output", width: 8, value: (row) => compact(row.output) },
  { head: "cache r", width: 9, value: (row) => compact(row.cacheRead) },
  { head: "cache w", width: 9, value: (row) => compact(row.cacheWrite) },
  { head: "hit", width: 6, value: (row) => cacheHit(row) },
  { head: "calls", width: 8, value: (row) => compact(row.calls) },
]
/** Narrow screens keep the first columns: tokens and cost, then the mix, cache and calls. */
const ORDER = ["tokens", "input", "output", "cache r", "cache w", "hit", "cost", "calls"]

/** A table of named totals: as many columns as fit (at least tokens and cost), a bold total row when `total` is given. */
export function totalsTable(input: { head: string; rows: Array<{ name: string; totals: Totals; tone?: Span["fg"] }>; total?: Totals; width: number; nameWidth?: number }): Line[] {
  // The name column is as wide as its longest name (up to `nameWidth`), never so wide that tokens and cost do not fit.
  const longest = Math.max(textWidth(input.head), 5, ...input.rows.map((row) => textWidth(row.name)))
  const nameWidth = Math.min(longest + 1, input.nameWidth ?? Math.min(40, Math.max(25, input.width - 34)), Math.max(8, input.width - 18))
  let room = input.width - nameWidth
  const shown = new Set<string>()
  for (const head of ["tokens", "cost", ...ORDER.filter((h) => h !== "tokens" && h !== "cost")]) {
    const column = COLUMNS.find((c) => c.head === head)!
    if (column.width > room && shown.size >= 2) break
    shown.add(head)
    room -= column.width
  }
  const columns = ORDER.map((head) => COLUMNS.find((c) => c.head === head)!).filter((c) => shown.has(c.head))
  const name = (text: string) => (textWidth(text) > nameWidth ? `${[...text].slice(0, nameWidth - 1).join("")}…` : text + " ".repeat(nameWidth - textWidth(text)))
  const line = (label: string, row: Totals, bold: boolean, tone?: Span["fg"]): Line => [
    { text: name(label), fg: tone ?? "text", ...(bold ? { bold: true } : {}) },
    ...columns.map((column): Span => ({ text: column.value(row).padStart(column.width), fg: "text", ...(bold ? { bold: true } : {}) })),
  ]
  return [
    [{ text: name(input.head), fg: "muted" }, ...columns.map((column): Span => ({ text: column.head.padStart(column.width), fg: "muted" }))],
    ...input.rows.map((row) => line(row.name, row.totals, false, row.tone)),
    ...(input.total ? [[{ text: "─".repeat(Math.max(0, Math.min(input.width, nameWidth + columns.reduce((sum, c) => sum + c.width, 0)))), fg: "border" as const }], line("Total", input.total, true)] : []),
  ]
}

/** Harness rows, the calls outside turns as their own row, and a note of the sub-agents' share; adds up to the page's total. */
export function harnessRows(report: UsageReport): { rows: Array<{ name: string; totals: Totals }>; notes: string[] } {
  const harnesses: UsageHarness[] = report.harnesses ?? []
  const rows = harnesses.map((entry) => ({ name: harnessLabel(entry.harness), totals: totalsOf([entry]) }))
  const outside = (report.auxiliary ?? []) as UsageAuxiliary[]
  const counted = outside.filter((entry) => !ATTRIBUTION_ROLES.includes(entry.role))
  if (counted.some((entry) => entry.calls > 0)) rows.push({ name: "Outside turns", totals: totalsOf(counted) })
  const notes: string[] = []
  for (const entry of harnesses) {
    if (entry.subagents?.tokens) notes.push(`${harnessLabel(entry.harness)}: ${compact(entry.subagents.tokens)} tok from ${thousands(entry.subagents.sessions)} sub-agent ${entry.subagents.sessions === 1 ? "session" : "sessions"} (inside its row)`)
  }
  return { rows, notes }
}

/** Model rows with their cache columns; turns only, like `report.models`. */
export function modelRows(models: readonly UsageModel[]): Array<{ name: string; totals: Totals }> {
  // An older daemon sends no `costUnknownCalls`: a zero cost from it is not known to be free.
  return [...models].map((model) => ({ name: `${model.provider}/${model.model}`, totals: totalsOf([model.costUnknownCalls === undefined && !model.costMicros ? { ...model, costUnknownCalls: model.calls } : model]) })).sort((a, b) => b.totals.tokens - a.totals.tokens || a.name.localeCompare(b.name))
}
