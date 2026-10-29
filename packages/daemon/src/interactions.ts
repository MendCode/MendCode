import { InteractionReport, MAX_FRAME_BYTES, redactSecrets } from "@mendcode/protocol"
import type { InteractionKind, SessionEvent, SessionId } from "@mendcode/protocol"

/** Only live requests: resolved events, cancellation and restart never reopen a prompt. */
export function createInteractions(directoryOf: (sessionId: SessionId) => string | undefined) {
  const pending = new Map<string, Extract<SessionEvent, { type: "server.request" }>>()
  const kindOf = (request: Extract<SessionEvent, { type: "server.request" }>): InteractionKind => request.planReview ? "plan-review" : request.kind === "question" ? "question" : "permission"
  function observe(event: SessionEvent) {
    if (event.type === "server.request") pending.set(event.requestId, event)
    if (event.type === "server.request.resolved") pending.delete(event.requestId)
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) {
      for (const [id, request] of pending) if (!request.async && request.sessionId === event.sessionId) pending.delete(id)
    }
  }
  function list(directory: string, kind: InteractionKind): InteractionReport {
    const requests: InteractionReport["requests"] = []
    for (const request of pending.values()) {
      if (directoryOf(request.sessionId) !== directory || kindOf(request) !== kind) continue
      const base = { id: request.requestId, sessionID: request.sessionId, ...(request.itemId ? { tool: { messageID: request.itemId, callID: request.itemId } } : {}) }
      const value = request.planReview ? { ...base, markdown: request.planReview.markdown, ...(request.planReview.title ? { title: request.planReview.title } : {}) }
        : request.kind === "question" ? { ...base, questions: request.questions ?? [{ header: request.title.slice(0, 30) || "Question", question: (request.detail || request.title).slice(0, 500), options: request.options ?? [], ...(request.multiple !== undefined ? { multiple: request.multiple } : {}) }] }
        : { ...base, permission: request.permissionContext?.name ?? request.tool ?? request.permission ?? "approval", patterns: request.permissionContext?.patterns ?? [], always: request.permissionContext?.always ?? [], metadata: { title: request.title, detail: request.detail } }
      requests.push(JSON.parse(redactSecrets(JSON.stringify(value)).text))
    }
    const report = InteractionReport.parse({ requests })
    // Never truncate pending requests silently: the caller must know a reply target is missing.
    if (Buffer.byteLength(JSON.stringify(report)) > MAX_FRAME_BYTES - 1024) throw new Error("Pending requests exceed the response limit")
    return report
  }
  /** One live request by id (an approval's tool, detail and permission context). */
  const get = (requestId: string) => pending.get(requestId)
  return { observe, list, get }
}
