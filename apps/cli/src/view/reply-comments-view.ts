import { DEFAULT_BINDINGS, inlineKeyNames, type KeyAction } from "../ui/keymap"
import type { Glyphs, Line, Span } from "../ui/theme"
import { fit } from "./deck"
import { PROMPT_MARGIN } from "./prompt-chrome"
import type { ReplyComment, ReplyUnit } from "./reply-comments"
import { overlayAt } from "./scroll-chrome"
import { lineWidth, textWidth, truncateEnd } from "./wrap"

/**
 * The rows of the reply-comments feature (docs in `reply-comments.ts`): the hint, the compose header, the chip row, the list, the
 * reply-mode bar and gutter marks (the sent message is `reply-comments-sent.ts`). Pure functions of their input and the theme roles, drawn from the
 * same primitives the rest of the chrome uses (`fit`, `overlayAt`, the prompt margin). The keys they name come from the caller (the
 * bindings in force), so the copy never drifts from what a key does; `REPLY_KEYS` are the defaults.
 */

/** The first default key of a binding, as the keymap names it. */
const defaultKey = (action: KeyAction): string => inlineKeyNames(DEFAULT_BINDINGS, action)[0] ?? ""

/** The default key names the copy uses. `comment` and `list` are bindings (`selection.comment`, `comment.list`), read from the keymap's defaults; the rest are fixed by the mode they belong to. */
export const REPLY_KEYS = { comment: defaultKey("selection.comment"), list: defaultKey("comment.list"), cancel: "esc", expand: "ctrl+o", send: "enter" } as const
export type ReplyKeys = { [K in keyof typeof REPLY_KEYS]: string }

/** The reply mode's own letters, as the `commentReplyKeys` setting spells them: next, previous, comment, decide. */
export type ReplyLetters = { next: string; previous: string; comment: string; decide: string }
export const REPLY_LETTERS: ReplyLetters = { next: "j", previous: "k", comment: "c", decide: "d" }
/** The setting's four characters as letters. */
export const lettersOf = (keys: string): ReplyLetters => {
  const [next = "j", previous = "k", comment = "c", decide = "d"] = [...keys]
  return { next, previous, comment, decide }
}

/** Marks the glyph sets do not have; the rail, separator and dot come from the active `Glyphs`. */
export const REPLY_MARKS = { quoteOpen: "“", quoteClose: "”", chipOpen: "[", chipClose: "]", pointer: "›", up: "↑" } as const

const INSET = " ".repeat(PROMPT_MARGIN + 1)
const sep = (g: Glyphs) => ` ${g.sep} `

/** A passage on one line: spaces collapsed, quoted, cut to `room` cells. */
export function quoteLabel(quote: string, room: number): string {
  const flat = quote.replace(/\s+/g, " ").trim()
  const inner = Math.max(1, room - 2)
  return `${REPLY_MARKS.quoteOpen}${truncateEnd(flat, inner)}${REPLY_MARKS.quoteClose}`
}

/** What the user can do with the passage they just selected or copied, as a pill like the jump button's. */
export function commentHint({ copied, width, keys = REPLY_KEYS }: { copied: boolean; width: number; keys?: Pick<ReplyKeys, "comment"> }, g: Glyphs): Line {
  const key: Span = { text: keys.comment, fg: "primary", bold: true }
  const forms: Line[] = [
    [{ text: copied ? " copied" : " ", fg: "muted", bg: "panel" }, ...(copied ? [{ text: sep(g), fg: "muted", bg: "panel" } as Span] : []), { ...key, bg: "panel" }, { text: " comment ", fg: "text", bg: "panel" }],
    [{ text: " ", bg: "panel" }, { ...key, bg: "panel" }, { text: " comment ", fg: "text", bg: "panel" }],
    [{ text: " ", bg: "panel" }, { ...key, bg: "panel" }, { text: " ", bg: "panel" }],
  ]
  return forms.find((form) => lineWidth(form) <= width) ?? forms.at(-1)!
}

/**
 * Where the hint sits next to a passage drawn on rows `from..to`: right-aligned on its last row when the text leaves room, else on the
 * blank row under it. Undefined when neither has room (the hint then lives on the prompt's rule instead).
 */
