import { expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdleGc, IDLE_GC_MS } from "../src/idle-gc"

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
