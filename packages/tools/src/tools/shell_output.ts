import { z } from "zod"
import type { BackgroundTaskInfo } from "../background"
import { defineTool } from "../tool"
import { binaryOutputNote, fail, truncateHeadTail } from "../util"

const MAX_WAIT_MS = 30_000
/** Waiting for the exit may take as long as a foreground `shell` command may run (its default and its ceiling). */
const DEFAULT_EXIT_WAIT_MS = 120_000
const MAX_EXIT_WAIT_MS = 600_000

/** "bg_1 running 42s" / "bg_1 exited 0 after 3m 5s" / "bg_1 killed (lifetime)". */
export function describeTask(task: BackgroundTaskInfo, now = Date.now()) {
  const seconds = Math.round(((task.endedAt ?? now) - task.startedAt) / 1_000)
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  if (task.status === "running") return `${task.id} running ${duration}`
  if (task.status === "killed") return `${task.id} killed${task.killedBy && task.killedBy !== "agent" ? ` (${task.killedBy})` : ""} after ${duration}`
  return `${task.id} exited ${task.exitCode ?? -1} after ${duration}`
}

export default defineTool({
  name: "shell_output",
  description:
    "Unread output of a background shell task and whether it still runs. waitMs (max 30000) returns at the first output or the exit; until: \"exit\" waits for the end (waitMs then defaults to 120000, max 600000) and adds the exit status. Exits are announced unasked, so keep working; wait for one only when nothing else can proceed. An exit read here is not announced again. Without id, lists this session's tasks.",
  permission: "read",
  args: z.object({
    id: z.string().optional().describe("Task id from shell with background: true"),
    waitMs: z.number().int().min(0).max(MAX_EXIT_WAIT_MS).optional().describe("Wait up to this long (default 0 and at most 30000 for output; default 120000 and at most 600000 with until: \"exit\")"),
    until: z.enum(["output", "exit"]).optional().describe("What ends the wait: new output or the exit (default), or only the exit"),
  }),
  async execute({ id, waitMs, until }, context) {
    if (!context.background) return fail({ title: "shell_output", message: "background tasks are not available here" })
    if (!id) {
      const tasks = context.background.list()
      return { output: tasks.length ? tasks.map((task) => `${describeTask(task)} · ${task.command}`).join("\n") : "no background tasks", truncated: false, title: "background tasks", isError: false }
    }
    const wait = until === "exit" ? Math.min(waitMs ?? DEFAULT_EXIT_WAIT_MS, MAX_EXIT_WAIT_MS) : Math.min(waitMs ?? 0, MAX_WAIT_MS)
    const read = await context.background.read(id, { waitMs: wait, signal: context.signal, ...(until === "exit" ? { until } : {}) })
    if (!read) return fail({ title: `shell_output ${id}`, message: `unknown task ${id}` })
    const binary = binaryOutputNote({ text: read.output })
    const capped = binary ? { text: binary, truncated: false } : truncateHeadTail({ text: read.output, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
    const lines = [describeTask(read.task), ...(read.dropped ? [`[${read.dropped} earlier characters scrolled out unread]`] : []), capped.text || "(no new output)"]
    return {
      output: lines.join("\n"),
      truncated: capped.truncated,
      title: `${read.task.id} · ${read.task.status}`,
      isError: false,
      meta: { taskId: read.task.id, status: read.task.status, ...(read.task.exitCode !== undefined ? { exitCode: read.task.exitCode } : {}) },
    }
  },
})
