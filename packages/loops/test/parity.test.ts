import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, Loop as LoopSchema, LoopTrigger, type Loop, type LoopId, type QueueId, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { adaptiveInterval, createLoopService, createProblems, describeTemplate, describeTrigger, getLoopTemplate, LOOP_TEMPLATES, nextWake, paceAfter, parseCheckpoint, parseTrigger, runPrompt, type WorktreePort } from "../src"

const START = new Date(2026, 8, 26, 10, 0, 0).getTime()
const MINUTE = 60_000
const flush = () => new Promise((r) => setImmediate(r))

function harness(options: { worktree?: WorktreePort } = {}) {
  const clock = createVirtualClock(START)
  const ids = createIdFactory({ now: () => clock.now() })
  const saved = new Map<LoopId, Loop>()
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const sessions: Array<{ sessionId: SessionId; directory: string; title: string; readOnly: boolean | undefined }> = []
  const service = createLoopService({
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    clock,
    ids,
    createSession: ({ directory, title, readOnly }) => {
      const sessionId = ids("session")
      sessions.push({ sessionId, directory, title, readOnly })
      return sessionId
    },
    submit: async ({ sessionId, text }) => {
      const queueId = ids("queue")
      submitted.push({ sessionId, text, queueId })
      return { queueId }
    },
    ...(options.worktree ? { worktree: options.worktree } : {}),
  })
  let seq = 0
  /** Plays a whole turn of the last submitted message: start, an agent message with `answer`, completion. */
  const playTurn = (answer: string) => {
    const last = submitted.at(-1)!
    const turnId = ids("turn") as TurnId
    const itemId = ids("item")
    const ev = (e: Record<string, unknown>) => service.observe({ sessionId: last.sessionId, seq: ++seq, at: clock.now(), ...e } as SessionEvent)
    ev({ type: "turn.started", turnId, queueId: last.queueId })
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text: answer })
    ev({ type: "turn.completed", turnId })
  }
  return { clock, service, saved, submitted, sessions, playTurn }
}

const checkpoint = (status: string, activity?: string) => `Done.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: did things\n${activity ? `activity: ${activity}\n` : ""}\`\`\``

