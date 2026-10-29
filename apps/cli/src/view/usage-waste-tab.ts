import type { UsageWasteReport, WasteChange, WasteFinding, WasteWindow } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { compact } from "./format"
import { kpiRow, kvList, section } from "./page"
import { duration, empty, fitText, longDate, money, percent, table } from "./usage-tabs"
import { textWidth, wrap } from "./wrap"

/**
 * /usage tab 7, Waste (docs/usage.md, "Waste"): where the range's tokens went, the moments that paid for the same context twice,
 * what to change, and what the changes already made did. `mendcode stats --waste` prints the same rows as text.
 * Pure: the daemon's `usage.waste` report in, rows out.
 */

export type WasteView = { report: UsageWasteReport | undefined; loading?: boolean; index: number; width: number; glyphs: Glyphs; /** The CLI: no selection, no keys. */ plain?: boolean }

/** A row Enter acts on: a finding's fix, or the revert of a change still in force. */
export type WasteAction = { kind: "apply"; finding: WasteFinding; patch: Record<string, unknown>; label: string } | { kind: "undo"; change: WasteChange; patch: Record<string, unknown>; label: string }

export function wasteActions(report: UsageWasteReport | undefined): WasteAction[] {
  if (!report) return []
  return [
    ...report.findings.flatMap((finding): WasteAction[] => (finding.fix ? [{ kind: "apply", finding, patch: finding.fix.patch, label: finding.fix.label }] : [])),
    ...report.changes.flatMap((change): WasteAction[] => (change.revert ? [{ kind: "undo", change, patch: change.revert, label: `undo ${change.label}` }] : [])),
  ]
}

const muted = (text: string): Span => ({ text, fg: "muted" })
const CERTAINTY: Record<WasteFinding["certainty"], { text: string; fg: ColorName }> = {
  clear: { text: "clear", fg: "success" },
  likely: { text: "likely", fg: "primary" },
  test: { text: "up to", fg: "warning" },
}
const tokens = (n: number) => `${compact(n)} tok`
const ago = (ms: number) => duration(Math.max(0, ms)).replace(/ \d+s$/, "")

/** A bar of `share` (0..1) in `width` cells. */
function bar(share: number, width: number, glyphs: Glyphs, fg: ColorName): Span[] {
  const filled = Math.max(share > 0 ? 1 : 0, Math.round(Math.min(1, share) * width))
  return [{ text: glyphs.barFull.repeat(filled), fg }, { text: glyphs.barEmpty.repeat(width - filled), fg: "border" }]
}

/** Rows of `label  ████░░░  42%  value`: the label column fits the widest label, the bar takes what is left. */
function bars(rows: Array<{ label: string; share: number; value: string; fg?: ColorName }>, width: number, glyphs: Glyphs): Line[] {
  const labelWidth = Math.max(...rows.map((row) => textWidth(row.label))) + 2
  const valueWidth = Math.max(...rows.map((row) => textWidth(row.value)))
  const barWidth = Math.max(6, Math.min(28, width - labelWidth - valueWidth - 7))
  return rows.map((row) => [muted(fitText(row.label, labelWidth)), ...bar(row.share, barWidth, glyphs, row.fg ?? "primary"), { text: ` ${`${Math.round(row.share * 100)}%`.padStart(4)}  `, fg: "text" }, muted(row.value.padStart(valueWidth))])
}

function marker(selected: boolean, plain: boolean | undefined): Span {
  if (plain) return { text: "" }
  return selected ? { text: "› ", fg: "primary", bold: true } : { text: "  " }
}

function findingRows(view: WasteView, report: UsageWasteReport, actions: WasteAction[]): Line[] {
  if (!report.findings.length) return empty("Nothing to change: no repeated waste in this range")
  const rows: Line[] = []
  for (const finding of report.findings) {
    const action = actions.findIndex((entry) => entry.kind === "apply" && entry.finding === finding)
    const selected = action >= 0 && action === view.index
    const certainty = CERTAINTY[finding.certainty]
    const saves = `${finding.certainty === "test" ? "up to " : ""}${finding.costMicros ? money(finding.costMicros) : tokens(finding.tokens)}`
    const head: Span[] = [marker(selected, view.plain), { text: `[${certainty.text}] `, fg: certainty.fg }]
    const room = Math.max(8, view.width - textWidth(head.map((span) => span.text).join("")) - textWidth(saves) - 2)
    rows.push([...head, { text: fitText(finding.title, room), fg: selected ? "primary" : "text", bold: true }, { text: "  " }, { text: saves, fg: "success" }])
    const indent = view.plain ? "" : "  "
    for (const text of wrap(finding.detail, Math.max(10, view.width - indent.length))) rows.push([muted(`${indent}${text}`)])
    if (finding.fix && !view.plain) rows.push([muted(indent), { text: selected ? "enter " : "", fg: "primary" }, muted(selected ? `applies ${finding.fix.label}` : finding.fix.label)])
    else if (finding.fix) rows.push([muted(`fix: ${finding.fix.label}`)])
    rows.push([])
  }
  rows.pop()
  return rows
}