export function hintByPassage({ rows, plain, from, to, width, hint, cover = false }: { rows: readonly Line[]; plain: readonly string[]; from: number; to: number; width: number; hint: Line; /** Lay the pill over the passage's last row even when it hides words, as the jump button does. */ cover?: boolean }): { row: number; line: Line; covers: boolean; col: number } | undefined {
  const left = width - PROMPT_MARGIN - lineWidth(hint)
  const place = (row: number, covers: boolean) => {
    const line = rows[row]
    const drawn = line ? overlayAt({ line, width, from: left, label: hint }) : undefined
    return drawn ? { row, line: drawn, covers, col: left } : undefined
  }
  if (textWidth(plain[to]?.trimEnd() ?? "") + 2 <= left) return place(to, false)
  if ((plain[to + 1] ?? "x").trim() === "") return place(to + 1, false)
  return cover ? place(to, true) : undefined
}

/** The hint on the prompt's top rule, the way the activity status sits there: the rule stays, the pill is laid over its right end. Returns where it landed. */
export function hintOnRule({ rule, width, hint }: { rule: Line; width: number; hint: Line }): { line: Line; from: number } {
  const from = width - PROMPT_MARGIN - lineWidth(hint) - 1
  return { line: overlayAt({ line: rule, width, from, label: hint }) ?? rule, from }
}

/** The prompt's rule tinted as a comment's: the typed text is a comment, not the message, and the colour says so before the header is read. */
export const tintRule = (rule: Line): Line => rule.map((span) => (span.fg === "primary" ? { ...span, fg: "commentRule" as const } : span))

/** Cells the quote on the compose header never goes under while a key hint can still be dropped instead. */
const QUOTE_MIN_ROOM = 24

/** The hint when it rides on the notice row that already says `copied N chars` (the toast's own `hint`). */
export const commentToastHint = (keys: Pick<ReplyKeys, "comment"> = REPLY_KEYS) => `${keys.comment} comment`
export const COMMENT_TOAST_HINT = commentToastHint()

/** The row under the rule while a comment is typed: whose passage it is, and that the draft below is safe. */
export function composeHeader({ quote, width, draftKept, keys = REPLY_KEYS, editing = false }: { quote: string; width: number; draftKept: boolean; keys?: Pick<ReplyKeys, "send" | "cancel">; editing?: boolean }, g: Glyphs): Line {
  const lead: Line = [{ text: " ".repeat(PROMPT_MARGIN) }, { text: g.rail, fg: "commentRule" }, { text: " " }]
  const kept = draftKept ? `draft kept${sep(g)}` : ""
  const tails = [`${kept}${keys.send} saves${sep(g)}${keys.cancel} cancels`, `${kept}${keys.send}${sep(g)}${keys.cancel}`, `${keys.send} saves${sep(g)}${keys.cancel}`, keys.cancel]
  const label = editing ? "edit comment on " : "comment on "
  const used = lineWidth(lead) + label.length
  // The quote keeps at least a recognisable stretch; the keys give way first.
  const tail = tails.find((text) => width - used - textWidth(text) - PROMPT_MARGIN - 2 >= QUOTE_MIN_ROOM) ?? ""
  const room = width - used - PROMPT_MARGIN - (tail ? textWidth(tail) + 2 : 0)
  const left: Line = [...lead, { text: label, fg: "muted" }, { text: quoteLabel(quote, room), fg: "text" }]
  const gap = width - lineWidth(left) - textWidth(tail) - PROMPT_MARGIN
  return fit(tail && gap >= 1 ? [...left, { text: " ".repeat(gap) }, { text: tail, fg: "muted" }] : left, width)
}

/** How a comment shows in the chip row. `earlier` (an arrow after its number): its passage is in an older answer than the newest, or in none any more. */
export type ChipModel = { n: number; quote: string; earlier?: boolean }

