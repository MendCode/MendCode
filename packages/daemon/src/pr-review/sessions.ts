import { MAX_DRAFT_CHARS, type BlobRef, type ModelChoice, type RequestId, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { ReviewSessionFactory, ReviewTurn } from "./engine"

/**
 * A review prompt as a message the session stores: one longer than a message may be (a large pull request's diff and
 * files) goes whole into a text attachment, which the native engine reads itself and other engines get put back in.
 */
export function reviewMessage(prompt: string, putText: (bytes: Uint8Array) => BlobRef): { text: string; attachments: BlobRef[] } {
  if (prompt.length <= MAX_DRAFT_CHARS) return { text: prompt, attachments: [] }
  return { text: "The review request (instructions and the pull request) is the attached text. Follow it.", attachments: [putText(new TextEncoder().encode(prompt))] }
}

/**
 * The review children the daemon runs (docs/pr-review.md): each `ReviewSession` is a hidden session in plan mode on the read-only
 * `explore` agent, so a review reads and searches but never edits or runs commands. A request for approval is refused (nobody is
 * there to answer), a turn is bounded by `timeoutMs`, and the answer is the turn's last message with the provider-reported tokens
 * of its calls. The session is removed once the review is done.
 */

export const REVIEW_AGENT = "explore"
const TURN_TIMEOUT_MS = 15 * 60_000

type Waiting = { text: string; message?: string; tokens: ReviewTurn["tokens"]; done(result: { ok: true; turn: ReviewTurn } | { ok: false; message: string }): void }

export function createReviewSessions(deps: {
  /** A hidden session in `directory` (a child of `owner` when given) on `REVIEW_AGENT`, with `model`, else the owner's model. */
  create(input: { owner?: string | undefined; directory: string; title: string; model?: ModelChoice | undefined; editing?: boolean }): SessionId
  /** Sets plan mode (unless `editing`) and submits `text` as the user's message. */
  submit(id: SessionId, text: string, editing?: boolean): Promise<void>
  deny(id: SessionId, requestId: RequestId, reason: string): void
  cancel(id: SessionId): Promise<void>
  remove(id: SessionId): void
  timeoutMs?: number
}) {
  const waiting = new Map<SessionId, Waiting>()
  const messages = new Map<SessionId, Set<string>>()
  const mine = new Set<SessionId>()
  const editors = new Set<SessionId>()

  /**
   * `editing` is `@mendcode fix`: a child on the default agent under the user's normal permission mode, whose approvals go to the
   * user like any session's instead of being refused, and which is kept (not removed) so its edits can be inspected.
   */
  function factory({ owner, directory, model, editing = false }: { owner?: string | undefined; directory: string; model?: ModelChoice | undefined; editing?: boolean }): ReviewSessionFactory {
    return async ({ purpose }) => {
      const id = deps.create({ owner, directory, model, editing, title: editing ? "PR fix" : purpose === "review" ? "PR review" : "PR review (verify)" })
      mine.add(id)
      if (editing) editors.add(id)
      return {
        async send(prompt) {
          const ended = new Promise<{ ok: true; turn: ReviewTurn } | { ok: false; message: string }>((resolve) => waiting.set(id, { text: "", tokens: { input: 0, output: 0, cached: 0 }, done: resolve }))
          const timer = setTimeout(() => { void deps.cancel(id); waiting.get(id)?.done({ ok: false, message: "[PR_REVIEW]: the review turn timed out" }) }, deps.timeoutMs ?? TURN_TIMEOUT_MS)
          try {
            await deps.submit(id, prompt, editing)
            const result = await ended
            if (!result.ok) throw new Error(result.message)
            return result.turn
          } finally { clearTimeout(timer); waiting.delete(id) }
        },
        async close() { waiting.delete(id); messages.delete(id); mine.delete(id); if (!editors.delete(id)) deps.remove(id) },
      }
    }
  }

  function observe(event: SessionEvent) {
    const entry = waiting.get(event.sessionId)
    if (!entry) return
    switch (event.type) {
      case "item.started":
        if (event.kind === "agent_message") { const set = messages.get(event.sessionId) ?? new Set(); set.add(event.itemId); messages.set(event.sessionId, set) }
        return
      case "item.completed":
        if (messages.get(event.sessionId)?.has(event.itemId) && event.status === "ok" && typeof event.text === "string") entry.text = event.text
        return
      case "usage.recorded":
        entry.tokens = { input: entry.tokens.input + event.input + event.cacheRead + event.cacheWrite, output: entry.tokens.output + event.output, cached: (entry.tokens.cached ?? 0) + event.cacheRead }
        return
      case "server.request":
        if (editors.has(event.sessionId)) return
        deps.deny(event.sessionId, event.requestId, "A PR review cannot ask for approval. Do not retry: answer from what you could read.")
        return
      case "turn.completed":
        return entry.done({ ok: true, turn: { text: entry.text, tokens: entry.tokens } })
      case "turn.failed":
        return entry.done({ ok: false, message: `[PR_REVIEW]: the review turn failed: ${event.error.message.slice(0, 300)}` })
      case "turn.cancelled":
      case "turn.interrupted":
        return entry.done({ ok: false, message: "[PR_REVIEW]: the review turn stopped" })
    }
  }

  return { factory, observe, isReview: (id: SessionId) => mine.has(id) }
}
export type ReviewSessions = ReturnType<typeof createReviewSessions>
