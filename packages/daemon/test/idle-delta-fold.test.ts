import { expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdleDeltaFold } from "../src/idle-delta-fold"

test("folding never runs at startup or while busy, stops when complete and cancels on shutdown", () => {
  const clock = createVirtualClock(0)
  let busy = true, calls = 0
  const fold = createIdleDeltaFold({ clock, busy: () => busy, step: () => ({ complete: ++calls === 2 }), warn: () => {} })
  expect(calls).toBe(0)
  clock.advance(30_000)
  expect(calls).toBe(0)
  busy = false
  clock.advance(30_000)
  expect(calls).toBe(1)
  clock.advance(30_000)
  expect(calls).toBe(2)
  clock.advance(30_000)
  expect(calls).toBe(2)
  fold.dispose()
  const stopped = createIdleDeltaFold({ clock, busy: () => false, step: () => { calls++; return { complete: false } }, warn: () => {} })
  stopped.dispose()
  clock.advance(30_000)
  expect(calls).toBe(2)
})
