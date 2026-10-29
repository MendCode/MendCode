import { afterEach, describe, expect, test } from "bun:test"
import type { ThemeFile } from "@mendcode/protocol"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { activeTheme, registerThemes, setTerminalMode, setTheme, setThemeLock, sgr, themeModeState, themeSelection } from "../src/ui/theme"
import { createTerminalMode } from "../src/ui/terminal-mode"
import { readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { legacyTheme } from "../../../packages/protocol/test/theme-fixtures"

afterEach(() => {
  cleanTemps()
  registerThemes([])
  setTerminalMode(undefined)
  setThemeLock(undefined)
  setTheme("mend")
})

const file: ThemeFile = { name: "Forest_Mode", file: "/tmp/themes/Forest_Mode.json", source: "project", json: legacyTheme }
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const CTRL_L = "\x0c"
const primary = () => sgr({ fg: "primary" }, "truecolor")

function harness(options: { width?: number; env?: Record<string, string>; profile?: Parameters<typeof writeTuiProfile>[1]; files?: ThemeFile[] } = {}) {
  const dataDir = tempDir("theme-picker-data-")
  const directory = tempDir("theme-picker-")
  if (options.profile) writeTuiProfile(dataDir, options.profile)
  const terminalMode = createTerminalMode(options.env ?? {})
  const requested = { count: 0 }
  const size = { width: options.width ?? 100, height: 40 }
  const screen = {
    size,
    draw() {},
    write() {},
    setTitle() {},
    terminalMode,
    consumeTerminalInput: (data: string) => terminalMode.consume(data),
    requestTerminalMode: () => void requested.count++,
  } as unknown as NonNullable<Parameters<typeof appHarness>[0]>["screen"]
  const h = appHarness({ screen, width: size.width, dataDir, directory, reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: options.files ?? [] } } : undefined })
  const run = async (command: string) => { await h.type(command); await h.type("\r") }
  return { ...h, run, dataDir, terminalMode, requested, text: () => h.text().join("\n") }
}

describe("theme picker page", () => {
  test("/theme and /themes open the picker on the current theme with system first and the key hints in the header", async () => {
    for (const command of ["/theme", "/themes"]) {
      const h = harness()
      await h.run(command)
      expect(h.app.page).toBe("theme")
      const text = h.text()
      expect(text).toContain("↑↓ preview · enter apply · ctrl+l lock · esc restore")
      expect(text).toContain("system")
      expect(text.indexOf("system")).toBeLessThan(text.indexOf("amber"))
      expect(text).toContain("mend (current)")
      expect(h.sentOf("themes.list")).toHaveLength(1)
    }
  })

  test("the leader key opens the same picker and keeps the prompt draft", async () => {
    const h = harness()
    h.app.editor.insert("keep this")
    await h.type("\x18t")
    expect(h.app.page).toBe("theme")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    expect(h.app.editor.text).toBe("keep this")
  })

  test("the v1 palettes, terminal and theme files are all listed and reachable by fuzzy filter", async () => {
    const h = harness({ files: [file] })
    await h.run("/theme")
    for (const [query, name] of [["lucent", "lucent-orng"], ["merc", "mercury"], ["vesp", "vesper"], ["curs", "cursor"], ["termin", "terminal"], ["forest", "Forest_Mode"]] as const) {
      await h.type("\x7f".repeat(12))
      await h.type(query)
      expect(h.text()).toContain(name)
      expect(activeTheme().name).toBe(name)
    }
    await h.type("zzzzqq")
    expect(h.text()).toContain("no matching theme")
  })

  test("moving the selection repaints in the highlighted theme; Esc puts the previous one back and saves nothing", async () => {
    const h = harness()
    await h.run("/theme")
    const before = primary()
    const initial = activeTheme().name
    await h.type(DOWN)
    const first = activeTheme().name
    expect(first).not.toBe(initial)
    await h.type(DOWN)
    expect(activeTheme().name).not.toBe(first)
    await h.type(UP)
    expect(activeTheme().name).toBe(first)
    expect([before, primary()]).not.toEqual([before, before])
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    expect(activeTheme().name).toBe(initial)
    expect(primary()).toBe(before)
    expect(h.sentOf("settings.set")).toEqual([])
  })

  test("typing previews the best match, clearing the filter restores the opening theme", async () => {
    const h = harness()
    await h.run("/theme")
    await h.type("vesper")
    expect(activeTheme().name).toBe("vesper")
    await h.type("\x7f".repeat(6))
    expect(activeTheme().name).toBe("mend")
    expect(h.text()).toContain("mend (current)")
  })

  test("Enter applies and persists the theme for the user and the terminal profile", async () => {
    const h = harness({ profile: { theme: "matrix" } })
    await h.run("/theme")
    await h.type("mercury")
    await h.type("\r")
    expect(h.app.page).toBe("chat")
    expect(activeTheme().name).toBe("mercury")
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { theme: "mercury" } })
    expect(readTuiProfile(h.dataDir).theme).toBe("mercury")
    await h.run("/theme")
    expect(h.text()).toContain("mercury (current)")
  })

  test("/theme <name> still applies directly and an unknown name opens nothing", async () => {
    const h = harness()
    await h.run("/theme vesper")
    expect(h.app.page).toBe("chat")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { theme: "vesper" } })
    await h.run("/theme nope")
    expect(h.app.page).toBe("chat")
    expect(activeTheme().name).toBe("vesper")
    expect(h.text()).toContain("unknown theme: nope")
  })

  test("compact width keeps every row inside the terminal and drops the hints before the keys", async () => {
    const h = harness({ width: 60 })
    await h.run("/theme")
    for (const line of h.text().split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(60)
    expect(h.text()).toContain("↑↓ · enter · ctrl+l lock · esc")
    expect(h.text()).not.toContain("follows the terminal")
  })
})

