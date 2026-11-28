import { expect, test } from "bun:test"
import { createLoopWatch } from "../src/loop-watch"

function rig() {
  let clock = 0
  let tick: () => void = () => {}
  const lines: string[] = []
  const watch = createLoopWatch({ log: (line) => lines.push(line), now: () => clock, intervalMs: 1000, thresholdMs: 1000, facts: () => "rss 10 MB", every: (run) => { tick = run; return () => { tick = () => {} } } })
  return { watch, lines, at: (ms: number) => { clock = ms }, tick: () => tick() }
}

test("a timer on time logs nothing; a late one names the lag, the commands in flight and the ones that started during it", () => {
  const r = rig()
  const before = r.watch.begin("session.list")
  r.at(500)
  before()
  r.at(1000)
  r.tick()
  expect(r.lines).toEqual([])
  const held = r.watch.begin("bot.list")
  r.at(1200)
  const quick = r.watch.begin("daemon.info")
  r.at(1210)
  quick()
  r.at(4500)
  r.tick()
  expect(r.lines).toHaveLength(1)
  expect(r.lines[0]).toBe("[DAEMON]: the event loop was blocked for 2500 ms · in flight: bot.list 3500ms · started during it: bot.list, daemon.info 10ms · rss 10 MB")
  held()
  r.at(5500)
  r.tick()
  expect(r.lines).toHaveLength(1)
})

test("with nothing in flight the line says so: the stall came from background work", () => {
  const r = rig()
  r.at(3200)
  r.tick()
  expect(r.lines[0]).toContain("blocked for 2200 ms · in flight: none · started during it: none")
})
