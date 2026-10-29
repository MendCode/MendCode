import { z } from "zod"
import { defineTool } from "../tool"
import { fail } from "../util"

/**
 * Stops a background task this session started. It needs no approval of its own: it can only end a
 * command that was already approved when it was started.
 */
export default defineTool({
  name: "shell_kill",
  description: "Stop a background shell task (SIGTERM, then SIGKILL after 2 s). No exit message follows for tasks you stop.",
  permission: "read",
  args: z.object({ id: z.string().min(1).describe("Task id from shell with background: true") }),
  async execute({ id }, context) {
    if (!context.background) return fail({ title: "shell_kill", message: "background tasks are not available here" })
    const task = context.background.kill(id)
    if (!task) return fail({ title: `shell_kill ${id}`, message: `unknown task ${id}` })
    const output = task.status === "running" ? `stopping ${id}` : `${id} had already ${task.status === "killed" ? "been stopped" : `exited ${task.exitCode ?? -1}`}`
    return { output, truncated: false, title: `kill ${id}`, isError: false, meta: { taskId: id } }
  },
})
