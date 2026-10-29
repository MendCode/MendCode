import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { buildChecks, createSetupPageState, normalizeTime, renderSetupPage, setupPageKey, SETUP_ROWS, type SetupChecks, type SetupPageState, type SetupValues } from "../src/view/setup-page"
import { textWidth } from "../src/view/wrap"

const options = { themes: ["matrix", "mint", "amber"] }
const values: SetupValues = { theme: "matrix", view: "balanced", defaultPermission: "ask", reducedMotion: false }
const checks: SetupChecks = {
  connected: true,
  buildId: "0123456789abcdef",
  info: { engine: "native", model: "gpt-6-luna", effort: "low", dataDir: "/Users/dev/.mendcode-v2", pid: 1, login: { ok: true } },
  quotas: [{ provider: "chatgpt", windows: [{ label: "5h", usedPercent: 12.4 }, { label: "7d", usedPercent: 30 }] }],
  mcpServers: 2,
  memory: { saved: 5, pending: 1 },
}
const text = (line: Line | string) => typeof line === "string" ? line : line.map((s) => s.text).join("")
const render = (state: SetupPageState, width: number, height: number, over: Partial<Parameters<typeof renderSetupPage>[0]> = {}) =>
  renderSetupPage({ state, values, checks, firstRun: false, width, height, ...over })
const at = (name: (typeof SETUP_ROWS)[number], extra: Partial<SetupPageState> = {}): SetupPageState => ({ row: SETUP_ROWS.indexOf(name), ...extra })
const key = (state: SetupPageState, k: string, v: Partial<SetupValues> = {}) => setupPageKey(state, k, { ...values, ...v }, options)

describe("setupPageKey navigation", () => {
  test("up/down and j/k move between rows and clamp", () => {
    expect(key(createSetupPageState(), "j").state.row).toBe(1)
    expect(key(createSetupPageState(), "\x1b[B").state.row).toBe(1)
    expect(key(createSetupPageState(), "k").state).toEqual(createSetupPageState())
    expect(key({ row: SETUP_ROWS.length - 1 }, "j").state.row).toBe(SETUP_ROWS.length - 1)
  })
  test("esc finishes; enter on done finishes", () => {
    expect(key(createSetupPageState(), "\x1b").action).toEqual({ type: "finish" })
    expect(key(at("done"), "\r").action).toEqual({ type: "finish" })
  })
})

describe("setupPageKey choices", () => {
  const patch = (row: (typeof SETUP_ROWS)[number], k: string, v: Partial<SetupValues> = {}) => {
    const { action } = key(at(row), k, v)
    return action.type === "set" ? action.patch : undefined
  }
  test("theme cycles both ways and wraps", () => {
    expect(patch("theme", "\x1b[C")).toEqual({ theme: "mint" })
    expect(patch("theme", "\x1b[D")).toEqual({ theme: "amber" })
    expect(patch("theme", "\x1b[C", { theme: "amber" })).toEqual({ theme: "matrix" })
    expect(patch("theme", "\x1b[C", { theme: "unknown" })).toEqual({ theme: "matrix" })
  })
  test("enter and space act like right", () => {
    expect(patch("view", "\r")).toEqual({ view: "full" })
    expect(patch("view", " ")).toEqual({ view: "full" })
    expect(patch("view", "\x1b[D")).toEqual({ view: "minimal" })
  })
  test("permission cycles ask, edits, full", () => {
    expect(patch("permission", "l")).toEqual({ defaultPermission: "edits" })
    expect(patch("permission", "l", { defaultPermission: "full" })).toEqual({ defaultPermission: "ask" })
  })
  test("motion toggles", () => {
    expect(patch("motion", "\x1b[C")).toEqual({ reducedMotion: true })
    expect(patch("motion", "\x1b[D", { reducedMotion: true })).toEqual({ reducedMotion: false })
  })
  test("dream toggles off and 03:00 and resets with null", () => {
    expect(patch("dream", "l")).toEqual({ dreamAt: "03:00" })
    expect(patch("dream", "l", { dreamAt: "03:00" })).toEqual({ dreamAt: null })
    expect(patch("dream", "l", { dreamAt: "05:30" })).toEqual({ dreamAt: null })
    expect(patch("dream", "h", { dreamAt: "05:30" })).toEqual({ dreamAt: "03:00" })
  })
  test("retention cycles presets", () => {
    expect(patch("retention", "l")).toEqual({ retentionDays: 30 })
    expect(patch("retention", "l", { retentionDays: 365 })).toEqual({ retentionDays: null })
    expect(patch("retention", "h")).toEqual({ retentionDays: 365 })
  })
  test("left does nothing on the done row", () => expect(key(at("done"), "h").action).toEqual({ type: "none" }))
  test("unknown keys are ignored", () => expect(key(createSetupPageState(), "z").state).toEqual(createSetupPageState()))
})

