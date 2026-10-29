import type { UsageReport } from "@mendcode/protocol"
import { panelGrid, spread } from "./view/deck"
import { compact } from "./view/format"
import type { Line } from "./ui/theme"

/** Human CLI stats use the same bordered grid as the terminal dashboard; JSON keeps the complete report. */
export function statsText(report: UsageReport, options: { kind: "stats" | "usage"; days?: number; models?: true | number; tools?: number }) {
  const width = 58
  const total = report.days.reduce((sum, d) => ({ input: sum.input + d.input, output: sum.output + d.output, reasoning: sum.reasoning + d.reasoning,
    cacheRead: sum.cacheRead + d.cacheRead, cacheWrite: sum.cacheWrite + d.cacheWrite, calls: sum.calls + d.calls,
    cost: sum.cost + d.costMicros, unknown: sum.unknown + d.costUnknownCalls }), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, unknown: 0 })
  const tokens = total.input + total.output + total.reasoning + total.cacheRead + total.cacheWrite
  const dates = report.days.map((d) => d.day).sort()
  const days = options.days === undefined ? dates.length ? Math.max(1, Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000) + 1) : 0 : Math.max(1, options.days)
  const cost = (micros: number, unknown = 0) => `$${(micros / 1e6).toFixed(2)}${unknown ? ` (+${unknown} unpriced)` : ""}`
  const row = (label: string, value: string): Line => spread([{ text: label, fg: "primary" }], [{ text: value, fg: "text" }], width - 4)
  const groups = [
    [{ title: "Overview", body: [row("Scope", `${report.scope?.kind ?? "global"}${report.scope?.directory ? ` · ${report.scope.directory}` : ""}`),
      ...(report.sessions === undefined ? [] : [row("Sessions", String(report.sessions))]), row("Calls", compact(total.calls)), row("Days", String(days))] }],
    [{ title: "Cost & Tokens", body: [row("Total cost", cost(total.cost, total.unknown)), row("Avg cost/day", days ? cost(total.cost / days, total.unknown) : "$0.00"),
      ...(report.sessions ? [row("Avg tokens/session", compact(tokens / report.sessions))] : []),
      row("Input", compact(total.input)), row("Output", compact(total.output)), row("Reasoning", compact(total.reasoning)), row("Cache read", compact(total.cacheRead)), row("Cache write", compact(total.cacheWrite))] }],
  ]
  const modelLimit = options.models === true ? Infinity : options.models ?? (options.kind === "usage" ? Infinity : 0)
  const models = [...report.models].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)).slice(0, modelLimit)
  if (modelLimit) groups.push([{ title: "Model Usage", body: models.length ? models.flatMap((m) => [[{ text: `${m.provider}/${m.model}`, fg: "primary" as const }],
    row("  Calls", compact(m.calls)), row("  Input", compact(m.input)), row("  Output", compact(m.output)), row("  Cost", cost(m.costMicros, m.costUnknownCalls))]) : [[{ text: "No model usage", fg: "muted" }]] }])
  const tools = [...(report.tools ?? [])].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, options.tools || Infinity)
  if (options.kind === "stats" || options.tools !== undefined) {
    const all = (report.tools ?? []).reduce((sum, t) => sum + t.calls, 0)
    const max = Math.max(1, ...tools.map((t) => t.calls))
    groups.push([{ title: "Tool Usage", body: tools.length ? tools.map((t) => row(t.tool, `${"█".repeat(Math.max(1, Math.round(t.calls / max * 20))).padEnd(20)} ${t.calls} (${(all ? t.calls / all * 100 : 0).toFixed(1)}%)`)) : [[{ text: "No tool usage", fg: "muted" }]] }])
  }
  return panelGrid({ width, rows: groups, padding: true, compact: false, maxColumns: 1 }).map((line) => line.map((s) => s.text).join("").trimEnd()).join("\n") + "\n"
}