const chipSpans = (chip: ChipModel, share: number, focused: boolean): Line => {
  const fill = focused ? { bg: "element" as const } : {}
  return [
    { text: REPLY_MARKS.chipOpen, fg: "muted", ...fill },
    { text: `${chip.n}${chip.earlier ? REPLY_MARKS.up : ""}`, fg: "commentMark", bold: true, ...fill },
    { text: ` ${quoteLabel(chip.quote, share)}`, fg: "commentQuote", ...(chip.earlier ? { dim: true } : {}), ...fill },
    { text: REPLY_MARKS.chipClose, fg: "muted", ...fill },
  ]
}

/** A chip's cells besides its quote: both brackets, the number, the arrow of an earlier answer and a space. */
const CHIP_FIXED = 2 + 1 + 1 + 1
/** The default for the `commentCollapse` setting. */
export const CHIP_MIN_QUOTE = 14

export type ChipStyle = "chips" | "numbers" | "count"

/**
 * The comments above the prompt, as the attachment chips are: one row, a chip per comment with its number and the start of its quote.
 * When the row cannot hold every chip at least `collapse` cells of its quote it collapses to a count, so the count stays whatever the
 * width. `style` `numbers` shows only `[1] [2] [3]` and `count` always the count; `focused` (a chip number) is drawn on a fill.
 */
export function chipRow({ chips, width, listing, style = "chips", collapse = CHIP_MIN_QUOTE, focused, keys = REPLY_KEYS }: { chips: readonly ChipModel[]; width: number; listing: boolean; style?: ChipStyle; collapse?: number; focused?: number; keys?: Pick<ReplyKeys, "list" | "send"> }, g: Glyphs): Line {
  const hint: Line = [{ text: "  " }, { text: keys.list, fg: "muted", dim: true }, { text: " list", fg: "muted", dim: true }]
  const room = (withHint: boolean) => width - INSET.length - (withHint ? lineWidth(hint) : 0) - PROMPT_MARGIN
  if (style === "numbers") {
    const nums: Line[] = chips.map((chip) => [{ text: REPLY_MARKS.chipOpen, fg: "muted" }, { text: `${chip.n}${chip.earlier ? REPLY_MARKS.up : ""}`, fg: "commentMark", bold: true, ...(focused === chip.n ? { bg: "element" as const } : {}) }, { text: REPLY_MARKS.chipClose, fg: "muted" }])
    const row: Line = [{ text: INSET }, ...nums.flatMap((chip, index): Line => (index ? [{ text: " " }, ...chip] : chip))]
    if (lineWidth(row) + lineWidth(hint) + PROMPT_MARGIN <= width) return fit([...row, ...hint], width)
    if (lineWidth(row) + PROMPT_MARGIN <= width) return fit(row, width)
  }
  if (style === "chips") {
    for (const withHint of [true, false]) {
      const free = room(withHint) - (chips.length - 1)
      const share = Math.floor(free / chips.length) - CHIP_FIXED - String(chips.length).length
      if (share < collapse) continue
      const row: Line = [{ text: INSET }]
      chips.forEach((chip, index) => row.push(...(index ? [{ text: " " }] : []), ...chipSpans(chip, Math.min(share, textWidth(chip.quote.replace(/\s+/g, " ").trim()) + 2), focused === chip.n)))
      return fit(withHint ? [...row, ...hint] : row, width)
    }
  }
  const earlier = chips.filter((chip) => chip.earlier).length
  const count: Line = [{ text: INSET }, { text: `${chips.length} ${chips.length === 1 ? "comment" : "comments"}`, fg: "commentMark", bold: true }, ...(earlier ? [{ text: `${sep(g)}${earlier} earlier`, fg: "muted" } as Span] : [])]
  const tails = [`${sep(g)}${keys.list} list${sep(g)}${keys.send} sends`, `${sep(g)}${keys.list} list`, ""]
  const tail = tails.find((text) => lineWidth(count) + textWidth(text) + PROMPT_MARGIN <= width) ?? ""
  return fit([...count, ...(listing || !tail ? [] : [{ text: tail, fg: "muted" } as Span])], width)
}

