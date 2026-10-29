import type { QuestionInfo } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import { clip, lineWidth } from "./deck"
import { wrapSpans } from "./markdown"
import { boxRow } from "./panel-box"
import { PROMPT_MARGIN } from "./prompt-chrome"
import { truncateEnd } from "./session-list"
import type { PanelRows } from "./request-panel"

/**
 * The question card: the model asks the user to choose (one question or a batch, single or multiple choice). It takes the
 * prompt's place (docs/layout.md, "Questions"): a rail card with the header, the question, the numbered options with their
 * descriptions wrapped in full, and a last "Type your own answer" row that turns into the text field when chosen.
 * A batch adds a row of tabs and a Confirm tab that reviews the answers before they are sent.
 */

export type QuestionDraft = { requestId: string; tab: number; choice: number; answers: string[][]; custom: string[]; editing: boolean; scroll: number }
/** The text field of the custom answer: the editor's rows laid out at `questionFieldWidth` and the cursor among them. */
export type QuestionField = { lines: readonly string[]; row: number; col: number }
/** The rows of a card, its click regions and where the terminal cursor goes (the field's caret, or the highlighted row). */
export type QuestionCard = PanelRows & { cursor?: { row: number; col: number } }

/** One question has no tabs and no Confirm tab: a single choice sends at once, a multiple choice sends with Enter. */
export const singleQuestion = (questions: readonly QuestionInfo[]) => questions.length === 1

export const CUSTOM_LABEL = "Type your own answer"
const RAIL: ColorName = "accent"
/** The cells before the card's text: the prompt margin, the rail and one space. */
const LEFT = PROMPT_MARGIN + 2

const roomOf = (width: number) => Math.max(10, width - PROMPT_MARGIN * 2 - 3)
const rowsOf = (question: QuestionInfo) => question.options.length + (question.custom === false ? 0 : 1)
/** Cells of `› 10. `: the marker, the widest number and its dot, one space. */
const indentOf = (question: QuestionInfo) => 2 + String(Math.max(1, rowsOf(question))).length + 2

/** Cells the custom answer's field has for its text at this width: the editor wraps to it. */
export function questionFieldWidth(width: number, question: QuestionInfo): number {
  return Math.max(4, roomOf(width) - indentOf(question))
}

type Row = { line: Line; fill?: ColorName }
type Answers = { rows: Row[]; hits: Array<{ row: number; index: number }>; cursor?: { row: number; col: number }; focus: { from: number; to: number } }

/** The answer rows of one question: each option with its description wrapped under it, then the custom row or its field. */
function answerRows(input: { width: number; question: QuestionInfo; draft: QuestionDraft; field?: QuestionField | undefined; ascii: boolean }): Answers {
  const { question, draft } = input
  const room = roomOf(input.width)
  const indent = indentOf(question)
  const hang: Span[] = [{ text: " ".repeat(indent) }]
  const picked = draft.answers[draft.tab] ?? []
  const multiple = question.multiple === true
  const rows: Row[] = []
  const hits: Answers["hits"] = []
  let cursor: Answers["cursor"]
  let focus = { from: 0, to: 0 }
  const lead = (index: number, on: boolean): Span[] => [
    { text: on ? (input.ascii ? "> " : "› ") : "  ", fg: "primary", bold: true },
    { text: `${index + 1}.`.padEnd(indent - 3), fg: on ? "primary" : "muted" },
    { text: " " },
  ]
  const box = (mark: boolean) => (multiple ? `[${mark ? (input.ascii ? "x" : "✓") : " "}] ` : "")
  const tick = (mark: boolean): Span[] => (!multiple && mark ? [{ text: input.ascii ? " *" : " ✓", fg: "success" }] : [])
  question.options.forEach((option, index) => {
    const on = draft.choice === index && !draft.editing
    const mark = picked.includes(option.label)
    const from = rows.length
    hits.push({ row: rows.length, index })
    const label = wrapSpans([{ text: `${box(mark)}${option.label}`, fg: on ? "primary" : mark ? "success" : "text", bold: on }, ...tick(mark)], room, lead(index, on), hang)
    const description = option.description ? wrapSpans([{ text: option.description, fg: "muted" }], room, hang) : []
    for (const line of [...label, ...description]) rows.push({ line, ...(on ? { fill: "element" as const } : {}) })
    if (on) focus = { from, to: rows.length }
  })
  if (question.custom !== false) {
    const index = question.options.length
    const on = draft.choice === index
    const saved = draft.custom[draft.tab] ?? ""
    const from = rows.length
    hits.push({ row: rows.length, index })
    if (draft.editing && input.field) {
      const lines = input.field.lines.length ? input.field.lines : [""]
      const empty = lines.length === 1 && lines[0] === ""
      lines.forEach((text, at) => {
        const head: Span[] = at === 0 ? lead(index, true) : hang
        const body: Span[] = empty ? [{ text: CUSTOM_LABEL, fg: "muted", dim: true }] : [{ text, fg: "text" }]
        rows.push({ line: [...head, ...body], fill: "element" })
      })
      cursor = { row: from + input.field.row, col: LEFT + indent + input.field.col }
    } else {
      const mark = saved !== "" && picked.includes(saved)
      const text: Span[] = saved ? [{ text: `${box(mark)}${saved}`, fg: on ? "primary" : mark ? "success" : "text", bold: on }, ...tick(mark)] : [{ text: `${box(false)}${CUSTOM_LABEL}`, fg: on ? "primary" : "muted", bold: on }]
      for (const line of wrapSpans(text, room, lead(index, on), hang)) rows.push({ line, ...(on ? { fill: "element" as const } : {}) })
    }
    if (on) focus = { from, to: rows.length }
  }
  return { rows, hits, ...(cursor ? { cursor } : {}), focus }
}

