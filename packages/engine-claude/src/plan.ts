import { todoListCard, todoListStatus, type TodoListItem } from "@mendcode/protocol"

/**
 * Claude Code's task lists as MendCode's one list shape (`todoListCard`), so the progress row, the dock and the todo card show them.
 * TodoWrite sends the whole list each call (`todos: [{content, status, activeForm}]`). TaskCreate (`{subject, activeForm?}`, answered
 * `Task #<id> created successfully: <subject>`) and TaskUpdate (`{taskId, status?, subject?, activeForm?}`, `deleted` removes it) change
 * one task each: the list they add up to lives as long as the session's Claude Code process. The item in progress reads as its
 * `activeForm` ("Running the tests"), as Claude Code's own screen shows it.
 */
export type ClaudeTask = { subject: string; activeForm?: string; status: TodoListItem["status"] }

/** The tools whose calls change the list. */
export const CLAUDE_PLAN_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"])

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")

const itemOf = (task: ClaudeTask): TodoListItem => ({ text: (task.status === "in_progress" && task.activeForm) || task.subject, status: task.status })

/** TodoWrite's list; items without text are left out. */
export function todoWriteItems(args: Record<string, unknown> | undefined): TodoListItem[] {
  const todos = Array.isArray(args?.todos) ? args.todos : []
  return todos.flatMap((todo): TodoListItem[] => {
    if (!todo || typeof todo !== "object") return []
    const { content, status, activeForm } = todo as Record<string, unknown>
    const subject = text(content)
    return subject ? [itemOf({ subject, status: todoListStatus(status), ...(text(activeForm) ? { activeForm: text(activeForm) } : {}) })] : []
  })
}

export function createClaudePlan() {
  /** By Claude Code's task id, in creation order. */
  const tasks = new Map<string, ClaudeTask>()
  return {
    /**
     * The card a finished call of a plan tool leaves (title `todo d/n` and the checklist), or undefined when the call is not one,
     * failed, or changed nothing that can be shown. `result` is the call's result text (TaskCreate's names the new id).
     */
    apply(name: string, args: Record<string, unknown> | undefined, result: string): { title: string; text: string } | undefined {
      if (name === "TodoWrite") return todoListCard(todoWriteItems(args))
      if (name === "TaskCreate") {
        const id = /Task #(\S+) created/.exec(result)?.[1]
        const subject = text(args?.subject) || /created successfully: (.+)$/m.exec(result)?.[1]?.trim()
        if (!id || !subject) return undefined
        tasks.set(id, { subject, status: "pending", ...(text(args?.activeForm) ? { activeForm: text(args?.activeForm) } : {}) })
      } else if (name === "TaskUpdate") {
        const id = text(args?.taskId)
        if (!id) return undefined
        if (args?.status === "deleted") tasks.delete(id)
        else {
          // A task created before this process (a resumed session) is known from its first update on.
          const was = tasks.get(id) ?? { subject: text(args?.subject) || `Task #${id}`, status: "pending" as const }
          tasks.set(id, {
            ...was,
            ...(text(args?.subject) ? { subject: text(args?.subject) } : {}),
            ...(text(args?.activeForm) ? { activeForm: text(args?.activeForm) } : {}),
            ...(typeof args?.status === "string" ? { status: todoListStatus(args.status) } : {}),
          })
        }
      } else return undefined
      return todoListCard([...tasks.values()].map(itemOf))
    },
  }
}

export type ClaudePlan = ReturnType<typeof createClaudePlan>
