import type { PlanReviewRecord } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export async function planHarness(width = 100, height = 30, phase: "plan" | "implementation" = "implementation", failure = false, remote?: { host: string; readOnly: boolean }, extra: { markdown?: string; mode?: "minimal" | "balanced" | "full"; screen?: NonNullable<Parameters<typeof appHarness>[0]>["screen"] } = {}, intercept?: NonNullable<Parameters<typeof appHarness>[0]>["reply"]) {
  const requestId = ids("request")
  const turnId = ids("turn")
  const markdown = extra.markdown ?? "# Socket recovery\n\nKeep queued work while the socket reconnects.\n\n## Changes\n\n1. Inspect `packages/client/src/index.ts`.\n2. Bound reconnect retries and preserve pending ids.\n3. Add cancellation and duplicate-reply tests.\n\n| State | Action |\n| --- | --- |\n| Offline | Keep queued work |\n| Reconnected | Replay once |\n\n## Verification\n\nRun typecheck and local socket tests."
  let saved: PlanReviewRecord[] = []
  const h = appHarness({ width, height, dataDir: tempDir(), ...(extra.mode ? { mode: extra.mode } : {}), ...(extra.screen ? { screen: extra.screen } : {}), ...(remote ? { remote } : {}), reply: (command) => {
    const forced = intercept?.(command)
    if (forced) return forced
    if (command.type === "agents.list") return { ok: true, result: { agents: [{ name: "build", mode: "primary", trusted: true }, { name: "executor", mode: "primary", trusted: true }, { name: "scout", mode: "subagent", trusted: true }] } }
    if (command.type === "plan.review.list") return { ok: true, result: { reviews: saved } }
    if (command.type === "request.resolve" && command.decision.kind === "plan_review") {
      if (failure) return { ok: false, error: { code: "target_mismatch", message: "Destination no longer trusted" } }
      saved = [{ requestId, turnId, sessionId: h.sessionId, markdown: command.decision.markdown ?? markdown, phase, destination: command.decision.destination ?? "build", title: "Socket recovery", createdAt: NOW, reply: command.decision }]
      chat.emit({ type: "server.request.resolved", requestId, resolution: "approved", planReview: command.decision })
    }
    return undefined
  } })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "server.request", turnId, requestId, title: "Review plan", detail: "", kind: "approval", planReview: { title: "Socket recovery", markdown, phase, destination: "build" } })
  await Bun.sleep(5)
  h.app.render()
  return { ...h, chat, markdown, requestId }
}


/** A daemon whose strict schema does not know the `permission` field of a plan reply: the client's own answer to that is "it may be an older build". */
export async function planHarnessSkewed(message = "daemon rejected request.resolve · it may be an older build · /daemon restart") {
  const base = await planHarness(100, 30, "implementation", false, undefined, {}, (command) => command.type === "request.resolve" && command.decision.kind === "plan_review" && "permission" in command.decision ? { ok: false, error: { code: "invalid_command", message } } : undefined)
  return base
}