describe("system theme and mode lock", () => {
  test("system follows the terminal: light picks a light palette, a mode report repaints, and it is saved as system", async () => {
    const h = harness({ env: { COLORFGBG: "0;15" } })
    await h.run("/theme")
    expect(h.text()).toContain("mode light · from the terminal")
    expect(h.requested.count).toBeGreaterThan(0)
    await h.type("syst")
    expect(themeSelection()).toBe("system")
    expect(activeTheme().dark).toBe(false)
    await h.type("\r")
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { theme: "system" } })
    const light = activeTheme().name
    await h.type("\x1b[?997;1n")
    expect(h.app.editor.text).toBe("")
    expect(activeTheme().dark).toBe(true)
    expect(activeTheme().name).not.toBe(light)
    await h.type("\x1b]11;rgb:ffff/ffff/ffff\x07")
    expect(activeTheme().name).toBe(light)
  })

  test("an undetected terminal says so and system falls back to dark", async () => {
    const h = harness()
    await h.run("/theme")
    expect(h.text()).toContain("mode dark · terminal not detected")
    await h.type("syst")
    expect(activeTheme().dark).toBe(true)
  })

  test("the lock pins the mode: terminal changes are ignored until it is released, and the lock is saved", async () => {
    const h = harness({ env: { COLORFGBG: "0;15" } })
    await h.run("/theme system")
    expect(activeTheme().dark).toBe(false)
    await h.run("/theme")
    await h.type(CTRL_L)
    expect(themeModeState()).toMatchObject({ locked: "light", effective: "light" })
    expect(h.text()).toContain("mode light · locked")
    expect(h.text()).toContain("ctrl+l unlock")
    expect(readTuiProfile(h.dataDir).themeLock).toBe("light")
    await h.type("\x1b[?997;1n")
    expect(h.terminalMode.mode).toBe("dark")
    expect(activeTheme().dark).toBe(false)
    await h.type(CTRL_L)
    expect(themeModeState().locked).toBeUndefined()
    expect(readTuiProfile(h.dataDir).themeLock).toBe("")
    await h.type("\x1b")
    expect(activeTheme().dark).toBe(true)
  })

  test("a saved lock applies at startup, and /theme lock and /theme unlock set it directly", async () => {
    const h = harness({ env: { COLORFGBG: "15;0" }, profile: { themeLock: "light" } })
    expect(themeModeState().locked).toBe("light")
    await h.run("/theme system")
    expect(activeTheme().dark).toBe(false)
    await h.run("/theme lock dark")
    expect(activeTheme().dark).toBe(true)
    expect(readTuiProfile(h.dataDir).themeLock).toBe("dark")
    await h.run("/theme unlock")
    expect(themeModeState().locked).toBeUndefined()
    expect(readTuiProfile(h.dataDir).themeLock).toBe("")
  })
})
