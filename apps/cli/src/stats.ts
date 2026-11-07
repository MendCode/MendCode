import type { UsageReport } from "@mendcode/protocol"
import { panelGrid, spread } from "./view/deck"
import { compact } from "./view/format"
import { auxiliaryLabel, auxiliaryOrder, auxiliaryTotals, callCount } from "./view/usage-auxiliary"
import { cacheHit, costText, daysWithAuxiliary, harnessRows, totalsOf } from "./view/usage-breakdown"
import type { Line } from "./ui/theme"

/** Human CLI stats use the same bordered grid as the terminal dashboard; JSON keeps the complete report. */
export function statsText(report: UsageReport, options: { kind: "stats" | "usage"; days?: number; models?: true | number; tools?: number }) {
  const width = 58
  // Every call: the turns of every harness (imported usage included) and the calls outside turns. Reasoning is inside output.
  const all = totalsOf(daysWithAuxiliary(report.days, report.auxiliaryDays))
  const total = { ...all, cost: all.costMicros, unknown: all.unpriced }
  const tokens = all.tokens
  const dates = report.days.map((d) => d.day).sort()
  const days = options.days === undefined ? dates.length ? Math.max(1, Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000) + 1) : 0 : Math.max(1, options.days)
  const cost = (micros: number, unknown = 0) => `$${(micros / 1e6).toFixed(2)}${unknown ? ` (+${unknown} unpriced)` : ""}`
  const row = (label: string, value: string): Line => spread([{ text: label, fg: "primary" }], [{ text: value, fg: "text" }], width - 4)
  const groups = [
    [{ title: "Overview", body: [row("Scope", `${report.scope?.kind ?? "global"}${report.scope?.directory ? ` · ${report.scope.directory}` : ""}`),
      ...(report.sessions === undefined ? [] : [row("Sessions", String(report.sessions))]), row("Calls", compact(total.calls)), row("Days", String(days))] }],
    [{ title: "Cost & Tokens", body: [row("Total cost", cost(total.cost, total.unknown)), row("Avg cost/day", days ? cost(total.cost / days, total.unknown) : "$0.00"),
      ...(report.sessions ? [row("Avg tokens/session", compact(tokens / report.sessions))] : []),
      row("Tokens", compact(tokens)), row("Input", compact(total.input)), row("Output", compact(total.output)), row("  of it reasoning", compact(total.reasoning)),
      row("Cache read", compact(total.cacheRead)), row("Cache write", compact(total.cacheWrite)), row("Cache hit", cacheHit(total))] }],
  ]
  const harness = harnessRows(report)
  if (harness.rows.length) groups.push([{ title: "By Harness", body: [...harness.rows.map((entry) => row(entry.name, `${compact(entry.totals.tokens)} tok · ${cacheHit(entry.totals)} hit · ${costText(entry.totals.costMicros, entry.totals.unpriced, entry.totals.calls, entry.totals.tokens)}`)),
    ...harness.notes.map((text): Line => [{ text, fg: "muted" }])] }])
  const modelLimit = options.models === true ? Infinity : options.models ?? (options.kind === "usage" ? Infinity : 0)
  const models = [...report.models].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)).slice(0, modelLimit)
  if (modelLimit) groups.push([{ title: "Model Usage", body: models.length ? models.flatMap((m) => [[{ text: `${m.provider}/${m.model}`, fg: "primary" as const }],
    row("  Calls", compact(m.calls)), row("  Input", compact(m.input)), row("  Output", compact(m.output)), row("  Cost", cost(m.costMicros, m.costUnknownCalls))]) : [[{ text: "No model usage", fg: "muted" }]] }])
  // Calls outside turns, apart from the turns' totals above; shown only when there were some.
  const auxiliary = report.auxiliary ?? []
  if (auxiliary.length) {
    const sum = auxiliaryTotals(auxiliary)
    groups.push([{ title: "Auxiliary Calls", body: [row("Calls outside turns", compact(sum.calls)), row("Tokens", compact(sum.tokens)), row("Cost", cost(sum.costMicros, sum.unpriced)),
      ...auxiliaryOrder(auxiliary).map((entry) => row(`  ${auxiliaryLabel(entry)}`, `${callCount(entry.calls, compact)} · ${compact(entry.input)} in`))] }])
  }
  const tools = [...(report.tools ?? [])].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, options.tools || Infinity)
  if (options.kind === "stats" || options.tools !== undefined) {
    const all = (report.tools ?? []).reduce((sum, t) => sum + t.calls, 0)
    const max = Math.max(1, ...tools.map((t) => t.calls))
    groups.push([{ title: "Tool Usage", body: tools.length ? tools.map((t) => row(t.tool, `${"█".repeat(Math.max(1, Math.round(t.calls / max * 20))).padEnd(20)} ${t.calls} (${(all ? t.calls / all * 100 : 0).toFixed(1)}%)`)) : [[{ text: "No tool usage", fg: "muted" }]] }])
  }
  return panelGrid({ width, rows: groups, padding: true, compact: false, maxColumns: 1 }).map((line) => line.map((s) => s.text).join("").trimEnd()).join("\n") + "\n"
}
