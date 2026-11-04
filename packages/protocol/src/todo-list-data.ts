/**
 * The one shape every engine's task list takes in a session (docs/layout.md, "The visible plan"): a tool card titled
 * `todo <done>/<total>` whose text is one `[x] item` line per item. The native `todo` tool writes it; Claude Code's TodoWrite and
 * TaskCreate/TaskUpdate, Codex's plan updates and an ACP agent's plan are turned into it by their engines, so the progress row, the
 * dock and the card read every engine's list the same way. Data and pure functions only.
 */

export type TodoListStatus = "pending" | "in_progress" | "done" | "cancelled"
export type TodoListItem = { text: string; status: TodoListStatus; priority?: "high" | "medium" | "low" }

/** The tool name the card is titled with, whichever engine kept the list. */
export const TODO_LIST_TOOL = "todo"

const MARK: Readonly<Record<TodoListStatus, string>> = { pending: "[ ]", in_progress: "[~]", done: "[x]", cancelled: "[-]" }

/** An engine's own status word as one of the four: `completed` is done, `inProgress` is in progress, anything unknown is pending. */
export function todoListStatus(status: unknown): TodoListStatus {
  if (status === "done" || status === "completed") return "done"
  if (status === "in_progress" || status === "inProgress") return "in_progress"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  return "pending"
}

/**
 * The card of a list: its title (`todo 2/5`, finished items over the ones not cancelled, as the progress row counts them) and its
 * checklist text, one line per item, cancelled ones included.
 */
export function todoListCard(items: readonly TodoListItem[]): { title: string; text: string } {
  const counted = items.filter((item) => item.status !== "cancelled")
  const done = counted.filter((item) => item.status === "done").length
  return {
    title: `${TODO_LIST_TOOL} ${done}/${counted.length}`,
    text: items.map((item) => `${MARK[item.status]} ${item.priority ? `(${item.priority}) ` : ""}${item.text.replace(/\s+/g, " ").trim()}`).join("\n"),
  }
}

/** The checklist text of a card (`todoListCard`) back as items; lines that are not checklist lines are skipped. */
export function parseTodoListText(text: string): TodoListItem[] {
  const items: TodoListItem[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*\[([ xX~-])\]\s+(.*)$/.exec(line)
    if (!match) continue
    const mark = match[1]!.toLowerCase()
    const priority = /^\((high|medium|low)\) (.*)$/.exec(match[2]!)
    items.push({ text: (priority?.[2] ?? match[2]!).trim(), status: mark === "x" ? "done" : mark === "~" ? "in_progress" : mark === "-" ? "cancelled" : "pending", ...(priority ? { priority: priority[1] as NonNullable<TodoListItem["priority"]> } : {}) })
  }
  return items
}
