import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { createVerifier, type VerifyInput } from "../src/verifier"

const ids = createIdFactory()

/** Fake ports: sessions are ids, submit answers with a queue id, checks and fingerprints are scripted. */
function harness(options: { checks?: Record<string, number>; fingerprints?: Array<string | undefined>; submitError?: string; attempts?: number } = {}) {
  const created: Array<{ title: string; readOnly?: boolean }> = []
  const prompts: string[] = []
  const queued: string[] = []
  let seq = 0
  const fingerprints = [...(options.fingerprints ?? [])]
  const checked: string[] = []
  const verifier = createVerifier({
    auditAttempts: options.attempts ?? 1,
    createSession: (input) => (created.push(input), ids("session")),
    submit: async ({ text }) => {
      prompts.push(text)
      if (options.submitError) return { error: options.submitError }
      const queueId = ids("queue")
      queued.push(queueId)
      return { queueId }
    },
    runCheck: async ({ argv }) => (checked.push(argv.join(" ")), { exitCode: options.checks?.[argv.join(" ")] ?? 0, output: `ran ${argv.join(" ")}` }),
    fingerprint: async () => fingerprints.shift(),
  })
  const emit = (sessionId: SessionId, event: Record<string, unknown>) => verifier.observe({ sessionId, seq: ++seq, at: 0, ...event } as SessionEvent)
  /** Plays an auditor turn in the only auditor session: `tools` successful tool calls, then the answer, then the ending. */
  const auditorTurn = async (answer: string, tools = 1, ending = "turn.completed") => {
    for (let i = 0; i < 50 && verifier.active().length === 0; i++) await Bun.sleep(1)
    const sessionId = verifier.active()[0]!
    for (let i = 0; i < 50 && queued.length === 0; i++) await Bun.sleep(1)
    await Bun.sleep(1)
    const turnId = ids("turn")
    emit(sessionId, { type: "turn.started", turnId, queueId: queued.at(-1) })
    for (let i = 0; i < tools; i++) {
      const itemId = ids("item")
      emit(sessionId, { type: "item.started", turnId, itemId, kind: "tool_call" })
      emit(sessionId, { type: "item.completed", itemId, status: "ok", text: "read a.ts" })
    }
    const answerId = ids("item")
    emit(sessionId, { type: "item.started", turnId, itemId: answerId, kind: "agent_message" })
    emit(sessionId, { type: "item.completed", itemId: answerId, status: "ok", text: answer })
    emit(sessionId, { type: ending, turnId, ...(ending === "turn.cancelled" ? { by: "user" } : ending === "turn.failed" ? { error: { code: "x", message: "y" } } : ending === "turn.interrupted" ? { reason: "restart" } : {}) })
    return sessionId
  }
  return { verifier, created, prompts, queued, checked, auditorTurn }
}

const input = (over: Partial<VerifyInput> = {}): VerifyInput => ({ directory: "/repo", title: "audit", checks: [], signal: new AbortController().signal, ...over })

