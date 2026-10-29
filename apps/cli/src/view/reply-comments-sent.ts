import type { UserMessageModel } from "@mendcode/extension-api/views"
import type { Glyphs, Line, Span } from "../ui/theme"
import { fit } from "./deck"
import { CHIP_MIN_QUOTE, quoteLabel, REPLY_KEYS, REPLY_MARKS, type ReplyKeys } from "./reply-comments-view"
import { lineWidth, textWidth, wrap } from "./wrap"

/**
 * The sent message of the reply-comments feature as the transcript draws it (docs/editor.md): what the user typed first, as an ordinary
 * message, then each quote and its comment as one numbered pair (the numbers of the chips and the margin marks). The `commentSentLayout`
 * setting picks the form: `rail` (a count line, the pairs on a rail under it; the default), `stack` (a blank row, then the quote over
 * its comment) or `inline` (`1 “quote” → comment` on one row when it fits). The quotes are folded to a line each; `expanded` (ctrl+o) opens them. The key hint is
 * chrome: muted, at the right, and only while there is something to open.
 */

type Sent = NonNullable<UserMessageModel["comments"]>
type SentComment = Sent["comments"][number]

/** Between a quote and its comment on one row. */
const THEN = " → "
const flat = (text: string) => text.replace(/\s+/g, " ").trim()
const rowsOf = (text: string, room: number) => text.split("\n").flatMap((line) => wrap(line || " ", Math.max(1, room)))
const spaces = (count: number): Span => ({ text: " ".repeat(Math.max(0, count)) })

/** The pairs of one message, and whether opening them would show more than is drawn. */
type Pairs = { rows: Line[]; hidden: boolean }
type PairsInput = { comments: Sent["comments"]; room: number; expanded: boolean; /** The bar behind an opened quote. */ bar: string }

/** What the folded form leaves out of a quote: words past the row, the line breaks, and the part cut before it was sent. */
const hides = (comment: SentComment, shown: number) => comment.cut > 0 || /\n/.test(comment.quote.trim()) || textWidth(flat(comment.quote)) + 2 > shown

/** The number column: the number, an arrow after it when the passage is in an older answer (as on the chips), then a space to `width`. */
const markOf = (comment: SentComment) => `${comment.n}${comment.of === "earlier answer" ? REPLY_MARKS.up : ""}`
const numberCell = (comment: SentComment, width: number): Span[] => [{ text: markOf(comment), fg: "commentMark", bold: true }, spaces(width - textWidth(markOf(comment)))]
const columnOf = (comments: Sent["comments"]) => Math.max(...comments.map((comment) => textWidth(markOf(comment)))) + 1

/** A quote opened: every line of it behind a bar, then what was cut from it. The number rides the first row. */
function openQuote({ comment, lead, room, bar }: { comment: SentComment; lead: number; room: number; bar: string }): Line[] {
  const behind: Span = { text: `${bar} `, fg: "muted" }
  const rows: Line[] = rowsOf(comment.quote, room - lead - behind.text.length).map((row, index) => [...(index === 0 ? numberCell(comment, lead) : [spaces(lead)]), behind, { text: row, fg: "commentQuote" }])
  if (comment.cut) rows.push([spaces(lead), behind, { text: `${comment.cut} more characters not sent`, fg: "muted", dim: true }])
  return rows
}

/** `stack` and `rail`: the number and the quote, the comment under the quote at the quote's column. */
function twoRowPairs({ comments, room, expanded, bar }: PairsInput): Pairs {
  const lead = columnOf(comments)
  const inner = room - lead
  const rows: Line[] = []
  let hidden = false
  for (const comment of comments) {
    if (expanded) rows.push(...openQuote({ comment, lead, room, bar }))
    else {
      hidden ||= hides(comment, inner)
      rows.push([...numberCell(comment, lead), { text: quoteLabel(comment.quote, inner), fg: "commentQuote" }])
    }
    for (const row of rowsOf(comment.text, inner)) rows.push([spaces(lead), { text: row, fg: "text" }])
  }
  return { rows, hidden }
}

/**
 * `inline`: `1 “quote” → comment` on one row while the quote keeps `collapse` cells (or all of it, when it is shorter), else the quote
 * with `→ comment` under it. The arrows of the pairs that fit line up on the widest quote shown.
 */
