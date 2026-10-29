import { describe, expect, test } from "bun:test"
import { createIdFactory, type Loop, type LoopRun } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import {
  createLoopsPageState,
  describeBudget,
  formatCountdown,
  formatDuration,
  loopsPageKey,
  needsTick,
  renderLoopsPage,
  type LoopsPageState,
} from "../src/view/loops-page"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000

function loop(over: Partial<Loop> = {}): Loop {
  return {
    loopId: ids("loop"),
    name: "check ci",
    directory: "/Users/dev/Code/MendCodeV2",
    objective: "check the CI status and fix failing tests",
    trigger: { kind: "interval", everyMs: 30 * MIN },
    budget: { mode: "monitor" },
    state: "active",
    sessionId: ids("session"),
    runs: 2,
    nextWakeAt: NOW + 12 * MIN + 3_000,
    history: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over,
  }
}

function run(n: number, over: Partial<LoopRun> = {}): LoopRun {
  return { run: n, startedAt: NOW - 10 * MIN, endedAt: NOW - 10 * MIN + 4 * MIN + 12_000, outcome: "completed", checkpoint: { status: "continue", summary: `run ${n} done` }, ...over }
}

const text = (line: Line) => line.map((span) => span.text).join("")
const render = (loops: Loop[], state: LoopsPageState, width = 100, height = 40) => renderLoopsPage({ loops, state, width, height, now: NOW })
const plain = (lines: Line[]) => lines.map(text)
const titleRow = (lines: Line[]) => lines[1]!
const tabsRow = (lines: Line[]) => lines[2]!
const ruleRow = (lines: Line[]) => lines[3]!
/** A row without the page's one-cell margin on each side; trailing padding trimmed. */
const unwrapPanel = (raw: string): string => (raw.length > 1 ? raw.slice(1, -1) : raw).trimEnd()
const history = (selected = 0): LoopsPageState => ({ selected, scope: "project", tab: 1 })

const sample = [
  loop({ name: "check ci", history: [run(1), run(2, { outcome: "failed", checkpoint: { status: "blocked", summary: "tests still red" } })] }),
  loop({ name: "triage issues", state: "running", nextWakeAt: undefined, budget: { mode: "goal", maxRuns: 3 }, criteria: "no untriaged issues remain" }),
  loop({ name: "release notes", state: "needs_input", reason: "waiting for your answer" }),
  loop({ name: "nightly", state: "paused", trigger: { kind: "daily", at: "09:00" }, nextWakeAt: undefined }),
  loop({ name: "migrate", state: "completed", budget: { mode: "fixed", maxRuns: 5 }, runs: 5, nextWakeAt: undefined }),
  loop({ name: "broken", state: "blocked", reason: "engine unavailable", nextWakeAt: undefined }),
  loop({ name: "old", state: "stopped", trigger: { kind: "manual" }, nextWakeAt: undefined }),
]

describe("formatting", () => {
  test("countdown boundaries", () => {
    const at = (ms: number) => formatCountdown(NOW + ms, NOW)
    expect(at(0)).toBe("due")
    expect(at(-5_000)).toBe("due")
    expect(at(1)).toBe("in 1s")
    expect(at(42_000)).toBe("in 42s")
    expect(at(59_000)).toBe("in 59s")
    expect(at(60_000)).toBe("in 1m 00s")
    expect(at(12 * MIN + 3_000)).toBe("in 12m 03s")
    expect(at(59 * MIN + 59_000)).toBe("in 59m 59s")
    expect(at(60 * MIN)).toBe("in 1h 00m")
    expect(at(3 * 3_600_000 + 5 * MIN)).toBe("in 3h 05m")
    expect(at(24 * 3_600_000)).toBe("in 1d 0h")
    expect(at(50 * 3_600_000)).toBe("in 2d 2h")
  })
  test("duration boundaries", () => {
    expect(formatDuration(400)).toBe("<1s")
    expect(formatDuration(-1)).toBe("<1s")
    expect(formatDuration(999)).toBe("<1s")
    expect(formatDuration(1_000)).toBe("1s")
    expect(formatDuration(3_599_999)).toBe("59m 59s")
    expect(formatDuration(86_400_000)).toBe("24h 00m")
    expect(formatDuration(38_000)).toBe("38s")
    expect(formatDuration(4 * MIN + 12_000)).toBe("4m 12s")
    expect(formatDuration(64 * MIN)).toBe("1h 04m")
  })
  test("budget descriptions", () => {
    expect(describeBudget(loop({ budget: { mode: "goal", maxRuns: 3 } }))).toBe("goal ≤3")
    expect(describeBudget(loop({ budget: { mode: "goal" } }))).toBe("goal")
    expect(describeBudget(loop({ budget: { mode: "fixed", maxRuns: 5 }, runs: 2 }))).toBe("fixed 2/5")
    expect(describeBudget(loop())).toBe("monitor")
  })
  test("needsTick only when a countdown is visible", () => {
    expect(needsTick([])).toBe(false)
    expect(needsTick([loop({ state: "paused" })])).toBe(false)
    expect(needsTick([loop({ nextWakeAt: undefined })])).toBe(false)
    expect(needsTick([loop({ state: "completed" }), loop()])).toBe(true)
  })
})

