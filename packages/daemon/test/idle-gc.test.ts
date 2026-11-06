import { expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdleGc, IDLE_GC_MS, STARTUP_GC_MS } from "../src/idle-gc"

test("the daemon collects once after it has been idle a while; new idle moments restart the wait, and work in the meantime skips it", () => {
  const clock = createVirtualClock(0)
  let busy = false
  let collections = 0
  const idleGc = createIdleGc({ clock, busy: () => busy, gc: () => void collections++ })
  idleGc.idle()
  clock.advance(IDLE_GC_MS - 1)
  idleGc.idle()
  clock.advance(IDLE_GC_MS - 1)
  expect(collections).toBe(0)
  clock.advance(1)
  expect(collections).toBe(1)
  idleGc.idle()
  busy = true
  clock.advance(IDLE_GC_MS)
  expect(collections).toBe(1)
  busy = false
  idleGc.idle()
  idleGc.stop()
  clock.advance(IDLE_GC_MS)
  expect(collections).toBe(1)
})

test("start-up arms one collection sooner than an idle moment, and an idle moment before it does not push it back", () => {
  const clock = createVirtualClock(0)
  let collections = 0
  const idleGc = createIdleGc({ clock, busy: () => false, gc: () => void collections++ })
  idleGc.started()
  clock.advance(STARTUP_GC_MS - 1)
  expect(collections).toBe(0)
  clock.advance(1)
  expect(collections).toBe(1)
  idleGc.started()
  clock.advance(STARTUP_GC_MS - 1)
  idleGc.idle()
  clock.advance(1)
  expect(collections).toBe(2)
  // Once it has run, idle moments wait the idle delay again.
  idleGc.idle()
  clock.advance(IDLE_GC_MS - 1)
  expect(collections).toBe(2)
  clock.advance(1)
  expect(collections).toBe(3)
})

/** Runs the virtual clock's due timers and the promises they resolve until nothing is left to run. */
async function settle(clock: ReturnType<typeof createVirtualClock>) {
  for (let i = 0; i < 100; i++) {
    clock.advance(0)
    await Promise.resolve()
  }
}

test("start-up's warm-up runs in steps with a young collection after each, then the full collection", async () => {
  const clock = createVirtualClock(0)
  const order: string[] = []
  const idleGc = createIdleGc({ clock, busy: () => false, gc: () => void order.push("gc"), youngGc: () => void order.push("young") })
  idleGc.started(async (between) => {
    for (const step of ["a", "b", "c"]) { order.push(step); await between() }
  })
  clock.advance(STARTUP_GC_MS - 1)
  await settle(clock)
  expect(order).toEqual([])
  clock.advance(1)
  await settle(clock)
  expect(order).toEqual(["a", "young", "b", "young", "c", "young", "gc"])
  // It runs once: the next collection is a plain one.
  idleGc.idle()
  clock.advance(IDLE_GC_MS)
  await settle(clock)
  expect(order.at(-1)).toBe("gc")
  expect(order.filter((step) => step === "a")).toEqual(["a"])
})

test("a turn that starts during the warm-up skips its collections, and a warm-up that throws still ends in the collection", async () => {
  const clock = createVirtualClock(0)
  let busy = false
  const order: string[] = []
  const idleGc = createIdleGc({ clock, busy: () => busy, gc: () => void order.push("gc"), youngGc: () => void order.push("young") })
  idleGc.started(async (between) => {
    order.push("a")
    busy = true
    await between()
    order.push("b")
    busy = false
    await between()
    throw new Error("no tools")
  })
  clock.advance(STARTUP_GC_MS)
  await settle(clock)
  expect(order).toEqual(["a", "b", "young", "gc"])
})

test("a busy daemon at the start-up moment leaves the warm-up for the next collection", async () => {
  const clock = createVirtualClock(0)
  let busy = true
  const order: string[] = []
  const idleGc = createIdleGc({ clock, busy: () => busy, gc: () => void order.push("gc"), youngGc: () => {} })
  idleGc.started(async () => void order.push("warm"))
  clock.advance(STARTUP_GC_MS)
  await settle(clock)
  expect(order).toEqual([])
  busy = false
  idleGc.idle()
  clock.advance(IDLE_GC_MS)
  await settle(clock)
  expect(order).toEqual(["warm", "gc"])
})
