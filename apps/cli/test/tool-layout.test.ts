import { afterEach, describe, expect, test } from "bun:test"
import { createCustomizePageState, customizePageKey, CUSTOMIZE_ROWS, toolLayoutOf } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, readTuiProfile, TOOL_LAYOUTS, TOOL_LAYOUT_NAMES, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

const apps: ReturnType<typeof appHarness>[] = []
afterEach(async () => {
  const results = await Promise.allSettled(apps.splice(0).map((h) => h.app.onKey("\x03")))
  cleanTemps()
  for (const result of results) if (result.status === "rejected") throw result.reason
})
const row = CUSTOMIZE_ROWS.indexOf("toolLayout")
const press = (profile: typeof DEFAULT_TUI_PROFILE, key: string) => customizePageKey({ ...createCustomizePageState(), row }, key, profile).action

describe("Tool layout", () => {
  test("the shipped profile is the default layout, and a hand-set key makes it custom", () => {
    expect(toolLayoutOf(DEFAULT_TUI_PROFILE)).toBe("default")
    for (const name of TOOL_LAYOUT_NAMES) expect(toolLayoutOf({ ...DEFAULT_TUI_PROFILE, ...TOOL_LAYOUTS[name] })).toBe(name)
    expect(toolLayoutOf({ ...DEFAULT_TUI_PROFILE, toolDensity: "dense" })).toBe("custom")
  })

  test("right and left cycle the layouts and each step sets all three tool card keys", () => {
    let profile = { ...DEFAULT_TUI_PROFILE }
    const seen: string[] = []
    for (let step = 0; step < TOOL_LAYOUT_NAMES.length; step++) {
      const action = press(profile, "\x1b[C")
      if (action.type !== "set") throw new Error("expected a set action")
      expect(Object.keys(action.patch).sort()).toEqual(["codeMapCard", "toolDensity", "toolOutput"])
      profile = { ...profile, ...action.patch }
      seen.push(toolLayoutOf(profile))
    }
    expect(seen).toEqual(["detailed", "everything", "quiet", "default"])
    expect(press(DEFAULT_TUI_PROFILE, "\x1b[D")).toEqual({ type: "set", patch: { ...TOOL_LAYOUTS.quiet } })
  })

  test("from a custom mix, right starts at the first layout and left at the last", () => {
    const custom = { ...DEFAULT_TUI_PROFILE, toolOutput: "expanded" as const, toolDensity: "calm" as const }
    expect(press(custom, "\x1b[C")).toEqual({ type: "set", patch: { ...TOOL_LAYOUTS.quiet } })
    expect(press(custom, "\x1b[D")).toEqual({ type: "set", patch: { ...TOOL_LAYOUTS.everything } })
  })

  test("in the running app the row shows the layout, saves all three keys, and the page fits 40 to 160 columns", async () => {
    for (const [width, height] of [[40, 20], [60, 24], [80, 24], [100, 30], [160, 40]] as const) {
      const dataDir = tempDir()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
      const h = appHarness({ dataDir, width, height })
      apps.push(h)
      await h.type("/customize\r")
      for (let i = 0; i < row; i++) await h.app.onKey("\x1b[B")
      expect(h.text().join("\n")).toMatch(/Tool layout +‹ default ›/)
      await h.app.onKey("\x1b[C")
      expect(h.text().join("\n")).toMatch(/Tool layout +‹ detailed ›/)
      expect(h.text()).toHaveLength(height)
      expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
      const saved = readTuiProfile(dataDir)
      expect({ toolOutput: saved.toolOutput, toolDensity: saved.toolDensity, codeMapCard: saved.codeMapCard }).toEqual({ ...TOOL_LAYOUTS.detailed })
    }
  }, 30_000)
})
