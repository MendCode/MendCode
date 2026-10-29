import { createInteractions } from "../../../packages/daemon/src/interactions"
import { createHttpInteractions } from "../../../packages/daemon/src/http-interactions"
import type { InteractionKind, PlanReviewRecord, SessionEvent } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export async function b88Harness(kind: InteractionKind, width = 100, height = 30) {
  const directory = "/work/mendcode"
  const requestId = ids("request"), turnId = ids("turn"), itemId = ids("item")
  const pending = createInteractions(() => directory)
  const saved: PlanReviewRecord[] = []
  const h = appHarness({ width, height, dataDir: tempDir(), directory, reply: (command) => {
    if (command.type === "plan.review.list") return { ok: true, result: { reviews: saved } }
    if (command.type === "agents.list") return { ok: true, result: { agents: [{ name: "build", mode: "primary", trusted: true }] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, (event: SessionEvent) => { pending.observe(event); h.app.onEvent(event) })
  const rest = createHttpInteractions({ body: (request) => request.json(), command: async (command) => {
    if (command.type === "interaction.list") return pending.list(directory, command.kind as InteractionKind)
    if (command.type !== "request.resolve") throw new Error("Unexpected frame fixture command")
    const decision = command.decision as { kind: string; action?: string; markdown?: string }
    if (kind === "plan-review") {
      const reply = decision as PlanReviewRecord["reply"]
      saved.push({ sessionId: h.sessionId, requestId, turnId, markdown: decision.markdown ?? "# Socket recovery\n\nKeep queued work while reconnecting.\nAdd bounded retries and a duplicate-reply regression.", title: "Socket recovery", destination: "build", phase: "implementation", createdAt: NOW, repliedAt: NOW + 1, ...(reply ? { reply } : {}) })
    }
    chat.emit({ type: "server.request.resolved", requestId, resolution: decision.kind === "deny" ? "denied" : "answered", ...(kind === "plan-review" ? { planReview: decision } : {}) })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: decision.kind === "plan_review" ? `Plan ${decision.action}` : decision.kind === "deny" ? "Request declined" : "Request answered" })
    chat.emit({ type: "turn.completed", turnId })
    await h.type("")
    return {}
  } })
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: kind === "permission" ? "read" : kind === "question" ? "question" : "plan_review" } })
  chat.emit({ type: "server.request", turnId, requestId, itemId, title: kind === "permission" ? "Read source" : kind === "question" ? "Recovery choices" : "Review plan", detail: kind === "permission" ? "src/socket.ts\n\nRead the reconnect handler." : "", kind: kind === "question" ? "question" : "approval",
    ...(kind === "permission" ? { tool: "read", permission: "read", permissionContext: { name: "read", patterns: ["src/socket.ts"], always: ["src/socket.ts"] } } : {}),
    ...(kind === "question" ? { questions: [{ header: "Strategy", question: "How should recovery run?", options: [{ label: "Retry", description: "Bounded retries" }, { label: "Stop", description: "Explicit restart" }], custom: false }, { header: "Checks", question: "Which regressions?", options: [{ label: "Socket" }, { label: "Queue" }], multiple: true }] } : {}),
    ...(kind === "plan-review" ? { planReview: { title: "Socket recovery", markdown: "# Socket recovery\n\nKeep queued work while reconnecting.\nAdd bounded retries and a duplicate-reply regression.", phase: "implementation", destination: "build" } } : {}),
  })
  await h.type("")
  const reply = (payload: unknown, action = "reply") => {
    const request = new Request(`http://127.0.0.1/${kind}/${requestId}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    return rest(request, new URL(request.url), { name: "fixture", hash: "fixture", readOnly: false }, directory)
  }
  return { ...h, requestId, reply }
}
