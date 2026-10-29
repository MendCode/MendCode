import { z } from "zod"
import { defineTool } from "../tool"
import { cancelled } from "../util"

export const MAX_SLEEP_MS = 300_000

export default defineTool({
  name: "sleep",
  description:
    "Wait without running a command (polling a deploy, letting a dev server boot, spacing out retries). Max 300000 ms per call; a turn cancel ends it at once. Prefer shell_output with waitMs when waiting for a background task's output.",
  permission: "read",
  args: z.object({
    ms: z.number().int().min(1).max(MAX_SLEEP_MS).describe("How long to wait, in milliseconds"),
    reason: z.string().optional().describe("What you are waiting for (shown on the card)"),
  }),
  async execute({ ms, reason }, context) {
    const title = `sleep ${ms >= 1_000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`}${reason ? ` · ${reason.slice(0, 60)}` : ""}`
    if (context.signal.aborted) return cancelled(title)
    const started = Date.now()
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        context.signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      context.signal.addEventListener("abort", done, { once: true })
    })
    if (context.signal.aborted) return cancelled(title)
    return { output: `waited ${Date.now() - started} ms`, truncated: false, title, isError: false, meta: { waitedMs: Date.now() - started } }
  },
})
