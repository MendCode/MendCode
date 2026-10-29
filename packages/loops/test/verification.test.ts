import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type Loop, type LoopId, type QueueId, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { auditPrompt, checkProblems, createLoopService, parseCheck, parseVerdict, runChecks, runPrompt, type CheckRunner } from "../src"

const START = new Date(2026, 8, 26, 10, 0, 0).getTime()
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}
const checkpoint = (status: string, summary = "did things") => `Done.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: ${summary}\n\`\`\``
const verdict = (value: string, findings = "criterion 1 met: tests pass") => `Checked.\n\n\`\`\`AUDIT_VERDICT\nverdict: ${value}\nfindings: ${findings}\n\`\`\``

function harness(options: { exitCodes?: Record<string, number>; fingerprints?: string[] } = {}) {
  const clock = createVirtualClock(START)
  const ids = createIdFactory({ now: () => clock.now() })
  const saved = new Map<LoopId, Loop>()
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const sessions: Array<{ sessionId: SessionId; readOnly: boolean }> = []
  const ran: string[][] = []
  const fingerprints = [...(options.fingerprints ?? [])]
  const runCheck: CheckRunner = async ({ argv }) => (ran.push(argv), { exitCode: options.exitCodes?.[argv.join(" ")] ?? 0, output: `${argv.join(" ")} output` })
  const service = createLoopService({
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    clock,
    ids,
    createSession: ({ readOnly }) => {
      const sessionId = ids("session")
      sessions.push({ sessionId, readOnly: readOnly === true })
      return sessionId
    },
    submit: async ({ sessionId, text }) => {
      const queueId = ids("queue")
      submitted.push({ sessionId, text, queueId })
      return { queueId }
    },
    runCheck,
    ...(options.fingerprints ? { fingerprint: async () => fingerprints.shift() } : {}),
  })
  let seq = 0
  /** One turn in the last submitted session: `reads` successful tool calls (an auditor must inspect), then the answer. */
  const playTurn = (answer: string, terminal: "turn.completed" | "turn.cancelled" = "turn.completed", reads = 1) => {
    const last = submitted.at(-1)!
    const turnId = ids("turn") as TurnId
    const itemId = ids("item")
    const ev = (e: Record<string, unknown>) => service.observe({ sessionId: last.sessionId, seq: ++seq, at: clock.now(), ...e } as SessionEvent)
    ev({ type: "turn.started", turnId, queueId: last.queueId })
    for (let i = 0; i < reads; i++) {
      const tool = ids("item")
      ev({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: "read: a.ts" } })
      ev({ type: "item.completed", itemId: tool, status: "ok", text: "…" })
    }
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text: answer })
    ev(terminal === "turn.cancelled" ? { type: terminal, turnId, by: "user" } : { type: terminal, turnId })
  }
  const goal = (extra: Partial<Parameters<typeof service.create>[0]> = {}) =>
    service.create({ name: "fix", directory: "/repo", objective: "make tests pass", criteria: "bun test passes", trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 5 }, ...extra })
  return { clock, service, submitted, sessions, ran, playTurn, goal }
}

describe("check commands", () => {
  test("plain commands become argv with quotes grouping words; shell syntax is refused", () => {
    expect(parseCheck(`bun test "packages/a b" 'x y'`)).toEqual({ argv: ["bun", "test", "packages/a b", "x y"] })
    for (const bad of ["bun test && rm -rf /", "bun test | tee x", "bun test > out", "echo $(id)", "echo `id`", "a; b", "a\nb"]) expect(parseCheck(bad)).toHaveProperty("error")
    expect(parseCheck(`bun test "open`)).toEqual({ error: expect.stringContaining("unclosed quote") })
    expect(checkProblems(["bun test", "a | b"])).toHaveLength(1)
  })
  test("every check runs even after a failure; failures carry the exit code and output tail", async () => {
    const run: CheckRunner = async ({ argv }) => ({ exitCode: argv[0] === "bad" ? 2 : 0, output: "boom\n" })
    const gates = await runChecks({ checks: ["bad one", "good", "x | y"], cwd: "/r", signal: new AbortController().signal, run })
    expect(gates).toEqual([
      { id: "bad one", status: "fail", detail: "exit 2\nboom" },
      { id: "good", status: "pass" },
      { id: "x | y", status: "fail", detail: expect.stringContaining("shell syntax") },
    ])
  })
})

