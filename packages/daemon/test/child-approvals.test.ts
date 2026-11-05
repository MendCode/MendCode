import { describe, expect, test } from "bun:test"
import type { SessionEventDraft } from "@mendcode/kernel"
import type { Command, QueueId, RequestId, SessionEvent, SessionId, TurnId } from "@mendcode/protocol"
import { createChildApprovals } from "../src/child-approvals"

const launcher = "ses_launcher" as SessionId
const kids = { a: "ses_a" as SessionId, b: "ses_b" as SessionId, c: "ses_c" as SessionId }

function harness(input: { humans?: SessionId[] } = {}) {
  const events: SessionEventDraft[] = []
  const notices: Array<{ launcher: string; text: string }> = []
  const answered: Array<{ child: string; requestId: string; approve: boolean }> = []
  const mirrored: Array<{ child: string; requestId: string; text: string }> = []
  let n = 0
  const links = new Map<string, string>([[kids.a, launcher], [kids.b, launcher], [kids.c, "ses_elsewhere"]])
  const approvals = createChildApprovals({
    launcherOf: (child) => links.get(child) as SessionId | undefined,
    humanSessions: () => input.humans ?? [launcher],
    title: (id) => `owner ${id}`,
    turnOf: () => "turn_running" as TurnId,
    requestId: () => `req_card${++n}` as RequestId,
    turnId: () => "turn_new" as TurnId,
    queueId: () => `que_${++n}` as QueueId,
    emit: (event) => void events.push(event),
    mask: (_id, text) => text.replaceAll("sk-secret", "[secret]"),
    notify: async (target, text) => void notices.push({ launcher: target, text }),
    resolveChild: async ({ child, requestId, decision }) => void (decision.kind === "answer" ? mirrored.push({ child, requestId, text: decision.text }) : answered.push({ child, requestId, approve: decision.kind === "approve" })),
    delayMs: 5,
  })
  const ask = (child: SessionId, requestId: string, detail = "bun scripts/gen.ts", kind: "approval" | "question" = "approval") =>
    approvals.observe({ type: "server.request", sessionId: child, requestId, turnId: "turn_c", kind, title: "Run command", detail, tool: "shell", seq: 1, at: 1 } as unknown as SessionEvent)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
  const cards = () => events.filter((event): event is Extract<SessionEventDraft, { type: "server.request" }> => event.type === "server.request")
  const answer = (card: { requestId: RequestId; sessionId: SessionId }, label: string, human = true) =>
    approvals.resolve({ v: 1, id: "cmd", clientId: "cli_user", type: "request.resolve", sessionId: card.sessionId, requestId: card.requestId, decision: { kind: "answer", text: label, answers: [[label]] } } as unknown as Extract<Command, { type: "request.resolve" }>, human)
  return { approvals, events, notices, answered, mirrored, ask, settle, cards, answer }
}

