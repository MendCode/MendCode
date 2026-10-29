import { afterEach, describe, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { glyphs, setTheme } from "../src/ui/theme"
import { createSettingsPageState, formatTokens, parseDays, parseTokens, renderSettingsPage, settingsPageKey, settingsRows, SETTINGS_GROUPS, type SettingsValues } from "../src/view/settings-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
  // Theme edits apply process-wide; later tests start from the default.
  setTheme("mend")
})

const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const DOWN = "\x1b[B"

const FULL: Settings = {
  onboarded: true,
  defaultPermission: "edits",
  compactAtTokens: 200_000,
  dreamAt: "04:15",
  retentionDays: 90,
  pet: "codex:luna",
  footer: ["state", "model"],
  trustedToolDirs: ["/a", "/b"],
  disabledPackages: ["user:x"],
  profiles: [{ name: "work", directories: ["/w"] }],
  models: { main: { model: "gpt-6" }, fast: { model: "mini" } },
}

async function open(settings: Settings = { onboarded: true }, reply?: (command: Record<string, unknown>) => unknown, height = 46) {
  const h = await appHarness({ width: 120, height, ...(reply ? { reply } : {}) })
  await h.start(settings)
  await h.type("/settings")
  await h.key("\r")
  return h
}
const patches = (h: Awaited<ReturnType<typeof open>>) => h.sent.filter((command) => command.type === "settings.set")
const down = async (h: Awaited<ReturnType<typeof open>>, count: number) => {
  for (let i = 0; i < count; i++) await h.key(DOWN)
}

