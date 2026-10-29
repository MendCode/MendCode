import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type ThemeFile } from "@mendcode/protocol"
import { DEFAULT_THEME } from "../src/themes"
import { themesFromFiles } from "../src/ui/theme-files"
import { createApp } from "../src/ui/app"
import { activeTheme, glyphs, registerThemes, setTheme, themeNames, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const colors = { primary: "#22c55e", text: "#e5e7eb", body: "#d1d5db", muted: "#6b7280", border: "#374151", heading: "#a78bfa", code: "#fbbf24", link: "#60a5fa", success: "#22c55e", warning: "#f59e0b", error: "#ef4444" }
const file = (name: string, json: unknown, extra: Partial<ThemeFile> = {}): ThemeFile => ({ name, file: `/p/themes/${name}.json`, source: "project", json, ...extra })

afterEach(() => {
  registerThemes([])
  setTheme(DEFAULT_THEME)
})

describe("theme files", () => {
  test("a valid file becomes a theme named after the file, with derived roles and readable contrast", () => {
    const { themes, problems } = themesFromFiles([file("forest", { label: "Forest", background: "#0b1210", colors })])
    expect(problems).toEqual([])
    expect(themes[0]).toMatchObject({ name: "forest", label: "Forest", dark: true, background: "#0b1210" })
    expect(themes[0]!.colors.accent).toBeString()
    expect(themes[0]!.colors.panel).toMatch(/^#[0-9a-f]{6}$/)
  })

  test("bad files are problems, not crashes: read errors, wrong shape, missing or invalid colors", () => {
    const { themes, problems } = themesFromFiles([
      file("broken", undefined, { problem: "invalid JSON: Unexpected token" }),
      file("shape", { colors }),
      file("partial", { background: "#000000", colors: { primary: "#ffffff" } }),
      file("hex", { background: "black", colors }),
    ])
    expect(themes).toEqual([])
    expect(problems.map((p) => [p.name, p.message])).toEqual([
      ["broken", "invalid JSON: Unexpected token"],
      ["shape", 'expected { "background": "#rrggbb", "colors": { … } }'],
      ["partial", "partial.text must be #rrggbb"],
      ["hex", "hex has an invalid background"],
    ])
  })

  test("registered file themes join the list, replace a built-in of the same name, and refresh the active one", () => {
    const [forest] = themesFromFiles([file("forest", { background: "#0b1210", colors })]).themes
    registerThemes([forest!])
    expect(themeNames()).toContain("forest")
    expect(setTheme("forest")).toBe(true)
    const [edited] = themesFromFiles([file("forest", { background: "#0b1210", colors: { ...colors, primary: "#10b981" } })]).themes
    registerThemes([edited!])
    expect(activeTheme().colors.primary).toBe(edited!.colors.primary)
    const [matrix] = themesFromFiles([file("matrix", { label: "My matrix", background: "#000000", colors })]).themes
    registerThemes([matrix!])
    expect(themeNames().filter((name) => name === "matrix")).toHaveLength(1)
    expect(setTheme("matrix") && activeTheme().label).toBe("My matrix")
  })

  test("/theme re-reads theme files, so one written after startup can be picked by name", async () => {
    const sent: Array<Record<string, unknown>> = []
    const frames: Line[][] = []
    const app = createApp({
      sessionId: ids("session"),
      screen: { size: { width: 100, height: 24 }, draw: (rows: Line[]) => void frames.push(rows) },
      directory: "/work/project",
      mode: "balanced",
      send: async (command: Record<string, unknown>) => {
        sent.push(command)
        if (command.type === "themes.list") return { ok: true, result: { themes: [file("sunset", { label: "Sunset", background: "#1a0f0a", colors })] } }
        return { ok: true }
      },
      exit() {},
      schedule: (fn: () => void) => fn(),
      glyphs: glyphs({}),
      now: () => 1_800_000_000_000,
    } as never)
    await app.onInput("/theme sunset")
    await app.onKey("\r")
    expect(sent.find((c) => c.type === "themes.list")).toEqual(expect.objectContaining({ directory: "/work/project" }))
    expect(activeTheme().name).toBe("sunset")
    expect(sent).toContainEqual(expect.objectContaining({ type: "settings.set", patch: { theme: "sunset" } }))
  })
})
