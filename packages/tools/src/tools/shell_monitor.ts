import { z } from "zod"
import { defineTool } from "../tool"
import { fail } from "../util"

/**
 * Watching a task only reads output of a command that was already approved when it started, like shell_output, so it
 * needs no approval. Matching is plain case-insensitive text, never a regular expression the model wrote.
 */
export default defineTool({
  name: "shell_monitor",
  description:
    "Push-style monitor of a background shell task: while it runs, output lines that contain any of the given texts (every new line when none) arrive as messages in batches, after your next tool result in this turn or in a new turn if your answer ended first, so you can keep working instead of polling shell_output. " +
    "Use it for 'tell me when the dev server is ready or errors' (match: [\"ready\", \"error\"]). A monitor stops when the task exits, when you set stop, or after 30 messages.",
  permission: "read",
  args: z.object({
    id: z.string().min(1).describe("Task id from shell with background: true"),
    match: z.array(z.string().min(1).max(100)).max(8).optional().describe("Texts to look for (case-insensitive substrings); omit to receive every new line"),
    stop: z.boolean().optional().describe("Stop monitoring this task"),
  }),
  async execute({ id, match, stop }, context) {
    if (!context.background) return fail({ title: "shell_monitor", message: "background tasks are not available here" })
    const result = context.background.watch(id, { match: match ?? [], ...(stop ? { stop: true } : {}) })
    if (!result) return fail({ title: `shell_monitor ${id}`, message: `unknown task ${id}` })
    if (!result.ok) return fail({ title: `shell_monitor ${id}`, message: result.error })
    const output = result.watching
      ? `monitoring ${id}${match?.length ? ` for ${match.map((text) => JSON.stringify(text)).join(", ")}` : " (every new line)"}; matching lines arrive as messages after your next tool result, or in a new turn if you have answered`
      : `stopped monitoring ${id}`
    return { output, truncated: false, title: `monitor ${id}`, isError: false, meta: { taskId: id, watching: result.watching } }
  },
})
