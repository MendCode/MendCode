import type { Line } from "../ui/theme"
import { parseTodoText, type TodoItem } from "./dock"
import type { Block } from "./transcript"
import { textWidth, truncateEnd } from "./wrap"

/**
 * The visible plan (feature `visible_plan`, docs/layout.md "The visible plan"): one muted row above the prompt with the item the
 * agent works on and how far the list is, while it has open items. Every engine's list arrives as the same card (`todo d/n`, the
 * native tool's, or Claude Code's TodoWrite and tasks, Codex's plan, an ACP agent's plan, which their engines turn into it).
 */

/** A list card's title: `todo` while the call runs, `todo 2/5` once it has finished. */
const TODO_TITLE = /^todo(?:\s|$)/

/**
 * The session's current list: the newest finished `todo` card. A call still running has no list yet and a failed one changed
 * nothing, so neither hides the list before it; a finished empty list (`[]`) clears it.
 */
export function latestTodos(blocks: readonly Block[]): TodoItem[] {
  const card = blocks.findLast((block) => block.kind === "tool_call" && block.status === "ok" && TODO_TITLE.test(block.title ?? ""))
  return card ? parseTodoText(card.text) : []
}

export type PlanProgress = { current: TodoItem; done: number; total: number }

/**
 * What the row says: the item in progress (else the next pending one), and the finished items over the ones not cancelled.
 * Undefined when nothing is open: an empty list, or every item done or cancelled.
 */
export function planProgress(items: readonly TodoItem[]): PlanProgress | undefined {
  const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending")
  if (!current) return undefined
  const counted = items.filter((item) => item.status !== "cancelled")
  return { current, done: counted.filter((item) => item.status === "done").length, total: counted.length }
}

/** Below this many cells for the item's text the row keeps its mark and count only. */
const MIN_ITEM_CELLS = 8

/**
 * The row's spans in `width` cells (the caller adds the prompt's inset): `▸ Writing the tests · 3/7`, the item cut with `…` before
 * the count gives way. ASCII chrome marks with `>` and `-`; a screen reader (`plain`) gets words without marks:
 * `Plan: Writing the tests, 3 of 7 done`.
 */
export function planRow({ progress, width, sep = "·", ascii = false, plain = false }: { progress: PlanProgress; width: number; sep?: string; ascii?: boolean; plain?: boolean }): Line {
  const { current, done, total } = progress
  if (plain) {
    const tail = `, ${done} of ${total} done`
    const room = width - textWidth("Plan: ") - textWidth(tail)
    return [{ text: room >= MIN_ITEM_CELLS ? `Plan: ${truncateEnd(current.text, room)}${tail}` : truncateEnd(`Plan: ${done} of ${total} done`, width), fg: "muted" }]
  }
  const mark = current.status === "in_progress" ? (ascii ? ">" : "▸") : ascii ? "-" : "□"
  const count = `${done}/${total}`
  const between = ` ${sep} `
  const room = width - textWidth(mark) - 1 - textWidth(between) - textWidth(count)
  if (room < MIN_ITEM_CELLS) return [{ text: truncateEnd(`${mark} ${count}`, width), fg: "muted" }]
  return [
    { text: `${mark} `, fg: "muted" },
    { text: truncateEnd(current.text, room), fg: "muted" },
    { text: between, fg: "muted" },
    { text: count, fg: "muted" },
  ]
}
