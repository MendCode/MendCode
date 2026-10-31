import { describe, expect, test } from "bun:test"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { createReviewSessions, ReviewTurnError, turnFailureKind } from "../src/pr-review/sessions"

const NOW = Date.UTC(2026, 9, 30, 12, 0)

describe("turnFailureKind", () => {
  test("usage-limit wording from Claude Code, Codex and the native engine is quota, even when it came as a 429", () => {
    for (const message of [
      "[CLAUDE]: Claude AI usage limit reached|1793361600",
      "[CLAUDE]: You've hit your limit · resets 9pm (America/Panama)",
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 3 days 2 hours.",
      "[ENGINE]: [PROVIDER]: openai 429 {\"error\":{\"code\":\"usage_limit_reached\"}}",
      "[ENGINE]: [PROVIDER]: openai 429 You exceeded your current quota, please check your plan and billing details. insufficient_quota",
    ]) expect({ message, kind: turnFailureKind(message) }).toEqual({ message, kind: "quota" })
    expect(turnFailureKind("faux 429 something", "usage_limit_reached")).toBe("quota")
  })
  test("a throttle the engine gave up retrying is rate_limit; anything else is error", () => {
    for (const message of [
      "[CLAUDE]: API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-minute rate limit\"}}",
      "[CLAUDE]: API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
      "exceeded retry limit, last status: 429 Too Many Requests",
      "[ENGINE]: [PROVIDER]: anthropic 429 rate_limit_error",
    ]) expect({ message, kind: turnFailureKind(message) }).toEqual({ message, kind: "rate_limit" })
    expect(turnFailureKind("[CLAUDE]: claude exited during the turn", "claude_exited")).toBe("error")
    expect(turnFailureKind("[ENGINE]: stopped after 40 model steps", "max_steps")).toBe("error")
  })
})

/** The review children with fake daemon hooks; `fail` ends the next submitted turn with that error. */
function children() {
  const removed: string[] = []
  let next = 0
  let fail: { code: string; message: string } | undefined
  const sessions = createReviewSessions({
    create: () => `ses_${++next}` as SessionId,
    submit: async (id) => {
      const at = { sessionId: id, seq: 1, at: NOW, turnId: "turn_1" } as const
      queueMicrotask(() => sessions.observe((fail ? { ...at, type: "turn.failed", error: fail } : { ...at, type: "turn.completed" }) as unknown as SessionEvent))
    },
    deny: () => {},
    cancel: async () => {},
    remove: (id) => { removed.push(id) },
    now: () => NOW,
  })
  return { sessions, removed, failWith: (error: { code: string; message: string }) => { fail = error } }
}

describe("review and fix sessions", () => {
  test("a fix session exposes its id and is kept after close; a review child is removed", async () => {
    const { sessions, removed } = children()
    const fix = await sessions.factory({ directory: "/x", editing: true })({ purpose: "review" })
    const review = await sessions.factory({ directory: "/x" })({ purpose: "review" })
    expect([fix.id, review.id] as string[]).toEqual(["ses_1", "ses_2"])
    await fix.send("fix it")
    await fix.close()
    await review.close()
    expect(removed).toEqual(["ses_2"])
  })

  test("a turn that hit the usage limit throws a ReviewTurnError of kind quota with the reset it names, so the job checkpoints", async () => {
    const { sessions, failWith } = children()
    failWith({ code: "claude_turn_failed", message: `[CLAUDE]: Claude AI usage limit reached|${NOW / 1000 + 3600}` })
    const session = await sessions.factory({ directory: "/x" })({ purpose: "review" })
    const error = await session.send("review").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReviewTurnError)
    const turn = error as ReviewTurnError
    expect({ kind: turn.kind, resetsAt: turn.resetsAt }).toEqual({ kind: "quota", resetsAt: NOW + 3_600_000 })
    expect(turn.message).toStartWith("[PR_REVIEW]: the review turn failed: ")
    failWith({ code: "provider_error", message: "[ENGINE]: boom" })
    const other = await session.send("again").catch((caught: unknown) => caught) as ReviewTurnError
    expect({ kind: other.kind, resetsAt: other.resetsAt }).toEqual({ kind: "error", resetsAt: undefined })
  })
})
