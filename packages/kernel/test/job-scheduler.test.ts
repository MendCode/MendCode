import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createJobScheduler, type JobContext } from "../src/job-scheduler"
import { createScope } from "../src/scope"
import { createHarness, flush } from "./helpers"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function setup(mode: "low" | "normal" | "high" = "normal") {
  const h = createHarness()
  const scheduler = createJobScheduler({ clock: h.clock, scope: h.root.child("jobs"), sink: h.globalSink, ids: h.ids, mode })
  return { h, scheduler }
}

describe("JobScheduler", () => {
  test("Dream (P5) pauses while any foreground session is busy and resumes after (FC-01 pressure side)", async () => {
    const { h, scheduler } = setup()
    const gate = deferred()
    const progress: string[] = []
    scheduler.schedule({
      jobType: "dream",
      priority: "P5",
      async run(ctx: JobContext) {
        progress.push("start")
        await gate.promise
        await ctx.checkpoint()
        progress.push("after-checkpoint")
      },
    })
    await flush()
    scheduler.setForegroundBusy("ses_a", true)
    gate.resolve()
    await flush()
    expect(progress).toEqual(["start"])
    expect(scheduler.snapshot()[0]?.state).toBe("paused")
    scheduler.setForegroundBusy("ses_a", false)
    await flush()
    expect(progress).toEqual(["start", "after-checkpoint"])
    expect(h.globals.map((e) => (e.type === "job.state" ? e.state : e.type))).toEqual(["scheduled", "running", "paused", "running", "done"])
  })

  test("a P5 job scheduled while the foreground is busy does not start until it is idle", async () => {
    const { scheduler } = setup()
    scheduler.setForegroundBusy("ses_a", true)
    let started = false
    scheduler.schedule({ jobType: "maintenance", priority: "P6", run: async () => void (started = true) })
    await flush()
    expect(started).toBe(false)
    scheduler.setForegroundBusy("ses_a", false)
    await flush()
    expect(started).toBe(true)
  })

  test("user-started workflows (P3) keep running under foreground pressure", async () => {
    const { scheduler } = setup()
    scheduler.setForegroundBusy("ses_a", true)
    let ran = false
    scheduler.schedule({ jobType: "workflow", priority: "P3", run: async () => void (ran = true) })
    await flush()
    expect(ran).toBe(true)
  })

  test("concurrency follows resourceMode (low = 1)", async () => {
    const { scheduler } = setup("low")
    const gate = deferred()
    let concurrent = 0
    let peak = 0
    for (let i = 0; i < 3; i++) {
      scheduler.schedule({
        jobType: "maintenance",
        priority: "P6",
        async run() {
          concurrent++
          peak = Math.max(peak, concurrent)
          await gate.promise
          concurrent--
        },
      })
    }
    await flush()
    gate.resolve()
    await flush(30)
    expect(peak).toBe(1)
  })

  test("future jobs use a single timer and run when due", async () => {
    const { h, scheduler } = setup()
    const ran: string[] = []
    const now = h.clock.now()
    scheduler.schedule({ jobType: "dream", priority: "P5", runAt: now + 10_000, run: async () => void ran.push("a") })
    scheduler.schedule({ jobType: "dream", priority: "P5", runAt: now + 20_000, run: async () => void ran.push("b") })
    expect(h.clock.pendingTimers()).toBe(1)
    h.clock.advance(10_000)
    await flush()
    expect(ran).toEqual(["a"])
    h.clock.advance(10_000)
    await flush()
    expect(ran).toEqual(["a", "b"])
    expect(h.clock.pendingTimers()).toBe(0)
  })

  test("disposing the scheduler cancels running jobs and leaves no timers (P6)", async () => {
    const { h, scheduler } = setup()
    let aborted = false
    scheduler.schedule({
      jobType: "loop",
      priority: "P4",
      run: (ctx) => new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => ((aborted = true), resolve()))),
    })
    scheduler.schedule({ jobType: "dream", priority: "P5", runAt: h.clock.now() + 60_000, run: async () => {} })
    await flush()
    h.root.dispose()
    await flush()
    expect(aborted).toBe(true)
    expect(h.clock.pendingTimers()).toBe(0)
    expect(h.registry.counters.timers).toBe(0)
  })
})

describe("Scope", () => {
  test("children and timers are released in reverse order and counters return to zero", () => {
    const h = createHarness()
    const order: string[] = []
    const parent = createScope({ name: "p", clock: h.clock, registry: h.registry })
    const child = parent.child("c")
    child.onDispose(() => order.push("child"))
    parent.onDispose(() => order.push("parent"))
    parent.timer(1_000, () => order.push("timer"))
    parent.dispose()
    expect(order).toEqual(["parent", "child"])
    h.clock.advance(2_000)
    expect(order).toEqual(["parent", "child"])
    expect(h.registry.counters.timers).toBe(0)
    expect(h.registry.counters.disposers).toBe(0)
  })

  test("a long-lived parent does not accumulate released children (no slow leak)", () => {
    const h = createHarness()
    const parent = createScope({ name: "p", clock: h.clock, registry: h.registry })
    for (let i = 0; i < 1_000; i++) parent.child(`c${i}`).dispose()
    expect(h.registry.counters.disposers).toBe(0)
    expect(h.registry.counters.scopes).toBe(2)
  })
})

describe("kernel boundaries", () => {
  test("kernel source has no IO, database, network or UI imports (P3)", () => {
    const dir = path.join(import.meta.dir, "../src")
    const forbidden = /^(node:|fs|path|net|child_process|bun:|@opentui|solid-js)/
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8")
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) expect(forbidden.test(match[1] ?? "")).toBe(false)
      expect(/\bset(Timeout|Interval)\(/.test(source) && file !== "clock.ts").toBe(false)
    }
  })
})
