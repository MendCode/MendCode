import { describe, expect, test } from "bun:test"
import type { SessionEventDraft } from "@mendcode/kernel"
import type { Command, RequestId, SessionId, TurnId } from "@mendcode/protocol"
import { createChildElevation, isHumanTerminal } from "../src/child-elevation"
import type { AgentOrigin } from "../src/agent-origin"

const origin: AgentOrigin = { via: "process", sessionId: "ses_launcher" }
const child = "ses_child" as SessionId

function harness(input: { humans?: SessionId[]; fresh?: boolean; waitMs?: number } = {}) {
  const events: SessionEventDraft[] = []
  const applied: Array<{ child: string; mode: string }> = []
  let n = 0
  const elevation = createChildElevation({
    humanSessions: () => input.humans ?? ["ses_launcher" as SessionId],
    turnOf: () => "turn_running" as TurnId,
    requestId: () => `req_${++n}` as RequestId,
    turnId: () => "turn_new" as TurnId,
    emit: (event) => void events.push(event),
    mask: (_sessionId, text) => text.replaceAll("sk-secret", "[secret]"),
    facts: () => ({ title: "owner", directory: "/work/tree", model: "openai/gpt-6.1-terra (effort medium)", maxTurns: 25 }),
    fresh: () => input.fresh ?? true,
    apply: async (id, mode) => void applied.push({ child: id, mode }),
    ...(input.waitMs ? { waitMs: input.waitMs } : {}),
  })
  const card = () => events.find((event): event is Extract<SessionEventDraft, { type: "server.request" }> => event.type === "server.request")
  const resolve = (decision: Extract<Command, { type: "request.resolve" }>["decision"], human = true) =>
    elevation.resolve({ v: 1, id: "cmd_1", clientId: "cli_owner", type: "request.resolve", sessionId: card()!.sessionId, requestId: card()!.requestId, decision } as never, human)
  const ask = (mode: "smart" | "edits" | "full" = "smart", startedByCaller = true) => elevation.request({ origin, child, mode, ceiling: "ask", text: "fix the flaky test sk-secret", images: 0, startedByCaller, alive: () => true })
  return { elevation, events, applied, card, resolve, ask }
}

const submit = (text: string): Command => ({ v: 1, id: "cmd_s", clientId: "cli_agent", type: "user.submit", sessionId: child, text, attachments: [] }) as never

describe("a child above the caller's mode, put to the user", () => {
  test("approved: one card with model, folder, mode, title and prompt; the mode is set and only that prompt goes through", async () => {
    const h = harness()
    const asked = h.ask()
    const card = h.card()!
    expect(card).toMatchObject({ sessionId: "ses_launcher", kind: "question", async: true, turnId: "turn_running" })
    const context = card.questions![0]!.context!
    for (const part of ["owner", "openai/gpt-6.1-terra (effort medium)", "/work/tree", "smart", "at most 25 turns", "fix the flaky test"]) expect(context).toContain(part)
    expect(context).not.toContain("sk-secret")
    expect(h.resolve({ kind: "answer", text: "Approve once", answers: [["Approve once"]] })).toEqual({ ok: true })
    expect(await asked).toBeUndefined()
    expect(h.applied).toEqual([{ child, mode: "smart" }])
    expect(h.events.at(-1)).toMatchObject({ type: "server.request.resolved", resolution: "approved" })

    expect(h.elevation.check(origin, submit("something else"), "ask")).toContain("one prompt")
    expect(h.elevation.check(origin, submit("fix the flaky test sk-secret"), "ask")).toBeUndefined()
    // Used once: the same text again is more work, and is refused.
    expect(h.elevation.check(origin, submit("fix the flaky test sk-secret"), "ask")).toContain("one prompt")
    expect(h.elevation.check(origin, { v: 1, id: "c", clientId: "c", type: "session.model.set", sessionId: child } as never, "ask")).toContain("one prompt")
    expect(h.elevation.check(origin, { v: 1, id: "c", clientId: "c", type: "session.permission.set", sessionId: child, mode: "smart" } as never, "ask")).toContain("one prompt")
    for (const type of ["turn.cancel", "session.delete", "session.archive"]) expect(h.elevation.check(origin, { v: 1, id: "c", clientId: "c", type, sessionId: child } as never, "ask")).toBeUndefined()
    expect(h.elevation.check(origin, { v: 1, id: "c", clientId: "c", type: "session.permission.set", sessionId: child, mode: "ask" } as never, "ask")).toBeUndefined()
    // Another session's shell is not held by this approval (the usual gate decides for it).
    expect(h.elevation.check({ via: "process", sessionId: "ses_other" }, submit("anything"), "ask")).toBeUndefined()
  })

  test("denied, dismissed or unanswered: the refusal stands and nothing is set", async () => {
    const decisions: Array<Extract<Command, { type: "request.resolve" }>["decision"]> = [{ kind: "answer", text: "Deny", answers: [["Deny"]] }, { kind: "deny" }]
    for (const decision of decisions) {
      const h = harness()
      const asked = h.ask()
      expect(h.resolve(decision)).toEqual({ ok: true })
      expect(await asked).toBe("the user denied it")
      expect(h.applied).toEqual([])
      expect(h.elevation.check(origin, submit("fix the flaky test sk-secret"), "ask")).toBeUndefined()
    }
    const late = harness({ waitMs: 20 })
    expect(await late.ask()).toContain("no one answered")
    expect(late.events.at(-1)).toMatchObject({ type: "server.request.resolved", resolution: "abandoned" })
    expect(late.applied).toEqual([])
  })

  test("no one at a terminal (headless, loops, remote or peer only): refused at once, without a card", async () => {
    const h = harness({ humans: [] })
    expect(await h.ask()).toContain("no one has the launching session or its project open in a local terminal")
    expect(h.events).toEqual([])
  })

  test("a remote or peer client neither counts as the user nor approves the card; it may only dismiss it", async () => {
    expect(isHumanTerminal({ dialogs: true })).toBe(true)
    expect(isHumanTerminal({ dialogs: true, remoteAddress: "10.0.0.2" })).toBe(false)
    expect(isHumanTerminal({ dialogs: true, peer: { name: "laptop" } })).toBe(false)
    expect(isHumanTerminal({ dialogs: true, agent: { via: "process" } })).toBe(false)
    expect(isHumanTerminal({})).toBe(false)
    const h = harness()
    const asked = h.ask()
    expect(h.resolve({ kind: "answer", text: "Approve once", answers: [["Approve once"]] }, false)).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.applied).toEqual([])
    expect(h.resolve({ kind: "deny" }, false)).toEqual({ ok: true })
    expect(await asked).toBe("the user denied it")
  })

  test("never full, never a session the caller did not just start, never a child that already ran", async () => {
    expect(await harness().ask("full")).toContain("never approved this way")
    expect(await harness().ask("smart", false)).toContain("only a session the caller just started")
    expect(await harness({ fresh: false }).ask()).toContain("already run")
    expect(await createChildElevation({ humanSessions: () => [], turnOf: () => undefined, requestId: () => "r" as RequestId, turnId: () => "t" as TurnId, emit() {}, mask: (_s, t) => t, facts: () => ({ title: "", directory: "", model: "" }), fresh: () => true, apply: async () => {} }).request({ origin: { via: "declared" }, child, mode: "smart", ceiling: "ask", text: "x", images: 0, startedByCaller: true, alive: () => true })).toContain("cannot be identified")
  })
})