function inlinePairs({ comments, room, expanded, collapse, bar }: PairsInput & { collapse: number }): Pairs {
  const lead = columnOf(comments)
  const inner = Math.max(1, room - lead)
  const natural = comments.map((comment) => textWidth(flat(comment.quote)) + 2)
  // The cells each pair has for its quote when the comment shares the row.
  const share = comments.map((comment) => inner - textWidth(THEN) - textWidth(flat(comment.text)))
  const oneRow = comments.map((comment, index) => !expanded && !comment.text.includes("\n") && share[index]! >= Math.min(natural[index]!, collapse))
  const column = Math.max(0, ...comments.map((_, index) => (oneRow[index] ? Math.min(natural[index]!, share[index]!) : 0)))
  const rows: Line[] = []
  let hidden = false
  comments.forEach((comment, index) => {
    if (oneRow[index]) {
      const shown = Math.min(natural[index]!, share[index]!)
      hidden ||= hides(comment, shown)
      rows.push([...numberCell(comment, lead), { text: quoteLabel(comment.quote, shown), fg: "commentQuote" }, spaces(Math.min(column - shown, share[index]! - shown)), { text: THEN, fg: "muted" }, { text: flat(comment.text), fg: "text" }])
      return
    }
    if (expanded) rows.push(...openQuote({ comment, lead, room, bar }))
    else {
      hidden ||= hides(comment, inner)
      rows.push([...numberCell(comment, lead), { text: quoteLabel(comment.quote, inner), fg: "commentQuote" }])
    }
    rowsOf(comment.text, inner - 2).forEach((row, at) => rows.push([spaces(lead), { text: at === 0 ? "→ " : "  ", fg: "muted" }, { text: row, fg: "text" }]))
  })
  return { rows, hidden }
}

/** `3 comments`, and how many of them are on an older answer. */
function summary(comments: Sent["comments"]) {
  const earlier = comments.filter((comment) => comment.of === "earlier answer").length
  return `${comments.length} ${comments.length === 1 ? "comment" : "comments"}${earlier ? ` · ${earlier}${REPLY_MARKS.up} earlier` : ""}`
}

/** The first of `forms` that fits at the right of the last row (two cells apart) or, failing that, on a row of its own. */
function placeMeta(rows: Line[], forms: readonly string[], room: number) {
  const last = rows.at(-1)
  const used = last ? lineWidth(last) : room
  const beside = forms.find((form) => used + 2 + textWidth(form) <= room)
  if (beside !== undefined && last) {
    rows[rows.length - 1] = [...last, spaces(room - used - textWidth(beside)), { text: beside, fg: "muted" }]
    return
  }
  const alone = forms.find((form) => textWidth(form) <= room)
  if (alone !== undefined) rows.push([spaces(room - textWidth(alone)), { text: alone, fg: "muted" }])
}

/**
 * The sent message the way the transcript draws it. The model's `layout` (the `commentSentLayout` setting; `rail` when it carries none)
 * and `collapse` (`commentCollapse`) shape the pairs. What came before the comments in the message (`head`) and after them (`tail`)
 * is shown as it is.
 */
export function sentRows({ parsed, width, style, expanded, keys = REPLY_KEYS }: { parsed: Sent; width: number; style: UserMessageModel["style"]; expanded: boolean; keys?: Pick<ReplyKeys, "expand"> }, g: Glyphs): Line[] {
  const prefix = [style.icon, style.lead, style.label].filter(Boolean).join(" ")
  const lead = prefix ? `${prefix} ` : ""
  const room = Math.max(1, width - textWidth(lead))
  const layout = parsed.layout ?? "rail"
  const body: Line[] = []
  const text = (value: string | undefined, fg: "text" | "muted") => { for (const row of value ? rowsOf(value, room) : []) body.push([{ text: row, fg }]) }
  text(parsed.head, "muted")
  text(parsed.note, "text")
  if (parsed.comments.length) {
    // The pairs hang under the message as an attachment, set apart from it: a blank row (stack), a count line and a rail (rail),
    // or two cells in (inline). With no message they start at the lead.
    const message = body.length > 0
    const inset: Span[] = layout === "rail" ? [{ text: `${g.rail} `, fg: "commentRule" }] : layout === "inline" && message ? [spaces(2)] : []
    const input = { comments: parsed.comments, room: room - lineWidth(inset), expanded, bar: layout === "rail" ? g.track : g.rail }
    const { rows, hidden } = layout === "inline" ? inlinePairs({ ...input, collapse: parsed.collapse ?? CHIP_MIN_QUOTE }) : twoRowPairs(input)
    const hint = hidden && !expanded ? `${keys.expand} quotes` : ""
    if (layout === "stack" && message) body.push([])
    if (layout === "rail") {
      // The count heads the rail; the key hint rides the same line.
      const count = summary(parsed.comments)
      const gap = room - textWidth(count) - textWidth(hint)
      body.push([{ text: count, fg: "muted" }, ...(hint && gap >= 2 ? [spaces(gap), { text: hint, fg: "muted" } as Span] : [])])
    }
    body.push(...rows.map((row): Line => [...inset, ...row]))
    if (hint && layout !== "rail") placeMeta(body, [`${summary(parsed.comments)} · ${hint}`, hint], room)
  }
  text(parsed.tail, "muted")
  return body.map((row, index): Line => {
    const spans: Line = [{ text: index === 0 ? lead : " ".repeat(textWidth(lead)), fg: "primary" }, ...row]
    return style.tint ? fit(spans, width).map((span) => ({ ...span, bg: span.bg ?? ("promptBg" as const) })) : spans
  })
}
