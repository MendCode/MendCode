import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

/**
 * A scrollable read-only document in one bordered panel: `/recap` (what the model says the session did) and `/changelog`.
 * Headings are accent rows, `lines` are wrapped paragraphs or `- ` bullets with a hanging indent.
 */
export type TextSection = { heading?: string; note?: string; lines: string[] }
export type TextPageState = { title: string; summary: string; sections: TextSection[]; status: "loading" | "ready" | "error"; error: string; scroll: number; hint?: string }

export function createTextPageState(input: { title: string; summary?: string; sections?: TextSection[]; status?: TextPageState["status"]; error?: string; hint?: string }): TextPageState {
  return { title: input.title, summary: input.summary ?? "", sections: input.sections ?? [], status: input.status ?? "ready", error: input.error ?? "", scroll: 0, ...(input.hint ? { hint: input.hint } : {}) }
}

/** The document as rows for a panel body `inner` cells wide. */
export function textPageRows(state: TextPageState, inner: number): Line[] {
  if (state.status === "loading") return [[{ text: state.hint || "working…", fg: "muted" }]]
  if (state.status === "error") return wrap(state.error || "failed", inner).map((text): Line => [{ text, fg: "warning" }])
  const out: Line[] = []
  for (const section of state.sections) {
    if (out.length) out.push([])
    if (section.heading) out.push([{ text: section.heading, fg: "heading", bold: true }, ...(section.note ? [{ text: `  ${section.note}`, fg: "muted" as const }] : [])])
    for (const text of section.lines) {
      if (text === "") { out.push([]); continue }
      const bullet = text.startsWith("- ")
      const parts = wrap(bullet ? text.slice(2) : text, Math.max(1, inner - (bullet ? 2 : 0)))
      parts.forEach((part, index) => out.push([{ text: bullet ? (index === 0 ? "• " : "  ") : "", fg: "muted" }, { text: part, fg: "text" }]))
    }
  }
  return out.length ? out : [[{ text: "nothing to show", fg: "muted" }]]
}

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])

/** Handles one raw key; `rows` and `viewport` bound the scroll. `close` is true on escape or q. */
export function textPageKey(state: TextPageState, key: string, rows: number, viewport: number): { state: TextPageState; close: boolean } {
  if (key === "\x1b" || key === "q") return { state, close: true }
  const max = Math.max(0, rows - viewport)
  const step = Math.max(1, viewport - 1)
  let scroll = state.scroll
  if (UP.has(key)) scroll -= 1
  else if (DOWN.has(key) || key === " ") scroll += key === " " ? step : 1
  else if (key === "\x1b[5~") scroll -= step
  else if (key === "\x1b[6~") scroll += step
  else if (key === "g" || key === "\x1b[H") scroll = 0
  else if (key === "G" || key === "\x1b[F") scroll = max
  scroll = Math.max(0, Math.min(max, scroll))
  return { state: scroll === state.scroll ? state : { ...state, scroll }, close: false }
}

/** The panel body width and height the scroll limit uses, shared by render and key handling. */
export function textPageViewport(width: number, height: number) {
  return { inner: Math.max(1, width < 68 ? width : width - 4), rows: Math.max(1, height - 2 - 4) }
}

export function renderTextPage(input: { state: TextPageState; width: number; height: number }): Line[] {
  const { state, width } = input
  const height = Math.max(0, input.height)
  const room = Math.max(0, height - 2)
  const view = textPageViewport(width, height)
  const hints = state.status === "ready" ? "↑↓ scroll · space page · g/G ends · esc back" : "esc back"
  return pickerFrame(state.title, hints, width, height, panelGrid({ width, heights: [room], padding: true, rows: [[{ title: state.title, active: true, scroll: Math.min(state.scroll, Math.max(0, textPageRows(state, view.inner).length - view.rows)), body: (inner: number) => textPageRows(state, inner) }]] }), state.summary)
}
