import { afterAll, describe, expect, test } from "bun:test"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const longAnswer = Array.from({ length: 60 }, (_, n) => `line ${n + 1} of the answer`).join("\n\n")

function chat(stickyPrompt?: boolean) {
  const dataDir = tempDir()
  if (stickyPrompt !== undefined) writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, stickyPrompt })
  const h = appHarness({ width: 100, height: 30, mode: "balanced", dataDir })
  const script = conversation(h.sessionId, (event) => h.app.onEvent(event))
  return { ...h, script }
}
const mentions = (rows: string[]) => rows.filter((row) => row.includes("pin me please")).length

describe("pinned latest prompt", () => {
  test("it shows under the top bar once the prompt has scrolled out of view, truncated to one muted row", async () => {
    const h = chat()
    h.script.exchange("pin me please", longAnswer)
    h.app.render()
    const rows = h.text()
    expect(mentions(rows)).toBe(1)
    expect(rows.findIndex((row) => row.includes("› pin me please"))).toBe(1)
    const narrow = chat()
    narrow.script.exchange(`pin me please ${"and keep going ".repeat(20)}`, longAnswer)
    narrow.app.render()
    const row = narrow.text().find((line) => line.includes("› pin me please"))!
    expect(row.trimEnd().endsWith("…")).toBe(true)
  })

  test("it stays out while the prompt is on screen, and when the setting is off", async () => {
    const short = chat()
    short.script.exchange("pin me please", "short answer")
    short.app.render()
    expect(mentions(short.text())).toBe(1)
    expect(short.text().findIndex((row) => row.includes("pin me please"))).toBeGreaterThan(1)
    const off = chat(false)
    off.script.exchange("pin me please", longAnswer)
    off.app.render()
    expect(mentions(off.text())).toBe(0)
  })

  test("the row is the same on every frame of the answer, and a newer prompt replaces it", async () => {
    const h = chat()
    h.script.exchange("pin me please", longAnswer)
    h.app.render()
    const first = h.text()
    h.app.render()
    h.app.render()
    expect(h.text()).toEqual(first)
    h.script.exchange("then pin the second one", longAnswer)
    h.app.render()
    expect(h.text().some((row) => row.includes("› then pin the second one"))).toBe(true)
    expect(mentions(h.text())).toBe(0)
  })

  test("a long pasted prompt is collapsed to one row of the same text each frame", async () => {
    const h = chat()
    const pasted = `pin me please\n${Array.from({ length: 400 }, (_, n) => `log line ${n} with   spaces`).join("\n")}`
    h.script.exchange(pasted, longAnswer)
    h.app.render()
    const row = h.text().find((line) => line.includes("› pin me please"))!
    expect(row).toContain("pin me please log line 0 with spaces log line 1")
    expect(row.trimEnd().endsWith("…")).toBe(true)
    h.app.render()
    expect(h.text().find((line) => line.includes("› pin me please"))).toBe(row)
  })

  test("scrolling back up to the prompt hands it back to the transcript, and /sticky-prompt toggles the row", async () => {
    const h = chat()
    h.script.exchange("pin me please", longAnswer)
    h.app.render()
    expect(mentions(h.text())).toBe(1)
    await h.type("\x1b[H")
    expect(mentions(h.text())).toBe(1)
    expect(h.text().findIndex((row) => row.includes("pin me please"))).toBe(2)
    await h.type("\x1b[F")
    expect(mentions(h.text())).toBe(1)
    await h.type("/sticky-prompt\r")
    expect(mentions(h.text())).toBe(0)
  })
})
