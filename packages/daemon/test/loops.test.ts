import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type Loop } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function boot(dir: string) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const changes: Loop[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "loops", onGlobal: (e) => void (e.type === "loop.changed" && changes.push(e.loop)) })
  await client.connect()
  return { daemon, client, changes }
}

describe("loops in the daemon", () => {
  test("loop.update preserves identity, history and state, persists and emits the edited schedule", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loop-edit-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client, changes } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    const created = await client.send({ type: "loop.create", name: "watch", directory: dir, objective: "check", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" }, runNow: true })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    await until(() => changes.some((c) => c.loopId === loop.loopId && c.history[0]?.outcome === "completed"))
    const before = changes.filter((c) => c.loopId === loop.loopId).at(-1)!
    const updated = await client.send({ type: "loop.update", loopId: loop.loopId, objective: "check again", trigger: { kind: "interval", everyMs: 7_200_000 } })
    expect(updated.ok).toBe(true)
    const edited = (updated.ok ? updated.result?.loop : undefined) as Loop
    expect(edited).toMatchObject({ loopId: before.loopId, sessionId: before.sessionId, directory: dir, name: before.name, state: "active", runs: before.runs, history: before.history, createdAt: before.createdAt, objective: "check again", trigger: { kind: "interval", everyMs: 7_200_000 } })
    expect(edited.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(edited.nextWakeAt).toBeGreaterThan(before.nextWakeAt!)
    expect(Math.abs(edited.nextWakeAt! - (Date.now() + 7_200_000))).toBeLessThan(1_000)
    await until(() => changes.some((c) => c.loopId === loop.loopId && c.objective === "check again"))
    expect(daemon.store.loops.all()).toEqual([edited])
    const manual = await client.send({ type: "loop.update", loopId: loop.loopId, trigger: { kind: "manual" } })
    expect(manual.ok && (manual.result?.loop as Loop).nextWakeAt).toBeUndefined()
    expect(manual).toMatchObject({ ok: true, result: { loop: { history: before.history, state: "active" } } })
    const listed = await client.send({ type: "loop.list" })
    expect(listed.ok && (listed.result?.loops as Loop[]).length).toBe(1)
  })

  test("editing paused, stopped and completed loops keeps them disabled, even with runNow", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loop-edit-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    for (const action of ["pause", "stop", "accept"] as const) {
      const created = await client.send({ type: "loop.create", name: action, directory: dir, objective: "check", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
      const loop = (created.ok ? created.result?.loop : undefined) as Loop
      const controlled = await client.send({ type: "loop.control", loopId: loop.loopId, action, ...(action === "accept" ? { reason: "done" } : {}) })
      const before = (controlled.ok ? controlled.result?.loop : undefined) as Loop
      const updated = await client.send({ type: "loop.update", loopId: loop.loopId, name: "edited", trigger: { kind: "interval", everyMs: 60_000 }, runNow: true })
      expect(updated).toMatchObject({ ok: true, result: { loop: { loopId: loop.loopId, state: before.state, history: before.history, runs: 0 } } })
      expect(updated.ok && (updated.result?.loop as Loop).reason).toBe(before.reason)
      expect(updated.ok && (updated.result?.loop as Loop).nextWakeAt).toBeUndefined()
      expect(daemon.store.readAfter(loop.sessionId, 0).some((e) => e.type === "queue.added")).toBe(false)
    }
  })

  test("loop.update rejects unknown ids, invalid schedules and invalid merged options without changing the loop", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loop-edit-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    expect(await client.send({ type: "loop.update", loopId: createIdFactory()("loop"), name: "missing" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    const created = await client.send({ type: "loop.create", name: "watch", directory: dir, objective: "check", trigger: { kind: "manual" }, budget: { mode: "goal" }, reportOnly: true })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    for (const patch of [
      { trigger: { kind: "interval" as const, everyMs: 1 } },
      { trigger: { kind: "daily" as const, at: "25:00" } },
      { trigger: { kind: "daily" as const, at: "09:00", timezone: "Nowhere/Invalid" } },
      { trigger: { kind: "adaptive" as const, everyMs: 60_000, minMs: 120_000 } },
      { checks: ["bun test && echo no"] },
      { workspace: "worktree" as const },
      { reportOnly: false, workspace: "worktree" as const },
      { template: "missing" },
    ]) expect(await client.send({ type: "loop.update", loopId: loop.loopId, ...patch })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(daemon.store.loops.all()).toEqual([loop])
  })

  test("editing report-only updates the existing root session's permission and supports explicit clears", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loop-edit-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    const created = await client.send({ type: "loop.create", name: "watch", directory: dir, objective: "check", criteria: "green", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun test"] })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    expect(await client.send({ type: "loop.update", loopId: loop.loopId, reportOnly: true })).toMatchObject({ ok: true, result: { loop: { reportOnly: true } } })
    expect(daemon.store.readAfter(loop.sessionId, 0).findLast((event) => event.type === "session.permission")).toMatchObject({ mode: "plan" })
    expect(await client.send({ type: "loop.update", loopId: loop.loopId, reportOnly: false, workspace: "in-place", criteria: "", checks: [], audit: "none" })).toMatchObject({ ok: true, result: { loop: { reportOnly: false, workspace: "in-place", criteria: "", checks: [], audit: "none" } } })
    expect(daemon.store.readAfter(loop.sessionId, 0).findLast((event) => event.type === "session.permission")).toMatchObject({ mode: "ask" })
  })

  test("a fixed loop runs in its own session through the actor and completes after its runs; control commands work", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loops-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client, changes } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    const created = await client.send({ type: "loop.create", name: "once", directory: "/repo", objective: "say hi", trigger: { kind: "manual" }, budget: { mode: "fixed", maxRuns: 1 }, runNow: true })
    expect(created.ok).toBe(true)
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    await until(() => changes.some((c) => c.loopId === loop.loopId && c.state === "completed"))
    const done = changes.filter((c) => c.loopId === loop.loopId).at(-1)!
    expect(done).toMatchObject({ runs: 1, reason: "1 runs done" })
    expect(done.history[0]).toMatchObject({ run: 1, outcome: "completed" })
    const events = daemon.store.readAfter(loop.sessionId, 0)
    expect(events.find((e) => e.type === "queue.added" && e.text.includes("say hi"))).toBeDefined()
    expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    expect(await client.send({ type: "loop.control", loopId: loop.loopId, action: "run" })).toMatchObject({ ok: false, error: { code: "busy" } })
    const monitor = await client.send({ type: "loop.create", name: "watch", directory: "/repo", objective: "check", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
    const monitorId = (monitor.ok ? (monitor.result?.loop as Loop).loopId : undefined)!
    expect(await client.send({ type: "loop.control", loopId: monitorId, action: "pause" })).toMatchObject({ ok: true, result: { loop: { state: "paused" } } })
    expect(await client.send({ type: "loop.control", loopId: monitorId, action: "delete" })).toMatchObject({ ok: true })
    const listed = await client.send({ type: "loop.list", directory: "/repo" })
    expect(listed.ok && (listed.result?.loops as Loop[]).map((l) => l.name)).toEqual(["once"])
  })

  test("a loop session follows the default permission; checks with shell syntax are refused; accept needs a reason", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loops-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { daemon, client } = await boot(dir)
    cleanups.push(() => daemon.stop(), () => client.close())
    await client.send({ type: "settings.set", patch: { defaultPermission: "edits" } })
    const bad = await client.send({ type: "loop.create", name: "g", directory: dir, objective: "o", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun test && rm -rf ."] })
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    const created = await client.send({ type: "loop.create", name: "g", directory: dir, objective: "o", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun --version"] })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    expect(loop).toMatchObject({ audit: "independent", checks: ["bun --version"] })
    await until(() => daemon.store.readAfter(loop.sessionId, 0).some((e) => e.type === "session.permission"))
    expect(daemon.store.readAfter(loop.sessionId, 0).find((e) => e.type === "session.permission")).toMatchObject({ mode: "edits" })
    expect(await client.send({ type: "loop.control", loopId: loop.loopId, action: "accept" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.send({ type: "loop.control", loopId: loop.loopId, action: "accept", reason: "done by hand" })).toMatchObject({ ok: true, result: { loop: { state: "completed", override: { reason: "done by hand" } } } })
  })

  test("loops survive a daemon restart and keep their schedule", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-loops-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot(dir)
    const created = await first.client.send({ type: "loop.create", name: "daily", directory: "/repo", objective: "report", trigger: { kind: "daily", at: "09:00" }, budget: { mode: "monitor" } })
    const loop = (created.ok ? created.result?.loop : undefined) as Loop
    first.client.close()
    await first.daemon.stop()
    const second = await boot(dir)
    cleanups.push(() => second.daemon.stop(), () => second.client.close())
    const listed = await second.client.send({ type: "loop.list" })
    const restored = (listed.ok ? (listed.result?.loops as Loop[]) : []).find((l) => l.loopId === loop.loopId)!
    expect(restored).toMatchObject({ state: "active", nextWakeAt: loop.nextWakeAt, sessionId: loop.sessionId })
  })
})