/** The count of pending comments as the pill on the prompt's top rule (`commentChips: rule`), drawn like the other pills. */
export function chipPill({ count, earlier, keys = REPLY_KEYS }: { count: number; earlier: number; keys?: Pick<ReplyKeys, "list"> }): Line {
  return [{ text: " ", bg: "panel" }, { text: `${count} ${count === 1 ? "comment" : "comments"}`, fg: "commentMark", bg: "panel", bold: true }, ...(earlier ? [{ text: ` ${earlier}${REPLY_MARKS.up}`, fg: "muted", bg: "panel" } as Span] : []), { text: ` ${keys.list} `, fg: "muted", bg: "panel" }]
}

/** The row that says comments are set aside as a draft (ctrl+c on an empty prompt): how many, how to bring them back and how to drop them. */
export function parkedRow({ count, width, keys = REPLY_KEYS }: { count: number; width: number; keys?: Pick<ReplyKeys, "list"> }, g: Glyphs): Line {
  const head: Line = [{ text: INSET }, { text: "draft", fg: "commentMark", bold: true }, { text: ` ${count} ${count === 1 ? "comment" : "comments"}`, fg: "text" }]
  const tails = [`${sep(g)}${keys.list} brings them back${sep(g)}/comments clear discards`, `${sep(g)}${keys.list} restore${sep(g)}/comments clear`, `${sep(g)}${keys.list} restore`, ""]
  const tail = tails.find((text) => lineWidth(head) + textWidth(text) + PROMPT_MARGIN <= width) ?? ""
  return fit([...head, ...(tail ? [{ text: tail, fg: "muted" } as Span] : [])], width)
}

/** The list that opens in place of the chip row: a header, then each comment as its quote and its words, the selected one on a fill. */
export function commentList({ comments, selected, width, maxRows, lastItemId, limit = 9, keys = REPLY_KEYS }: { comments: readonly ReplyComment[]; selected: number; width: number; maxRows: number; lastItemId?: string | undefined; limit?: number; keys?: Pick<ReplyKeys, "cancel"> }, g: Glyphs): Line[] {
  const listKeys = width >= 64 ? `${sep(g)}up down select${sep(g)}e edit${sep(g)}d delete${sep(g)}J K move${sep(g)}${keys.cancel} close` : `${sep(g)}e d J K${sep(g)}${keys.cancel}`
  const head: Line = fit([{ text: INSET }, { text: "Comments", fg: "commentMark", bold: true }, { text: ` ${comments.length} of ${limit}`, fg: "muted" }, { text: listKeys, fg: "muted" }], width)
  const perComment = 2
  const window = Math.max(1, Math.floor((maxRows - 1) / perComment))
  const first = Math.max(0, Math.min(selected - Math.floor(window / 2), comments.length - window))
  const rows: Line[] = [head]
  comments.slice(first, first + window).forEach((comment, offset) => {
    const index = first + offset
    const on = index === selected
    // Older than the newest answer, or with no answer left to point at (a compaction): either way the quote is what is sent.
    const note = comment.other ? "" : comment.itemId === undefined ? "quote only" : comment.itemId !== lastItemId ? "earlier" : ""
    const lead = `${on ? REPLY_MARKS.pointer : " "} ${index + 1} `
    const quote = quoteLabel(comment.quote, Math.max(8, width - INSET.length - lead.length - (note ? note.length + 4 : 0) - PROMPT_MARGIN))
    const top: Line = [{ text: INSET }, { text: lead, fg: on ? "commentMark" : "muted", bold: on }, { text: quote, fg: "commentQuote" }, ...(note ? [{ text: `  ${note}`, fg: "muted", dim: true } as Span] : [])]
    const words = truncateEnd(comment.text.replace(/\s+/g, " "), Math.max(4, width - INSET.length - lead.length - PROMPT_MARGIN))
    const bottom: Line = [{ text: INSET }, { text: " ".repeat(lead.length) }, { text: words, fg: "text" }]
    for (const row of [top, bottom]) rows.push(on ? fit(row, width).map((span) => ({ ...span, bg: "element" as const })) : fit(row, width))
  })
  return rows
}

/** What the unit under the reply-mode cursor is called in the bar. */
export const unitName = (unit: ReplyUnit) => (unit.kind === "option" ? `option ${unit.number}` : unit.kind)

