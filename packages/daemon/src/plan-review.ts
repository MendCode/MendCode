import { isPlanningOnlyPacket, redactSecrets, type PlanReviewRecord, type PlanReviewReply, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

/** Replays durable request/reply events, newest first; restart closes unfinished reviews, never applies them. */
export function readPlanReviews(store: Store, sessionId: SessionId, limit = 20): PlanReviewRecord[] {
  const records: PlanReviewRecord[] = []
  const replies = new Map<string, { at: number; reply: PlanReviewReply }>()
  let before: number | undefined
  let bytes = 0
  while (records.length < limit) {
    const events = store.readBefore(sessionId, before, 200)
    if (!events.length) break
    before = events[0]!.seq
    for (const event of events.reverse()) {
      if (event.type === "server.request.resolved" && event.planReview) replies.set(event.requestId, { at: event.at, reply: event.planReview })
      if (event.type !== "server.request" || !event.planReview) continue
      const answered = replies.get(event.requestId)
      const raw = answered?.reply ?? { kind: "plan_review" as const, action: "close" as const, reason: "Interrupted before a decision" }
      const reply = { ...raw, ...(raw.markdown ? { markdown: redactSecrets(raw.markdown).text } : {}), ...(raw.comments ? { comments: redactSecrets(raw.comments).text } : {}), ...(raw.reason ? { reason: redactSecrets(raw.reason).text } : {}) }
      const record: PlanReviewRecord = {
        ...event.planReview,
        ...(event.planReview.title ? { title: redactSecrets(event.planReview.title).text } : {}),
        markdown: redactSecrets(reply.markdown ?? event.planReview.markdown).text,
        destination: reply.destination ?? event.planReview.destination,
        phase: event.planReview.phase === "plan" || isPlanningOnlyPacket(reply.markdown ?? event.planReview.markdown) ? "plan" : "implementation",
        requestId: event.requestId, sessionId, turnId: event.turnId, createdAt: event.at,
        ...(answered ? { repliedAt: answered.at, reply } : {}),
      }
      bytes += Buffer.byteLength(JSON.stringify(record))
      if (bytes > 160_000 || records.length === limit) return records
      records.push(record)
      replies.delete(event.requestId)
    }
  }
  return records
}