function splitRows(view: WasteView, report: UsageWasteReport): Line[] {
  const priced = report.splitMicros
  const source = priced ?? report.split
  const total = source.reread + source.written + source.fresh + source.output
  if (!total) return empty("No model calls in this range")
  // Priced, the shares are of what the priced calls cost; the tokens below are every call's, priced or not.
  const value = (key: keyof typeof source) => (priced ? money(priced[key]) : tokens(report.split[key]))
  const rows = bars([
    { label: "Re-reading the conversation", share: source.reread / total, value: value("reread") },
    { label: "Writing it into the cache", share: source.written / total, value: value("written"), fg: "warning" },
    { label: "New input", share: source.fresh / total, value: value("fresh") },
    { label: "Answers, code and thinking", share: source.output / total, value: value("output"), fg: "success" },
  ], view.width, view.glyphs)
  if (!priced) return rows
  const { split } = report
  return [...rows, [], [muted(`All calls, in tokens: re-read ${compact(split.reread)} · written ${compact(split.written)} · new ${compact(split.fresh)} · out ${compact(split.output)}`)]]
}

function bandRows(view: WasteView, report: UsageWasteReport): Line[] {
  const total = report.bands.reduce((sum, band) => sum + band.prompt, 0)
  if (!total) return empty("No model calls in this range")
  const name = (band: UsageWasteReport["bands"][number]) => (band.max === undefined ? `${compact(band.min)}+` : band.min === 0 ? `under ${compact(band.max)}` : `${compact(band.min)}–${compact(band.max)}`)
  return bars(report.bands.map((band) => ({ label: name(band), share: band.prompt / total, value: `${compact(band.calls)} calls`, fg: band.max === undefined ? "warning" : "primary" })), view.width, view.glyphs)
}

function coldRows(view: WasteView, report: UsageWasteReport): Line[] {
  const { cold } = report
  if (!cold.count) return empty("No cold returns: every pause came back to a warm cache, or was compacted before it expired")
  const some = cold.priced !== undefined && cold.priced < cold.count ? `The ${cold.priced} on a priced model cost` : "They cost"
  const priced = cold.micros !== undefined ? ` ${some} ${money(cold.micros)}, where a warm cache would have read them for ${money(cold.warmMicros ?? 0)}.` : ""
  const rows: Line[] = wrap(`${cold.count} times you came back after a long conversation's cache expired and sent ${compact(cold.resent)} tokens again, in ${cold.sessions} ${cold.sessions === 1 ? "session" : "sessions"}.${priced}`, view.width).map((text) => [{ text, fg: "text" }])
  if (cold.worst.length) {
    rows.push([])
    rows.push(...table({ head: ["conversation", "away", "sent again"], rows: cold.worst.map((entry) => [entry.title || "untitled", ago(entry.gapMs), compact(entry.tokens)]), widths: [8, 12], width: view.width }))
  }
  return rows
}

function otherRows(view: WasteView, report: UsageWasteReport): Line[] {
  const { breaks, switches, compactions } = report
  return kvList([
    { label: "Warm cache missed (prompt changed)", value: breaks.count ? `${breaks.count} · ${tokens(breaks.resent)}` : "none", ...(breaks.count ? { tone: "warning" as const } : {}) },
    { label: "Model switched mid-session", value: switches.count ? `${switches.count} · ${tokens(switches.resent)}` : "none" },
    { label: "Compactions (auto · manual · idle)", value: `${compactions.auto} · ${compactions.manual} · ${compactions.idle}` },
    ...(compactions.failed ? [{ label: "Compactions that failed", value: String(compactions.failed), tone: "error" as const }] : []),
    { label: "Waiting for summaries", value: duration(compactions.waitMs) },
  ], view.width)
}

/** `-26%` against the side before; a rise is a cost for every figure here. */
function delta(before: number, after: number): Span {
  if (!before && !after) return muted("")
  if (!before) return { text: "new", fg: "warning" }
  const change = Math.round(((after - before) / before) * 100)
  return { text: `${change > 0 ? "+" : ""}${change}%`, fg: change < -2 ? "success" : change > 2 ? "warning" : "muted" }
}

