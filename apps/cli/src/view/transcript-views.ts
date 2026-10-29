import type { CompactionCardModel, ToolRowModel, TurnStatusModel } from "@mendcode/extension-api/views"
import type { Glyphs, Line } from "../ui/theme"
import { errorBox, statusLine, type TurnEnd } from "./chat-blocks"
import { renderCompactionPanel, type Compaction } from "./compaction-panel"
import { fit } from "./deck"
import { goalCardRows, type GoalCard } from "./goal"
import { renderMarkdown, wrapSpans } from "./markdown"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "./tui-profile"
import { limitCardLine, limitCardRows, type LimitCard } from "./usage-limit"
import { textWidth, truncateEnd } from "./wrap"

/**
 * The built-in renderers of `compaction.card`, `turn.status` and `tool.row` as pure functions of their input model
 * (docs/views.md). The transcript builds the model from a block and draws it through the view host.
 */

const INDENT = "  "
type Sized<M> = M & { width: number }

export function compactionRows(m: Sized<CompactionCardModel>): Line[] {
  const data = { turnId: m.turnId, reason: m.reason, ...(m.idle ? { idle: true as const } : {}), state: m.state, followUp: m.followUp, followUpQueueId: m.followUpQueueId, summary: m.summary, method: m.method, tailTurns: m.tailTurns, tailTokens: m.tailTokens, fallbackReason: m.fallbackReason, ...(m.cachedPrefix ? { cachedPrefix: true as const } : {}) } as unknown as Compaction
  const profile: TuiProfile = { ...DEFAULT_TUI_PROFILE, compactionStyle: m.style as TuiProfile["compactionStyle"], presentation: m.presentation as TuiProfile["presentation"], compactionProgress: m.progress, compactionScratchpad: m.scratchpad }
  return renderCompactionPanel({ data, profile, width: m.width, expanded: m.expanded, summaryRows: m.expanded ? renderMarkdown(m.summary, Math.max(1, m.width - 4)) : [] })
}

export function turnStatusRows(m: Sized<TurnStatusModel>, g: Glyphs): Line[] {
  const { width } = m
  if (m.variant === "checkpoint") return [fit([{ text: "  checkpoint saved · subscription limit near", fg: "muted", dim: true }], width)]
  if (m.variant === "goal") return goalCardRows(m.goal as unknown as GoalCard, width)
  if (m.variant === "limit") return m.mode === "minimal" ? limitCardLine(m.limit as unknown as LimitCard, width) : limitCardRows(m.limit as unknown as LimitCard, width)
  if (m.variant === "note") return m.cacheNotices ? wrapSpans([{ text: `${g.rule.repeat(2)} ${m.note}`, fg: "muted", dim: true }], width, [{ text: INDENT }]) : []
  if (m.variant === "undone") {
    const count = m.undone ?? 0
    const label = ` undone · ${count} message${count === 1 ? "" : "s"} `
    const tail = Math.max(0, Math.min(width - INDENT.length - 2 - label.length, 10))
    return [[{ text: INDENT }, { text: g.rule.repeat(2), fg: "border" }, { text: label, fg: "muted", dim: true }, { text: g.rule.repeat(tail), fg: "border" }]]
  }
  const ended = m.end as unknown as TurnEnd | undefined
  if (!ended) return []
  const end = m.time ? { ...ended, doneAt: m.time } : ended
  const glyphs = { ...g, done: m.done }
  if (m.meta === "off") return end.error ? errorBox(end.error, width, g) : end.outcome === "completed" || end.outcome === "paused" ? [] : [[{ text: `  ${end.outcome}`, fg: "warning" }]]
  if (m.meta === "compact") {
    const { model: _model, agent: _agent, ...compact } = end
    return [...(end.error ? [...errorBox(end.error, width, g), []] : []), ...statusLine(compact, width, glyphs, INDENT)]
  }
  if (m.mode === "minimal") {
    const line = statusLine(end, width, glyphs).map((row) => row.map((span) => ({ ...span, dim: true })))
    return end.error ? [...wrapSpans([{ text: `${g.fail} ${end.error.message.split("\n")[0]}`, fg: "error" }], width, [{ text: INDENT }]).slice(0, 3), ...line] : line
  }
  return [...(end.error ? [...errorBox(end.error, width, g), []] : []), ...statusLine(end, width, glyphs, `${INDENT} `, m.mode === "full")]
}

export function toolRows(m: Sized<ToolRowModel>, g: Glyphs): Line[] {
  const { width } = m
  if (m.variant === "memory" || m.variant === "orientation") {
    // One muted row; the hint (`/memory undo`, `click or ctrl+o to open`) sits at its right edge, or follows the text when the row has no room to spare.
    const hint = m.hint ?? ""
    const opened = m.variant === "memory" && m.open && m.detail ? wrapSpans([{ text: m.detail, fg: "muted" }], width, [{ text: INDENT }]) : []
    // A note without a hint (an update, a removal, a save from an older daemon) is the plain muted text, as before.
    if (!hint) return [...wrapSpans([{ text: m.text, fg: "muted", dim: true }], width), ...opened]
    const text = truncateEnd(m.text, Math.max(10, width - textWidth(hint) - 3))
    const spare = width - textWidth(text) - textWidth(hint)
    const row: Line = [{ text, fg: "muted", dim: true }, { text: " ".repeat(Math.max(3, spare)) + hint, fg: "muted", dim: true }]
    return [row, ...opened]
  }
  if (m.variant === "images") return wrapSpans([{ text: `■ ${m.images ?? 0} image${m.images === 1 ? "" : "s"}${m.where ?? ""}`, fg: "muted" }], width, [{ text: INDENT }])
  if (m.variant === "plan") {
    const done = m.status === "ok" ? [{ text: ` ${g.ok} approved`, fg: "success" as const }] : m.status === "running" ? [{ text: " review", fg: "warning" as const }] : [{ text: " changes requested", fg: "warning" as const }]
    return [[{ text: `${g.tool} `, fg: "heading" }, { text: "plan", fg: "heading", bold: true }, ...done], ...renderMarkdown(m.text, Math.max(10, width - INDENT.length)).map((line): Line => [{ text: INDENT }, ...line])]
  }
  if (m.folded) return []
  const state = m.status === "running" ? { text: ` ${g.running}`, fg: "warning" as const } : m.status === "ok" ? { text: ` ${g.ok}`, fg: "success" as const } : { text: ` ${g.fail} ${m.status}`, fg: "error" as const }
  const count = m.run > 1 ? [{ text: `${m.run} tools · `, fg: "muted" as const, dim: true }] : []
  return wrapSpans([...count, { text: m.title ?? "tool", fg: "muted" }, state, ...(m.reason ? [{ text: ` · ${m.reason.trim()}`, fg: "error" as const }] : [])], width, [{ text: `${g.tool} `, fg: "muted" }])
}