describe("audit prompt and verdict", () => {
  test("the verdict is read from the last AUDIT_VERDICT block with multi-line findings; anything else is no verdict", () => {
    expect(parseVerdict(verdict("pass", "1 met\n2 met"))).toEqual({ verdict: "pass", findings: "1 met\n2 met" })
    expect(parseVerdict(`${verdict("pass")}\n${verdict("fail", "2 missing")}`)).toEqual({ verdict: "fail", findings: "2 missing" })
    expect(parseVerdict("looks good to me")).toBeUndefined()
    // Seen live (gpt-6-luna): the marker in bold instead of a fence.
    expect(parseVerdict("**AUDIT_VERDICT**\nverdict: pass\nfindings: Met — hello.txt contains hi")).toEqual({ verdict: "pass", findings: "Met — hello.txt contains hi" })
    expect(parseVerdict("## AUDIT_VERDICT\nverdict: FAIL\nfindings: missing")).toEqual({ verdict: "fail", findings: "missing" })
    expect(parseVerdict("I will end with an AUDIT_VERDICT block later.")).toBeUndefined()
    expect(parseVerdict("```AUDIT_VERDICT\nverdict: maybe\n```")).toBeUndefined()
  })
  test("the auditor is told not to trust the claim, not to change anything, and what the host checks found", () => {
    const loop = { name: "fix", objective: "o", criteria: "c" } as Loop
    const text = auditPrompt(loop, 2, { status: "complete", summary: "all green" }, [{ id: "bun test", status: "pass" }])
    for (const part of ["Do not trust the claim", "must not call plan_submit", "Done when:\nc", "Claim:\nall green", "- bun test: pass", "```AUDIT_VERDICT"]) expect(text).toContain(part)
  })
})