describe("adaptive triggers", () => {
  const trigger = { kind: "adaptive", everyMs: 10 * MINUTE, minMs: 5 * MINUTE, maxMs: 40 * MINUTE } as const

  test("pace math: idle doubles up to the max, acted halves down to the min, anything else keeps it", () => {
    expect(paceAfter(trigger, undefined, "idle")).toBe(20 * MINUTE)
    expect(paceAfter(trigger, 20 * MINUTE, "idle")).toBe(40 * MINUTE)
    expect(paceAfter(trigger, 40 * MINUTE, "idle")).toBe(40 * MINUTE)
    expect(paceAfter(trigger, 20 * MINUTE, "acted")).toBe(10 * MINUTE)
    expect(paceAfter(trigger, 5 * MINUTE, "acted")).toBe(5 * MINUTE)
    expect(paceAfter(trigger, 20 * MINUTE, undefined)).toBe(20 * MINUTE)
    expect(adaptiveInterval(trigger, 999 * MINUTE)).toBe(40 * MINUTE)
    expect(nextWake(trigger, START)).toBe(START + 10 * MINUTE)
    expect(nextWake(trigger, START, { adaptiveMs: 25 * MINUTE })).toBe(START + 25 * MINUTE)
  })

  test("bounds default to a quarter and eight times the starting interval, and must bracket it", () => {
    expect(LoopTrigger.safeParse({ kind: "adaptive", everyMs: 10 * MINUTE }).success).toBe(true)
    expect(LoopTrigger.safeParse({ kind: "adaptive", everyMs: 10 * MINUTE, minMs: 20 * MINUTE }).success).toBe(false)
    expect(LoopTrigger.safeParse({ kind: "adaptive", everyMs: 10 * MINUTE, maxMs: 5 * MINUTE }).success).toBe(false)
    expect(parseTrigger("adaptive 30m")).toEqual({ kind: "adaptive", everyMs: 30 * MINUTE })
    expect(parseTrigger("adaptive 30m 5m..4h")).toEqual({ kind: "adaptive", everyMs: 30 * MINUTE, minMs: 5 * MINUTE, maxMs: 240 * MINUTE })
    expect(parseTrigger("adaptive 30m 40m..4h")).toBeUndefined()
    expect(describeTrigger({ kind: "adaptive", everyMs: 30 * MINUTE })).toBe("adaptive 30m (7.5m..4h)")
  })

  test("runs that find nothing back off, runs that act speed up, with an injected clock", async () => {
    const { clock, service, submitted, playTurn } = harness()
    const loop = service.create({ name: "watch", directory: "/repo", objective: "look for new failures", trigger, budget: { mode: "monitor" } })
    expect(loop.nextWakeAt).toBe(START + 10 * MINUTE)

    const runWith = async (activity: string | undefined, expectedNext: number) => {
      const due = service.get(loop.loopId)!.nextWakeAt!
      clock.advance(due - clock.now())
      await flush()
      expect(service.get(loop.loopId)!.state).toBe("running")
      playTurn(checkpoint("continue", activity))
      const after = service.get(loop.loopId)!
      expect(after.adaptiveMs).toBe(expectedNext)
      expect(after.nextWakeAt).toBe(clock.now() + expectedNext)
    }
    await runWith("idle", 20 * MINUTE)
    await runWith("idle", 40 * MINUTE)
    await runWith("idle", 40 * MINUTE)
    await runWith("acted", 20 * MINUTE)
    await runWith("acted", 10 * MINUTE)
    await runWith("acted", 5 * MINUTE)
    await runWith("acted", 5 * MINUTE)
    await runWith(undefined, 5 * MINUTE)
    // The run prompt asks an adaptive loop to report its activity; a plain interval loop is not asked.
    expect(submitted[0]!.text).toContain("activity: idle | acted")
    const interval = service.create({ name: "plain", directory: "/repo", objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    expect(runPrompt(interval, 1)).not.toContain("activity:")
  })

  test("a failed run and a run without activity keep the pace; the checkpoint's activity is parsed", async () => {
    expect(parseCheckpoint(checkpoint("continue", "idle"))?.activity).toBe("idle")
    expect(parseCheckpoint(checkpoint("continue", "Acted because of X"))?.activity).toBe("acted")
    expect(parseCheckpoint(checkpoint("continue", "maybe"))?.activity).toBeUndefined()
    const { clock, service, playTurn } = harness()
    const loop = service.create({ name: "watch", directory: "/repo", objective: "o", trigger, budget: { mode: "monitor" } })
    clock.advance(10 * MINUTE)
    await flush()
    playTurn("no checkpoint at all")
    expect(service.get(loop.loopId)!.adaptiveMs).toBe(10 * MINUTE)
  })
})

describe("external triggers", () => {
  test("an external loop never wakes by itself; fire starts a run with the note and records how it started", async () => {
    const { clock, service, submitted, playTurn } = harness()
    const loop = service.create({ name: "ci", directory: "/repo", objective: "react to CI", trigger: { kind: "external" }, budget: { mode: "monitor" } })
    expect(loop.nextWakeAt).toBeUndefined()
    clock.advance(30 * 86_400_000)
    await flush()
    expect(submitted).toHaveLength(0)

    const fired = service.fire(loop.loopId, "CI run 42 failed")
    expect(fired).toMatchObject({ ok: true, queued: false })
    await flush()
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.text).toContain("fired from outside: CI run 42 failed")
    expect(service.get(loop.loopId)!.history[0]).toMatchObject({ run: 1, trigger: "external" })
    playTurn(checkpoint("continue"))
    const after = service.get(loop.loopId)!
    expect(after.state).toBe("active")
    expect(after.nextWakeAt).toBeUndefined()
    expect(after.pendingFire).toBeUndefined()
  })

  test("a fire during a run waits (several count once) and starts the next run as soon as the loop is free", async () => {
    const { clock, service, submitted, playTurn } = harness()
    const loop = service.create({ name: "ci", directory: "/repo", objective: "react", trigger: { kind: "external" }, budget: { mode: "monitor" } })
    service.fire(loop.loopId, "first")
    await flush()
    expect(service.fire(loop.loopId, "second")).toMatchObject({ ok: true, queued: true })
    expect(service.fire(loop.loopId, "third")).toMatchObject({ ok: true, queued: true })
    expect(submitted).toHaveLength(1)
    playTurn(checkpoint("continue"))
    clock.advance(0)
    await flush()
    expect(submitted).toHaveLength(2)
    expect(submitted[1]!.text).toContain("fired from outside: third")
    expect(service.get(loop.loopId)!.history.at(-1)).toMatchObject({ run: 2, trigger: "external" })
    playTurn(checkpoint("continue"))
    clock.advance(0)
    await flush()
    expect(submitted).toHaveLength(2)
  })

  test("only external loops that are idle can be fired", async () => {
    const { service } = harness()
    const interval = service.create({ name: "i", directory: "/repo", objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    expect(service.fire(interval.loopId)).toMatchObject({ ok: false, reason: "not_external" })
    const external = service.create({ name: "e", directory: "/repo", objective: "o", trigger: { kind: "external" }, budget: { mode: "monitor" } })
    service.pause(external.loopId)
    expect(service.fire(external.loopId)).toMatchObject({ ok: false, reason: "inactive" })
    service.resume(external.loopId)
    expect(service.fire(external.loopId)).toMatchObject({ ok: true })
    expect(service.fire("lop_unknown" as LoopId)).toMatchObject({ ok: false, reason: "unknown" })
    service.dispose()
  })
})

describe("daily triggers in a time zone", () => {
  const at = (iso: string) => Date.parse(iso)
  const next = (trigger: { at: string; timezone?: string }, from: string) => new Date(nextWake({ kind: "daily", ...trigger }, at(from))!).toISOString()

  test("the next occurrence is wall-clock time in the zone", () => {
    expect(next({ at: "09:00", timezone: "UTC" }, "2026-06-01T08:00:00Z")).toBe("2026-06-01T09:00:00.000Z")
    expect(next({ at: "09:00", timezone: "UTC" }, "2026-06-01T09:00:00Z")).toBe("2026-06-02T09:00:00.000Z")
    expect(next({ at: "09:00", timezone: "Europe/Madrid" }, "2026-06-01T05:00:00Z")).toBe("2026-06-01T07:00:00.000Z")
    expect(next({ at: "09:00", timezone: "Europe/Madrid" }, "2026-06-01T08:00:00Z")).toBe("2026-06-02T07:00:00.000Z")
    expect(next({ at: "09:00", timezone: "Asia/Kolkata" }, "2026-06-01T00:00:00Z")).toBe("2026-06-01T03:30:00.000Z")
    // The zone's date decides "today": 23:30 UTC is already the next day in Tokyo.
    expect(next({ at: "08:00", timezone: "Asia/Tokyo" }, "2026-06-01T23:30:00Z")).toBe("2026-06-02T23:00:00.000Z")
  })

  test("a day is 23 hours long when clocks go forward and 25 when they go back", () => {
    // America/New_York: 2026-03-08 02:00 EST -> 03:00 EDT; 2026-11-01 02:00 EDT -> 01:00 EST.
    expect(next({ at: "09:00", timezone: "America/New_York" }, "2026-03-07T14:00:01Z")).toBe("2026-03-08T13:00:00.000Z")
    expect(next({ at: "09:00", timezone: "America/New_York" }, "2026-03-08T13:00:01Z")).toBe("2026-03-09T13:00:00.000Z")
    expect(next({ at: "09:00", timezone: "America/New_York" }, "2026-10-31T13:00:01Z")).toBe("2026-11-01T14:00:00.000Z")
    const forward = at("2026-03-08T13:00:00Z") - at("2026-03-07T14:00:00Z")
    expect(forward).toBe(23 * 3_600_000)
  })

  test("a time that does not exist happens shifted past the gap; a time that happens twice happens the first time", () => {
    // Europe/Madrid: 2026-03-29 02:00 CET -> 03:00 CEST (02:30 does not exist); 2026-10-25 03:00 CEST -> 02:00 CET (02:30 twice).
    expect(next({ at: "02:30", timezone: "Europe/Madrid" }, "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z")
    expect(next({ at: "02:30", timezone: "Europe/Madrid" }, "2026-03-29T02:00:00Z")).toBe("2026-03-30T00:30:00.000Z")
    expect(next({ at: "02:30", timezone: "Europe/Madrid" }, "2026-10-24T12:00:00Z")).toBe("2026-10-25T00:30:00.000Z")
    expect(next({ at: "02:30", timezone: "Europe/Madrid" }, "2026-10-25T00:30:01Z")).toBe("2026-10-26T01:30:00.000Z")
  })

  test("the zone is validated; without one the local clock is used as before", () => {
    expect(LoopTrigger.safeParse({ kind: "daily", at: "09:00", timezone: "Europe/Madrid" }).success).toBe(true)
    expect(LoopTrigger.safeParse({ kind: "daily", at: "09:00", timezone: "UTC" }).success).toBe(true)
    expect(LoopTrigger.safeParse({ kind: "daily", at: "09:00", timezone: "Mars/Olympus" }).success).toBe(false)
    expect(parseTrigger("daily 09:00 Europe/Madrid")).toEqual({ kind: "daily", at: "09:00", timezone: "Europe/Madrid" })
    expect(parseTrigger("daily 09:00 Mars/Olympus")).toBeUndefined()
    expect(parseTrigger("daily 09:00")).toEqual({ kind: "daily", at: "09:00" })
    expect(describeTrigger({ kind: "daily", at: "09:00", timezone: "Europe/Madrid" })).toBe("daily 09:00 Europe/Madrid")
    expect(new Date(nextWake({ kind: "daily", at: "11:30" }, START)!).getHours()).toBe(11)
  })
})

describe("templates", () => {
  test("v1's four templates exist, each with a valid trigger and budget", () => {
    expect(LOOP_TEMPLATES.map((template) => template.id)).toEqual(["pr-watch", "ci-repair", "research-digest", "repo-maintenance"])
    for (const template of LOOP_TEMPLATES) {
      expect(LoopTrigger.safeParse(template.trigger).success).toBe(true)
      expect(describeTemplate(template).summary.length).toBeGreaterThan(0)
    }
    expect(getLoopTemplate("nope")).toBeUndefined()
  })

  test("a loop created from a template takes its objective, rules, trigger, budget and mode; explicit options win", () => {
    const { service, sessions } = harness()
    const digest = service.create({ name: "news", directory: "/repo", template: "research-digest" })
    expect(digest).toMatchObject({ template: "research-digest", trigger: { kind: "adaptive", everyMs: 60 * MINUTE }, budget: { mode: "monitor" }, reportOnly: true })
    expect(digest.objective).toContain("Research the requested topic from primary sources")
    expect(digest.objective).toContain("- cite primary/current sources")
    expect(digest.objective).toContain("- no material changes after repeated iterations")
    expect(LoopSchema.safeParse(digest).success).toBe(true)
    expect(sessions.at(-1)).toMatchObject({ readOnly: true })

    const watch = service.create({ name: "pr", directory: "/repo", template: "pr-watch", objective: "PR 123 only", trigger: { kind: "interval", everyMs: 30 * MINUTE }, reportOnly: false })
    expect(watch).toMatchObject({ template: "pr-watch", trigger: { kind: "interval", everyMs: 30 * MINUTE }, budget: { mode: "goal", maxRuns: 100 }, criteria: "PR merged", audit: "independent" })
    expect(watch.reportOnly).toBeUndefined()
    expect(watch.objective).toContain("Specifically: PR 123 only")
    expect(sessions.at(-1)!.readOnly).toBeUndefined()

    const fixed = service.create({ name: "r", directory: "/repo", template: "repo-maintenance", budget: { mode: "fixed", maxRuns: 3 } })
    expect(fixed.budget).toEqual({ mode: "fixed", maxRuns: 3 })
    expect(fixed.criteria).toBeUndefined()
  })

  test("problems: unknown template, missing pieces, a report-only loop with a worktree", () => {
    expect(createProblems({ name: "x", directory: "/r", template: "nope" })).toContain("unknown loop template")
    expect(createProblems({ name: "x", directory: "/r" })).toContain("needs an objective")
    expect(createProblems({ name: "x", directory: "/r", objective: "o", trigger: { kind: "manual" } })).toContain("needs an objective")
    expect(createProblems({ name: "x", directory: "/r", template: "research-digest", workspace: "worktree" })).toContain("report-only")
    expect(createProblems({ name: "x", directory: "/r", template: "repo-maintenance", workspace: "worktree" })).toBeUndefined()
    expect(() => harness().service.create({ name: "x", directory: "/r", template: "nope" })).toThrow("[LOOP]: unknown loop template")
  })
})

describe("report-only loops", () => {
  test("the loop session is read-only (plan mode: write and execute tools are refused) and the prompt says so", async () => {
    const { clock, service, sessions, submitted } = harness()
    const loop = service.create({ name: "report", directory: "/repo", objective: "audit deps", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" }, reportOnly: true })
    expect(loop.reportOnly).toBe(true)
    expect(sessions).toEqual([expect.objectContaining({ title: "loop · report", readOnly: true })])
    clock.advance(3_600_000)
    await flush()
    expect(submitted[0]!.text).toContain("Report-only loop")
    const normal = service.create({ name: "normal", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
    expect(normal.reportOnly).toBeUndefined()
    expect(sessions.at(-1)!.readOnly).toBeUndefined()
  })
})

describe("worktree leases in the service", () => {
  type Call = { op: "create" | "release"; key?: string; from?: string; path?: string; branch?: string }
  function fakeWorktrees(release: "removed" | "retained" = "retained") {
    const calls: Call[] = []
    const port: WorktreePort = {
      async create({ key, from }) {
        calls.push({ op: "create", key, ...(from ? { from } : {}) })
        return { ok: true, path: `/leases/${key}`, branch: `loop/${key}`, base: "abc123" }
      },
      async release({ path, branch }) {
        calls.push({ op: "release", path, branch })
        return release === "removed" ? { state: "removed" } : { state: "retained", detail: "1 commit" }
      },
    }
    return { calls, port }
  }

  test("each run gets its own session in its own worktree and the lease ends with the run", async () => {
    const fake = fakeWorktrees("retained")
    const { service, sessions, submitted, playTurn, saved } = harness({ worktree: fake.port })
    const loop = service.create({ name: "fix", directory: "/repo", objective: "fix it", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    expect(loop.workspace).toBe("worktree")
    service.runNow(loop.loopId)
    await flush()
    await flush()
    const run = service.get(loop.loopId)!.history[0]!
    expect(run.worktree).toMatchObject({ state: "active", path: `/leases/${loop.loopId}-r1`, base: "abc123" })
    expect(sessions.at(-1)).toMatchObject({ directory: `/leases/${loop.loopId}-r1`, title: "loop · fix · run 1" })
    expect(submitted[0]!.sessionId).toBe(run.sessionId!)
    expect(submitted[0]!.sessionId).not.toBe(loop.sessionId)
    expect(submitted[0]!.text).toContain("private git worktree")
    playTurn(checkpoint("continue"))
    await flush()
    await flush()
    const done = service.get(loop.loopId)!
    expect(done.state).toBe("active")
    expect(done.history[0]!.worktree).toMatchObject({ state: "retained", detail: "1 commit" })
    expect(fake.calls.map((call) => call.op)).toEqual(["create", "release"])
    expect(saved.get(loop.loopId)!.history[0]!.worktree!.state).toBe("retained")
  })

  test("goal loops continue from the branch the last run kept; monitors start from HEAD each time", async () => {
    const goal = fakeWorktrees("retained")
    const a = harness({ worktree: goal.port })
    const loop = a.service.create({ name: "g", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 5 }, audit: "none", workspace: "worktree" })
    a.service.runNow(loop.loopId)
    await flush()
    a.playTurn(checkpoint("continue"))
    await flush()
    await flush()
    a.service.runNow(loop.loopId)
    await flush()
    expect(goal.calls.filter((call) => call.op === "create").map((call) => call.from)).toEqual([undefined, `loop/${loop.loopId}-r1`])

    const monitor = fakeWorktrees("retained")
    const b = harness({ worktree: monitor.port })
    const watch = b.service.create({ name: "m", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    b.service.runNow(watch.loopId)
    await flush()
    b.playTurn(checkpoint("continue"))
    await flush()
    await flush()
    b.service.runNow(watch.loopId)
    await flush()
    expect(monitor.calls.filter((call) => call.op === "create").map((call) => call.from)).toEqual([undefined, undefined])
  })

  test("a worktree that cannot be made fails the run instead of touching the user's checkout", async () => {
    const { service, submitted } = harness({
      worktree: { create: async () => ({ ok: false, message: "not a git checkout" }), release: async () => ({ state: "removed" }) },
    })
    const loop = service.create({ name: "x", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    service.runNow(loop.loopId)
    await flush()
    await flush()
    const failed = service.get(loop.loopId)!
    expect(submitted).toHaveLength(0)
    expect(failed.history[0]).toMatchObject({ outcome: "failed" })
    expect(failed.reason).toContain("worktree unavailable: not a git checkout")
    const without = harness()
    const bare = without.service.create({ name: "y", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    without.service.runNow(bare.loopId)
    await flush()
    await flush()
    expect(without.submitted).toHaveLength(0)
    expect(without.service.get(bare.loopId)!.reason).toContain("worktrees are not available")
  })

  test("a lease the daemon died holding is released when the service starts again", async () => {
    const fake = fakeWorktrees("retained")
    const first = harness({ worktree: fake.port })
    const loop = first.service.create({ name: "x", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, workspace: "worktree" })
    first.service.runNow(loop.loopId)
    await flush()
    await flush()
    expect(first.service.get(loop.loopId)!.history[0]!.worktree!.state).toBe("active")
    // A new service over the same store: the interrupted run is closed and its lease ends.
    const clock = createVirtualClock(START)
    const again = createLoopService({
      store: { all: () => [...first.saved.values()], save: (l) => void first.saved.set(l.loopId, l), remove: () => {} },
      clock,
      ids: createIdFactory({ now: () => clock.now() }),
      createSession: () => "ses_x" as SessionId,
      submit: async () => ({ error: "unused" }),
      worktree: fake.port,
    })
    again.start()
    await flush()
    await flush()
    const restored = again.get(loop.loopId)!
    expect(restored.history[0]).toMatchObject({ outcome: "interrupted", worktree: { state: "retained" } })
    expect(fake.calls.filter((call) => call.op === "release")).toHaveLength(1)
  })
})
