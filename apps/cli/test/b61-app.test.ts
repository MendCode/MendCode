import { afterEach, describe, expect, test } from "bun:test"
import { b61Harness } from "./b61-harness"
import { cleanTemps } from "./session-ui-harness"
import { SETUP_ROWS, setupPageKey } from "../src/view/setup-page"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { renderIntroPage } from "../src/view/intro-page"
import { textWidth } from "../src/view/wrap"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"

afterEach(cleanTemps)
const select = async (h: ReturnType<typeof b61Harness>, row: typeof SETUP_ROWS[number]) => {
  for (let i = 0; i < SETUP_ROWS.indexOf(row); i++) await h.app.onKey("\x1b[B")
}

describe("B61 setup and intro", () => {
  test("setup advanced, presets and USD edits use their daemon commands", async () => {
    const h = b61Harness()
    await h.type("/setup advanced\r")
    expect(h.app.page).toBe("setup")
    await select(h, "preset")
    await h.type("\x1b[C")
    expect(h.sent.some((c) => c.type === "setup.preset" && c.preset === "minimal")).toBe(true)
    expect(h.modes.status(h.directory).mode).toBe("minimal")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\x1b[B")
    await h.type("\x1b[C")
    expect(h.settings().budgets).toMatchObject({ mode: "api-usage", warnUsd: 1, stopUsd: 3, expensiveModelRequiresConfirm: true })
    await h.app.onKey("\x1b[B")
    await h.type("2\r")
    expect(h.settings().budgets?.warnUsd).toBe(2)
    await h.type("9\r")
    expect(h.text().join("\n")).toContain("stop ≥ warn")
    expect(h.settings().budgets?.warnUsd).toBe(2)
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.type("/setup advanced\r")
    expect(h.app.page).toBe("setup")
  }, 15_000)
  test("helper context survives navigation and reopen, clear starts fresh", async () => {
    const h = b61Harness()
    await h.type("/setup advanced\r")
    await select(h, "helper")
    await h.type("\r")
    await h.type("Which model?\r")
    expect(h.text().join("\n")).toContain("Your main role")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\x1b[B")
    await h.type("\r")
    expect(h.text().join("\n")).toContain("Which model?")
    await h.type("Again?\r")
    const calls = h.sent.filter((c) => c.type === "setup.ask")
    expect(calls[1]).toMatchObject({ history: [{ role: "user", text: "Which model?" }, { role: "assistant", text: expect.stringContaining("Your main role") }] })
    await h.app.onKey("\x0c")
    await h.type("Fresh\r")
    expect(h.sent.filter((c) => c.type === "setup.ask").at(-1)).toMatchObject({ history: [] })
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.type("/setup advanced\r")
    await select(h, "helper")
    await h.type("\r")
    expect(h.text().join("\n")).toContain("Fresh")
  }, 60_000)
  test("unavailable helper and provider failures remain in the helper panel", async () => {
    const h = b61Harness()
    h.available(false)
    await h.type("/setup advanced\r")
    await select(h, "helper")
    await h.type("\r")
    await h.type("Hi\r")
    expect(h.text().join("\n")).toContain("Native completion service unavailable")
    expect(h.sent.some((c) => c.type === "setup.ask")).toBe(false)
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    h.available(true)
    h.refuse("Fake provider failure")
    await h.type("/setup advanced\r")
    await select(h, "helper")
    await h.type("\r")
    await h.type("\r")
    expect(h.text().join("\n")).toContain("Fake provider failure")
  }, 30_000)
  test("intro replay is lazy, skippable and never changes settings", async () => {
    const h = b61Harness()
    await h.app.onInput("/intro\r")
    expect(h.app.page).toBe("intro")
    await h.app.onKey("\r")
    expect(h.app.page).toBe("chat")
    h.app.applySettings({ reducedMotion: true, onboarded: true })
    await h.app.openIntro()
    expect(h.app.page).toBe("intro")
    expect(h.text().join("\n")).toContain("(o o)")
    // The static identity closes by itself; on a loaded machine that takes longer than its nominal delay.
    for (let i = 0; i < 100 && h.app.page !== "chat"; i++) await Bun.sleep(20)
    expect(h.app.page).toBe("chat")
    expect(h.sent.some((c) => c.type === "settings.set")).toBe(false)
  }, 15_000)
  test("helper edits in its own input and never submits a session turn", () => {
    const values = { theme: "mend", view: "balanced", defaultPermission: "ask", reducedMotion: false }
    let state = { row: SETUP_ROWS.indexOf("helper"), helper: { open: true, draft: "ac", cursor: 1, messages: [], busy: false } }
    const edited = setupPageKey(state, "b", values, { themes: ["mend"] })
    expect(edited.state.helper).toMatchObject({ draft: "abc", cursor: 2 })
    expect(setupPageKey(edited.state, "\r", values, { themes: ["mend"] }).action).toEqual({ type: "ask", text: "abc" })
  })
  test("setup and each intro phase fit every breakpoint", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const h = b61Harness(width, height)
      await h.type("/setup advanced\r")
      expect(h.text()).toHaveLength(height!)
      expect(h.text().every((row) => textWidth(row) <= width!)).toBe(true)
      for (const elapsedMs of [0, 300, 1000, 1460, 1900]) {
        const rows = renderIntroPage({ profile: DEFAULT_TUI_PROFILE, elapsedMs, width: width!, height: height! })
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row.map((s) => s.text).join("")) <= width!)).toBe(true)
      }
    }
  }, 30_000)
})

describe("B61 automation", () => {
  test("setup/budget commands dispatch through the client and failed doctor exits 1", async () => {
    for (const [target, operations] of [["setup", ["status", "plan", "doctor"]], ["budget", ["status", "doctor"]]] as const) {
      for (const operation of operations) {
        const parsed = parseAutomation(["control-plane", target, operation, "--json"])
        expect(parsed.ok).toBe(true)
        if (parsed.ok !== true) continue
        let output = ""
        const deps: AutomationDeps = { client: { send: async (c) => { expect(c).toMatchObject({ type: `${target}.${operation}`, directory: "/tmp/project" }); return { ok: true, result: { ok: operation !== "doctor" } } }, subscribe: async () => ({ ok: true }) }, listen() {}, out: { write: (s) => { output += s } }, err: { write() {} }, cwd: "/tmp/project", now: () => 0, onInterrupt() {} }
        expect(await runAutomation(parsed.command, deps)).toBe(operation === "doctor" ? 1 : 0)
        expect(output).toContain(`${target}.${operation}`)
      }
    }
    expect(parseAutomation(["control-plane", "budget", "plan"]).ok).toBe(false)
    expect(parseAutomation(["control-plane", "setup", "status", "extra"]).ok).toBe(false)
  })
})
