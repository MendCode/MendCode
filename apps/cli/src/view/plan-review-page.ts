import type { PlanReviewRecord } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { columns, fit, panelGrid, spread } from "./deck"
import { renderMarkdown, wrapSpans } from "./markdown"
import { createEditor, graphemes } from "./editor"
import { textWidth } from "./wrap"

export type PlanStage = "preview" | "edit" | "comments" | "reject"
export type PlanDraft = {
  id: string
  stage: PlanStage
  markdown: string
  comments: string
  destination: string
  scroll: number
  editor: ReturnType<typeof createEditor>
  note: string
}

export function renderPlanReviewPage(input: { record: PlanReviewRecord; draft: PlanDraft; pending: boolean; width: number; height: number; index: number; count: number }): { rows: Line[]; cursor?: { row: number; col: number } } {
  const { record, draft, pending, width, height } = input
  const compact = width < 70
  const editing = draft.stage !== "preview"
  const room = Math.max(4, width - 4)
  const weight = width < 110 ? 2 : 3
  const side = compact ? 0 : columns(room, [weight, 1])[1]!
  const main = compact ? room : room - side - 1
  const textRoom = compact ? main : main - 4
  draft.editor.setVisualWidth(textRoom)
  const primary = record.phase === "plan" ? "accept" : "apply"
  const hints = !pending ? "←→ review · ↑↓ scroll · esc back" : draft.stage === "preview" ? width < 90 ? `↵ ${primary} · e edit · c notes · r reject · esc` : `enter ${primary} · a accept · e edit · c comments · r reject · t agent · esc close` : draft.stage === "reject" ? "enter reject · esc preview" : `ctrl-o ${primary} · ctrl-s save · esc preview`
  const status = pending ? "Pending" : record.reply?.action ?? "Interrupted"
  const meta: Line[] = [
    [{ text: "Status  ", fg: "primary" }, { text: status, fg: "text" }],
    [{ text: "Phase   ", fg: "primary" }, { text: record.phase, fg: "text" }],
    [{ text: "Agent   ", fg: "primary" }, { text: draft.destination, fg: "text" }],
  ]
  if (draft.comments) meta.push([{ text: "Comments  ", fg: "primary" }, { text: `${draft.comments.length} chars`, fg: "text" }])
  if (record.reply?.reason) meta.push([{ text: "Reason  ", fg: "primary" }, { text: `${record.reply.reason.length} chars`, fg: "text" }])
  if (record.phase === "plan") meta.push([], [{ text: "Planning only", fg: "warning" }])
  const reviewBody = meta.flatMap((line) => wrapSpans(line, Math.max(4, compact ? room : side - 4)))
  const panelsHeight = Math.max(4, height - 4)
  const mainHeight = compact ? Math.max(3, panelsHeight - Math.min(7, reviewBody.length + 2) - 1) : panelsHeight
  const visible = Math.max(1, mainHeight - (compact ? 2 : 4))
  const visual = draft.editor.visualLines()
  let cursorRow = visual.findLastIndex((row) => row.start <= draft.editor.cursorOffset)
  cursorRow = Math.max(0, cursorRow)
  const body = editing ? visual.map((row) => [{ text: row.text, fg: "text" as const }]) : renderMarkdown([draft.markdown.replace(/^\s*#\s+[^\n]+\n{1,2}/, ""), ...(draft.comments ? [`## Implementation comments\n\n${draft.comments}`] : []), ...(record.reply?.reason ? [`## Rejection reason\n\n${record.reply.reason}`] : [])].join("\n\n"), textRoom)
  if (editing) draft.scroll = Math.min(draft.scroll, cursorRow)
  if (editing && cursorRow >= draft.scroll + visible) draft.scroll = cursorRow - visible + 1
  draft.scroll = Math.max(0, Math.min(draft.scroll, body.length - visible))
  const title = draft.stage === "preview" ? record.title || "Plan" : draft.stage === "edit" ? "Edit plan" : draft.stage === "comments" ? "Implementation comments" : "Reject reason"
  const groups = compact ? [[{ title, body: body.slice(draft.scroll, draft.scroll + visible), active: true }], [{ title: "Review", body: reviewBody }]] : [[{ title, body: body.slice(draft.scroll, draft.scroll + visible), weight, active: true }, { title: "Review", body: reviewBody, weight: 1 }]]
  const grid = panelGrid({ rows: groups, width: room, heights: compact ? [mainHeight, panelsHeight - mainHeight - 1] : [panelsHeight], compact, padding: !compact })
  const header: Line = [{ text: `${width < 90 ? "Plan" : "Plan review"}${input.count > 1 ? ` · ${input.index + 1}/${input.count}` : ""}`, fg: "primary", bold: true }]
  // Keep a single header hint row even on a narrow terminal.
  const rows: Line[] = [spread(header, [{ text: hints, fg: "muted" }], width), [], ...grid.map((row) => [{ text: "  " }, ...row]), [{ text: draft.note || (body.length > visible ? `${draft.scroll + 1}–${Math.min(body.length, draft.scroll + visible)} / ${body.length}` : ""), fg: draft.note ? "warning" : "muted" }]]
  while (rows.length < height) rows.push([])
  const cursor = editing ? { row: 2 + 2 + cursorRow - draft.scroll, col: 2 + (compact ? 0 : 2) + textWidth(graphemes(draft.editor.text).slice(visual[cursorRow]!.start, draft.editor.cursorOffset).join("")) } : undefined
  return { rows: rows.slice(0, height).map((row) => fit(row, width)), ...(cursor ? { cursor: { row: Math.min(height - 1, cursor.row), col: Math.min(width - 1, cursor.col) } } : {}) }
}
