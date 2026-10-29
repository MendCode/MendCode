import { expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, type Loop, type LoopId } from "@mendcode/protocol"
import { createLoopService, type WorktreePort } from "../src"

function harness(worktree?: WorktreePort) {
  const clock = createVirtualClock(1_000_000), ids = createIdFactory(), saved = new Map<LoopId, Loop>()
  let submissions = 0
  const service = createLoopService({ clock, ids, store: { all: () => [...saved.values()], save: (loop) => { saved.set(loop.loopId, loop) }, remove: (id) => { saved.delete(id) } }, createSession: () => ids("session"), submit: async () => { submissions++; return { queueId: ids("queue") } }, ...(worktree ? { worktree } : {}) })
  const loop = service.create({ name: "fixture", directory: "/temp", objective: "work", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" }, ...(worktree ? { workspace: "worktree" } : {}) })
  return { clock, service, loop, saved, submissions: () => submissions }
}
test("text edits preserve due time; two wakes dispatch once, ACK is not completion", async () => {
  const h = harness()
  const due = h.loop.nextWakeAt
  h.clock.advance(30_000)
  expect(h.service.update(h.loop.loopId, { objective: "updated" })?.nextWakeAt).toBe(due)
  h.clock.advance(30_000)
  h.service.runNow(h.loop.loopId)
  await new Promise((resolve) => setImmediate(resolve))
  expect(h.submissions()).toBe(1)
  expect(h.service.get(h.loop.loopId)?.history[0]?.endedAt).toBeUndefined()
  h.service.dispose()
})
test("stop/delete or edit while workspace creation awaits cannot dispatch or revive deleted loops", async () => {
  for (const change of ["delete", "edit"] as const) {
    let release!: (result: { ok: true; path: string; branch: string; base: string }) => void, releases = 0
    const h = harness({ create: () => new Promise((resolve) => { release = resolve }), release: async () => { releases++; return { state: "removed" } } })
    h.service.runNow(h.loop.loopId)
    if (change === "delete") { h.service.stop(h.loop.loopId); expect(h.service.remove(h.loop.loopId)).toBe(true) }
    else h.service.update(h.loop.loopId, { objective: "new request" })
    release({ ok: true, path: "/fake/lease", branch: "current-base-fixture", base: "head-fixture" })
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.submissions()).toBe(0)
    expect(releases).toBe(1)
    if (change === "delete") { expect(h.service.get(h.loop.loopId)).toBeUndefined(); expect(h.saved.has(h.loop.loopId)).toBe(false) }
    else expect(h.service.get(h.loop.loopId)?.history[0]?.outcome).toBe("interrupted")
    h.service.dispose()
  }
})

test("unused lease cleanup failure is recorded without dispatch", async () => {
  let resolve!: (result: { ok: true; path: string; branch: string; base: string }) => void
  const h = harness({ create: () => new Promise((done) => { resolve = done }), release: async () => { throw new Error("fixture failure") } })
  h.service.runNow(h.loop.loopId)
  h.service.update(h.loop.loopId, { objective: "changed" })
  resolve({ ok: true, path: "/fake/retained", branch: "fixture", base: "fixture-base" })
  await new Promise((done) => setImmediate(done))
  expect(h.submissions()).toBe(0)
  expect(h.service.get(h.loop.loopId)?.history[0]?.worktree).toMatchObject({ state: "retained", detail: expect.stringContaining("cleanup failed") })
  h.service.dispose()
})