describe("renderLoopsPage", () => {
  test.each([[60, 20], [100, 30], [160, 45], [180, 50], [220, 60], [50, 6], [60, 1]])("panel grid fits %ix%i on both tabs", (width, height) => {
    for (const tab of [0, 1]) for (const selected of [0, 3, 20]) {
      const lines = render(sample, { selected, scope: "project", tab }, width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBe(width)
    }
  })

  test("hints share the header, tabs stay at the top and panels use the screen width", () => {
    const rows = plain(render(sample, createLoopsPageState(), 180, 50))
    expect(rows[0]).toContain("Loops · this project")
    expect(rows[0]).toContain("esc back")
    expect(rows[1]).toContain("1 Active")
    expect(rows[1]).toContain("2 History")
    expect(rows[2]).toStartWith("┌")
    expect(rows[2]).toEndWith("┐")
    expect(rows.at(-1)).toStartWith("└")
    expect(rows.join("\n")).toContain("Gates / Rubric")
    expect(rows.slice(2).join("\n")).not.toContain("esc back")
  })

  test("compact mode has one bordered column and selection stays visible", () => {
    const many = Array.from({ length: 30 }, (_, i) => loop({ name: `loop-${i}` }))
    const rows = plain(render(many, { selected: 25, scope: "project" }, 60, 20))
    expect(rows[2]!.match(/┌/g)).toHaveLength(1)
    expect(rows.filter((row) => row.includes("❯ loop-25"))).toHaveLength(1)
    expect(rows.join("\n")).not.toContain("loop-0 ")
  })

  test("Active and History filter finished loops without losing the selection pointer", () => {
    const active = plain(render(sample, createLoopsPageState(), 220, 60)).join("\n")
    for (const name of ["check ci", "triage issues", "release notes", "nightly", "broken"]) expect(active).toContain(name)
    for (const name of ["migrate", "old"]) expect(active).not.toContain(name)
    const done = plain(render(sample, history(), 220, 60)).join("\n")
    expect(done).toContain("❯ migrate")
    expect(done).toContain("old")
    expect(done).not.toContain("check ci")
  })

  test("selection shows the real objective, reason and five latest runs in order", () => {
    const selected = loop({ state: "blocked", reason: "tests failed", criteria: "all checks pass", history: Array.from({ length: 8 }, (_, i) => run(i + 1)) })
    const rows = plain(render([selected], createLoopsPageState(), 220, 60))
    const all = rows.join("\n")
    for (const part of [selected.objective, "all checks pass", "tests failed", "#8", "#4", "run 8 done"]) expect(all).toContain(part)
    expect(all).not.toContain("#3 ")
    expect(all.indexOf("#8")).toBeLessThan(all.indexOf("#4"))
  })

  test("empty states and confirmations name the available action", () => {
    expect(plain(render([], createLoopsPageState())).join("\n")).toContain("/loop every 1h <objective>")
    expect(plain(render([loop()], history())).join("\n")).toContain("No finished loops")
    const target = sample[0]!
    const lines = render(sample, { selected: 0, scope: "project", confirm: { kind: "stop", loopId: target.loopId } }, 180, 50)
    expect(text(lines[0]!)).toContain("Confirm")
    expect(plain(lines).join("\n")).toContain('stop "check ci"?')
  })
})

describe("loopsPageKey", () => {
  const start = createLoopsPageState()
  const finished = (loop: Loop) => loop.state === "completed" || loop.state === "stopped"
  /** Presses `key` with the named loop selected on the tab that lists it. */
  const on = (name: string, key: string, extra: Partial<LoopsPageState> = {}) => {
    const target = sample.find((l) => l.name === name)!
    const tab = finished(target) ? 1 : 0
    const list = sample.filter((l) => finished(l) === (tab === 1))
    return loopsPageKey({ selected: list.indexOf(target), scope: "project", tab, ...extra }, key, sample)
  }
  const id = (name: string) => sample.find((l) => l.name === name)!.loopId
  test("moves the selection with clamping inside the active tab", () => {
    expect(loopsPageKey(start, "j", sample).state.selected).toBe(1)
    expect(loopsPageKey(start, "\x1b[B", sample).state.selected).toBe(1)
    expect(loopsPageKey(start, "k", sample).state).toBe(start)
    expect(loopsPageKey({ ...start, selected: 4 }, "j", sample).state.selected).toBe(4)
    expect(loopsPageKey({ ...start, tab: 1, selected: 1 }, "j", sample).state.selected).toBe(1)
  })
  test("enter opens the loop session", () => {
    expect(loopsPageKey({ ...start, selected: 1 }, "\r", sample).action).toEqual({ type: "open", sessionId: sample[1]!.sessionId })
    expect(loopsPageKey(start, "\r", []).action).toEqual({ type: "none" })
  })
  test("esc and q close", () => {
    expect(loopsPageKey(start, "\x1b", sample).action).toEqual({ type: "close" })
    expect(loopsPageKey(start, "q", []).action).toEqual({ type: "close" })
  })
  test("p pauses active and needs-input loops, resumes paused and blocked ones", () => {
    expect(on("check ci", "p").action).toEqual({ type: "control", loopId: id("check ci"), action: "pause" })
    expect(on("release notes", "p").action).toEqual({ type: "control", loopId: id("release notes"), action: "pause" })
    expect(on("nightly", "p").action).toEqual({ type: "control", loopId: id("nightly"), action: "resume" })
    expect(on("broken", "p").action).toEqual({ type: "control", loopId: id("broken"), action: "resume" })
    for (const name of ["triage issues", "migrate", "old"]) expect(on(name, "p").action).toEqual({ type: "none" })
  })
  test("n runs now unless running or finished", () => {
    expect(on("check ci", "n").action).toEqual({ type: "control", loopId: id("check ci"), action: "run" })
    expect(on("nightly", "n").action).toEqual({ type: "control", loopId: id("nightly"), action: "run" })
    for (const name of ["triage issues", "migrate", "old"]) expect(on(name, "n").action).toEqual({ type: "none" })
  })
  test("s asks for confirmation, then s or y stops", () => {
    const asked = on("check ci", "s")
    expect(asked.action).toEqual({ type: "none" })
    expect(asked.state.confirm).toEqual({ kind: "stop", loopId: id("check ci") })
    const done = loopsPageKey(asked.state, "s", sample)
    expect(done.action).toEqual({ type: "control", loopId: id("check ci"), action: "stop" })
    expect(done.state.confirm).toBeUndefined()
    expect(loopsPageKey(asked.state, "y", sample).action).toMatchObject({ action: "stop" })
  })
  test("d asks for confirmation, then d or y deletes", () => {
    const asked = loopsPageKey(start, "d", sample)
    expect(asked.state.confirm).toEqual({ kind: "delete", loopId: sample[0]!.loopId })
    expect(loopsPageKey(asked.state, "d", sample).action).toEqual({ type: "control", loopId: sample[0]!.loopId, action: "delete" })
    expect(loopsPageKey(asked.state, "y", sample).action).toMatchObject({ action: "delete" })
    expect(loopsPageKey(asked.state, "s", sample).action).toEqual({ type: "none" })
  })
  test("any other key cancels a confirmation, esc does not close", () => {
    const asked = loopsPageKey(start, "s", sample).state
    for (const key of ["n", "j", "\x1b", "x", "2"]) {
      const result = loopsPageKey(asked, key, sample)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state.confirm).toBeUndefined()
      expect(result.state.tab).toBeUndefined()
    }
  })
  test("a confirmation for a loop that is no longer selected does nothing", () => {
    const asked = loopsPageKey(start, "s", sample).state
    expect(loopsPageKey({ ...asked, selected: 1 }, "s", sample).action).toEqual({ type: "none" })
  })
  test("stop is ignored for finished loops but delete is not", () => {
    expect(on("migrate", "s").state.confirm).toBeUndefined()
    expect(on("migrate", "d").state.confirm).toEqual({ kind: "delete", loopId: id("migrate") })
  })
  test("tab toggles the scope, resets the selection and keeps the current tab", () => {
    const all = loopsPageKey({ selected: 3, scope: "project" }, "\t", sample)
    expect(all.action).toEqual({ type: "scope", scope: "all" })
    expect(all.state).toEqual({ selected: 0, scope: "all" })
    expect(loopsPageKey(all.state, "\t", sample).action).toEqual({ type: "scope", scope: "project" })
    expect(loopsPageKey({ selected: 1, scope: "project", tab: 1 }, "\t", sample).state).toEqual({ selected: 0, scope: "all", tab: 1 })
  })
  test("1 and 2 jump to the Active and History tabs and reset the selection", () => {
    const moved = loopsPageKey({ ...start, selected: 3, scroll: 20 }, "2", sample)
    expect(moved.action).toEqual({ type: "none" })
    expect(moved.state).toEqual({ selected: 0, scope: "project", tab: 1, scroll: 0 })
    expect(loopsPageKey(moved.state, "1", sample).state).toEqual({ selected: 0, scope: "project", tab: 0, scroll: 0 })
    expect(loopsPageKey(start, "1", sample).state).toBe(start)
    expect(loopsPageKey(moved.state, "2", sample).state).toBe(moved.state)
  })
  test("shift-tab flips between the two tabs", () => {
    const history = loopsPageKey(start, "\x1b[Z", sample).state
    expect(history.tab).toBe(1)
    expect(loopsPageKey(history, "\x1b[Z", sample).state.tab).toBe(0)
  })
  test("keys act on the loops of the current tab", () => {
    expect(loopsPageKey({ ...start, tab: 1 }, "\r", sample).action).toEqual({ type: "open", sessionId: id("migrate") && sample.find((l) => l.name === "migrate")!.sessionId })
    expect(loopsPageKey({ ...start, tab: 1, selected: 1 }, "d", sample).state.confirm).toEqual({ kind: "delete", loopId: id("old") })
  })
  test("an empty list never throws", () => {
    for (const key of ["j", "p", "n", "s", "d", "\r", "1", "2", "\x1b[Z"]) expect(loopsPageKey(start, key, []).action).toEqual({ type: "none" })
  })
})