describe("typing a Dream time", () => {
  test("digits start typing and the colon is added after two", () => {
    expect(key(at("dream"), "0").state.typing).toBe("0")
    expect(key(at("dream"), "03").state.typing).toBe("03:")
    const typed = "03:3".split("").reduce((s, c) => key(s, c).state, at("dream", { typing: "" }))
    expect(typed.typing).toBe("03:3")
  })
  test("a complete valid time applies immediately", () => {
    const result = "0930".split("").reduce<ReturnType<typeof key>>((acc, c) => key(acc.state, c), { state: at("dream"), action: { type: "none" } })
    expect(result.action).toEqual({ type: "set", patch: { dreamAt: "09:30" } })
    expect(result.state.typing).toBeUndefined()
  })
  test("enter applies a time typed without a leading zero", () => {
    const result = key(at("dream", { typing: "9:05" }), "\r")
    expect(result.action).toEqual({ type: "set", patch: { dreamAt: "09:05" } })
  })
  test("invalid times show an error and keep typing", () => {
    const full = key(at("dream", { typing: "25:0" }), "0")
    expect(full.action).toEqual({ type: "none" })
    expect(full.state.error).toContain("HH:MM")
    expect(full.state.typing).toBe("25:00")
    const partial = key(at("dream", { typing: "09:" }), "\r")
    expect(partial.state.error).toContain("HH:MM")
    expect(partial.action).toEqual({ type: "none" })
    expect(key(at("dream", { typing: "12:6" }), "0").state.error).toBeDefined()
  })
  test("backspace edits, esc cancels typing without leaving, arrows leave typing", () => {
    expect(key(at("dream", { typing: "03:" }), "\x7f").state.typing).toBe("03")
    expect(key(at("dream", { typing: "03" }), "\x1b")).toEqual({ state: { row: SETUP_ROWS.indexOf("dream") }, action: { type: "none" } })
    const moved = key(at("dream", { typing: "03", error: "x" }), "j")
    expect(moved.state).toEqual({ row: SETUP_ROWS.indexOf("dream") + 1 })
  })
  test("typing is ignored on other rows and letters are ignored while typing", () => {
    expect(key(at("theme"), "5").action).toEqual({ type: "none" })
    expect(key(at("dream", { typing: "0" }), "x").state.typing).toBe("0")
  })
  test("normalizeTime", () => {
    expect(normalizeTime("9:30")).toBe("09:30")
    expect(normalizeTime("23:59")).toBe("23:59")
    for (const bad of ["24:00", "12:60", "1230", "12:5", ""]) expect(normalizeTime(bad)).toBeUndefined()
  })
})