describe("/settings page", () => {
  test("lists every daemon setting in Appearance, Behavior, Models, Memory and Storage, plus links to /customize and /extensions", async () => {
    // Tall enough for every row at once; a shorter page scrolls to the selected row.
    const h = await open(FULL, undefined, 50)
    expect(h.app.page).toBe("settings")
    const text = h.text()
    for (const title of ["Appearance", "Behavior", "Models", "Memory", "Storage", "More", "Subagents", "Queue"]) expect(text).toContain(title)
    for (const row of ["at once        ‹ default (4) ›", "whole tree     ‹ default (16) ›"]) expect(text).toContain(row)
    for (const label of ["theme", "view", "motion", "pet", "footer", "permission", "compact at", "idle compact", "cache ttl", "claude ttl", "profiles", "trusted tools", "disabled pkgs", "onboarded", "roles", "dream at", "retention", "customize", "extensions"]) expect(text).toContain(label)
    for (const value of ["‹ mend ›", "‹ balanced ›", "‹ normal ›", "codex:luna", "2 segments", "‹ edits ›", "‹ 200k ›", "work", "2 directories", "1 off", "‹ on ›", "gpt-6 · 1 more role", "‹ 04:15 ›", "‹ 90 days ›"]) expect(text).toContain(value)
    expect(text).toContain(`${SETTINGS_GROUPS.flatMap((group) => group.rows).length} settings`)
    expect(h.rows()).toHaveLength(50)
  })

  test("the page covers every field of Settings exactly once", () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.rows.map((row) => row.id))
    expect(new Set(ids).size).toBe(ids.length)
    const fields = ["profiles", "models", "theme", "view", "defaultPermission", "compactAtTokens", "reducedMotion", "pet", "trustedToolDirs", "disabledPackages", "dreamAt", "retentionDays", "worktreeGcDays", "footer", "onboarded"]
    for (const field of fields) expect(ids as string[]).toContain(field)
    // Pinned to the protocol: a setting added there without a row here fails this list.
    const source = Object.keys(({ profiles: 1, models: 1, theme: 1, view: 1, defaultPermission: 1, compactAtTokens: 1, reducedMotion: 1, pet: 1, trustedToolDirs: 1, disabledPackages: 1, dreamAt: 1, retentionDays: 1, worktreeGcDays: 1, footer: 1, onboarded: 1 } satisfies Record<keyof Settings, 1>))
    expect(source.sort()).toEqual([...fields].sort())
  })

  test("edits send the same settings.set patches the setup page sends", async () => {
    const { app, sent, key, type } = await appHarness({ width: 120, height: 44, reply: (command) => (command.type === "mcp.status" ? { ok: true, result: { servers: [], issues: [] } } : undefined) })
    app.applySettings({})
    await app.openSetup({ advanced: true })
    // Setup rows: recipe, theme, view, permission, motion, dream, retention.
    await key("j")
    await key(RIGHT)
    await key("j")
    await key(RIGHT)
    await key("j")
    await key(RIGHT)
    await key("j")
    await key(" ")
    await key("j")
    await type("0415")
    await key("j")
    await key(RIGHT)
    const fromSetup = sent.filter((command) => command.type === "settings.set")
    // The theme applies process-wide (the setup page previews it); start the second run from the same one.
    setTheme("mend")

    const h = await open({})
    await h.key(RIGHT)
    await h.key(DOWN)
    await h.key(RIGHT)
    await h.key(DOWN)
    await h.key(" ")
    await down(h, 3)
    await h.key(RIGHT)
    await down(h, 11)
    await h.type("0415")
    await h.key(DOWN)
    await h.key(RIGHT)
    const fromSettings = patches(h)

    const merged = (list: Array<Record<string, unknown>>) => Object.assign({}, ...list.map((command) => command.patch))
    expect(fromSettings.every((command) => Object.keys(command).sort().join() === "patch,type")).toBe(true)
    expect(merged(fromSettings)).toEqual(merged(fromSetup))
    expect(fromSettings).toHaveLength(fromSetup.length)
    expect(merged(fromSettings)).toEqual({ theme: "matrix", view: "full", reducedMotion: true, defaultPermission: "edits", dreamAt: "04:15", retentionDays: 30 })
  })

  test("each row cycles like the setup page: theme previews, permission, dream and retention presets, onboarded toggles", async () => {
    const h = await open({ onboarded: true, dreamAt: "03:00", retentionDays: 365, defaultPermission: "full" })
    await h.key(LEFT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { theme: expect.any(String) } })
    await down(h, 5)
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { defaultPermission: "ask" } })
    await down(h, 9)
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { onboarded: false } })
    await down(h, 2)
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { dreamAt: null } })
    await h.key(DOWN)
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { retentionDays: null } })
  })

  test("compact-at takes presets, a typed count or 200k, and clears back to the default", async () => {
    const h = await open({ onboarded: true })
    await down(h, 6)
    expect(h.text()).toContain("default (95% of the model's window)")
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { compactAtTokens: 100_000 } })
    await h.type("300k")
    expect(h.text()).toContain("‹ 300k_ ›")
    await h.key("\r")
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { compactAtTokens: 300_000 } })
    await h.type("12345")
    await h.key("\r")
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { compactAtTokens: 12_345 } })
    await h.type("5")
    await h.key("\r")
    expect(h.text()).toContain("tokens must be 8000-2000000")
    expect(patches(h)).toHaveLength(3)
    await h.key("\x1b")
    expect(h.app.page).toBe("settings")
  })

  test("a typed dream time applies at once and a bad one is refused; retention days are range-checked", async () => {
    const h = await open({ onboarded: true })
    await down(h, 16)
    await h.type("2599")
    expect(patches(h)).toHaveLength(0)
    expect(h.text()).toContain("time must be HH:MM")
    await h.key("\x1b")
    await h.type("0415")
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { dreamAt: "04:15" } })
    await h.key(DOWN)
    await h.type("3")
    await h.key("\r")
    expect(h.text()).toContain("days must be 7-3650")
    await h.key("\x7f")
    await h.type("45")
    await h.key("\r")
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { retentionDays: 45 } })
  })

  test("worktree cleanup cycles through off, 7, 14 and 30 days or takes a typed count from 1", async () => {
    const h = await open({ onboarded: true })
    await down(h, 18)
    expect(h.text()).toContain("worktree gc")
    await h.key(RIGHT)
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { worktreeGcDays: 7 } })
    await h.type("0")
    await h.key("\r")
    expect(h.text()).toContain("days must be 1-3650")
    await h.key("\x7f")
    await h.type("21")
    await h.key("\r")
    expect(patches(h).at(-1)).toEqual({ type: "settings.set", patch: { worktreeGcDays: 21 } })
  })

  test("footer: a custom one resets to the default, the default does nothing", async () => {
    const custom = await open({ onboarded: true, footer: ["state", "model"] })
    await down(custom, 4)
    await custom.key("\r")
    expect(patches(custom)).toEqual([{ type: "settings.set", patch: { footer: null } }])
    const plain = await open({ onboarded: true })
    await down(plain, 4)
    await plain.key("\r")
    expect(patches(plain)).toEqual([])
  })

  test("profiles are shown, not edited here", async () => {
    const h = await open(FULL)
    await down(h, 11)
    for (const key of ["\r", RIGHT, LEFT, " "]) await h.key(key)
    expect(patches(h)).toEqual([])
    expect(h.text()).toContain("not editable here")
  })

  test("link rows open /customize, /extensions, /model, /tools, /packages and /storage", async () => {
    const reply = (command: Record<string, unknown>) => (command.type === "extensions.list" ? { ok: true, result: { extensions: [] } } : undefined)
    const rows: Array<[number, string]> = [[12, "tools"], [13, "packages"], [15, "model"], [19, "storage"], [20, "customize"], [21, "extensions"], [22, "acp"]]
    for (const [count, page] of rows) {
      const h = await open({ onboarded: true }, reply)
      await down(h, count)
      await h.key("\r")
      expect(h.app.page).toBe(page)
    }
  })

  test("esc closes the page", async () => {
    const h = await open()
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })
})

