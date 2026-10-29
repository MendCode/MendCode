import { ideSelectionKey } from "@mendcode/protocol/wire"
import type { IdeState } from "../ui/app/ide"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { fit, panelGrid, type GridPanel } from "./deck"
import { cells } from "./wrap"

export function renderIdePage(input: { state: IdeState | undefined; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const report = state?.report
  const selection = report?.selection
  const key = ideSelectionKey(selection)
  const label = selection ? key === state?.dismissed ? "cleared" : key === state?.sent ? "sent" : "pending" : "none"
  const compact = width < 70
  const room = Math.max(0, height - 2)
  const top = Math.min(9, Math.max(7, room - 8))
  const previewHeight = compact ? Math.max(4, room - top - 1) : room
  const rows = (values: string[], cols: number): Line[] => values.flatMap((value) => {
    const result: Line[] = []
    let text = "", used = 0
    for (const cell of cells(value)) {
      if (used + cell.width > cols && text) { result.push([{ text, fg: "text" }]); text = ""; used = 0 }
      text += cell.text
      used += cell.width
    }
    result.push([{ text, fg: "text" }])
    return result
  })
  const bridge: GridPanel = { title: report?.editor === "vscode" ? "VS Code" : "Zed", weight: 1, body: (cols) => rows([
    `Bridge: ${report?.enabled ? "on" : "off"}`,
    `Status: ${state?.loading ? "loading" : report?.status ?? "unavailable"}`,
    `Context: ${label}`,
    ...(state?.error || report?.message ? ["", state?.error ?? report!.message!] : []),
    ...(state?.directory ? ["", state.directory] : []),
  ], cols) }
  const preview: GridPanel = { title: selection ? `Editor context · ${label}` : "Editor context", weight: 2, body: (cols) => {
    const content = rows(selection ? [selection.filePath, "", ...selection.ranges.flatMap((range, index) => [
      `${selection.ranges.length > 1 ? `Range ${index + 1} · ` : ""}${range.selection.start.line}:${range.selection.start.character}–${range.selection.end.line}:${range.selection.end.character}`,
      ...range.text.split("\n"), "",
    ])] : [report?.enabled ? "No editor selection" : "Editor context is off"], Math.max(1, cols - 1))
    const visible = Math.max(1, previewHeight - 4)
    if (state) state.maxScroll = Math.max(0, content.length - visible)
    const start = Math.max(0, Math.min(state?.scroll ?? 0, content.length - visible))
    const thumb = Math.max(1, Math.floor(visible * visible / content.length))
    const offset = Math.round(start / Math.max(1, content.length - visible) * (visible - thumb))
    return content.slice(start, start + visible).map((row, index): Line => [
      ...fit(row, cols - 1), { text: content.length > visible ? index >= offset && index < offset + thumb ? "█" : "│" : " ", fg: "borderActive" },
    ])
  } }
  const body = panelGrid({ width: Math.max(1, width - 4), compact: false, padding: true, maxColumns: compact ? 1 : 2,
    heights: compact ? [top, Math.max(4, room - top - 1)] : [room], rows: compact ? [[bridge], [preview]] : [[bridge, preview]] })
  const hints = compact ? "↑↓ · e on/off · c clear · o open · r · esc" : "↑↓ scroll · e on/off · c clear · o open · r refresh · esc back"
  return appearancePage({ title: "IDE", hints, body, width, height })
}