const toLines = (rows: Row[], width: number): Line[] => rows.map((row) => boxRow({ line: [{ text: " " }, ...row.line], width, rail: RAIL, ...(row.fill ? { fill: row.fill } : {}) }))

/** The option block alone, for a custom `question` view that draws the rest of a single question around it (docs/views.md). */
export function questionAnswerBlock(input: { width: number; question: QuestionInfo; draft: QuestionDraft; field?: QuestionField | undefined; ascii: boolean }): QuestionCard {
  const answers = answerRows(input)
  const cursor = answers.cursor ?? { row: answers.focus.from, col: LEFT }
  return { rows: toLines(answers.rows, input.width), hits: answers.hits, cursor }
}

/** The key hint at the foot of the card; shorter words when the full line does not fit. */
function hintRow(input: { room: number; single: boolean; review: boolean; editing: boolean; multiple: boolean }): Line {
  const pairs: Array<[string, string]> = input.editing
    ? [["enter", input.single && !input.multiple ? "send" : "save"], ...(input.single ? [] : [["tab", "next"] as [string, string]]), ["esc", "back"]]
    : input.review
      ? [["enter", "submit"], ["tab", "back"], ["esc", "dismiss"]]
      : [
          ...(input.single ? [] : [["tab", "next"] as [string, string]]),
          ["↑↓", "select"],
          ...(input.multiple && input.single ? [["space", "toggle"] as [string, string]] : []),
          ["enter", input.multiple ? (input.single ? "send" : "toggle") : "confirm"],
          ["esc", "dismiss"],
        ]
  const full: Line = pairs.flatMap(([key, word], index): Span[] => [...(index ? [{ text: " · ", fg: "muted" as const }] : []), { text: key, fg: "text" }, { text: ` ${word}`, fg: "muted" }])
  if (lineWidth(full) <= input.room) return full
  return pairs.flatMap(([key], index): Span[] => [...(index ? [{ text: " · ", fg: "muted" as const }] : []), { text: key, fg: "text" }])
}

/** The tabs of a batch: one per question (✓ once answered) and Confirm; the open one is filled. Hits carry the tab as `-tab - 1`. */
function tabRow(input: { room: number; questions: readonly QuestionInfo[]; draft: QuestionDraft; ascii: boolean }): { line: Line; hits: Array<{ index: number; from: number; to: number }> } {
  const { questions, draft } = input
  const count = questions.length + 1
  const tabWidth = Math.min(18, Math.max(8, Math.floor(input.room / Math.min(count, 4))))
  const visible = Math.max(1, Math.floor(input.room / tabWidth))
  const start = Math.max(0, Math.min(draft.tab - Math.floor(visible / 2), count - visible))
  const line: Line = []
  const hits: Array<{ index: number; from: number; to: number }> = []
  for (let index = start; index < Math.min(count, start + visible); index++) {
    const label = index === questions.length ? "Confirm" : questions[index]!.header
    const selected = index === draft.tab
    const answered = (draft.answers[index]?.length ?? 0) > 0
    const from = lineWidth(line)
    line.push({ text: ` ${truncateEnd(label, tabWidth - 3)}${answered ? (input.ascii ? "*" : "✓") : " "} `, fg: selected ? "background" : answered ? "text" : "muted", ...(selected ? { bg: "primary" as const, bold: true } : {}) })
    hits.push({ index: -index - 1, from: LEFT + from, to: LEFT + lineWidth(line) })
  }
  return { line, hits }
}

