import { afterEach, describe, expect, test } from "bun:test"
import { FOOTER_PRESETS, FOOTER_PRESET_NAMES, FOOTER_ROWS_MAX, footerRowsProblems, footerTextLine, tuiProblems } from "@mendcode/protocol/wire"
import { createCustomizePageState, customizePageKey, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { footerRowBudget, parseFooterRowsCommand, renderFooterRows } from "../src/view/footer-rows"
import { glyphs } from "../src/ui/theme"
import { footerIcon } from "../src/ui/footer-icons"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { FIVE_ROWS, NOW, rowsScreen } from "./footer-rows-fixture"

const open: Array<() => void> = []
afterEach(() => {
  for (const cleanup of open.splice(0)) cleanup()
})
async function screen(options: Parameters<typeof rowsScreen>[0] = {}) {
  const made = await rowsScreen(options)
  open.push(made.cleanup)
  return made
}
/** The footer: every row under the prompt's bottom rule. */
const footerOf = (rows: string[]) => {
  const rules = rows.map((row, index) => (/─{20,}/.test(row) ? index : -1)).filter((index) => index >= 0)
  return rows.slice(rules.at(-1)! + 1).filter((row) => row.trim() !== "")
}
const strip = (row: string) => row.replace(/^.*│/, "").trim()

describe("the built-in footer takes any number of rows by settings alone", () => {
  test("the minimal view draws the rows the profile asks for, and a page takes them away", async () => {
    const has = (rows: string[]) => rows.some((row) => row.includes("CODEX")) && rows.some((row) => row.includes("~/Code/MendCodeV2"))
    const minimal = await screen({ profile: { ...FIVE_ROWS, presentation: "minimal" } })
    expect(has(minimal.text())).toBe(true)
    // With no rows asked for, the minimal view keeps no footer at all.
    expect((await screen({ profile: { presentation: "minimal" } })).text().some((row) => row.includes("gpt-6.1-sol") || row.includes("GPT-6.1-Sol"))).toBe(false)
    const full = await screen({ profile: FIVE_ROWS })
    expect(has(full.text())).toBe(true)
    await full.h.type("/packages")
    await full.h.key("\r")
    await Bun.sleep(10)
    full.h.app.render()
    expect(full.text().some((row) => row.includes("Packages"))).toBe(true)
    expect(full.text().some((row) => row.includes("CODEX"))).toBe(false)
  })

  test("no rows set: the default single row, the same frame as before the setting existed", async () => {
    const plain = await screen({ width: 100 })
    const explicit = await screen({ width: 100, profile: { footerRows: [], footerText: {}, footerIcons: "none" } })
    expect(explicit.text()).toEqual(plain.text())
    expect(footerOf(plain.text())).toHaveLength(1)
  })

  test("the five-row request is the profile, under the prompt, in order, with no extension", async () => {
    const { text } = await screen({ profile: FIVE_ROWS })
    const rows = footerOf(text()).map(strip)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toBe("~/Code/MendCodeV2 · keep the contract, improve the result")
    expect(rows[1]).toMatch(/^GPT-6\.1-Sol · low:JEV · context \d+% · cache 0% · in 3,100 out 13$/)
    expect(rows[2]).toBe("CODEX 7d ███████░ 92% left resets 5d9h · 5h n/a")
    expect(rows[3]).toBe("CLAUDE 7d ███░░░░░ 39% left resets 1d23h · 5h ███████░ 89% left resets 2h")
    expect(rows[4]).toBe("graph on")
    // Nothing was pushed above the prompt.
    expect(text().some((row) => row.includes("keep the contract") && text().indexOf(row) < text().findIndex((other) => other.includes("❭")))).toBe(false)
  })

  test("the preset `rows` is that layout; the tagline is the only thing left to say", async () => {
    expect(FOOTER_PRESETS.rows!.rows).toEqual(FIVE_ROWS.footerRows!)
    expect(FOOTER_PRESETS.rows!.profile).toEqual({ quotaView: "left", quotaColor: "accent" })
    expect(FOOTER_PRESET_NAMES).toEqual(["classic", "rows", "compact", "telemetry"])
    for (const name of FOOTER_PRESET_NAMES) expect(footerRowsProblems(FOOTER_PRESETS[name]!.rows)).toEqual([])
  })

  test("icons: none draws none, glyph is plain Unicode, nerd is Nerd Font; every row starts in the same column", async () => {
    const none = footerOf((await screen({ profile: FIVE_ROWS })).text()).map(strip)
    const glyph = footerOf((await screen({ profile: { ...FIVE_ROWS, footerIcons: "glyph" } })).text()).map(strip)
    const nerd = footerOf((await screen({ profile: { ...FIVE_ROWS, footerIcons: "nerd" } })).text()).map(strip)
    expect(none[0]![0]).toBe("~")
    expect(glyph.map((row) => row.slice(0, 2))).toEqual(["▸ ", "◆ ", "◎ ", "◎ ", "⎇ "])
    expect(nerd.map((row) => row.codePointAt(0))).toEqual([0xf07b, 0xf035b, 0xf0200, 0xf0200, 0x2387])
    // The icon is one cell and a space, so the text of every row starts at column 2 in both modes.
    for (const rows of [glyph, nerd]) {
      for (const row of rows) expect(textWidth([...row][0]!)).toBe(1)
      expect(rows.map((row) => row.indexOf(" "))).toEqual(rows.map((row) => [...row][0]!.length))
    }
    const after = (row: string) => [...row].slice(2).join("")
    expect(after(nerd[2]!)).toBe(none[2])
    expect(after(nerd[3]!)).toBe(none[3])
  })

  test("ascii chrome never has an icon", async () => {
    const rows = footerOf((await screen({ profile: { ...FIVE_ROWS, footerIcons: "nerd", accessible: true } })).text()).map(strip)
    expect(rows.every((row) => !/[-\u{F0000}-\u{FFFFD}▸◆◎○]/u.test(row))).toBe(true)
    expect(footerIcon({ entry: "model", mode: "nerd", ascii: true })).toBeUndefined()
    expect(footerIcon({ entry: "text:tagline", mode: "nerd" })).toBeUndefined()
  })

  test("a row that does not fit drops its lowest-ranked segments, then truncates; it never wraps", async () => {
    const wide = footerOf((await screen({ profile: { ...FIVE_ROWS, sidebar: "hidden" }, width: 100 })).text())
    const narrow = footerOf((await screen({ profile: { ...FIVE_ROWS, sidebar: "hidden" }, width: 60 })).text())
    expect(narrow).toHaveLength(5)
    for (const row of narrow) expect(textWidth(row)).toBeLessThanOrEqual(60)
    // Tokens and the cache go before the model and the context do.
    expect(strip(narrow[1]!)).toContain("GPT-6.1-Sol")
    expect(strip(narrow[1]!)).not.toContain("tokens")
    expect(strip(wide[1]!)).toContain("in 3,100 out 13")
  })

  test("on a short terminal the rows drop from the bottom of the list: a quarter of the height", async () => {
    expect(footerRowBudget(12)).toBe(3)
    expect(footerRowBudget(24)).toBe(6)
    expect(footerRowBudget(200)).toBe(FOOTER_ROWS_MAX)
    expect(footerRowBudget(3)).toBe(1)
    const short = await screen({ profile: { ...FIVE_ROWS, sidebar: "hidden" }, height: 12 })
    const rows = footerOf(short.text()).map(strip)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("~/Code/MendCodeV2")
    expect(rows[2]).toContain("CODEX")
    expect(short.text()).toHaveLength(12)
  })

  test("a non-default permission always shows on the first row, as the goal does in the single row", async () => {
    const input = { segments: [], width: 80, glyphs: glyphs({}), stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "full", permissionLabel: "full access", quotas: [], now: NOW, notice: "" } as const
    const rows = renderFooterRows({ input, rows: [["model"], ["cache"]], limit: 5 }).map((line) => line.map((span) => span.text).join(""))
    expect(rows).toEqual(["full access", ""])
    // The user's own `showPermission` off hides it, as in the single row.
    expect(renderFooterRows({ input: { ...input, showPermission: false }, rows: [["model"]], limit: 5 }).map((line) => line.length)).toEqual([0])
    expect(renderFooterRows({ input: { ...input, permission: "ask" }, rows: [["model"]], limit: 5 }).map((line) => line.length)).toEqual([0])
  })

  test("statusColors recolours a segment by name, and the separator is the profile's", async () => {
    const made = await screen({ profile: { ...FIVE_ROWS, statusColors: '{"directory":"#ff8800"}', statusSeparator: " | " } })
    const row = made.lines().find((line) => line.some((span) => span.text === "~/Code/MendCodeV2"))!
    expect(row.find((span) => span.text === "~/Code/MendCodeV2")).toMatchObject({ fgHex: "#ff8800" })
    expect(made.text().some((line) => line.includes("~/Code/MendCodeV2 | keep the contract"))).toBe(true)
  })
})

describe("quota in a row: fresh, stale, expired, unknown", () => {
  const rowsOf = async (quotas: Parameters<typeof screen>[0] extends infer T ? (T extends { quotas?: infer Q } ? Q : never) : never) =>
    footerOf((await screen({ profile: FIVE_ROWS, quotas })).text()).map(strip)

  test("fresh shows the bar, what is left and the countdown", async () => {
    const rows = await rowsOf("fresh")
    expect(rows[3]).toContain("5h ███████░ 89% left resets 2h")
  })

  test("stale inside a live window keeps its number, dimmed, with a compact age and no words", async () => {
    const made = await screen({ profile: FIVE_ROWS, quotas: "stale" })
    const rows = footerOf(made.text()).map(strip)
    expect(rows[3]).toBe("CLAUDE 7d █████░░░ 62% left ~2d · 5h ████████ 96% left ~2d")
    expect(rows[3]).not.toMatch(/stale|old|reset/)
    const line = made.lines().find((entry) => entry.some((span) => span.text.includes("CLAUDE")))!
    const figure = line.find((span) => span.text.includes("62%"))!
    expect(figure.fg).toBe("muted")
    // Muted only: SGR 2 over a 24-bit colour drew a black box behind the text in a terminal with a transparent background.
    expect(line.find((span) => span.text.includes("~2d"))).toEqual({ text: " ~2d", fg: "muted" })
  })

  test("a window that has reset is n/a, whatever the number was", async () => {
    const rows = await rowsOf("expired")
    expect(rows[3]).toBe("CLAUDE 7d █████░░░ 62% left ~2d · 5h n/a")
    expect(rows[3]).not.toContain("96")
  })

  test("nothing heard: every window is n/a, never 0% or 100%", async () => {
    const rows = await rowsOf("unknown")
    expect(rows[2]).toBe("CODEX 7d n/a · 5h n/a")
    expect(rows[3]).toBe("CLAUDE 7d n/a · 5h n/a")
    expect(rows.join("\n")).not.toMatch(/0% left|100% left/)
  })

  test("the roles of the five rows are theme roles: accent bars, muted countdowns", async () => {
    const made = await screen({ profile: FIVE_ROWS })
    const line = made.lines().find((entry) => entry.some((span) => span.text.includes("CODEX")))!
    expect(line.find((span) => span.text.includes("CODEX"))).toMatchObject({ fg: "text", bold: true })
    expect(line.find((span) => span.text.includes("███████"))).toMatchObject({ fg: "primary" })
    expect(line.find((span) => span.text.includes("92%"))).toMatchObject({ fg: "primary" })
    expect(line.find((span) => span.text.includes("resets 5d9h"))).toEqual({ text: " resets 5d9h", fg: "muted" })
  })
})

describe("profile validation, one line each", () => {
  test("rows are capped, named and typed", () => {
    expect(tuiProblems({ footerRows: Array.from({ length: FOOTER_ROWS_MAX }, () => ["model"]) })).toEqual([])
    expect(tuiProblems({ footerRows: Array.from({ length: FOOTER_ROWS_MAX + 1 }, () => ["model"]) })).toEqual([`footerRows: at most ${FOOTER_ROWS_MAX} rows`])
    expect(tuiProblems({ footerRows: [["model", "weather"]] })).toEqual(['footerRows: row 1: unknown footer segment "weather"'])
    expect(tuiProblems({ footerRows: [["model"], "quota"] })).toEqual(["footerRows: row 2 must be a list of segment names"])
    expect(tuiProblems({ footerRows: [["quota:Codex"]] })[0]).toContain("takes lowercase letters")
    expect(tuiProblems({ footerRows: [["model:x"]] })[0]).toContain("only quota and text take a name")
    expect(tuiProblems({ footerRows: [["quota:codex", "text:tagline", "codegraph", "directory", "time"]] })).toEqual([])
  })

  test("text and icons", () => {
    expect(tuiProblems({ footerText: { tagline: "hello", days: ["a", "b"] } })).toEqual([])
    expect(tuiProblems({ footerText: { Tagline: "x" } })[0]).toContain("is not a name")
    expect(tuiProblems({ footerText: { tagline: "x".repeat(121) } })[0]).toContain("at most 120")
    expect(tuiProblems({ footerText: [] })).toEqual(["footerText: expected an object of name: text"])
    expect(tuiProblems({ footerIcons: "emoji" })).toEqual(["footerIcons: expected none|glyph|nerd"])
    expect(tuiProblems({ footerIcons: "nerd" })).toEqual([])
  })

  test("an invalid stored value reads as the default, not half a list", () => {
    const profile = normalizeTuiProfile({ ...DEFAULT_TUI_PROFILE, footerRows: [["model", "nope"]], footerText: [1], footerIcons: "x" } as never)
    expect(profile.footerRows).toEqual([])
    expect(profile.footerText).toEqual({})
    expect(profile.footerIcons).toBe("none")
  })

  test("a text list shows one line per day, the same all day", () => {
    const now = Date.UTC(2026, 9, 8, 12)
    expect(footerTextLine("one", now)).toBe("one")
    expect(footerTextLine(["a", "b", "c"], now)).toBe(footerTextLine(["a", "b", "c"], now + 3_600_000))
    expect(new Set([0, 1, 2].map((day) => footerTextLine(["a", "b", "c"], now + day * 86_400_000))).size).toBe(3)
    expect(footerTextLine([], now)).toBeUndefined()
  })
})

describe("/footer rows grammar", () => {
  const current = { rows: [["model"], ["quota"]], icons: "none" as const }
  test("preset sets rows and the keys the preset names", () => {
    expect(parseFooterRowsCommand("preset rows", current)).toMatchObject({ ok: true, patch: { footerRows: FIVE_ROWS.footerRows, quotaView: "left", quotaColor: "accent" }, notice: "footer preset rows: 5 rows" })
    expect(parseFooterRowsCommand("preset classic", current)).toMatchObject({ ok: true, patch: { footerRows: [] } })
    expect(parseFooterRowsCommand("preset nope", current)).toEqual({ ok: false, error: 'unknown preset "nope" (classic, rows, compact, telemetry)' })
    expect(parseFooterRowsCommand("preset", current)).toMatchObject({ ok: false })
  })
  test("row N sets, appends, removes; rows N keeps the first N", () => {
    expect(parseFooterRowsCommand("row 3 quota:codex", current)).toMatchObject({ ok: true, patch: { footerRows: [["model"], ["quota"], ["quota:codex"]] } })
    expect(parseFooterRowsCommand("row 1 directory, text:tagline", current)).toMatchObject({ ok: true, patch: { footerRows: [["directory", "text:tagline"], ["quota"]] } })
    expect(parseFooterRowsCommand("row 2", current)).toMatchObject({ ok: true, patch: { footerRows: [["model"]] } })
    expect(parseFooterRowsCommand("row 4 model", current)).toMatchObject({ ok: false })
    expect(parseFooterRowsCommand("row 1 weather", current)).toEqual({ ok: false, error: 'unknown footer segment "weather"' })
    expect(parseFooterRowsCommand("rows 1", current)).toMatchObject({ ok: true, patch: { footerRows: [["model"]] } })
    expect(parseFooterRowsCommand("rows 0", current)).toMatchObject({ ok: true, patch: { footerRows: [] }, notice: "footer rows: off" })
    expect(parseFooterRowsCommand("rows 13", current)).toMatchObject({ ok: false })
  })
  test("icons, and everything else belongs to the segment grammar", () => {
    expect(parseFooterRowsCommand("icons nerd", current)).toMatchObject({ ok: true, patch: { footerIcons: "nerd" } })
    expect(parseFooterRowsCommand("icons emoji", current)).toMatchObject({ ok: false })
    expect(parseFooterRowsCommand("+branch -quota", current)).toBeUndefined()
    expect(parseFooterRowsCommand("reset", current)).toBeUndefined()
    expect(parseFooterRowsCommand("", current)).toBeUndefined()
  })
})

describe("/customize", () => {
  const row = (name: string) => CUSTOMIZE_ROWS.indexOf(name as never)
  test("the rows, the text and the icons have rows of their own, and the preset cycles", () => {
    for (const name of ["footerPreset", "footerRows", "footerText", "footerIcons"]) expect(row(name)).toBeGreaterThan(-1)
    const cycled = customizePageKey({ ...createCustomizePageState(), row: row("footerPreset") }, "l", DEFAULT_TUI_PROFILE)
    expect(cycled.action).toMatchObject({ type: "set", patch: { footerRows: [["directory", "text:tagline"], ["model", "effort", "context", "cache", "tokens"], ["quota:codex"], ["quota:claude"], ["codegraph"]], quotaView: "left" } })
    const icons = customizePageKey({ ...createCustomizePageState(), row: row("footerIcons") }, "l", DEFAULT_TUI_PROFILE)
    expect(icons.action).toMatchObject({ type: "set", patch: { footerIcons: "glyph" } })
  })

  test("footerRows is typed as `row; row`, checked on enter with the one-line problem", () => {
    let state = customizePageKey({ ...createCustomizePageState(), row: row("footerRows") }, "\r", DEFAULT_TUI_PROFILE).state
    expect(state.typing).toBe("")
    for (const key of "model,context; quota:codex") state = customizePageKey(state, key, DEFAULT_TUI_PROFILE).state
    const saved = customizePageKey(state, "\r", DEFAULT_TUI_PROFILE)
    expect(saved.action).toEqual({ type: "set", patch: { footerRows: [["model", "context"], ["quota:codex"]] } })
    let bad = customizePageKey({ ...createCustomizePageState(), row: row("footerRows") }, "\r", DEFAULT_TUI_PROFILE).state
    for (const key of "model,weather") bad = customizePageKey(bad, key, DEFAULT_TUI_PROFILE).state
    expect(customizePageKey(bad, "\r", DEFAULT_TUI_PROFILE).state.error).toBe('row 1: unknown footer segment "weather"')
  })

  test("footerText is JSON, and empty clears it", () => {
    let state = customizePageKey({ ...createCustomizePageState(), row: row("footerText") }, "\r", DEFAULT_TUI_PROFILE).state
    for (const key of '{"tagline":"hi"}') state = customizePageKey(state, key, DEFAULT_TUI_PROFILE).state
    expect(customizePageKey(state, "\r", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { footerText: { tagline: "hi" } } })
    let bad = customizePageKey({ ...createCustomizePageState(), row: row("footerText") }, "\r", DEFAULT_TUI_PROFILE).state
    for (const key of "{oops") bad = customizePageKey(bad, key, DEFAULT_TUI_PROFILE).state
    expect(customizePageKey(bad, "\r", DEFAULT_TUI_PROFILE).state.error).toContain("JSON")
  })
})

describe("the codegraph segment shows the index the daemon pushed", () => {
  const DIRECTORY = "/Users/dev/Code/MendCodeV2"
  const status = (patch: Record<string, unknown>) => ({ type: "codegraph.status", gseq: 0, at: NOW, directory: DIRECTORY, state: "indexed", files: 2594, symbols: 17641, edges: 41203, partial: false, ...patch })
  const graphRow = (made: Awaited<ReturnType<typeof screen>>) => made.text().map(strip).find((row) => /graph/i.test(row))

  test("before any graph tool indexed the project it reads `graph on`; then indexing…, then the counts; none clears it", async () => {
    const made = await screen({ width: 160, profile: FIVE_ROWS })
    expect(graphRow(made)).toBe("graph on")
    made.h.app.onGlobal(status({ state: "indexing", files: 0, symbols: 0, edges: 0 }) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("GRAPH indexing…")
    made.h.app.onGlobal(status({}) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed")
    made.h.app.onGlobal(status({ state: "none", files: 0, symbols: 0, edges: 0 }) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("graph on")
  })

  test("another project's counts are not this session's", async () => {
    const made = await screen({ width: 160, profile: FIVE_ROWS })
    made.h.app.onGlobal(status({ directory: "/Users/dev/Code/other" }) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("graph on")
  })

  test("a folder the gate skips says why in one quiet phrase, and the counts come back when it is indexed", async () => {
    const made = await screen({ width: 160, profile: FIVE_ROWS })
    made.h.app.onGlobal(status({ state: "skipped", reason: "large folder", files: 0, symbols: 0, edges: 0 }) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("graph off · large folder")
    const row = made.lines().find((line) => /graph off/.test(line.map((span) => span.text).join("")))!
    expect(row.find((span) => span.text.includes("graph off"))).toMatchObject({ fg: "muted" })
    made.h.app.onGlobal(status({ state: "skipped", reason: "off", files: 0, symbols: 0, edges: 0 }) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("graph off")
    made.h.app.onGlobal(status({}) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed")
  })

  test("saved counts only this session's graph lookups: output filters and graft are not the graph's, and nothing shows before a lookup", async () => {
    const others = await screen({ width: 160, profile: FIVE_ROWS, savings: [{ source: "graft", calls: 5, tokens: 95_200 }, { source: "tests", calls: 2, tokens: 1_800 }] })
    await Bun.sleep(5)
    others.h.app.render()
    expect(graphRow(others)).toBe("graph on")
    const graph = await screen({ width: 160, profile: FIVE_ROWS, savings: [{ source: "graft", calls: 5, tokens: 95_200 }, { source: "graph", calls: 2, tokens: 1_200 }] })
    await Bun.sleep(5)
    graph.h.app.render()
    expect(graphRow(graph)).toBe("graph on · ~1,200 saved")
  })

  test("with the code graph switched off it reads `graph off`, whatever was pushed", async () => {
    const made = await screen({ width: 160, profile: FIVE_ROWS, settings: { features: { codegraph: false } } as never })
    made.h.app.onGlobal(status({}) as never)
    made.h.app.render()
    expect(graphRow(made)).toBe("graph off")
  })

  test("the counts take theme roles: a bold label, muted figures, the state in success", async () => {
    const made = await screen({ width: 160, profile: FIVE_ROWS })
    made.h.app.onGlobal(status({}) as never)
    made.h.app.render()
    const row = made.lines().find((line) => /GRAPH/.test(line.map((span) => span.text).join("")))!
    const label = row.find((span) => span.text.includes("GRAPH"))!
    const figures = row.find((span) => span.text.includes("2,594 files"))!
    const state = row.find((span) => span.text === "indexed")!
    expect([label.fg, label.bold, figures.fg, state.fg]).toEqual(["text", true, "muted", "success"])
  })

  test("an unchanged default footer is not touched by any of it", async () => {
    const before = await screen({ width: 100 })
    before.h.app.onGlobal(status({}) as never)
    before.h.app.render()
    const after = await screen({ width: 100 })
    expect(before.text()).toEqual(after.text())
  })
})
