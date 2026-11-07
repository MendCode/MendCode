import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { closedSearch, pageSearchKey, pageSearchRow, searchMatches } from "../src/view/page-search"
import { CUSTOMIZE_ROWS, customizePageKey, customizeSteps, previewScene, rowShown } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, tuiProfilePath, type TuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"

/** The regrouped /customize: sections, hidden rows, the `/` filter, number rows, the scene each row previews and the home input. */

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const item of made.splice(0)) item.cleanup() })
const saved = (dataDir: string): TuiProfile => JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8"))
const DOWN = "\x1b[B"
const RIGHT = "\x1b[C"

async function app(options: { width?: number; height?: number; profile?: Partial<TuiProfile> } = {}) {
  const temp = scratch()
  made.push(temp)
  if (options.profile) temp.write("data/tui/profile.json", JSON.stringify({ ...DEFAULT_TUI_PROFILE, ...options.profile }))
  const h = await appHarness({ dataDir: temp.dataDir, width: options.width ?? 140, height: options.height ?? 44 })
  await h.start({ onboarded: true } as never)
  return { h, dataDir: temp.dataDir }
}

describe("the shared page search", () => {
  test("/ opens it, typing edits, Backspace deletes, Esc clears, Enter keeps the query; other keys are the page's", () => {
    expect(pageSearchKey(undefined, "j")).toBeUndefined()
    let search = pageSearchKey(closedSearch(), "/")!.search
    expect(search).toEqual({ open: true, query: "" })
    for (const key of ["b", "o", "r"]) search = pageSearchKey(search, key)!.search
    expect(pageSearchKey(search, "\x7f")!.search.query).toBe("bo")
    expect(pageSearchKey(search, DOWN)).toBeUndefined()
    expect(pageSearchKey(search, "\r")).toEqual({ search: { open: false, query: "bor" }, event: "submitted" })
    expect(pageSearchKey(search, "\x1b")).toEqual({ search: closedSearch(), event: "closed" })
  })

  test("every word must match one of the fields, any case", () => {
    expect(searchMatches("", ["anything"])).toBe(true)
    expect(searchMatches("top BAR", ["Top bar", "Top & side"])).toBe(true)
    expect(searchMatches("top footer", ["Top bar"])).toBe(false)
  })

  test("the box row never runs past its width: the count goes first, then the query is cut", () => {
    const width = (line: ReturnType<typeof pageSearchRow>) => textWidth(line!.map((span) => span.text).join(""))
    expect(pageSearchRow(closedSearch(), 3, 40)).toBeUndefined()
    const short = pageSearchRow({ open: true, query: "border" }, 4, 40)!
    expect(short.map((span) => span.text).join("")).toBe("/ border_  4 matches")
    for (const room of [8, 14, 20, 30]) expect(width(pageSearchRow({ open: true, query: "a long query with words" }, 12, room))).toBeLessThanOrEqual(room)
  })
})

describe("/customize sections", () => {
  test("the common sections come first and Advanced holds extensions, views, the slash menu and reset", () => {
    const at = (row: (typeof CUSTOMIZE_ROWS)[number]) => CUSTOMIZE_ROWS.indexOf(row)
    expect(at("theme")).toBe(0)
    expect(at("logoKind")).toBeLessThan(at("promptChrome"))
    for (const row of ["extensions", "views", "slashMenu", "reset"] as const) expect(at(row)).toBeGreaterThan(at("turnBell"))
    expect(CUSTOMIZE_ROWS.at(-1)).toBe("reset")
  })

  test("a row that depends on one switched off is hidden with it", () => {
    const shown = (row: (typeof CUSTOMIZE_ROWS)[number], profile: Partial<TuiProfile>) => rowShown(row, { ...DEFAULT_TUI_PROFILE, ...profile })
    expect(shown("topbarStats", { showTopbar: true })).toBe(true)
    expect(shown("topbarStats", { showTopbar: false })).toBe(false)
    expect(shown("customAscii", { logoKind: "wordmark" })).toBe(false)
    expect(shown("customAscii", { logoKind: "custom" })).toBe(true)
    expect(shown("logoFont", { logoKind: "custom" })).toBe(false)
    expect(shown("placeholderText", { showPlaceholder: false })).toBe(false)
    expect(shown("homeInput", { homeLayout: "split" })).toBe(false)
    // Footer rows own the footer: the one-row parts change nothing there, so they are not listed.
    expect(shown("showModel", {})).toBe(true)
    expect(shown("showModel", { footerRows: [["model"]] })).toBe(false)
    expect(rowShown("showModel", DEFAULT_TUI_PROFILE, { footerExtension: "look" })).toBe(false)
  })

  test("the steps to a row skip the hidden rows above it", () => {
    const off = { ...DEFAULT_TUI_PROFILE, showTopbar: false }
    expect(customizeSteps("sidebar", off)).toBeLessThan(customizeSteps("sidebar", { ...off, showTopbar: true }))
  })

  test("each row previews the part of the screen it changes", () => {
    expect(previewScene("logoKind")).toBe("home")
    expect(previewScene("homeInput")).toBe("home")
    expect(previewScene("showTopbar")).toBe("chat")
    expect(previewScene("presentation")).toBe("chat")
    expect(previewScene("promptStatus")).toBe("prompt")
    expect(previewScene("tableStyle")).toBe("markdown")
    expect(previewScene("diffView")).toBe("diff")
    expect(previewScene("keyProtocol")).toBe("about")
  })

  test("number rows step with the arrows inside their range and edit with Enter", () => {
    const row = CUSTOMIZE_ROWS.indexOf("wheelLines")
    const right = customizePageKey({ row }, RIGHT, { ...DEFAULT_TUI_PROFILE, wheelLines: 3 })
    expect(right.action).toEqual({ type: "set", patch: { wheelLines: 4 } })
    expect(customizePageKey({ row }, RIGHT, { ...DEFAULT_TUI_PROFILE, wheelLines: 20 }).action).toEqual({ type: "set", patch: { wheelLines: 20 } })
    expect(customizePageKey({ row }, "\r", DEFAULT_TUI_PROFILE).state.typing).toBe(String(DEFAULT_TUI_PROFILE.wheelLines))
  })
})

