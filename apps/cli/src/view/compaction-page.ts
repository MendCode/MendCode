import type { TurnId } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import type { createEditor } from "./editor"
import type { Compaction } from "./compaction-panel"
import { compactionHeading, compactionStages } from "./compaction-panel"
import { appearancePage } from "./appearance-layout"
import { panelGrid } from "./deck"
import { renderMarkdown, wrapSpans } from "./markdown"
import { textWidth } from "./wrap"
import type { TuiProfile } from "./tui-profile"

export type CompactionView = { turnId?: TurnId; expanded: boolean; scroll: number; editing: boolean; editor: ReturnType<typeof createEditor>; error?: string | undefined }

export function renderCompactionPage(input: { data?: Compaction; state: CompactionView; profile: TuiProfile; readOnly: boolean; width: number; height: number }): { rows: Line[]; cursor?: { row: number; col: number } } {
  const { data, state, profile, width, height } = input
  const inner = Math.max(4, width - 4)
  const room = Math.max(4, height - 2)
  const compact = width < 70
  if (!data) return { rows: appearancePage({ title: "Compaction", hints: "esc back", body: panelGrid({ rows: [[{ title: "Memory", body: [[{ text: "No compaction in the loaded history", fg: "muted" }]] }]], width: inner, heights: [room], compact: false, padding: true }), width, height }) }
  const writing = data.state === "writing"
  const editable = writing && !input.readOnly && profile.compactionScratchpad
  const editing = state.editing && editable
  const scratch = profile.compactionScratchpad && (writing || !!data.followUp)
  const scratchWidth = inner - 4
  state.editor.setVisualWidth(Math.max(1, scratchWidth - 1))
  const visual = state.editor.visualLines()
  const cursorAt = Math.max(0, visual.findLastIndex((line) => line.start <= state.editor.cursorOffset))
  const topHeight = compact ? 0 : scratch ? Math.max(8, Math.floor((room - 1) * .6)) : room
  const scratchHeight = compact ? room : room - topHeight - 1
  const stages = profile.compactionProgress ? compactionStages(data) : []
  const memoryTitle: Line = [{ text: `${state.expanded ? "▾" : "▸"} Compacted memory · ${data.state}`, fg: "primary" }]
  const summaryRoom = compact && scratch ? Math.min(3, Math.max(1, room - stages.length - 9)) : compact ? Math.max(1, room - stages.length - 7) : Math.max(1, topHeight - 5)
  const summary = (w: number): Line[] => {
    if (!state.expanded) return []
    const lines = data.summary ? renderMarkdown(data.summary, w) : [[{ text: writing ? "Writing summary…" : "No summary", fg: "muted" as const }]]
    state.scroll = Math.max(0, Math.min(state.scroll, lines.length - summaryRoom))
    return lines.slice(state.scroll, state.scroll + summaryRoom)
  }
  const compactHead: Line[] = compact ? [...stages, ...(stages.length ? [[]] : []), memoryTitle, ...summary(scratchWidth), []] : []
  const noteRows = Math.max(1, scratchHeight - 5 - compactHead.length - (state.error ? 2 : 0))
  const first = Math.max(0, cursorAt - noteRows + 1)
  const note: Line[] = editing ? visual.slice(first, first + noteRows).map((line, index) => [{ text: line.text, fg: "text" }, ...(visual.length > noteRows ? [{ text: " ".repeat(Math.max(0, scratchWidth - 1 - textWidth(line.text))) }, { text: first + index === cursorAt ? "┃" : "│", fg: "primary" as const }] : [])]) : data.followUp.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" }], scratchWidth)).slice(0, noteRows)
  const scratchBody: Line[] = [...compactHead, ...(scratch ? [[{ text: editing ? "Typing · autosave" : data.followUpQueueId ? "Follow-up queued" : editable ? "e edit follow-up" : input.readOnly && writing ? "Read-only terminal" : "Saved follow-up", fg: "muted" as const }], ...note] : []), ...(state.error ? [[], ...wrapSpans([{ text: state.error, fg: "error" }], scratchWidth)] : [])]
  const body = panelGrid({ rows: compact ? [[{ title: compactionHeading(data.state), body: scratchBody, active: editing }]] : [
    [{ title: `Progress · ${data.idle ? "idle" : data.reason}`, body: stages, weight: 1 }, { title: compactionHeading(data.state), body: (w) => [memoryTitle, ...summary(w)], weight: 2 }],
    ...(scratch ? [[{ title: writing ? "Scratchpad" : "Follow-up", body: scratchBody, active: editing }]] : []),
  ], width: inner, heights: compact ? [room] : scratch ? [topHeight, scratchHeight] : [room], compact: false, padding: true, maxColumns: compact ? 1 : 2 })
  const hints = editing ? "arrows move · enter newline · esc leave" : width < 110 ? `${editable ? "e edit · " : ""}m fold · ↑↓ · esc back` : `${editable ? "e edit · " : ""}m memory · ↑↓ scroll · [ ] previous/next · esc back`
  const rows = appearancePage({ title: "Compaction", hints, body, width, height })
  if (!editing) return { rows }
  const current = visual[cursorAt]!
  const before = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current.text)].slice(0, state.editor.cursorOffset - current.start).map((cell) => cell.segment).join("")
  return { rows, cursor: { row: 2 + (compact ? 0 : topHeight + 1) + 3 + compactHead.length + cursorAt - first, col: Math.min(width - 4, 4 + textWidth(before)) } }
}
