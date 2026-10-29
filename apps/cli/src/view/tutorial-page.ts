import type { ColorName, Glyphs, Line } from "../ui/theme"
import type { Bindings } from "../ui/keymap"
import { clip, fit, spread } from "./deck"
import { wrap } from "./wrap"
import { NEXT_STEPS, cheatSheet } from "../tutorial/lessons"
import { railNames, RAIL_WIDTH, WIDE_TUTORIAL, type TourView } from "../tutorial/tour"

/**
 * `/tutorial`: a lesson rail beside the live practice chat. The chat rows come from the real terminal app running against
 * the tutorial engine (`sandbox`); this page only lays them out, so the practice cannot drift from the product. At 110
 * columns and up the rail is a 36-cell column on the left; below that it is a short header above the chat.
 */
export const MARKER = "practice · nothing here is real or saved"

export type TutorialInput = {
  view: TourView
  bindings: Bindings
  /** The practice chat's rows for a rectangle (the page asks for the size it has room for). */
  sandbox(width: number, height: number): Line[]
  width: number
  height: number
  glyphs: Glyphs
  accessible: boolean
}

/** The size the practice chat gets for a page size, so the tour can tell which lessons the terminal can show. */
export function sandboxSize(width: number, height: number): { width: number; height: number } {
  return width >= WIDE_TUTORIAL ? { width: width - RAIL_WIDTH - 1, height: Math.max(5, height - 1) } : { width, height: Math.max(5, height - 3) }
}

const row = (text: string, fg: ColorName = "text", bold = false): Line => [{ text, fg, ...(bold ? { bold: true } : {}) }]
const pad = (lines: Line[], height: number, width: number): Line[] => Array.from({ length: height }, (_, y) => fit(lines[y] ?? [], width))
const box = (done: boolean, glyphs: Glyphs) => (done ? `[${glyphs.ok}]` : "[ ]")

function railLines(input: TutorialInput, width: number): Line[] {
  const { view, glyphs } = input
  const lesson = view.lesson!
  const lines: Line[] = []
  lines.push(spread(row("Tutorial", "primary", true), row(`${view.index + 1}/${view.total}`, "muted"), width), row("─".repeat(width), "muted"))
  lines.push(row(lesson.title, "heading", true), [])
  for (const [label, text] of [["why", lesson.why], ["do", lesson.action]] as const) {
    wrap(text, width - 5).forEach((part, i) => lines.push([{ text: i === 0 ? `${label.padEnd(4)} ` : "     ", fg: "muted" }, { text: part, fg: "text" }]))
  }
  lines.push([])
  for (const step of view.steps) wrap(step.label, width - 4).forEach((part, i) => lines.push([{ text: i === 0 ? `${box(step.done, glyphs)} ` : "    ", fg: step.done ? "success" : "muted" }, { text: part, fg: step.done ? "muted" : "text" }]))
  lines.push([])
  for (const part of wrap(view.hint, width)) lines.push(row(part, "muted"))
  if (view.echo) lines.push([], row(`▶ ${view.echo}`, "primary", true))
  else if (view.complete) lines.push([], ...wrap(`done · enter or ${railNames().next} for the next lesson`, width).map((part) => row(part, "success")))
  return lines
}

function listLines(view: TourView, width: number, glyphs: Glyphs): Line[] {
  return view.lessons.map((item) => clip([
    { text: item.state === "current" ? "▸ " : "  ", fg: "primary" },
    { text: item.state === "done" ? `${glyphs.ok} ` : item.state === "skipped" ? "- " : "  ", fg: item.state === "done" ? "success" : "muted" },
    { text: item.title, fg: item.state === "current" ? "primary" : item.state === "todo" ? "text" : "muted" },
  ], width))
}

const keysLine = () => {
  const names = railNames()
  return `${names.show} show me · ${names.skip} skip · ${names.next} next · ${names.back} back · ${names.leave} leave`
}
/** The key reminder of the narrow header, longest first: the one that fits beside the practice marker is used. */
const keyLines = () => {
  const names = railNames()
  return [keysLine(), `${names.show} show · ${names.skip} skip · ${names.next} next · ${names.leave} leave`, `${names.show} show · ${names.skip} skip · ${names.leave} leave`, `${names.show} show · ${names.skip} skip`]
}

