import type { Line } from "../ui/theme"
import { deck, deckChrome, panelGrid } from "./deck"
import { kvList } from "./page"
import { wrap } from "./wrap"
import type { DiagnosticsReport } from "@mendcode/protocol"
export type { DiagnosticsReport } from "@mendcode/protocol"

const bytes = (value: number) => `${(value / 1048576).toFixed(1)} MiB`
export const memoryGuardrail = (rss: number) => rss >= 4 * 1024 ** 3 ? "critical" : rss >= 2 * 1024 ** 3 ? "warning" : "ok"
const facts = (rows: string[][], width: number) => kvList(rows.map(([label, value]) => ({ label: label!, value: value! })), width)
function memoryRows(memory: NodeJS.MemoryUsage | undefined, width: number): Line[] {
  return facts(memory ? [
    ["RSS", bytes(memory.rss)], ["Heap used", bytes(memory.heapUsed)], ["Heap total", bytes(memory.heapTotal)],
    ["External", bytes(memory.external)], ["Array buffers", bytes(memory.arrayBuffers)],
    ["Guardrail", memoryGuardrail(memory.rss)], ["Warn / critical", "2.0 / 4.0 GiB"],
  ] : [["Memory", "unavailable"]], width)
}

export function renderDiagnosticsPage(input: { width: number; height: number; memory?: NodeJS.MemoryUsage; report?: DiagnosticsReport; error?: string; snapshots?: string[]; scroll?: number; readOnly?: boolean; ui?: { sessions: number; messages: number; items: number; route: string; pid: number; uptime: number } }): Line[] {
  const { width, height, report } = input
  const hints = width < 70
    ? input.readOnly ? "↑↓ scroll · r refresh · esc" : "↑↓ scroll · r refresh · s heap · esc"
    : input.readOnly ? "↑↓ scroll · r refresh · esc back" : "↑↓ scroll · r refresh · s snapshot · esc back"
  const room = Math.max(0, height - deckChrome("", width))
  const snapshotLines: Line[] = input.snapshots?.flatMap((file) => wrap(file, Math.max(1, width - 6)).map((text) => [{ text }])) ?? []
  const grid = panelGrid({ width: Math.max(1, width - 2), compact: false, maxColumns: width < 70 ? 1 : 2, padding: true, ...(width >= 70 && !snapshotLines.length && !input.error ? { heights: [Math.max(11, Math.floor((room - 1) * 0.45)), Math.max(12, room - 1 - Math.max(11, Math.floor((room - 1) * 0.45)))] } : {}), rows: [
    [{ title: "TUI memory", body: (inner) => memoryRows(input.memory, inner) }, { title: "Daemon memory", body: (inner) => memoryRows(report?.memory, inner) }],
    [{ title: "TUI counters", body: (inner) => facts(input.ui ? [["Loaded sessions", String(input.ui.sessions)], ["Transcript messages", String(input.ui.messages)], ["Transcript items", String(input.ui.items)], ["Route", input.ui.route], ["PID", String(input.ui.pid)], ["Uptime", `${Math.floor(input.ui.uptime)}s`]] : [["Counters", "unavailable"]], inner) }, { title: "Daemon resources", body: (inner) => facts(report ? [["Connections", String(report.connections)], ["Session actors", String(report.actors)], ["Scheduled jobs", String(report.jobs)], ["Scopes", String(report.scopes)], ["Timers", String(report.timers)], ["Disposers", String(report.disposers)], ...(report.pid === undefined ? [] : [["PID", String(report.pid)]]), ...(report.uptime === undefined ? [] : [["Uptime", `${Math.floor(report.uptime)}s`]])] : [["Daemon", input.error || "unavailable"]], inner) }],
    ...(snapshotLines.length ? [[{ title: "Heap snapshots", body: snapshotLines }]] : []),
    ...(input.error && report ? [[{ title: "Error", body: wrap(input.error, Math.max(1, width - 6)).map((text): Line => [{ text, fg: "error" }]) }]] : []),
  ] })
  return deck({ page: "Diagnostics", summary: hints, hints: "", width, height, body: grid, scroll: Math.min(input.scroll ?? 0, Math.max(0, grid.length - room)) })
}
