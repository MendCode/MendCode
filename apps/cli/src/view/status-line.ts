import type { ForegroundState } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/** The prompt status line (`promptStatus: border`): `READY › model › effort › repo › branch › ctx 42%`, drawn in the prompt's top rule. */
export type StatusLineInput = {
  /** The foreground state's label ("ready", "generating", "needs answer"). */
  stateLabel: string
  state: ForegroundState
  model?: string
  effort?: string
  repo?: string
  branch?: string
  /** Context used, as a percent of the compaction threshold. */
  contextPercent?: number
  /** "ctx" when the percent is of the engine's own window (it compacts by itself) rather than of MendCode's compaction threshold. */
  contextLabel?: "ctx"
  /** The engine's figures disagreed and the context was clamped: the percent is drawn `~N%`. */
  contextApprox?: boolean
  glyphs: Glyphs
}

const BUSY = new Set<ForegroundState>(["generating", "tool", "compacting", "cancelling"])

function stateColor(state: ForegroundState): ColorName {
  return state === "error" ? "error" : BUSY.has(state) ? "primary" : state === "idle" ? "success" : "warning"
}

function contextColor(percent: number): ColorName {
  return percent >= 85 ? "error" : percent >= 60 ? "warning" : "success"
}

/** The pieces in order; each a span group. Fewer drop from the end (context and state last) when `width` is short. */
export function statusLineSpans({ stateLabel, state, model, effort, repo, branch, contextPercent, contextLabel, contextApprox, glyphs }: StatusLineInput, width: number): Line {
  const arrow = glyphs.rule === "-" ? ">" : "›"
  const parts: Array<{ keep: number; spans: Span[] }> = [
    { keep: 9, spans: [{ text: stateLabel.toUpperCase(), fg: stateColor(state), bold: true }] },
    ...(model ? [{ keep: 6, spans: [{ text: model, fg: "text" as const }] }] : []),
    ...(effort ? [{ keep: 3, spans: [{ text: effort, fg: "muted" as const }] }] : []),
    ...(repo ? [{ keep: 4, spans: [{ text: repo, fg: "body" as const }] }] : []),
    ...(branch ? [{ keep: 5, spans: [{ text: branch, fg: "secondary" as const }] }] : []),
    ...(contextPercent !== undefined ? [{ keep: 8, spans: [{ text: `${contextLabel ?? "compact"} ${contextApprox ? "~" : ""}${contextPercent}%`, fg: contextColor(contextPercent) }] }] : []),
  ]
  const join = (items: typeof parts): Line => items.flatMap((part, index) => (index ? [{ text: ` ${arrow} `, fg: "muted" as const }, ...part.spans] : part.spans))
  const total = (items: typeof parts) => join(items).reduce((sum, span) => sum + textWidth(span.text), 0)
  let kept = parts
  while (kept.length > 1 && total(kept) > width) {
    const lowest = Math.min(...kept.map((part) => part.keep))
    kept = kept.filter((part, index) => index !== kept.findLastIndex((candidate) => candidate.keep === lowest))
  }
  const line = join(kept)
  if (total(kept) <= width) return line
  // Even the state alone is wider than the room: cut it.
  const only = line[0]!
  return [{ ...only, text: truncateEnd(only.text, Math.max(0, width)) }]
}

/**
 * A prompt rule with `status` laid over it, `offset` cells in and a space either side. `rule` is a single row of uniform
 * single-width glyphs (the prompt's top rule or a box edge); anything wider than the room after `offset` is cut off.
 */
export function overlayRule(rule: Line, status: Line, offset: number): Line {
  const cells: Array<{ char: string; span: Span }> = rule.flatMap((span) => [...span.text].map((char) => ({ char, span })))
  const room = cells.length - offset - 4
  if (room < 1 || status.length === 0) return rule
  const statusWidth = status.reduce((sum, span) => sum + textWidth(span.text), 0)
  const fitted = statusWidth <= room ? status : [{ ...status[0]!, text: truncateEnd(status[0]!.text, room) }]
  const width = fitted.reduce((sum, span) => sum + textWidth(span.text), 0)
  const regroup = (items: typeof cells): Line => {
    const out: Line = []
    for (const { char, span } of items) {
      const last = out[out.length - 1]
      if (last && last.fg === span.fg && last.bg === span.bg && last.dim === span.dim && last.bold === span.bold) last.text += char
      else out.push({ ...span, text: char })
    }
    return out
  }
  const ruleSpan = cells[offset]?.span ?? rule[0]!
  return [
    ...regroup(cells.slice(0, offset)),
    { ...ruleSpan, text: " " },
    ...fitted,
    { ...ruleSpan, text: " " },
    ...regroup(cells.slice(offset + width + 2)),
  ]
}

/**
 * `rule` with `notice` laid over its right end, three rule cells from the edge and a space either side, as a title sits on a
 * rule. Left as it is when the notice would reach what is already laid over its left part.
 */
export function ruleRight(rule: Line, notice: Line): Line {
  const cells = rule.flatMap((span) => [...span.text])
  const width = notice.reduce((sum, span) => sum + textWidth(span.text), 0)
  // The rule ends at its last visible cell (the row may carry margins); a box's top ends in a corner past the rule glyph.
  let end = cells.length - 1
  while (end >= 0 && cells[end] === " ") end--
  if (end < 1) return rule
  const last = cells[end] === cells[end - 1] ? end : end - 1
  const edge = cells[last]
  const offset = last + 1 - width - 2 - 3
  // The last cell that is not the rule glyph: a status or notice already over the rule ends there.
  let used = last
  while (used >= 0 && cells[used] === edge) used--
  if (offset - 1 <= used) return rule
  return overlayRule(rule, notice, offset)
}
