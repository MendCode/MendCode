import { realClock, type Clock } from "@mendcode/kernel"
import { claudeArgs, claudeQuota, controlRequest, controlResponse, userMessage, type ClaudeMessage, type QuotaDraft } from "./protocol"
import { spawnClaude, type ClaudeTransport } from "./transport"

/** The one user message of a probe. The turn is not one word in total: Claude Code adds its own system prompt and tool definitions (and the user's global instructions) to it. */
export const CLAUDE_PROBE_TEXT = "."
const DEFAULT_TIMEOUT_MS = 90_000

export type ClaudeQuotaProbe = {
  /** Claude Code's alias of the cheapest model (`haiku`), or the user's override. */
  model: string
  cwd: string
  bin?: string
  /** Extra variables for the process, such as MendCode's own Claude Code profile (`CLAUDE_CONFIG_DIR`). */
  env?: Record<string, string> | undefined
  clock?: Clock
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with the snapshot of each `rate_limit_event` Claude Code sends; the probe succeeds only when one arrives. */
  onQuota(snapshot: QuotaDraft): void
  transportFactory?(input: { args: string[]; cwd: string }): ClaudeTransport
}

/**
 * One throwaway Claude Code process running one minimal turn (Claude Code's own prompt plus one word): Claude Code reports the subscription's windows with a `rate_limit_event` during
 * a turn, and a turn is the only way it does. No tools, no saved session, no MendCode session: the process answers and is stopped.
 * It uses Claude Code's own login (`claude`), never a credential of ours. Resolves once the answer has ended; rejects when no
 * window was reported, the process failed or the time ran out.
 */
export async function probeClaudeQuota(options: ClaudeQuotaProbe): Promise<void> {
  const clock = options.clock ?? realClock
  // `--tools ""` leaves the model nothing to call and `--no-session-persistence` keeps Claude Code from saving the exchange.
  // `disableAllHooks`: the user's Claude Code hooks (a system notification when a turn ends, a session log) are for their own sessions, never for this probe.
  const args = [...claudeArgs({ model: options.model, permission: "plan" }), "--tools", "", "--no-session-persistence", "--settings", JSON.stringify({ disableAllHooks: true })]
  const transport = options.transportFactory?.({ args, cwd: options.cwd }) ?? spawnClaude({ bin: options.bin ?? "claude", args, cwd: options.cwd, env: options.env })
  let reported = false
  let failure: Error | undefined
  const timer = clock.setTimer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
    failure = new Error("[CLAUDE]: the probe timed out")
    transport.close()
  })
  const abort = () => { failure ??= new Error("[CLAUDE]: the probe was cancelled"); transport.close() }
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    // Like the engine, the message is sent only after Claude Code answered its initialize.
    transport.write(controlRequest("mend-probe-1", { subtype: "initialize" }))
    let sent = false
    for await (const line of transport.lines) {
      let message: ClaudeMessage
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === "control_response" && !sent) {
        sent = true
        transport.write(userMessage([{ type: "text", text: CLAUDE_PROBE_TEXT }]))
      } else if (message.type === "rate_limit_event") {
        const quota = claudeQuota(message.rate_limit_info, clock.now())
        if (quota) { options.onQuota(quota); reported = true }
      } else if (message.type === "control_request") {
        // Nothing may run: any permission question is refused.
        transport.write(controlResponse(message.request_id, { behavior: "deny", message: "A quota probe runs nothing." }))
      } else if (message.type === "result") break
    }
  } finally {
    timer.cancel()
    options.signal?.removeEventListener("abort", abort)
    transport.close()
  }
  if (failure) throw failure
  if (!reported) {
    const tail = transport.stderrTail().trim().split("\n").at(-1)?.slice(0, 160)
    throw new Error(`[CLAUDE]: Claude Code reported no rate limits${tail ? ` (${tail})` : ""}`)
  }
}