/** The bar above the prompt while the reply mode is on; every form keeps the way out. */
export function replyBar({ index, total, unit, width, options, letters = REPLY_LETTERS, keys = REPLY_KEYS }: { index: number; total: number; unit: ReplyUnit; width: number; options: boolean; letters?: ReplyLetters; keys?: Pick<ReplyKeys, "cancel"> }, g: Glyphs): Line {
  const head: Line = [{ text: INSET }, { text: "reply", fg: "commentMark", bold: true }, { text: ` ${index + 1}/${total}`, fg: "text" }]
  const forms = [
    `${sep(g)}${unitName(unit)}${sep(g)}${letters.next} ${letters.previous} move${sep(g)}${letters.comment} comment${options ? `${sep(g)}${letters.decide} decide` : ""}${sep(g)}${keys.cancel} exit`,
    `${sep(g)}${letters.next} ${letters.previous}${sep(g)}${letters.comment}${options ? `${sep(g)}${letters.decide}` : ""}${sep(g)}${keys.cancel}`,
    `${sep(g)}${keys.cancel}`,
  ]
  const tail = forms.find((text) => lineWidth(head) + textWidth(text) + PROMPT_MARGIN <= width) ?? ""
  return fit([...head, { text: tail, fg: "muted" }], width)
}

/** The row under the rule while a numbered decision is typed (`1: yes, 2: no`); once something parses it says what will be stored. */
export function decideHeader({ options, pairs, width, keys = REPLY_KEYS }: { options: readonly number[]; pairs: ReadonlyArray<{ number: number; text: string }>; width: number; keys?: Pick<ReplyKeys, "send"> }, g: Glyphs): Line {
  const range = options.length > 1 ? `${options[0]}-${options.at(-1)}` : String(options[0] ?? "")
  const lead: Line = [{ text: " ".repeat(PROMPT_MARGIN) }, { text: g.rail, fg: "commentRule" }, { text: " " }]
  const forms = pairs.length
    ? [`${pairs.map((pair) => `${pair.number} ${pair.text}`).join(sep(g))}${sep(g)}${keys.send} saves`, pairs.map((pair) => `${pair.number} ${pair.text}`).join(sep(g))]
    : [`decide ${range}${sep(g)}1: yes, 2: no`, `decide ${range}`]
  const text = forms.find((form) => lineWidth(lead) + textWidth(form) + PROMPT_MARGIN <= width) ?? truncateEnd(forms.at(-1)!, width - lineWidth(lead) - PROMPT_MARGIN)
  return fit([...lead, { text, fg: pairs.length ? "text" : "muted" }], width)
}

/** Which of an answer's options a typed `1: yes, 2: no` answers, as comments' words; numbers that are no option are returned apart. */
export function parseDecisions(input: string, options: ReadonlyArray<{ number: number }>): { pairs: Array<{ number: number; text: string }>; unknown: number[] } {
  const parts = input.split(/(?:^|[,;]\s*)(\d+)\s*:\s*/).slice(1)
  const pairs: Array<{ number: number; text: string }> = []
  const unknown: number[] = []
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const number = Number(parts[at])
    const text = parts[at + 1]!.trim()
    if (!text) continue
    if (options.some((option) => option.number === number)) pairs.push({ number, text })
    else unknown.push(number)
  }
  return { pairs, unknown }
}

/** The gutter mark of a pending comment on rows `from..to`: its number on the first row, the rail beside the rest; the transcript text is not moved. `glyph` replaces the glyph set's rail. */
export function markRows({ rows, from, to, n, width, glyph }: { rows: readonly Line[]; from: number; to: number; n?: number; width: number; glyph?: string }, g: Glyphs): Line[] {
  return rows.map((row, index) => {
    if (index < from || index > to) return row
    const label: Line = [{ text: n !== undefined && index === from ? String(n) : " ", fg: "commentMark", bold: true }, { text: glyph || g.rail, fg: "commentMark" }]
    return overlayAt({ line: row, width, from: 0, label }) ?? row
  })
}
