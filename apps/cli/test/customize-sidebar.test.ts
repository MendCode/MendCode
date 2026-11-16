import { describe, expect, test } from "bun:test"
import { CUSTOMIZE_ROWS, customizePageKey, rowShown } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "../src/view/tui-profile"

const RIGHT = "\x1b[C"
const at = (row: (typeof CUSTOMIZE_ROWS)[number]) => ({ row: CUSTOMIZE_ROWS.indexOf(row) })
const press = (row: (typeof CUSTOMIZE_ROWS)[number], key: string, profile: TuiProfile = DEFAULT_TUI_PROFILE, state: ReturnType<typeof at> & { typing?: string } = at(row)) => customizePageKey(state, key, profile, [], undefined, [], { bots: true })

describe("/customize sidebar rows", () => {
  test("projects scope is a normal setting; layout and sections need the bots flag", () => {
    expect(rowShown("sidebarProjects", DEFAULT_TUI_PROFILE, {})).toBe(true)
    expect(rowShown("sidebarLayout", DEFAULT_TUI_PROFILE, {})).toBe(false)
    expect(rowShown("sidebarSections", DEFAULT_TUI_PROFILE, {})).toBe(false)
    expect(rowShown("sidebarLayout", DEFAULT_TUI_PROFILE, { bots: true })).toBe(true)
    expect(rowShown("sidebarSections", DEFAULT_TUI_PROFILE, { bots: true })).toBe(true)
  })

  test("the sidebar rows stay on the page when the mode is hidden, since the toggle key shows the sidebar in any mode", () => {
    const hidden = { ...DEFAULT_TUI_PROFILE, sidebar: "hidden" as const }
    for (const row of ["sidebarProjects", "sidebarPreviewCount", "sidebarSide", "sidebarHeader"] as const) expect(rowShown(row, hidden, {})).toBe(true)
    expect(rowShown("sidebarLayout", hidden, { bots: true })).toBe(true)
    expect(rowShown("sidebarSections", hidden, { bots: true })).toBe(true)
    expect(rowShown("sidebarLayout", hidden, {})).toBe(false)
  })

  test("projects scope steps auto, folder, all", () => {
    expect(press("sidebarProjects", RIGHT).action).toEqual({ type: "set", patch: { sidebarProjects: "folder" } })
    expect(press("sidebarProjects", RIGHT, { ...DEFAULT_TUI_PROFILE, sidebarProjects: "folder" }).action).toEqual({ type: "set", patch: { sidebarProjects: "all" } })
    expect(press("sidebarProjects", RIGHT, { ...DEFAULT_TUI_PROFILE, sidebarProjects: "all" }).action).toEqual({ type: "set", patch: { sidebarProjects: "auto" } })
  })

  test("the preview count is a number row beside the other sidebar rows: shown with the sidebar, stepped within 1..50, typed and checked", () => {
    expect(rowShown("sidebarPreviewCount", DEFAULT_TUI_PROFILE, {})).toBe(true)
    expect(CUSTOMIZE_ROWS.indexOf("sidebarPreviewCount")).toBe(CUSTOMIZE_ROWS.indexOf("sidebarProjects") + 1)
    expect(press("sidebarPreviewCount", RIGHT).action).toEqual({ type: "set", patch: { sidebarPreviewCount: 6 } })
    expect(press("sidebarPreviewCount", "\x1b[D").action).toEqual({ type: "set", patch: { sidebarPreviewCount: 4 } })
    expect(press("sidebarPreviewCount", RIGHT, { ...DEFAULT_TUI_PROFILE, sidebarPreviewCount: 50 }).action).toEqual({ type: "set", patch: { sidebarPreviewCount: 50 } })
    const open = press("sidebarPreviewCount", "\r").state
    expect(press("sidebarPreviewCount", "\r", DEFAULT_TUI_PROFILE, { ...open, typing: "12" }).action).toEqual({ type: "set", patch: { sidebarPreviewCount: 12 } })
    const bad = press("sidebarPreviewCount", "\r", DEFAULT_TUI_PROFILE, { ...open, typing: "0" })
    expect(bad.action).toEqual({ type: "none" })
    expect(bad.state.error).toContain("1..50")
  })

  test("choosing a starting layout brings its own sections, dropping a typed list", () => {
    const typed = { ...DEFAULT_TUI_PROFILE, sidebarSections: "bots" }
    expect(press("sidebarLayout", RIGHT, typed).action).toEqual({ type: "set", patch: { sidebarLayout: "bots-first", sidebarSections: "" } })
    expect(press("sidebarLayout", "\x1b[D", typed).action).toEqual({ type: "set", patch: { sidebarLayout: "scratch", sidebarSections: "" } })
  })

  test("the section list is typed, checked and saved in order; an unknown name is refused", () => {
    const open = press("sidebarSections", "\r").state
    expect(open.typing).toBe("")
    const typed = { ...open, typing: "bots, projects" }
    expect(press("sidebarSections", "\r", DEFAULT_TUI_PROFILE, typed).action).toEqual({ type: "set", patch: { sidebarSections: "bots,projects" } })
    const bad = press("sidebarSections", "\r", DEFAULT_TUI_PROFILE, { ...open, typing: "bots, mail" })
    expect(bad.action).toEqual({ type: "none" })
    expect(bad.state.error).toContain("projects, bots, sessions")
    expect(press("sidebarSections", "\r", DEFAULT_TUI_PROFILE, { ...open, typing: "none" }).action).toEqual({ type: "set", patch: { sidebarSections: "none" } })
  })
})
