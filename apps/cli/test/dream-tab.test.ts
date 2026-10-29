import { describe, expect, test } from "bun:test"
import type { DreamRun } from "@mendcode/protocol"
import { createDreamTabState, dreamTabKey, renderDreamTab } from "../src/view/dream-tab"
import type { Line } from "../src/ui/theme"

const NOW = 1_800_000_000_000
const plain = (rows: Line[]) => rows.map((row) => row.map((span) => span.text).join(""))

function run(runId: number, patch: Partial<DreamRun> = {}): DreamRun {
  return { runId, directory: "/work/app", status: "done", startedAt: NOW - runId * 3_600_000, endedAt: NOW - runId * 3_600_000 + 12_000, proposed: 0, ...patch }
}

const RUNS = [run(1, { proposed: 3, notes: "found three durable preferences" }), run(2, { status: "failed", error: "model timed out" }), run(3, { status: "skipped", notes: "nothing changed since the last run" })]

describe("dream tab keys", () => {
  test("j/k and arrows move within the runs and stop at the ends", () => {
    const start = createDreamTabState()
    expect(dreamTabKey(start, "k", RUNS).state).toBe(start)
    const down = dreamTabKey(start, "j", RUNS).state
    expect(down.selected).toBe(1)
    expect(dreamTabKey(dreamTabKey(down, "\x1b[B", RUNS).state, "\x1b[B", RUNS).state.selected).toBe(2)
    expect(dreamTabKey(down, "\x1b[A", RUNS).state.selected).toBe(0)
  })

  test("r runs Dream unless one is already running; esc closes", () => {
    expect(dreamTabKey(createDreamTabState(), "r", RUNS).action).toEqual({ type: "run" })
    expect(dreamTabKey(createDreamTabState(), "r", undefined).action).toEqual({ type: "run" })
    expect(dreamTabKey(createDreamTabState(), "r", [run(9, { status: "running", endedAt: undefined } as never), ...RUNS]).action).toEqual({ type: "none" })
    expect(dreamTabKey(createDreamTabState(), "\x1b", RUNS).action).toEqual({ type: "close" })
  })

  test("enter reviews only a run that proposed memories", () => {
    expect(dreamTabKey({ selected: 0 }, "\r", RUNS).action).toEqual({ type: "review" })
    expect(dreamTabKey({ selected: 1 }, "\r", RUNS).action).toEqual({ type: "none" })
  })
})

describe("dream tab render", () => {
  test("schedule, pending count, runs newest first and the selected run's notes", () => {
    const rows = plain(renderDreamTab({ runs: RUNS, state: { selected: 0 }, dreamAt: "03:30", pending: 3, width: 80, height: 20, now: NOW }))
    expect(rows[0]).toContain("daily at 03:30")
    expect(rows[0]).toContain("3 pending to review")
    const text = rows.join("\n")
    expect(text).toContain("› ● 3 proposals")
    expect(text).toContain("failed")
    expect(text).toContain("skipped")
    expect(text).toContain("12s")
    expect(text).toContain("found three durable preferences")
  })

  test("a failed run shows its error; without a schedule it says where to set one", () => {
    const rows = plain(renderDreamTab({ runs: RUNS, state: { selected: 1 }, pending: 0, width: 80, height: 20, now: NOW }))
    expect(rows[0]).toContain("no schedule")
    expect(rows.join("\n")).toContain("model timed out")
  })

  test("loading and empty states, and it never exceeds its box", () => {
    expect(plain(renderDreamTab({ runs: undefined, state: createDreamTabState(), pending: 0, width: 60, height: 10, now: NOW })).join("\n")).toContain("loading runs")
    expect(plain(renderDreamTab({ runs: [], state: createDreamTabState(), pending: 0, width: 60, height: 10, now: NOW })).join("\n")).toContain("r runs Dream now")
    const many = Array.from({ length: 20 }, (_, index) => run(index + 1))
    for (const [width, height] of [[20, 3], [60, 8], [120, 30]] as const) {
      const rows = renderDreamTab({ runs: many, state: { selected: 19 }, dreamAt: "03:30", pending: 0, width, height, now: NOW })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of plain(rows)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width)
      expect(plain(rows).some((row) => row.startsWith("› "))).toBe(true)
    }
  })
})