describe("goal verification", () => {
  test("a complete claim runs the checks, then a read-only audit; a pass with an unchanged workspace completes the loop", async () => {
    const { service, submitted, sessions, ran, playTurn, goal } = harness({ fingerprints: ["abc", "abc"] })
    const loop = goal({ checks: ["bun test"] })
    service.runNow(loop.loopId)
    await flush()
    expect(submitted[0]!.text).toContain("The host runs these checks when you report complete")
    playTurn(checkpoint("complete", "tests fixed"))
    expect(service.get(loop.loopId)!.state).toBe("verifying")
    await flush()
    expect(ran).toEqual([["bun", "test"]])
    expect(sessions.at(-1)).toMatchObject({ readOnly: true })
    expect(submitted.at(-1)!.text).toContain("independent auditor")
    playTurn(verdict("pass"))
    await flush()
    const done = service.get(loop.loopId)!
    expect(done).toMatchObject({ state: "completed", reason: "tests fixed" })
    expect(done.history.at(-1)).toMatchObject({ gates: [{ id: "bun test", status: "pass" }, { id: "independent-audit", status: "pass" }], audit: { verdict: "pass", sessionId: sessions.at(-1)!.sessionId } })
  })

  test("a failing check sends the loop back to work with the failure as feedback; no audit runs", async () => {
    const { service, submitted, sessions, playTurn, goal } = harness({ exitCodes: { "bun test": 1 } })
    const loop = goal({ checks: ["bun test"] })
    service.runNow(loop.loopId)
    await flush()
    playTurn(checkpoint("complete"))
    await flush()
    const back = service.get(loop.loopId)!
    expect(back).toMatchObject({ state: "active", reason: "completion claim rejected" })
    expect(back.feedback).toContain("Checks failed:\n- bun test\nexit 1")
    expect(sessions).toHaveLength(1)
    service.runNow(loop.loopId)
    await flush()
    expect(submitted.at(-1)!.text).toContain("Your last completion claim was rejected")
    playTurn(checkpoint("continue"))
    expect(service.get(loop.loopId)!.feedback).toBeUndefined()
  })

  test("an audit that fails, gives no verdict, or changes the workspace is rejected with feedback", async () => {
    for (const [answer, fingerprints, expected] of [
      [verdict("fail", "criterion 1 not met"), ["a", "a"], "criterion 1 not met"],
      ["I think it is fine", ["a", "a"], "no AUDIT_VERDICT"],
      [verdict("pass"), ["a", "b"], "workspace changed"],
    ] as const) {
      const { service, playTurn, goal } = harness({ fingerprints: [...fingerprints] })
      const loop = goal()
      service.runNow(loop.loopId)
      await flush()
      playTurn(checkpoint("complete"))
      await flush()
      playTurn(answer)
      await flush()
      const back = service.get(loop.loopId)!
      expect(back.state).toBe(fingerprints[0] === fingerprints[1] ? "active" : "blocked")
      expect(back.feedback).toContain(expected)
    }
  })

  test("an auditor that inspected nothing cannot pass the loop, whatever its verdict says", async () => {
    const { service, playTurn, goal } = harness({ fingerprints: ["a", "a"] })
    const loop = goal()
    service.runNow(loop.loopId)
    await flush()
    playTurn(checkpoint("complete"))
    await flush()
    playTurn(verdict("pass"), "turn.completed", 0)
    await flush()
    const back = service.get(loop.loopId)!
    expect(back.state).toBe("blocked")
    expect(back.feedback).toContain("inspected nothing")
  })

  test("audit none completes on the checks alone, without opening an auditor session", async () => {
    const { service, sessions, playTurn, goal } = harness()
    const checked = goal({ checks: ["bun test"], audit: "none" })
    service.runNow(checked.loopId)
    await flush()
    playTurn(checkpoint("complete"))
    await flush()
    expect(service.get(checked.loopId)!.state).toBe("completed")
    expect(sessions).toHaveLength(1)
  })

  test("a cancelled audit blocks the loop and cannot be bypassed by legacy accept", async () => {
    const { service, playTurn, goal } = harness()
    const loop = goal()
    service.runNow(loop.loopId)
    await flush()
    playTurn(checkpoint("complete"))
    await flush()
    playTurn("stopped", "turn.cancelled")
    await flush()
    expect(service.get(loop.loopId)).toMatchObject({ state: "blocked", reason: "audit cancelled by the user" })
    service.accept(loop.loopId, "verified by hand")
    expect(service.get(loop.loopId)).toMatchObject({ state: "blocked", reason: "audit cancelled by the user" })
  })

  test("the run cap still applies: a rejected claim on the last allowed run blocks the loop", async () => {
    const { service, playTurn, goal } = harness({ exitCodes: { "bun test": 1 } })
    const loop = goal({ checks: ["bun test"], budget: { mode: "goal", maxRuns: 1 } })
    service.runNow(loop.loopId)
    await flush()
    playTurn(checkpoint("complete"))
    await flush()
    expect(service.get(loop.loopId)).toMatchObject({ state: "blocked", feedback: expect.stringContaining("bun test") })
  })

  test("pausing during verification stops it; the late check result changes nothing", async () => {
    let release: (() => void) | undefined
    const clock = createVirtualClock(START)
    const ids = createIdFactory({ now: () => clock.now() })
    const submitted: Array<{ sessionId: SessionId; queueId: QueueId }> = []
    const service = createLoopService({
      store: { all: () => [], save: () => {}, remove: () => {} },
      clock,
      ids,
      createSession: () => ids("session"),
      submit: async ({ sessionId }) => {
        const queueId = ids("queue")
        submitted.push({ sessionId, queueId })
        return { queueId }
      },
      runCheck: () => new Promise((resolve) => (release = () => resolve({ exitCode: 0, output: "" }))),
    })
    const loop = service.create({ name: "n", directory: "/r", objective: "o", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun test"] })
    service.runNow(loop.loopId)
    await flush()
    const last = submitted.at(-1)!
    const turnId = ids("turn") as TurnId
    const itemId = ids("item")
    for (const e of [
      { type: "turn.started", turnId, queueId: last.queueId },
      { type: "item.started", turnId, itemId, kind: "agent_message" },
      { type: "item.completed", itemId, status: "ok", text: checkpoint("complete") },
      { type: "turn.completed", turnId },
    ])
      service.observe({ sessionId: last.sessionId, seq: 1, at: 0, ...e } as SessionEvent)
    await flush()
    service.pause(loop.loopId)
    release?.()
    await flush()
    expect(service.get(loop.loopId)!.state).toBe("paused")
    expect(submitted).toHaveLength(1)
  })

  test("a run prompt without checks or feedback stays as before", () => {
    const text = runPrompt({ name: "n", objective: "o", budget: { mode: "monitor" } } as Loop, 1)
    expect(text).not.toContain("host runs")
    expect(text).not.toContain("rejected")
  })
})
