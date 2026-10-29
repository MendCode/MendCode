import type { ColorName, Line, Span } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

/** A `/btw` side question: its answer arrives later, or an error. Nothing of it enters the session. */
export type Aside = { question: string; answer?: string; error?: string; scroll: number }

export type AsideCard = { rows: Line[]; top: number; left: number; lines: number; visible: number }

const CARD: ColorName = "panel"
const PADDING = 2
const MAX_WIDTH = 100
const QUESTION_LINES = 3

function fit(spans: Span[], width: number): Span[] {
  const out: Span[] = []
  let used = 0
  for (const span of spans) {
    const room = width - used
    if (room <= 0) break
    const text = textWidth(span.text) > room ? truncateEnd(span.text, room) : span.text
    out.push({ ...span, text })
    used += textWidth(text)
  }
  return used < width ? [...out, { text: " ".repeat(width - used) }] : out
}

/** The answer's lines for a card of this inner width; the app scrolls with them. */
export function asideLines(aside: Aside, inner: number): Array<{ text: string; fg: ColorName }> {
  if (aside.error) return wrap(aside.error, inner).map((text) => ({ text, fg: "error" as const }))
  if (aside.answer === undefined) return [{ text: "thinking…", fg: "muted" }]
  return aside.answer.split("\n").flatMap((paragraph) => (paragraph.trim() ? wrap(paragraph, inner) : [""])).map((text) => ({ text, fg: "text" as const }))
}

/**
 * The `/btw` card floating over the transcript, its bottom just above the prompt at `bottom`: title and `esc`, the
 * question, then the answer, scrolled by `aside.scroll` with a hint when more is above or below.
 */
export function renderAsideCard(input: { aside: Aside; width: number; bottom: number }): AsideCard | undefined {
  const { aside, width } = input
  const cardWidth = Math.min(MAX_WIDTH, width - 4)
  const room = input.bottom
  if (cardWidth < 24 || room < 5) return undefined
  const inner = cardWidth - PADDING * 2
  const painted = (spans: Span[]): Line => [{ text: " ".repeat(PADDING), bg: CARD }, ...fit(spans, inner).map((span) => ({ ...span, bg: span.bg ?? CARD })), { text: " ".repeat(PADDING), bg: CARD }]
  const blank = painted([])

  const question = wrap(aside.question.replace(/\s+/g, " ").trim(), Math.max(1, inner - 2)).slice(0, QUESTION_LINES)
  const head: Line[] = [
    blank,
    painted([{ text: "btw", fg: "accent", bold: true }, { text: " ".repeat(Math.max(1, inner - 6)) }, { text: "esc", fg: "muted" }]),
    ...question.map((text, index) => painted([{ text: index === 0 ? "› " : "  ", fg: "muted" }, { text, fg: "muted" }])),
    blank,
  ]
  const lines = asideLines(aside, inner)
  const answerRoom = Math.max(1, Math.min(lines.length, room - head.length - 2))
  const scroll = Math.max(0, Math.min(aside.scroll, lines.length - answerRoom))
  const shown = lines.slice(scroll, scroll + answerRoom).map((line) => painted([{ text: line.text, fg: line.fg }]))
  const below = lines.length - scroll - answerRoom
  const hint = scroll > 0 || below > 0 ? `${scroll > 0 ? `↑ ${scroll} above` : ""}${scroll > 0 && below > 0 ? " · " : ""}${below > 0 ? `↓ ${below} more` : ""} · pgup/pgdn` : "not saved in the session"
  const rows = [...head, ...shown, blank, painted([{ text: hint, fg: "muted" }]), blank].slice(0, room)
  return { rows, top: Math.max(0, input.bottom - rows.length), left: Math.max(0, Math.floor((width - cardWidth) / 2)), lines: lines.length, visible: answerRoom }
}
