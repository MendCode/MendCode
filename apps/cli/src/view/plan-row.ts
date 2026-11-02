import { parseTodoText, type TodoItem } from "./dock"
import type { Block } from "./transcript"

/** Every engine's list arrives as a finished `todo d/n` card, shared by the dock and sidebar. */
const TODO_TITLE = /^todo(?:\s|$)/

/** A running or failed call keeps the previous list; a finished empty list clears it. */
export function latestTodos(blocks: readonly Block[]): TodoItem[] {
  const card = blocks.findLast((block) => block.kind === "tool_call" && block.status === "ok" && TODO_TITLE.test(block.title ?? ""))
  return card ? parseTodoText(card.text) : []
}
