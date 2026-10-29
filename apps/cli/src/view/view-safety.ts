import type { ApprovalModel, QuestionModel, ViewModels, ViewSlot } from "@mendcode/extension-api/views"
import type { Glyphs, Line } from "../ui/theme"
import { wrapSpans } from "./markdown"

/**
 * What a custom view is never allowed to change (docs/views.md, "Safety rules"). A view restyles; the terminal keeps the
 * keys, the real options and the text being approved. These rules run on a custom view's output only.
 */

const MAX_SUBJECT = 400
const plain = (line: Line) => line.map((span) => span.text).join("")
/** Text without any whitespace, so a view may wrap, indent or re-flow what it shows and still be found. */
const compactText = (text: string) => text.replace(/\s+/g, "")

/** Whether `needle` appears in the lines as written (rows may wrap it anywhere). */
export const shows = (lines: readonly Line[], needle: string) => {
  const target = compactText(needle)
  return target === "" || compactText(lines.map(plain).join("\n")).includes(target)
}

/** The part of an approval a custom view must show: the exact text being approved (the first 400 characters of a longer one). */
export const approvalSubject = (subject: string) => subject.slice(0, MAX_SUBJECT)

/**
 * What `secure` did to a view's rows: the rows it returns, and how the view's own rows moved. A row `r` of the view is row
 * `r + offset` of `lines` and is gone when `r >= kept`, so a hit region follows its text (see `rebase`).
 */
export type Secured = { lines: Line[]; offset: number; kept: number }

/** The view's hit regions moved to where their rows ended up; those on rows the safety rules removed are dropped. */
export const rebase = <T extends { row: number }>(hits: readonly T[], secured: Secured): T[] =>
  hits.filter((hit) => hit.row < secured.kept).map((hit) => ({ ...hit, row: hit.row + secured.offset }))

/** Rows a view of `slot` may not remove: the approval's subject, the question's text. The options are the terminal's (`hostOptions`). */
export function secure(slot: ViewSlot, model: unknown, lines: Line[], at: { height: number; width: number }, g: Glyphs): Secured {
  if (slot === "approval") return secureApproval(model as ApprovalModel, lines, at, g)
  if (slot === "question") return secureQuestion(model as QuestionModel, lines, at, g)
  if (slot === "page") return secureEscape(lines, at.height)
  return { lines, offset: 0, kept: lines.length }
}

/** A page always says how to leave it: when the drawn rows have no `esc` hint one is added (replacing the last row only when the page is full). */
function secureEscape(lines: Line[], height: number): Secured {
  if (lines.some((line) => /\besc\b/i.test(plain(line)))) return { lines, offset: 0, kept: lines.length }
  const hint: Line = [{ text: "esc back", fg: "muted" }]
  if (lines.length < height) return { lines: [...lines, hint], offset: 0, kept: lines.length }
  const kept = Math.max(0, height - 1)
  return { lines: [...lines.slice(0, kept), hint], offset: 0, kept }
}

/** `lines` made to fit `height` rows under `head` rows the terminal puts first. */
function squeeze(lines: Line[], head: Line[], height: number): Secured {
  const room = Math.max(0, height - head.length)
  const out = [...head, ...lines.slice(0, room)].slice(0, Math.max(1, height))
  return { lines: out, offset: head.length, kept: Math.max(0, Math.min(lines.length, room, out.length - head.length)) }
}

function secureApproval(m: ApprovalModel, lines: Line[], at: { height: number; width: number }, g: Glyphs): Secured {
  const subject = approvalSubject(m.subject)
  const head: Line[] = shows(lines, subject) ? [] : [...wrapSpans([{ text: subject, fg: "warning", bold: true }], Math.max(10, at.width), [{ text: `${g.ask} `, fg: "warning", bold: true }], [{ text: "  " }]).slice(0, 6), ...(m.subject.length > MAX_SUBJECT ? [[{ text: `  … ${m.subject.length - MAX_SUBJECT} more characters`, fg: "muted" as const }]] : [])]
  return head.length ? squeeze(lines, head, at.height) : { lines, offset: 0, kept: lines.length }
}

function secureQuestion(m: QuestionModel, lines: Line[], at: { height: number; width: number }, g: Glyphs): Secured {
  // A batch is one panel the terminal draws whole, the question text included.
  const asks = m.variant === "batch" ? "" : m.title
  const head: Line[] = asks && !shows(lines, asks.slice(0, MAX_SUBJECT)) ? wrapSpans([{ text: asks.slice(0, MAX_SUBJECT), fg: "text", bold: true }], Math.max(10, at.width), [{ text: `${g.ask} `, fg: "warning", bold: true }], [{ text: "  " }]).slice(0, 4) : []
  return head.length ? squeeze(lines, head, at.height) : { lines, offset: 0, kept: lines.length }
}

/** Whether `arg` is a valid target for `action` of this slot's current input; a view naming anything else is invalid output. `approval` and `question` have no actions: their options belong to the terminal. */
export function validArgFor(slot: ViewSlot, model: unknown, action: string, arg: string | number | undefined): boolean {
  const index = (limit: number) => typeof arg === "number" && Number.isInteger(arg) && arg >= 0 && arg < limit
  switch (slot) {
    case "home": return action === "open" && typeof arg === "string" && (model as ViewModels["home"]).sessions.some((session) => session.id === arg)
    case "slash.menu": return action === "select" && index((model as ViewModels["slash.menu"]).items.length)
    case "sessions.sidebar": return action === "open" && typeof arg === "string" && (model as ViewModels["sessions.sidebar"]).sessions.some((session) => session.sessionId === arg)
    case "notice": {
      const m = model as ViewModels["notice"]
      if (arg !== undefined) return false
      if (m.kind === "queue") return action === "send"
      return m.kind === "limit" && m.chips.some((chip) => chip.action === action)
    }
    case "file.viewer": {
      const m = model as ViewModels["file.viewer"]
      if (action === "line") return typeof arg === "number" && m.rows.some((row) => row.line === arg && !row.pending)
      if (action === "entry") return typeof arg === "number" && Number.isInteger(arg) && arg >= 0 && arg < (m.entries?.length ?? 0)
      return arg === undefined && (action === "switch" ? m.panel : ["close", "open", "ask", "copy"].includes(action))
    }
    case "tool.card": return arg === undefined && (action === "toggle" || (action === "page" && (model as ViewModels["tool.card"]).level === "full"))
    default: return false
  }
}