/** The whole card for a pending question or batch; at most `height` rows, the highlighted answer (or the field's caret) always among them. */
export function renderQuestionBatch(input: { width: number; height: number; questions: readonly QuestionInfo[]; draft: QuestionDraft; field?: QuestionField | undefined; ascii?: boolean }): QuestionCard {
  const { width, questions, draft } = input
  const ascii = input.ascii === true
  const room = roomOf(width)
  const single = singleQuestion(questions)
  const review = !single && draft.tab >= questions.length
  const question = review ? undefined : questions[Math.min(draft.tab, questions.length - 1)]
  const head: Row[] = []
  const hits: PanelRows["hits"] = []
  if (!single) {
    const tabs = tabRow({ room, questions, draft, ascii })
    for (const hit of tabs.hits) hits.push({ row: 0, ...hit })
    head.push({ line: tabs.line })
  }
  const intro: Row[] = []
  if (question) {
    const header = question.header.trim()
    if (single && header && header !== question.question.trim()) intro.push({ line: [{ text: header, fg: "primary", bold: true }] })
    const text = question.question.split("\n")
    text.forEach((part, at) => {
      const tail: Span[] = at === text.length - 1 && question.multiple ? [{ text: " (select all that apply)", fg: "muted" }] : []
      for (const line of wrapSpans([{ text: part, fg: "text", bold: true }, ...tail], room)) intro.push({ line })
    })
    if (question.context?.trim()) for (const part of question.context.trim().split("\n")) for (const line of wrapSpans([{ text: part, fg: "muted" }], room)) intro.push({ line })
  } else intro.push({ line: [{ text: "Review", fg: "primary", bold: true }] })
  // Body: the answers (or the review). The hint and two spacer rows are kept; the intro gives way first, then the body scrolls.
  const body: Row[] = []
  const bodyHits: Array<{ row: number; index: number }> = []
  let focus = { from: 0, to: 0 }
  let cursorAt: { row: number; col: number } | undefined
  if (question) {
    const answers = answerRows({ width, question, draft, field: input.field, ascii })
    body.push(...answers.rows)
    bodyHits.push(...answers.hits)
    focus = answers.cursor ? { from: answers.cursor.row, to: answers.cursor.row + 1 } : answers.focus
    cursorAt = answers.cursor ?? { row: answers.focus.from, col: LEFT }
  } else {
    questions.forEach((entry, index) => {
      const answers = draft.answers[index] ?? []
      bodyHits.push({ row: body.length, index: -index - 1 })
      for (const line of wrapSpans([{ text: `${entry.header}: `, fg: "primary" }, { text: answers.length ? answers.join(", ") : "(not answered)", fg: answers.length ? "text" : "error" }], room)) body.push({ line })
    })
    focus = { from: draft.scroll, to: draft.scroll + 1 }
  }
  const fixed = head.length + 3
  const height = Math.max(fixed + 2, input.height)
  const minBody = Math.min(body.length, Math.max(1, focus.to - focus.from), 6)
  const introRoom = Math.max(1, height - fixed - Math.max(minBody, Math.min(body.length, 3)))
  const shownIntro = intro.slice(0, introRoom)
  if (intro.length > shownIntro.length) shownIntro[shownIntro.length - 1] = { line: [...clip(shownIntro.at(-1)!.line, room - 1), { text: "…", fg: "muted" }] }
  const available = Math.max(1, height - fixed - shownIntro.length)
  let first = 0
  if (review) {
    draft.scroll = Math.max(0, Math.min(draft.scroll, body.length - available))
    first = draft.scroll
  } else if (body.length > available) {
    // The highlighted answer (or the caret) comes into view with as much of what follows it as fits.
    first = focus.to > available ? Math.min(focus.from, focus.to - available) : 0
    first = Math.max(0, Math.min(first, body.length - available))
  }
  const window = body.slice(first, first + available)
  const below = body.length - first - window.length
  if (below > 0) window[window.length - 1] = { line: [{ text: `${ascii ? "v" : "↓"} ${below + 1} more rows`, fg: "muted" }] }
  const top = head.length + shownIntro.length + 1
  const rows: Row[] = [...head, ...shownIntro, { line: [] }, ...window, { line: [] }, { line: hintRow({ room, single, review, editing: draft.editing, multiple: question?.multiple === true }) }]
  for (const hit of bodyHits) if (hit.row >= first && hit.row < first + window.length && !(below > 0 && hit.row === first + window.length - 1)) hits.push({ row: top + hit.row - first, index: hit.index })
  const cursor = cursorAt && cursorAt.row >= first && cursorAt.row < first + window.length ? { row: top + cursorAt.row - first, col: cursorAt.col } : { row: rows.length - 1, col: LEFT }
  return { rows: toLines(rows, width), hits, cursor }
}