describe("verifier", () => {
  test("a failed auditor is asked again in a new session with the same check results; three failures are unavailable", async () => {
    const h = harness({ attempts: 3 })
    const run = h.verifier.run(input({ checks: ["bun test"], audit: { prompt: () => "audit" } }))
    await h.auditorTurn("", 1, "turn.failed")
    for (let i = 0; i < 50 && h.queued.length < 2; i++) await Bun.sleep(1)
    await h.auditorTurn("AUDIT_VERDICT\nverdict: pass\nfindings: ok\nEND_AUDIT_VERDICT")
    expect(await run).toMatchObject({ kind: "audited", gates: [{ id: "bun test", status: "pass" }] })
    expect(h.created.map((entry) => entry.title)).toEqual(["audit", "audit (attempt 2)"])
    expect(h.checked).toEqual(["bun test"])

    const failing = harness({ attempts: 3 })
    const all = failing.verifier.run(input({ audit: { prompt: () => "audit" } }))
    for (let tries = 1; tries <= 3; tries++) {
      for (let i = 0; i < 50 && failing.queued.length < tries; i++) await Bun.sleep(1)
      await failing.auditorTurn("", 1, "turn.failed")
    }
    expect(await all).toEqual({ kind: "unavailable", gates: [], reason: "audit run failed (3 attempts)" })
    // The user's own cancel is final at once.
    const cancelled = harness({ attempts: 3 })
    const once = cancelled.verifier.run(input({ audit: { prompt: () => "audit" } }))
    await cancelled.auditorTurn("", 1, "turn.cancelled")
    expect(await once).toEqual({ kind: "unavailable", gates: [], reason: "audit cancelled by the user" })
    expect(cancelled.created).toHaveLength(1)
  })

  test("no checks and no audit: checked with no gates", async () => {
    expect(await harness().verifier.run(input())).toEqual({ kind: "checked", gates: [] })
  })

  test("a failing check stops before any audit", async () => {
    const h = harness({ checks: { "bun test": 1 } })
    const outcome = await h.verifier.run(input({ checks: ["bun test", "bun run typecheck"], audit: { prompt: () => "audit" } }))
    expect(outcome.kind).toBe("checks-failed")
    expect(outcome.kind === "checks-failed" && outcome.gates.map((g) => [g.id, g.status])).toEqual([
      ["bun test", "fail"],
      ["bun run typecheck", "pass"],
    ])
    expect(h.created).toEqual([])
  })

  test("the audit runs in a read-only session with the gates in its prompt, and reports answer and inspections", async () => {
    const h = harness({ fingerprints: ["a", "a"] })
    const pending = h.verifier.run(input({ checks: ["bun test"], audit: { prompt: (gates) => `judge ${gates.map((g) => g.status).join(",")}` } }))
    const sessionId = await h.auditorTurn("```AUDIT_VERDICT\nverdict: pass\n```", 2)
    // A passing gate carries no detail (only failures do).
    expect(await pending).toEqual({ kind: "audited", gates: [{ id: "bun test", status: "pass" }], audit: { sessionId, answer: "```AUDIT_VERDICT\nverdict: pass\n```", inspections: 2, workspaceChanged: false } })
    expect(h.created).toEqual([{ directory: "/repo", title: "audit", readOnly: true } as never])
    expect(h.prompts).toEqual(["judge pass"])
    expect(h.verifier.active()).toEqual([])
  })

  test("a changed workspace marks the audit; a cancelled or failed audit is unavailable with a reason", async () => {
    const changed = harness({ fingerprints: ["a", "b"] })
    const pending = changed.verifier.run(input({ audit: { prompt: () => "p" } }))
    await changed.auditorTurn("verdict")
    expect(await pending).toMatchObject({ kind: "audited", audit: { workspaceChanged: true } })
    for (const [ending, reason] of [
      ["turn.cancelled", "audit cancelled by the user"],
      ["turn.failed", "audit run failed"],
    ] as const) {
      const h = harness()
      const run = h.verifier.run(input({ audit: { prompt: () => "p" } }))
      await h.auditorTurn("x", 0, ending)
      expect(await run).toEqual({ kind: "unavailable", gates: [], reason })
    }
  })

  test("an interrupted audit is interrupted; one that cannot start is unavailable", async () => {
    const h = harness()
    const run = h.verifier.run(input({ audit: { prompt: () => "p" } }))
    await h.auditorTurn("x", 0, "turn.interrupted")
    expect(await run).toEqual({ kind: "interrupted", gates: [] })
    expect(await harness({ submitError: "busy" }).verifier.run(input({ audit: { prompt: () => "p" } }))).toEqual({ kind: "unavailable", gates: [], reason: "audit could not start: busy" })
  })

  test("an abort during the audit stops waiting; not wanted after checks means no audit at all", async () => {
    const h = harness()
    const controller = new AbortController()
    const run = h.verifier.run(input({ audit: { prompt: () => "p" }, signal: controller.signal }))
    for (let i = 0; i < 50 && h.verifier.active().length === 0; i++) await Bun.sleep(1)
    controller.abort()
    expect(await run).toEqual({ kind: "aborted" })
    expect(h.verifier.active()).toEqual([])
    const unwanted = harness()
    expect(await unwanted.verifier.run(input({ audit: { prompt: () => "p" }, stillWanted: () => false }))).toEqual({ kind: "aborted" })
    expect(unwanted.created).toEqual([])
  })

  test("a hung auditor times out: its tracked turn is cancelled and the verification is unavailable (FC-19)", async () => {
    const clock = createVirtualClock(1_000)
    const cancelled: Array<{ sessionId: SessionId; turnId: TurnId }> = []
    let queueId: string | undefined
    const verifier = createVerifier({
      createSession: () => ids("session"),
      submit: async () => ({ queueId: (queueId = ids("queue")) as never }),
      clock,
      cancelTurn: (input) => void cancelled.push(input),
      auditTimeoutMs: 60_000,
      auditAttempts: 1,
    })
    const run = verifier.run(input({ audit: { prompt: () => "p" } }))
    for (let i = 0; i < 50 && !queueId; i++) await Bun.sleep(1)
    const sessionId = verifier.active()[0]!
    const turnId = ids("turn")
    verifier.observe({ sessionId, seq: 1, at: 0, type: "turn.started", turnId, queueId } as SessionEvent)
    clock.advance(59_000)
    await Bun.sleep(1)
    expect(verifier.active()).toEqual([sessionId])
    clock.advance(2_000)
    expect(await run).toEqual({ kind: "unavailable", gates: [], reason: "audit stalled: no activity for 1 min" })
    expect(cancelled).toEqual([{ sessionId, turnId }])
    expect(verifier.active()).toEqual([])
  })

  test("an auditor that keeps working runs past the idle limit and finishes; only the overall cap stops it", async () => {
    const clock = createVirtualClock(1_000)
    let queueId: string | undefined
    const verifier = createVerifier({ createSession: () => ids("session"), submit: async () => ({ queueId: (queueId = ids("queue")) as never }), clock, auditTimeoutMs: 60_000, auditAttempts: 1 })
    const run = verifier.run(input({ audit: { prompt: () => "p" } }))
    for (let i = 0; i < 50 && !queueId; i++) await Bun.sleep(1)
    const sessionId = verifier.active()[0]!
    const turnId = ids("turn")
    let seq = 1
    verifier.observe({ sessionId, seq: seq++, at: 0, type: "turn.started", turnId, queueId } as SessionEvent)
    // Ten minutes of reading, an event every 50 s: ten times the idle limit, still running.
    for (let i = 0; i < 12; i++) {
      clock.advance(50_000)
      verifier.observe({ sessionId, seq: seq++, at: 0, type: "item.started", turnId, itemId: `tool-${i}`, kind: "tool_call" } as unknown as SessionEvent)
    }
    await Bun.sleep(1)
    expect(verifier.active()).toEqual([sessionId])
    verifier.observe({ sessionId, seq: seq++, at: 0, type: "turn.completed", turnId } as SessionEvent)
    expect(await run).toMatchObject({ kind: "audited" })

    const capped = createVerifier({ createSession: () => ids("session"), submit: async () => ({ queueId: (queueId = ids("queue")) as never }), clock, auditTimeoutMs: 60_000, auditAttempts: 1 })
    queueId = undefined
    const long = capped.run(input({ audit: { prompt: () => "p" } }))
    for (let i = 0; i < 50 && !queueId; i++) await Bun.sleep(1)
    const busy = capped.active()[0]!
    for (let i = 0; i < 73; i++) { clock.advance(50_000); capped.observe({ sessionId: busy, seq: i + 1, at: 0, type: "usage.recorded" } as unknown as SessionEvent) }
    expect(await long).toEqual({ kind: "unavailable", gates: [], reason: "audit still running after 60 min" })
  })

  test("events of other sessions are not its business", () => {
    const h = harness()
    expect(h.verifier.observe({ sessionId: ids("session"), seq: 1, at: 0, type: "turn.completed", turnId: ids("turn") } as SessionEvent)).toBe(false)
  })
})