describe("settings page units", () => {
  const values: SettingsValues = { settings: {}, theme: "mend", view: "balanced", reducedMotion: false }

  test("parseTokens and parseDays accept only values inside the daemon's ranges", () => {
    expect(parseTokens("200k")).toBe(200_000)
    expect(parseTokens("200000")).toBe(200_000)
    expect(parseTokens("8000")).toBe(8_000)
    expect(parseTokens("7999")).toBeUndefined()
    expect(parseTokens("2001k")).toBeUndefined()
    expect(parseTokens("1.5k")).toBeUndefined()
    expect(parseTokens("")).toBeUndefined()
    expect(parseDays("7")).toBe(7)
    expect(parseDays("3650")).toBe(3650)
    expect(parseDays("6")).toBeUndefined()
    expect(parseDays("3651")).toBeUndefined()
    expect(parseDays("1e3")).toBeUndefined()
    expect(formatTokens(160_000)).toBe("160k")
    expect(formatTokens(12_345)).toBe("12345")
  })

  test("settingsRows reports the same values the page draws", () => {
    const rows = settingsRows({ ...values, settings: FULL })
    expect(rows.find((row) => row.id === "compactAtTokens")?.value).toBe("200k")
    expect(rows.find((row) => row.id === "dreamAt")?.value).toBe("04:15")
    expect(rows.find((row) => row.id === "models")?.value).toBe("gpt-6 · 1 more role")
    expect(rows.map((row) => row.group)).toEqual(SETTINGS_GROUPS.flatMap((group) => group.rows.map(() => group.title)))
  })

  test("the sub-agent limits step up and down from their defaults, and default clears the setting", () => {
    const row = (id: string) => ({ row: SETTINGS_GROUPS.flatMap((group) => group.rows).findIndex((each) => each.id === id) })
    const press = (id: string, key: string, settings: Settings) => settingsPageKey(row(id), key, { ...values, settings }, { themes: ["mend"] }).action
    expect(press("subagentMaxChildren", "\x1b[C", {})).toEqual({ type: "set", patch: { subagentMaxChildren: 8 } })
    expect(press("subagentMaxChildren", "\x1b[D", {})).toEqual({ type: "set", patch: { subagentMaxChildren: 2 } })
    expect(press("subagentMaxChildren", "\x1b[D", { subagentMaxChildren: 8 })).toEqual({ type: "set", patch: { subagentMaxChildren: null } })
    expect(press("subagentMaxDescendants", "\x1b[C", {})).toEqual({ type: "set", patch: { subagentMaxDescendants: 32 } })
  })

  test("keys clamp at both ends; typing only takes the characters its row allows", () => {
    let state = createSettingsPageState()
    expect(settingsPageKey(state, "k", values, { themes: ["mend"] }).state).toBe(state)
    for (let i = 0; i < 40; i++) state = settingsPageKey(state, "j", values, { themes: ["mend"] }).state
    expect(state.row).toBe(SETTINGS_GROUPS.flatMap((group) => group.rows).length - 1)
    // Letters never start typing on the time row, digits do.
    expect(settingsPageKey({ row: 16 }, "x", values, { themes: ["mend"] }).state).toEqual({ row: 16 })
    expect(settingsPageKey({ row: 16 }, "0", values, { themes: ["mend"] }).state).toEqual({ row: 16, typing: "0" })
    expect(settingsPageKey({ row: 17, typing: "12" }, "a", values, { themes: ["mend"] }).state).toEqual({ row: 17, typing: "12" })
  })

  test("renders exactly width x height and never wider, from a phone to a wide screen", () => {
    for (const [width, height] of [[24, 8], [40, 12], [80, 24], [120, 44], [240, 60]] as const) {
      const rows = renderSettingsPage({ state: createSettingsPageState(), values: { ...values, settings: FULL }, width, height, glyphs: glyphs({}) })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
  })

  test("the focused row stays on screen on a short terminal", () => {
    let state = createSettingsPageState()
    for (let i = 0; i < 20; i++) state = settingsPageKey(state, "j", values, { themes: ["mend"] }).state
    const rows = renderSettingsPage({ state, values, width: 80, height: 14, glyphs: glyphs({}) }).map((row) => row.map((span) => span.text).join(""))
    expect(rows.join("\n")).toContain("extensions")
  })
})