describe("goal verification in /loops", () => {
  const text = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
  const verified = loop({
    budget: { mode: "goal" },
    checks: ["bun test", "tsc -b"],
    audit: "independent",
    state: "active",
    feedback: "The independent audit did not confirm the goal:\ncriterion 2 not met",
    history: [run(3, { checkpoint: { status: "complete", summary: "all green" }, gates: [{ id: "bun test", status: "pass" }, { id: "tsc -b", status: "fail", detail: "exit 2" }], audit: { verdict: "fail", findings: "criterion 2 not met" } })],
  })

  test("the detail shows how completion is verified, the last checks and audit, and why the claim was rejected", () => {
    const out = text(renderLoopsPage({ loops: [verified], state: createLoopsPageState(), width: 220, height: 60, now: NOW }))
    expect(out.some((l) => l.includes("Verify  2 checks · independent audit"))).toBe(true)
    expect(out.some((l) => l.includes("✓ bun test"))).toBe(true)
    expect(out.some((l) => l.includes("✗ tsc -b"))).toBe(true)
    expect(out.some((l) => l.includes("audit  fail"))).toBe(true)
    expect(out.join("\n")).toContain("criterion 2 not met")
  })

  test("a verifying loop can be paused; `a` on an idle loop asks for a reason; running or completed loops cannot be accepted", () => {
    const state = createLoopsPageState()
    expect(loopsPageKey(state, "p", [loop({ state: "verifying" })]).action).toMatchObject({ type: "control", action: "pause" })
    expect(loopsPageKey(state, "a", [verified]).action).toEqual({ type: "accept", loopId: verified.loopId })
    expect(loopsPageKey(state, "a", [loop({ state: "running" })]).action).toEqual({ type: "none" })
    expect(loopsPageKey(state, "a", [loop({ state: "completed" })]).action).toEqual({ type: "none" })
  })

  test("a hand-accepted loop shows the user's reason", () => {
    const out = text(renderLoopsPage({ loops: [loop({ state: "completed", override: { reason: "checked by hand", at: NOW } })], state: history(), width: 100, height: 40, now: NOW }))
    expect(out.some((l) => l.includes("accepted by you checked by hand"))).toBe(true)
  })

  test.each([40, 60, 100, 140])("verification rows fit width %i", (width) => {
    for (const line of renderLoopsPage({ loops: [verified], state: createLoopsPageState(), width, height: 40, now: NOW })) expect(textWidth(line.map((s) => s.text).join(""))).toBeLessThanOrEqual(width)
  })
})
