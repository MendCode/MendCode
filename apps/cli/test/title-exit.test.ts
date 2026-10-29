import { describe, expect, test } from "bun:test"
import { createScreen } from "../src/ui/screen"
import { exitSummary, formatDuration } from "../src/view/exit-summary"

function fakeOutput() {
  const writes: string[] = []
  return { writes, output: { write: (data: string) => void writes.push(data), columns: 40, rows: 10 } }
}

describe("terminal title", () => {
  test("enter pushes the shell's title, setTitle writes OSC 2 only on change, leave pops it", () => {
    const { writes, output } = fakeOutput()
    const screen = createScreen(output, {})
    screen.enter()
    expect(writes[0]).toContain("\x1b[22;0t")
    screen.setTitle("MendCode | fix\x07 reconnect")
    screen.setTitle("MendCode | fix\x07 reconnect")
    expect(writes.filter((w) => w.startsWith("\x1b]2;"))).toEqual(["\x1b]2;MendCode | fix  reconnect\x07"])
    screen.leave()
    expect(writes.at(-1)).toContain("\x1b[23;0t")
  })

  test("MENDCODE_TERMINAL_TITLE=0 leaves the title alone; long titles are capped", () => {
    const off = fakeOutput()
    const quiet = createScreen(off.output, { MENDCODE_TERMINAL_TITLE: "0" })
    quiet.enter()
    quiet.setTitle("x")
    quiet.leave()
    expect(off.writes.join("")).not.toContain("\x1b]2;")
    expect(off.writes.join("")).not.toContain("22;0t")
    const on = fakeOutput()
    createScreen(on.output, {}).setTitle("y".repeat(200))
    expect(on.writes[0]).toBe(`\x1b]2;${"y".repeat(80)}\x07`)
  })
})

describe("/restart keeps the frame", () => {
  test("the old process stays on the alternate screen and the new one paints over it without clearing", () => {
    const old = fakeOutput()
    const before = createScreen(old.output as never, {})
    before.enter()
    old.writes.length = 0
    before.leave(true)
    expect(old.writes.join("")).not.toContain("\x1b[?1049l")
    const next = fakeOutput()
    const after = createScreen(next.output as never, {}, { keepFrame: true })
    after.enter()
    expect(next.writes.join("")).toContain("\x1b[?1049h")
    expect(next.writes.join("")).not.toContain("\x1b[2J")
  })

  test("a plain exit leaves the alternate screen", () => {
    const { writes, output } = fakeOutput()
    const screen = createScreen(output as never, {})
    screen.enter()
    screen.leave()
    expect(writes.join("")).toContain("\x1b[?1049l")
  })
})

describe("exit summary", () => {
  test("names the session, its usage and how to resume it", () => {
    expect(exitSummary({ sessionId: "ses_1", title: "fix reconnect", turns: 3, input: 12_340, output: 1_100, model: "gpt-6-luna", elapsedMs: 65_000 })).toBe(
      "MendCode · fix reconnect\n  gpt-6-luna · ↑12.3K ↓1,100 · 3 turns · 1m 5s\n  resume: mendcode --session ses_1\n",
    )
  })

  test("a reopened chat that ran no turn still says how to come back, without a usage line", () => {
    expect(exitSummary({ sessionId: "ses_1", title: "fix reconnect", turns: 0, input: 0, output: 0, elapsedMs: 5_000, hasHistory: true })).toBe(
      "MendCode · fix reconnect\n  resume: mendcode --session ses_1\n",
    )
  })

  test("color dims the labels and marks the title and the command", () => {
    const text = exitSummary({ sessionId: "ses_1", title: "t", turns: 0, input: 0, output: 0, elapsedMs: 0, hasHistory: true, color: true })
    expect(text).toBe("\x1b[2mMendCode ·\x1b[22m \x1b[1mt\x1b[22m\n  \x1b[2mresume:\x1b[22m \x1b[1mmendcode --session ses_1\x1b[22m\n")
  })

  test("nothing when no turn ran; durations read like v1", () => {
    expect(exitSummary({ sessionId: "ses_1", title: "", turns: 0, input: 0, output: 0, elapsedMs: 5_000 })).toBe("")
    expect([formatDuration(820), formatDuration(45_000), formatDuration(192_000), formatDuration(3_900_000)]).toEqual(["1s", "45s", "3m 12s", "1h 5m"])
  })
})