/** What was learned as a compact card of the user's own keys, then three next steps. */
function endLines(input: TutorialInput): Line[] {
  const { bindings, width, view } = input
  const sheet = cheatSheet(bindings)
  const half = Math.ceil(sheet.length / 2)
  const col = Math.max(24, Math.floor((width - 4) / 2))
  const lines: Line[] = [row("Tutorial complete", "heading", true), row(`${view.finished}/${view.total} lessons done or skipped · your keys`, "muted"), []]
  for (let i = 0; i < half; i++) {
    const cell = (entry: { keys: string; what: string } | undefined): Line => entry ? [{ text: entry.keys.padEnd(14), fg: "primary" }, { text: entry.what, fg: "text" }] : []
    lines.push(width >= 64 ? fit(cell(sheet[i]), col).concat(fit(cell(sheet[i + half]), col)) : cell(sheet[i]))
  }
  if (width < 64) for (const entry of sheet.slice(half)) lines.push([{ text: entry.keys.padEnd(14), fg: "primary" }, { text: entry.what, fg: "text" }])
  lines.push([], row("Next", "primary", true))
  for (const step of NEXT_STEPS) lines.push(row(`  ${step}`))
  lines.push([], row("enter closes · /tutorial opens the tour again", "muted"))
  return lines
}

export function renderTutorialPage(input: TutorialInput): Line[] {
  const { view, width, height } = input
  if (view.ended || !view.lesson) return pad(endLines(input), height, width)
  if (input.accessible) return accessibleLines(input)
  if (width >= WIDE_TUTORIAL) {
    const rail = railLines(input, RAIL_WIDTH)
    const list = listLines(view, RAIL_WIDTH, input.glyphs)
    const left: Line[] = [...rail]
    const room = height - left.length - 5
    if (room >= list.length + 1) left.push([], ...list)
    const keys = wrap(keysLine(), RAIL_WIDTH).slice(0, 3)
    left.push(...Array.from({ length: Math.max(0, height - left.length - keys.length - 1) }, () => [] as Line), row("─".repeat(RAIL_WIDTH), "muted"), ...keys.map((part) => row(part, "muted")))
    const size = sandboxSize(width, height)
    const chat = input.sandbox(size.width, size.height)
    const marker = clip([{ text: `┌ ${MARKER} `, fg: "warning" }, { text: "─".repeat(size.width), fg: "muted" }], size.width)
    const leftRows = pad(left, height, RAIL_WIDTH)
    const right: Line[] = [marker, ...pad(chat, height - 1, size.width)]
    return Array.from({ length: height }, (_, y) => [...leftRows[y]!, { text: " " }, ...fit(right[y] ?? [], size.width)])
  }
  const lesson = view.lesson
  const progress = view.steps.map((step) => box(step.done, input.glyphs)).join("")
  const state: Line = view.echo ? [{ text: `▶ ${view.echo}`, fg: "primary", bold: true }] : view.complete ? [{ text: `done · enter or ${railNames().next} for the next lesson`, fg: "success" }] : [{ text: "do ", fg: "muted" }, { text: lesson.action, fg: "text" }, { text: `  ${view.hint}`, fg: "muted" }]
  const marker = `─ ${MARKER} ─ ${progress} `
  const keys = keyLines().find((line) => line.length <= width - marker.length - 2)
  const head: Line[] = [
    clip([{ text: `${view.index + 1}/${view.total} `, fg: "muted" }, { text: lesson.title, fg: "heading", bold: true }, { text: `  ${lesson.why}`, fg: "muted" }], width),
    clip(state, width),
    clip([{ text: "─ ", fg: "muted" }, { text: MARKER, fg: "warning" }, { text: " ─ ", fg: "muted" }, { text: `${progress} `, fg: view.complete ? "success" : "text" }, ...(keys ? [{ text: `─ ${keys}`, fg: "muted" } as const] : [])], width),
  ]
  const size = sandboxSize(width, height)
  return [...head.map((line) => fit(line, width)), ...pad(input.sandbox(size.width, size.height), height - head.length, width)]
}

/** Screen-reader mode: the lesson as plain sentences, one per line, then the practice chat below. */
function accessibleLines(input: TutorialInput): Line[] {
  const { view, bindings, width, height } = input
  const lesson = view.lesson!
  const text = [`Lesson ${view.index + 1} of ${view.total}: ${lesson.title}.`, lesson.why, ...lesson.text(bindings), ...view.steps.map((step) => `${step.done ? "Done" : "To do"}: ${step.label}.`), view.complete ? "Lesson complete. Press Enter for the next lesson." : `Keys: ${keysLine().replace(/ · /g, ", ")}.`, `This is a practice chat: nothing here is real or saved.`]
  const lines = text.flatMap((part) => wrap(part, Math.max(10, width - 2)).map((piece) => row(piece)))
  const size = { width, height: Math.max(5, height - lines.length) }
  return pad([...lines, ...input.sandbox(size.width, size.height)], height, width)
}