function changeRows(view: WasteView, report: UsageWasteReport, actions: WasteAction[]): Line[] {
  if (!report.changes.length) return empty("No change to compaction, cache or cost settings in the last 90 days")
  const rows: Line[] = []
  for (const change of report.changes) {
    const action = actions.findIndex((entry) => entry.kind === "undo" && entry.change === change)
    const selected = action >= 0 && action === view.index
    rows.push([marker(selected, view.plain), { text: change.label, fg: selected ? "primary" : "text", bold: true }, muted(`  ${longDate(change.at)}`)])
    const figure = (pick: (side: WasteWindow) => number, show: (n: number) => string): Array<string | Span> => [show(pick(change.before)), show(pick(change.after)), delta(pick(change.before), pick(change.after))]
    const lines: Array<[string, ...Array<string | Span>]> = [
      ["prompt per turn", ...figure((side) => side.promptPerTurn, compact)],
      ["sent uncached per turn", ...figure((side) => side.uncachedPerTurn, compact)],
      ["calls past 200K", ...figure((side) => Math.round(side.over200k * 100), (n) => `${n}%`)],
      ["compactions a day", ...figure((side) => side.compactionsPerDay, (n) => String(n))],
      ["waiting for summaries a day", ...figure((side) => side.waitMsPerDay, duration)],
    ]
    if (change.before.costPerTurnMicros !== undefined && change.after.costPerTurnMicros !== undefined) lines.unshift(["cost per turn", ...figure((side) => side.costPerTurnMicros ?? 0, money)])
    const indent = view.plain ? 0 : 2
    rows.push(...table({ head: ["", `before · ${change.before.days}d`, `after · ${change.after.days}d`, ""], rows: lines, widths: [14, 14, 7], width: view.width - indent }).map((line) => [{ text: " ".repeat(indent) }, ...line]))
    const notes = [change.early ? "Too early to read: a side has fewer than 10 turns or a day." : "", change.revert && selected && !view.plain ? "enter puts it back" : ""].filter(Boolean)
    for (const note of notes) rows.push([{ text: `${" ".repeat(indent)}${note}`, fg: note.startsWith("enter") ? "primary" : "muted" }])
    rows.push([])
  }
  rows.pop()
  return rows
}

function topRows(view: WasteView, report: UsageWasteReport): Line[] {
  if (!report.top.length) return empty("No sessions in this range")
  const priced = report.topBy === "cost"
  return table({
    head: ["conversation", priced ? "cost" : "prompt", "turns", "cold", "peak"],
    rows: report.top.map((entry) => [entry.title || "untitled", priced ? (entry.costMicros !== undefined ? money(entry.costMicros) : "—") : compact(entry.prompt), String(entry.turns), entry.cold ? { text: String(entry.cold), fg: "warning" } : muted("0"), compact(entry.peak)]),
    widths: [10, 7, 6, 7],
    width: view.width,
  })
}

export function wasteTab(view: WasteView): Line[] {
  const report = view.report
  if (!report) return section({ title: "Waste", body: empty(view.loading === false ? "The daemon did not answer; R tries again" : "Reading the calls of this range…"), width: view.width })
  const actions = wasteActions(report)
  const listPriced = report.priced.list > 0
  const over = report.bands.find((band) => band.max === undefined)
  const rows: Line[] = [
    ...kpiRow([
      { value: compact(report.calls), label: "Calls" },
      { value: String(report.cold.count), label: "Cold returns", ...(report.cold.count ? { tone: "warning" as const } : {}) },
      { value: compact(report.cold.resent + report.breaks.resent + report.switches.resent), label: "Sent again" },
      { value: percent(over?.calls ?? 0, report.calls), label: "Calls past 200K", ...((over?.calls ?? 0) / Math.max(1, report.calls) >= 0.2 ? { tone: "warning" as const } : {}) },
      { value: String(report.compactions.idle), label: "Idle compactions" },
    ], view.width),
    [],
    ...section({ title: "What to change", subtitle: "Each saving is measured alone; they overlap, never add them", body: findingRows(view, report, actions), width: view.width }),
    [],
    ...section({ title: "Where it goes", subtitle: report.splitMicros ? `${listPriced ? "at API prices" : "billed"} · ${compact(report.priced.billed + report.priced.list)} of ${compact(report.calls)} calls priced` : "tokens · no call in this range has a known price", body: splitRows(view, report), width: view.width }),
    [],
    ...section({ title: "Context size", subtitle: "Share of the prompt tokens sent, by how large the prompt was", body: bandRows(view, report), width: view.width }),
    [],
    ...section({ title: "Cold returns", subtitle: "A pause past the cache's lifetime, then the whole context sent again", body: coldRows(view, report), width: view.width }),
    [],
    ...section({ title: "Changes", subtitle: "The days after each change against the days before; the sessions differ, so read it as a trend", body: changeRows(view, report, actions), width: view.width }),
    [],
    ...section({ title: report.topBy === "cost" ? "Costliest conversations" : "Largest conversations", subtitle: report.topBy === "cost" ? (report.priced.list > 0 ? "at API prices" : "billed") : "by prompt tokens sent · not every call has a price", body: topRows(view, report), width: view.width }),
    [],
    ...section({ title: "Other repeats", body: otherRows(view, report), width: view.width }),
  ]
  return rows
}