describe("/customize in the app", () => {
  test("/ filters by name, section or description; Enter goes to the row, Esc clears", async () => {
    const { h } = await app()
    await h.type("/customize\r")
    await h.key("/")
    await h.type("top bar")
    expect(h.text()).toContain("/ top bar_")
    expect(h.text()).toContain("Top bar stats")
    expect(h.text()).not.toContain("Logo kind")
    await h.key("\r")
    // The filter is gone and the cursor stays on the picked row, with every row listed again.
    expect(h.text()).not.toContain("/ top bar")
    expect(h.text()).toMatch(/❯ Top bar\b/)
    expect(h.text()).toContain("Compaction panel")
    await h.key("/")
    await h.type("zzzz")
    expect(h.text()).toContain("No row matches")
    await h.key("\x1b")
    expect(h.text()).not.toContain("/ zzzz")
    expect(h.app.page).toBe("customize")
  })

  test("Top bar off hides its rows at once and the chat preview draws without the bar", async () => {
    const { h, dataDir } = await app()
    await h.type("/settings showTopbar\r")
    expect(h.text()).toContain("Chat preview")
    expect(h.text()).toContain("Top bar stats")
    await h.key(" ")
    expect(saved(dataDir).showTopbar).toBe(false)
    expect(h.text()).not.toContain("Top bar stats")
  })

  test("own footer rows: the page says so and the one-row parts are not listed", async () => {
    const { h } = await app({ profile: { footerRows: [["directory", "branch"], ["model", "effort"]] } })
    await h.type("/settings showStatus\r")
    expect(h.text()).toContain("Your own footer rows are in use")
    expect(h.text()).not.toMatch(/\bProvider\s+‹/)
  })

  for (const homeInput of ["center", "top"] as const) {
    test(`Input position ${homeInput} puts the empty home's prompt under the logo, the footer stays at the bottom`, async () => {
      const { h } = await app({ width: 120, height: 40, profile: { homeInput } })
      const rows = h.text().split("\n")
      const prompt = rows.findIndex((row) => row.includes("❭"))
      const sessions = rows.findIndex((row) => row.includes("No sessions yet"))
      expect(prompt).toBeGreaterThan(0)
      expect(sessions).toBeGreaterThan(prompt)
      // The prompt (its top rule, then the input row) sits right under the identity, past the gap, in the top half when the logo keeps to the top.
      const logoEnd = rows.findLastIndex((row, index) => index < prompt && /[█▀▄]/.test(row))
      expect(prompt - logoEnd).toBeLessThanOrEqual(4)
      if (homeInput === "top") expect(prompt).toBeLessThanOrEqual(rows.length / 2)
      await h.type("hello")
      expect(h.text()).toContain("hello")
    })
  }

  test("Input position bottom keeps the prompt under the session list", async () => {
    const { h } = await app({ width: 120, height: 40 })
    const rows = h.text().split("\n")
    expect(rows.findIndex((row) => row.includes("❭"))).toBeGreaterThan(rows.findIndex((row) => row.includes("No sessions yet")))
  })
})