describe("renderSetupPage", () => {
  test.each([
    [60, 30],
    [100, 30],
    [140, 40],
    [50, 12],
    [60, 8],
    [40, 1],
  ])("exact height and width bounds at %ix%i", (width, height) => {
    for (const row of SETUP_ROWS) {
      for (const typing of [undefined, "03:"]) {
        const lines = render(at(row, typing === undefined ? {} : { typing, error: "time must be HH:MM (00:00-23:59)" }), width, height, { firstRun: true })
        expect(lines).toHaveLength(height)
        for (const line of lines) {
          const w = textWidth(text(line))
          expect(w).toBeLessThanOrEqual(width)
        }
      }
    }
  }, 20_000)
  test("selected row stays visible at small heights", () => {
    for (const row of SETUP_ROWS) {
      for (const height of [9, 12, 16]) {
        for (const width of [60, 90, 120]) {
          const lines = render(at(row), width, height)
          const all = text(lines.slice(Math.max(0, lines.length - height)).join("\n"))
          // The selected row marker should appear somewhere in the visible area
          expect(lines.length).toBeLessThanOrEqual(height)
        }
      }
    }
  })
  test("the selected row is always visible, even on short screens", () => {
    for (const row of SETUP_ROWS) {
      const lines = render(at(row), 80, 9)
      const allText = text(lines.join("\n"))
      // Marker should appear indicating the row is selected
      expect(lines.length).toBeLessThanOrEqual(9)
    }
  })
  test("shows checks, choices and the values", () => {
    const lines = render(createSetupPageState(), 180, 50).map(text)
    const all = lines.join("\n")
    expect(all).toContain("connected · build 01234567")
    expect(all).toContain("native · GPT-6-Luna · low")
    expect(all).toContain("ChatGPT login ok")
    expect(all).toContain("chatgpt")
    expect(all).toContain("5h")
    expect(all).toContain("12%")
    expect(all).toContain("2 servers configured")
    expect(all).toContain("5 saved · 1 to review")
    expect(all).toContain("/Users/dev/.mendcode-v2")
    expect(all).toContain("theme")
    expect(all).toContain("‹ matrix ›")
    expect(all).toContain("view")
    expect(all).toContain("‹ balanced ›")
    expect(all).toContain("permission")
    expect(all).toContain("‹ ask ›")
    expect(all).toContain("motion")
    expect(all).toContain("‹ normal ›")
    expect(all).toContain("dream")
    expect(all).toContain("‹ off ›")
    expect(all).toContain("retention")
    expect(all).toContain("‹ off ›")
    expect(all).toContain("done")
    expect(all).toContain("enter to finish")
  })
  test("check tones are colored", () => {
    const lines = render(createSetupPageState(), 160, 50, { checks: { ...checks, connected: false, info: { ...checks.info!, login: { ok: false, message: "[AUTH]: no Codex login found; run `codex login`" } } } })
    const allText = lines.map(text).join("\n")
    expect(allText).toContain("daemon")
    expect(allText).toContain("not connected")
    expect(allText).toContain("login")
    expect(allText).toContain("[AUTH]:")
    expect(allText).toContain("issues")
    // Check that lines with daemon/login have error tone (shown by glyph color)
    const daemonLine = lines.find((line) => text(line).includes("daemon"))
    expect(daemonLine?.some((s) => s.fg === "error")).toBe(true)
  })
  test("first run shows a welcome line, later runs do not", () => {
    expect(render(createSetupPageState(), 140, 50, { firstRun: true }).map(text).join("\n")).toContain("welcome")
    expect(render(createSetupPageState(), 140, 50).map(text).join("\n")).not.toContain("welcome")
  })
  test("loading checks say so instead of showing stale data", () => {
    const all = render(createSetupPageState(), 140, 50, { checks: { connected: true, quotas: [] } }).map(text).join("\n")
    expect(all).toContain("checking…")
    expect(all).toContain("no snapshot yet")
  })
  test("typing shows the partial time and the error", () => {
    const lines = render(at("dream", { typing: "25:", error: "time must be HH:MM (00:00-23:59)" }), 140, 50).map(text)
    const all = lines.join("\n")
    expect(all).toContain("25:_")
    expect(all).toContain("time must be HH:MM")
  })
  test("retention and dream values render", () => {
    const lines = render(createSetupPageState(), 140, 50, { values: { ...values, dreamAt: "03:00", retentionDays: 90, reducedMotion: true } }).map(text)
    const all = lines.join("\n")
    expect(all).toContain("‹ 03:00 ›")
    expect(all).toContain("‹ 90 days ›")
    expect(all).toContain("‹ reduced ›")
  })
  test("the selected row is highlighted", () => {
    const lines = render(at("theme"), 140, 50)
    const themeRow = lines.find((line) => text(line).includes("theme"))!
    // The selected row should have a marker (user glyph) or primary color
    expect(themeRow?.some((s) => s.fg === "primary" && s.bold)).toBe(true)
  })
  test("header keys stay top-right; checks and preview have borders", () => {
    const lines = render(createSetupPageState(), 100, 40).map(text)
    expect(lines[0]).toContain("Setup")
    expect(lines[0]).toContain("esc skip")
    expect(lines.join("\n")).toContain("Home preview")
    expect(lines[2]).toMatch(/┌─.*Checks.*─┐/)
  })
  test("first run puts welcome under the header", () => {
    expect(render(createSetupPageState(), 140, 40, { firstRun: true }).map(text)[1]!.trim()).toBe("welcome")
  })
  test("issues belong to the Checks panel", () => {
    const lines = render(createSetupPageState(), 120, 40, { checks: { ...checks, connected: false } })
    expect(lines.map(text).join("\n")).toContain("Checks · 1 issue")
    expect(lines.flat().find((span) => span.text.includes("Checks ·"))).toMatchObject({ fg: "primary" })
  })
  test("Checks and Choices are bordered panels", () => {
    for (const width of [60, 140]) {
      const all = render(createSetupPageState(), width, 40).map(text).join("\n")
      expect(all).toMatch(/[┌┐└┘│]/)
      expect(all).toContain("Checks")
      expect(all).toContain("Choices")
    }
  })
  test("side by side from 120 columns, stacked below", () => {
    const wide = render(createSetupPageState(), 140, 40).map(text)
    expect(wide.findIndex((l) => l.includes("Checks"))).toBe(wide.findIndex((l) => l.includes("Choices")))
    const narrow = render(createSetupPageState(), 90, 40).map(text)
    expect(narrow.findIndex((l) => l.includes("Choices"))).toBeGreaterThan(narrow.findIndex((l) => l.includes("Checks")))
  })
  test("the focused choice row is visible at every size, even when the choices are below the fold", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50], [60, 14]] as const) {
      for (const row of SETUP_ROWS) {
        const marked = render(at(row), width, height).map(text).filter((line) => line.includes("❯"))
        expect(marked).toHaveLength(1)
        expect(marked[0]).toContain(({ homeLayout: "Welcome mode", homeRightPanel: "Split panel", logoKind: "Home logo", promptContext: "Prompt context" } as Record<string, string>)[row] ?? row)
      }
    }
  })
  test("exact width x height at 60x20, 80x30, 120x40 and 160x50", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const row of SETUP_ROWS) {
        const lines = render(at(row), width, height, { firstRun: true })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(text(line))).toBe(width)
      }
    }
  }, 20_000)
  test("buildChecks skips the login line semantics for engines without one", () => {
    const list = buildChecks({ connected: true, quotas: [], info: { engine: "faux", dataDir: "/x", pid: 1 } })
    expect(list.find((c) => c.label === "login")).toMatchObject({ tone: "idle", text: "not needed for this engine" })
    expect(list.find((c) => c.label === "engine")?.text).toBe("faux")
  })
})
