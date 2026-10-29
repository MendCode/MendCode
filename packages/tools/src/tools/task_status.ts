import { z } from "zod"
import { defineTool } from "../tool"
import { binaryOutputNote, fail, truncateHeadTail } from "../util"
import { describeTask } from "./shell_output"

const DEFAULT_TAIL_CHARS = 2_000
const MAX_TAIL_CHARS = 20_000
/** Background shell task ids (`bg_…`, see background.ts); any other id names a workflow. */
const BACKGROUND_ID = /^bg_/

export default defineTool({
  name: "task_status",
  description:
    "Status of this session's background shell tasks and workflows (id from workflow_start), without waiting or consuming output; without id, lists both. With an id: state, exit code, how much output is unread and its end. Child tasks: task_id with action list/get/cancel/wait (a wait defaults to 30000 ms, max 300000). Do not poll in a loop: shell_output with waitMs waits.",
  permission: "read",
  args: z.object({
    task_id: z.string().optional(),
    action: z.enum(["list", "get", "wait", "cancel"]).optional(),
    timeout_ms: z.number().int().min(1).max(300_000).optional(),
    id: z.string().min(1).max(200).optional().describe("A background task id (bg_…) or a workflow id; omit to list everything"),
    tailChars: z.number().int().min(0).max(MAX_TAIL_CHARS).optional().describe(`Characters of a task's output to show from its end (default ${DEFAULT_TAIL_CHARS})`),
  }),
  async execute({ id, tailChars, task_id, action, timeout_ms }, context) {
    if (task_id || action) {
      if (!context.taskStatus) return fail({ title: "task_status", message: "child tasks are not available here" })
      if (action && action !== "list" && !task_id) return fail({ title: "task_status", message: "task_id required for get, wait and cancel" })
      try { return { output: await context.taskStatus({ task_id, action, timeout_ms }), title: "child task", truncated: false, isError: false } }
      catch (error) { return fail({ title: "task_status", message: String(error) }) }
    }
    if (id && !BACKGROUND_ID.test(id)) {
      if (!context.workflows) return fail({ title: `task_status ${id}`, message: "workflows are not available here" })
      return { output: await context.workflows.status(id), truncated: false, title: `workflow ${id}`, isError: false }
    }
    if (id) {
      if (!context.background) return fail({ title: "task_status", message: "background tasks are not available here" })
      const peek = context.background.peek(id, tailChars ?? DEFAULT_TAIL_CHARS)
      if (!peek) return fail({ title: `task_status ${id}`, message: `unknown task ${id}` })
      const binary = binaryOutputNote({ text: peek.tail })
      const capped = binary ? { text: binary, truncated: false } : truncateHeadTail({ text: peek.tail, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      const lines = [`${describeTask(peek.task)} · ${peek.task.command}`, `${peek.unread} characters of output not read yet`, capped.text ? `--- end of output ---\n${capped.text}` : "(no output yet)"]
      return {
        output: lines.join("\n"),
        truncated: capped.truncated,
        title: `${peek.task.id} · ${peek.task.status}`,
        isError: false,
        meta: { taskId: peek.task.id, status: peek.task.status, unread: peek.unread, ...(peek.task.exitCode !== undefined ? { exitCode: peek.task.exitCode } : {}) },
      }
    }
    const tasks = context.background?.list() ?? []
    const sections = [`Background tasks:\n${tasks.length ? tasks.map((task) => `${describeTask(task)} · ${task.command}`).join("\n") : "none"}`]
    if (context.taskStatus) sections.push(`Child tasks:\n${await context.taskStatus({ action: "list" })}`)
    if (context.workflows) sections.push(`Workflows:\n${await context.workflows.status()}`)
    return { output: sections.join("\n\n"), truncated: false, title: "task status", isError: false, meta: { background: tasks.length, running: tasks.filter((task) => task.status === "running").length } }
  },
})
