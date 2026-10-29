import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, mendRowIn, tempDir, type Harness } from "./session-ui-harness"
import type { PresentationMode } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
const RULE = /^[\s│]*─{10,}/

async function chat({ width, height, view, exchanges }: { width: number; height: number; view: PresentationMode; exchanges: number }) {
  const h = appHarness({ dataDir: tempDir(), width, height })
  h.app.applySettings({ onboarded: true, view })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  for (let i = 0; i < exchanges; i++) talk.exchange(`question ${i} needle`, `answer ${i}`)
  h.app.render()
  return h
}

const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
const promptRule = (h: Harness) => h.text().findIndex((row) => RULE.test(row))

describe("a transcript shorter than the body", () => {
  for (const [width, height] of [[60, 20], [100, 30], [200, 60]] as const) {
    for (const view of ["minimal", "balanced", "full"] as const) {
      test(`starts under the top bar after one blank row, the free rows sit above the prompt: ${width}x${height} ${view}`, async () => {
        const h = await chat({ width, height, view, exchanges: 1 })
        const first = rowOf(h, "question 0")
        const last = rowOf(h, "answer 0")
        const rule = promptRule(h)
        const topbar = view === "minimal" ? 0 : 1
        expect(first).toBe(topbar + 1)
        const chatOf = (row: string) => (width >= 120 ? row.slice(38) : row)
        expect(h.text().slice(topbar, first).every((row) => chatOf(row).trim() === "")).toBe(true)
        expect(last).toBe(first + 2)
        expect(rule).toBeGreaterThan(last + 1)
        expect(h.text().slice(last + 1, rule).every((row) => chatOf(row).trim() === "")).toBe(true)
      })
    }
  }

  test("a transcript that fills the body follows the bottom as before: no gap above the prompt, no blank band above the top", async () => {
    const h = await chat({ width: 100, height: 30, view: "balanced", exchanges: 30 })
    const last = rowOf(h, "answer 29")
    expect(promptRule(h) - last).toBe(2)
    expect(h.text()[2]!.trim()).not.toBe("")
    expect(h.text().slice(1, 4).filter((row) => row.trim() === "").length).toBeLessThan(3)
  })

  test("the layout switches at the first row that overflows", async () => {
    // Each exchange takes four rows; with a 30 row screen the body is 20 rows.
    const short = await chat({ width: 100, height: 30, view: "balanced", exchanges: 3 })
    expect(rowOf(short, "question 0")).toBe(2)
    const overflow = await chat({ width: 100, height: 30, view: "balanced", exchanges: 8 })
    expect(rowOf(overflow, "question 0")).toBe(-1)
    expect(promptRule(overflow) - rowOf(overflow, "answer 7")).toBe(2)
  })

  test("a drag over the first message and its answer copies exactly their text", async () => {
    const h = await chat({ width: 100, height: 30, view: "balanced", exchanges: 1 })
    const first = rowOf(h, "question 0")
    const last = rowOf(h, "answer 0")
    const start = h.text()[first]!.indexOf("question")
    await h.app.onKey(press(start, first))
    await h.app.onKey(drag(start + 4, first))
    await h.app.onKey(drag(40, last))
    await h.app.onKey(release(40, last))
    expect(osc52(h)).toEqual(["question 0 needle\n\nanswer 0"])
  })

  test("a drag that ends in the free rows under the last message still copies the messages, not blanks", async () => {
    const h = await chat({ width: 100, height: 30, view: "balanced", exchanges: 1 })
    const first = rowOf(h, "question 0")
    const start = h.text()[first]!.indexOf("question")
    await h.app.onKey(press(start, first))
    await h.app.onKey(drag(start + 4, first + 1))
    await h.app.onKey(drag(40, rowOf(h, "answer 0") + 6))
    await h.app.onKey(release(40, rowOf(h, "answer 0") + 6))
    expect(osc52(h)).toEqual(["question 0 needle\n\nanswer 0"])
  })

  test("find paints its hit on the row it is drawn at and the jump keeps it in view", async () => {
    const h = await chat({ width: 100, height: 30, view: "balanced", exchanges: 2 })
    await h.type("\x06")
    await h.type("needle")
    const painted = (h.frames.at(-1) ?? []).flatMap((line, row) => (line.some((span) => span.bg === "warning" && span.text === "needle") ? [row] : []))
    expect(painted).toEqual([rowOf(h, "question 1 needle")])
    await h.type("\x1b[A")
    const previous = (h.frames.at(-1) ?? []).flatMap((line, row) => (line.some((span) => span.bg === "warning" && span.text === "needle") ? [row] : []))
    expect(previous).toEqual([rowOf(h, "question 0 needle")])
  })

  test("the pet sits in the free rows right above the prompt, never over the messages", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "mend" })
    const h = appHarness({ dataDir, width: 100, height: 30 })
    h.app.applySettings({ onboarded: true, view: "balanced" })
    await Bun.sleep(10)
    conversation(h.sessionId, h.app.onEvent).exchange("question 0 needle", "answer 0")
    h.app.render()
    const rule = promptRule(h)
    // Mend at rest, seven rows standing on the prompt's rule.
    expect(mendRowIn(h.frames.at(-1)!, "done")).toBe(rule - 7)
    expect(h.text()[rowOf(h, "question 0")]!.trim()).toBe("› question 0 needle")
    expect(h.text()[rowOf(h, "answer 0")]!.trim()).toBe("• answer 0")
  })

  test("scrolling up in a short transcript changes nothing and the scrollbar stays away", async () => {
    const h = await chat({ width: 100, height: 30, view: "balanced", exchanges: 1 })
    const before = h.text()
    await h.type("\x1b[5~")
    await h.type("\x1b[6~")
    expect(h.text()).toEqual(before)
  })
})
