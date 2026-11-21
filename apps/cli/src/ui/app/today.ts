import type { SessionId } from "@mendcode/protocol"
import type { AppContext } from "./context"

/**
 * `/today` (docs/today.md): opens the Today chat of this day. The daemon makes it on the first `/today` of the day and gives it
 * Today's instructions and tool; this terminal only switches to it and, for a chat with no turn yet, sends the first message the
 * daemon hands back, so the session's own model writes the brief. Everything after that is the chat: the user asks Today to
 * accept or decline memories, to decide them from now on, or to report something in every Today.
 * Loaded by its first command, not at start-up; it draws no page of its own.
 */
export function createToday(ctx: AppContext, deps: { switchSession(sessionId: SessionId): Promise<void> }) {
  const { input, fail, say, requestFrame } = ctx
  /** A second `/today` while the first is opening does nothing: one chat, one first message. */
  let opening = false

  async function command(args: string) {
    if (args.trim()) return say("usage: /today", "warning")
    if (opening) return
    opening = true
    try {
      const reply = await input.send({ type: "today.open", ...(input.directory ? { directory: input.directory } : {}) })
      if (!reply.ok) return fail(reply.error.message.replace(/^\[[A-Z_-]+\]:\s*/, ""))
      const sessionId = reply.result?.sessionId
      if (typeof sessionId !== "string") return fail("the Today chat was not opened")
      await deps.switchSession(sessionId as SessionId)
      const kickoff = reply.result?.kickoff
      if (typeof kickoff !== "string" || !kickoff) return
      const sent = await input.send({ type: "user.submit", sessionId: sessionId as SessionId, text: kickoff, attachments: [] })
      if (!sent.ok) fail(`Today is open, but its brief could not start: ${sent.error.message.replace(/^\[[A-Z_-]+\]:\s*/, "")}`)
    } catch (error) {
      fail(`the daemon did not answer: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      opening = false
      requestFrame()
    }
  }

  return { command }
}
