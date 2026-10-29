import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { B60_LEFT, B60_RIGHT, b60Harness } from "./b60-harness"
import { cleanTemps, plain, tempDir, appHarness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { renderStatusRow } from "../src/view/prompt-chrome"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("B60: colored script rows own the left side, concatenate segments and align unequal sides", () => {
  const h = b60Harness()
  h.status({ left: [{ text: "legacy fallback" }], leftRows: B60_LEFT, rightRows: B60_RIGHT })
  expect(h.text().slice(-4).map((line) => line.trim())).toEqual([
    expect.stringMatching(/^main · clean +12:04$/), expect.stringMatching(/^checks: passed +branch: main$/),
    expect.stringMatching(/^project: \/work\/mendcode +tools: 2 running$/), "queue: 1",
  ])
  const first = h.frames.at(-1)!.at(-4)!
  expect(first.find((span) => span.text === "main")).toMatchObject({ fgHex: "#70ffaf", bold: true })
  expect(h.text().join("\n")).not.toContain("legacy fallback")
  expect(h.cursors.at(-1)?.row).toBe(24)
})

test("B60: legacy pushes shrink the footer, other projects are ignored, shell hides all script rows", async () => {
  const h = b60Harness()
  h.status({ leftRows: B60_LEFT, rightRows: B60_RIGHT })
  h.status({ directory: "/another/project", leftRows: [[{ text: "wrong project" }]] })
  expect(h.text().join("\n")).not.toContain("wrong project")
  await h.type("!")
  expect(h.text().at(-1)).toContain("Shell")
  expect(h.text().join("\n")).not.toContain("queue: 1")
  await h.app.onKey("\x1b")
  expect(h.text().at(-1)).toContain("queue: 1")
  h.status({ left: [{ text: "legacy" }], right: [{ text: "single" }] })
  expect(h.text().at(-1)).toMatch(/Build.*legacy +single$/)
  expect(h.text().join("\n")).not.toContain("queue: 1")
  expect(h.cursors.at(-1)?.row).toBe(27)
})

test("B60: long rows clip by cell width on both sides without wrapping or hiding the right", () => {
  for (const width of [20, 60, 100, 160, 180, 220]) {
    const line = renderStatusRow({ width, loops: 0, scriptLeftRow: [{ text: "左".repeat(120) }], scriptRightRow: [{ text: "right " + "🙂".repeat(120) }] })
    expect(textWidth(plain(line))).toBeLessThanOrEqual(width)
    expect(plain(line)).toContain("right")
    expect(plain(line)).toContain("…")
  }
})

test("B60: home, chat, multiline prompt, popup, tray and page keep bounded frames at every contracted size", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
    const h = b60Harness(width, height)
    const check = () => {
      const frame = h.frames.at(-1)!
      expect(frame).toHaveLength(height)
      expect(frame.every((line) => textWidth(plain(line)) <= width && !/[\x00-\x1f]/.test(plain(line)))).toBe(true)
      const cursor = h.cursors.at(-1)
      if (cursor) {
        expect(cursor.row).toBeGreaterThanOrEqual(0)
        expect(cursor.row).toBeLessThan(height)
        expect(cursor.col).toBeLessThan(width)
      }
    }
    h.status({ leftRows: B60_LEFT, rightRows: B60_RIGHT })
    check()
    h.chat("Check the footer", "All four rows stay outside the prompt.")
    check()
    h.app.editor.replaceAll(Array(20).fill("draft").join("\n"))
    h.app.render()
    check()
    h.app.editor.clear()
    await h.app.onKey("\x14")
    check()
    await h.type("/customize\r")
    check()
    await h.app.onKey("\x1b")
    await h.type("/pr")
    check()
  }
})

test("B60: minimal and boxed prompt footers stay outside; status off removes every row", () => {
  for (const promptChrome of ["minimal", "ascii-box", "box"] as const) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, promptChrome })
    const h = appHarness({ width: 100, height: 30, directory: "/work/mendcode", dataDir })
    h.app.applySettings({ onboarded: true })
    h.app.onGlobal({ type: "status.line", gseq: 0, at: 0, directory: "/work/mendcode", left: [], right: [], problems: [], leftRows: B60_LEFT, rightRows: B60_RIGHT })
    const text = h.text()
    expect(text.slice(-4).some((row) => /[│└┘╰╯]/.test(row))).toBe(false)
    if (promptChrome === "minimal") expect(text.at(-5)?.trim()).toBe("")
    else expect(text.at(-5)).toMatch(/[└╰]/)
    h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { ...DEFAULT_TUI_PROFILE, showStatus: false } })
    expect(h.text().join("\n")).not.toContain("queue: 1")
  }
})

test("B60: extension replacement owns the complete footer; side slots share rows with scripts", async () => {
  for (const replacement of [false, true]) {
    const dataDir = tempDir()
    mkdirSync(path.join(dataDir, "extensions"))
    writeFileSync(path.join(dataDir, "extensions", "footer.ts"), `export default { name: "footer", tui(api) { api.slot("footer.${replacement ? "replace" : "left"}", () => [[{text:"extension one"}], [{text:"extension two"}]]) } }`)
    const h = appHarness({ width: 100, height: 30, dataDir, directory: "/work/mendcode" })
    h.app.applySettings({ onboarded: true })
    await h.app.extensionsReady
    h.app.onGlobal({ type: "status.line", gseq: 0, at: 0, directory: "/work/mendcode", left: [], right: [], problems: [], leftRows: B60_LEFT, rightRows: B60_RIGHT })
    expect(h.text().join("\n")).toContain("extension two")
    if (replacement) {
      expect(h.text().slice(-2).map((line) => line.trim())).toEqual(["extension one", "extension two"])
      expect(h.text().join("\n")).not.toContain("queue: 1")
    } else expect(h.text().at(-3)).toContain("checks: passed · extension two")
  }
})
