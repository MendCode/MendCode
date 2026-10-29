import type { LedgerPage, LedgerScope } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread } from "./deck"
import { wrap } from "./wrap"

export type AutomationLedgerState = {
  scope: LedgerScope
  ownerId: string
  name: string
  operation: "events" | "artifacts" | "receipt"
  selected: number
  scroll: number
  cursors: Array<number | undefined>
  page?: LedgerPage
  error?: string
  loading?: boolean
  exported?: { format: "json" | "markdown"; text: string }
}

export function renderAutomationLedger(input: { state: AutomationLedgerState; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const page = state.page
  const entries = page?.entries ?? []
  const selected = entries[Math.min(state.selected, Math.max(0, entries.length - 1))]
  const compact = width < 70
  const header = spread([{ text: `${state.scope === "workflow" ? "Workflow" : "Loop"} evidence`, fg: "accent", bold: true }], [{ text: compact ? "↑↓ · pgdn · esc" : "↑↓ select · [ ] page · pgdn scroll · e/m export · esc", fg: "muted" }], width)
  const tabs: Line = [{ text: `1 Events  2 Artifacts  3 Receipt  · ${state.name}`, fg: "text" }]
  const list = (room: number): Line[] => {
    const meta = `${page?.retained ?? 0} retained${page?.truncated ? " · truncated" : ""}${page && !page.historical ? " · snapshot only" : ""}`
    const rows: Line[] = [[{ text: meta, fg: page?.truncated ? "warning" : "muted" }], []]
    if (state.loading) rows.push([{ text: "Loading evidence…", fg: "muted" }])
    if (state.error) rows.push(...wrap(state.error, room).map((text): Line => [{ text, fg: "warning" }]))
    if (page && !entries.length) rows.push([{ text: `No ${state.operation}`, fg: "muted" }])
    const start = Math.max(0, state.selected - Math.max(1, height - 11))
    for (const [index, entry] of entries.entries()) {
      if (index < start) continue
      rows.push([{ text: `${index === state.selected ? "›" : " "} #${entry.sequence}  r${entry.run}  ${entry.kind}`, fg: index === state.selected ? "accent" : "text" }])
    }
    if (page?.nextBefore) rows.push([], [{ text: `] older · cursor ${page.nextBefore}`, fg: "muted" }])
    return rows
  }
  const detail = (room: number): Line[] => {
    const textRows = (value: string) => value.split("\n").flatMap((line) => {
      const indent = Math.min(/^\s*/.exec(line)?.[0].length ?? 0, Math.floor(room / 3))
      return wrap(line.trimStart(), Math.max(1, room - indent)).map((text): Line => [{ text: " ".repeat(indent) + text, fg: "body" }])
    })
    if (state.exported) return textRows(state.exported.text)
    if (!selected) return []
    return [
      [{ text: `#${selected.sequence} · run ${selected.run} · ${new Date(selected.at).toISOString()}`, fg: "muted" }],
      ...wrap(selected.title, room).map((text): Line => [{ text, fg: "accent", bold: true }]),
      ...(selected.category === "receipt" ? [[{ text: `Verification: ${selected.data.verified === true ? "verified" : selected.data.override ? "manual override" : "unverified"}`, fg: selected.data.verified === true ? "accent" : "warning" }] as Line] : []),
      [],
      ...wrap(selected.summary, room).map((text): Line => [{ text, fg: "text" }]),
      ...(selected.taskId ? [[{ text: `Task ${selected.taskId}`, fg: "muted" }] as Line] : []),
      ...(selected.sessionId ? [[{ text: `Session ${selected.sessionId}`, fg: "muted" }] as Line] : []),
      [],
      ...textRows(JSON.stringify(selected.data, null, 2)),
    ]
  }
  const title = state.exported ? `${state.exported.format === "json" ? "JSON" : "Markdown"} export · y copy · esc close` : `${state.operation === "receipt" ? "Completion receipt" : "Evidence"} · ${state.selected + (entries.length ? 1 : 0)}/${entries.length}`
  const room = Math.max(0, height - 2)
  const body = panelGrid({ width, compact: false, padding: true, maxColumns: compact || state.exported ? 1 : 2, heights: [room], rows: compact || state.exported ? [[
    { title, active: true, scroll: state.scroll, body: (w) => state.exported ? detail(w) : [...list(w).slice(0, 6), [], ...detail(w)] },
  ]] : [[{ title: "Ledger", body: list, weight: 2 }, { title, body: detail, scroll: state.scroll, active: true, weight: 3 }]] })
  return [header, tabs, ...body].slice(0, height).map((row) => fit(row, width))
}