describe("approvals that sessions started from another session wait for", () => {
  test("children that block together are one notice to the launcher and one card for the user", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    h.ask(kids.b, "req_b", "bun test sk-secret")
    h.ask(kids.c, "req_c")
    await h.settle()
    // The third child belongs to another launcher: it gets its own notice, not a place in this one.
    expect(h.notices.map((notice) => notice.launcher).sort()).toEqual(["ses_elsewhere", launcher])
    const mine = h.notices.find((notice) => notice.launcher === launcher)!
    expect(mine.text).toContain("ses_a")
    expect(mine.text).toContain("ses_b")
    expect(mine.text).not.toContain("ses_c")
    expect(mine.text).not.toContain("sk-secret")
    expect(mine.text).toContain("You cannot approve")
    const [card] = h.cards()
    expect(h.cards()).toHaveLength(2)
    expect(card).toMatchObject({ sessionId: launcher, kind: "question", async: true })
    expect(card!.questions![0]!.options!.map((option) => option.label)).toEqual(["Approve all (2)", "Deny all", "One by one"])
    expect(card!.questions![0]!.context).toContain("bun test [secret]")
    expect(h.answered).toEqual([])
  })

  test("a session nobody launched from a shell is not announced", async () => {
    const h = harness()
    h.ask("ses_mine" as SessionId, "req_mine")
    await h.settle()
    expect(h.notices).toEqual([])
    expect(h.cards()).toEqual([])
  })

  test("approve all answers exactly the requests the card listed, as the user, once", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    h.ask(kids.b, "req_b")
    await h.settle()
    const card = h.cards()[0]!
    // A request that arrives after the card was drawn is not covered by it.
    h.ask(kids.a, "req_late")
    expect(h.answer(card, "Approve all (2)")).toEqual({ ok: true })
    await h.settle()
    expect(h.answered.filter((entry) => entry.requestId !== "req_late")).toEqual([{ child: kids.a, requestId: "req_a", approve: true }, { child: kids.b, requestId: "req_b", approve: true }])
    expect(h.answered.some((entry) => entry.requestId === "req_late")).toBe(false)
    expect(h.events.find((event) => event.type === "server.request.resolved" && event.requestId === card.requestId)).toMatchObject({ resolution: "answered" })
  })

  test("the model side cannot approve: a non-user client is refused, and a dismissal answers nothing", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    await h.settle()
    const card = h.cards()[0]!
    expect(h.answer(card, "Approve all (1)", false)).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.answered).toEqual([])
    expect(h.approvals.resolve({ v: 1, id: "c", clientId: "c", type: "request.resolve", sessionId: card.sessionId, requestId: card.requestId, decision: { kind: "deny" } } as never, false)).toEqual({ ok: true })
    await h.settle()
    expect(h.answered).toEqual([])
  })

  test("deny all denies them; one by one opens a card per child and each answers only its own", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    h.ask(kids.b, "req_b")
    await h.settle()
    h.answer(h.cards()[0]!, "One by one")
    const singles = h.cards().slice(1)
    expect(singles).toHaveLength(2)
    expect(singles[0]!.questions![0]!.options!.map((option) => option.label)).toEqual(["Approve once", "Deny"])
    h.answer(singles[0]!, "Approve once")
    h.answer(singles[1]!, "Deny")
    await h.settle()
    expect(h.answered).toEqual([{ child: kids.a, requestId: "req_a", approve: true }, { child: kids.b, requestId: "req_b", approve: false }])

    const other = harness()
    other.ask(kids.a, "req_a")
    await other.settle()
    other.answer(other.cards()[0]!, "Deny all")
    await other.settle()
    expect(other.answered).toEqual([{ child: kids.a, requestId: "req_a", approve: false }])
  })

  test("a request answered in the child's own session leaves the card: updated while others wait, withdrawn when none does", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    h.ask(kids.b, "req_b")
    await h.settle()
    const first = h.cards()[0]!
    h.approvals.observe({ type: "server.request.resolved", sessionId: kids.a, requestId: "req_a", resolution: "approved" } as unknown as SessionEvent)
    await h.settle()
    expect(h.events.find((event) => event.type === "server.request.resolved" && event.requestId === first.requestId)).toMatchObject({ resolution: "abandoned" })
    const second = h.cards()[1]!
    expect(second.questions![0]!.options![0]!.label).toBe("Approve all (1)")
    h.approvals.observe({ type: "server.request.resolved", sessionId: kids.b, requestId: "req_b", resolution: "approved" } as unknown as SessionEvent)
    await h.settle()
    expect(h.events.find((event) => event.type === "server.request.resolved" && event.requestId === second.requestId)).toMatchObject({ resolution: "abandoned" })
    expect(h.cards()).toHaveLength(2)
  })

  test("a choice a headless child asks (a settings proposal) is mirrored to the user, whose answer is forwarded as the user's", async () => {
    const h = harness()
    h.approvals.observe({ type: "server.request", sessionId: kids.a, requestId: "req_set", turnId: "turn_c", kind: "question", title: "Change MendCode settings? (answer on this machine)", detail: "permissionAllow: unset -> bun test", questions: [{ header: "Settings", question: "Apply this change?", options: [{ label: "Apply" }, { label: "Don't apply" }], custom: false }], seq: 1, at: 1 } as unknown as SessionEvent)
    await h.settle()
    const card = h.cards().at(-1)!
    expect(card).toMatchObject({ sessionId: launcher, async: true })
    expect(card.questions![0]!.options!.map((option) => option.label)).toEqual(["Apply", "Don't apply"])
    expect(card.questions![0]!.context).toContain("permissionAllow")
    expect(h.answer(card, "Apply", false)).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.answer(card, "Something else")).toEqual({ ok: true })
    await h.settle()
    expect(h.mirrored).toEqual([])
  })

  test("a mirrored answer reaches the child only when it is one of the offered options", async () => {
    const h = harness()
    h.approvals.observe({ type: "server.request", sessionId: kids.a, requestId: "req_set", turnId: "turn_c", kind: "question", title: "Change settings", detail: "x", questions: [{ header: "Settings", question: "Apply this change?", options: [{ label: "Apply" }, { label: "Don't apply" }], custom: false }], seq: 1, at: 1 } as unknown as SessionEvent)
    await h.settle()
    h.answer(h.cards().at(-1)!, "Apply")
    await h.settle()
    expect(h.mirrored).toEqual([{ child: kids.a, requestId: "req_set", text: "Apply" }])
  })

  test("a question is announced to the launcher but never offered for approval", async () => {
    const h = harness()
    h.ask(kids.a, "req_q", "Which database?", "question")
    await h.settle()
    expect(h.notices).toHaveLength(1)
    expect(h.cards()).toEqual([])
  })

  test("with no terminal of the user open there is no card, only the notice", async () => {
    const h = harness({ humans: [] })
    h.ask(kids.a, "req_a")
    await h.settle()
    expect(h.notices).toHaveLength(1)
    expect(h.cards()).toEqual([])
  })

  test("nothing is pending after the launcher or the child is forgotten, and stop withdraws the card", async () => {
    const h = harness()
    h.ask(kids.a, "req_a")
    await h.settle()
    const card = h.cards()[0]!
    h.approvals.stop()
    expect(h.events.find((event) => event.type === "server.request.resolved" && event.requestId === card.requestId)).toMatchObject({ resolution: "abandoned" })
    const second = harness()
    second.ask(kids.a, "req_a")
    second.approvals.forget(kids.a)
    expect(second.approvals.pending(launcher)).toEqual([])
  })
})
