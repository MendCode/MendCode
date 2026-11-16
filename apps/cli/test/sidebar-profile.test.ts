import { describe, expect, test } from "bun:test"
import { TUI_DEFAULTS, tuiProblems } from "@mendcode/protocol/wire"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, sidebarListsAll, sidebarSectionsOf } from "../src/view/tui-profile"

describe("sidebar projects scope", () => {
  test("auto lists every project while bots are on and the opened folder otherwise; folder and all mean what they say", () => {
    expect(sidebarListsAll("auto", true)).toBe(true)
    expect(sidebarListsAll("auto", false)).toBe(false)
    expect(sidebarListsAll("folder", true)).toBe(false)
    expect(sidebarListsAll("folder", false)).toBe(false)
    expect(sidebarListsAll("all", true)).toBe(true)
    expect(sidebarListsAll("all", false)).toBe(true)
  })

  test("a saved folder or all survives loading; a missing key is auto", () => {
    expect(normalizeTuiProfile({ sidebarProjects: "folder" }).sidebarProjects).toBe("folder")
    expect(normalizeTuiProfile({ sidebarProjects: "all" }).sidebarProjects).toBe("all")
    expect(normalizeTuiProfile({ sidebar: "hidden" }).sidebarProjects).toBe("auto")
  })
})

describe("sidebar profile keys", () => {
  test("a profile written before the keys existed loads unchanged, with today's sidebar", () => {
    const old = { sidebar: "auto", sidebarSide: "left", sidebarHeader: true, theme: "dark" }
    const loaded = normalizeTuiProfile(old)
    expect(loaded).toEqual(normalizeTuiProfile({ ...old, sidebarProjects: "auto", sidebarLayout: "bots-first", sidebarSections: "" }))
    expect(loaded).toMatchObject({ sidebarProjects: "auto", sidebarLayout: "bots-first", sidebarSections: "" })
    expect(DEFAULT_TUI_PROFILE).toMatchObject({ sidebarProjects: "auto", sidebarLayout: "bots-first", sidebarSections: "" })
  })

  test("bots come first by default, and a layout the user saved is kept", () => {
    expect(sidebarSectionsOf(normalizeTuiProfile({}))).toEqual(["bots", "projects", "sessions"])
    expect(sidebarSectionsOf(normalizeTuiProfile({ sidebarLayout: "projects-first" }))).toEqual(["projects", "bots", "sessions"])
    expect(normalizeTuiProfile({ sidebarLayout: "scratch" }).sidebarLayout).toBe("scratch")
  })

  test("the protocol's defaults agree with the terminal's and its checks accept only the known values", () => {
    for (const key of ["sidebarProjects", "sidebarLayout", "sidebarSections"] as const) expect(TUI_DEFAULTS[key]).toBe(DEFAULT_TUI_PROFILE[key])
    expect(tuiProblems({ sidebarProjects: "all", sidebarLayout: "icons-only", sidebarSections: "bots,projects" })).toEqual([])
    expect(tuiProblems({ sidebarProjects: "everything" })[0]).toContain("auto|folder|all")
    expect(tuiProblems({ sidebarLayout: "grid" })[0]).toContain("projects-first|bots-first|icons-only|scratch")
    expect(tuiProblems({ sidebarSections: "bots,mail" })[0]).toContain("projects, bots, sessions")
  })

  test("a bad value falls back to the default instead of breaking the profile", () => {
    expect(normalizeTuiProfile({ sidebarProjects: "x", sidebarLayout: 3, sidebarSections: "bots,mail" })).toMatchObject({ sidebarProjects: "auto", sidebarLayout: "bots-first", sidebarSections: "" })
    expect(normalizeTuiProfile({ sidebarSections: "bots, projects, bots" }).sidebarSections).toBe("bots,projects")
    expect(normalizeTuiProfile({ sidebarSections: "none" }).sidebarSections).toBe("none")
  })

  test("sidebarPreviewCount: a profile written before the key loads with 5, and the protocol agrees", () => {
    expect(normalizeTuiProfile({ sidebar: "auto" }).sidebarPreviewCount).toBe(5)
    expect(DEFAULT_TUI_PROFILE.sidebarPreviewCount).toBe(5)
    expect(TUI_DEFAULTS.sidebarPreviewCount).toBe(5)
  })

  test("sidebarPreviewCount is normalized into 1..50 and a bad value falls back to 5", () => {
    expect(normalizeTuiProfile({ sidebarPreviewCount: 0 }).sidebarPreviewCount).toBe(1)
    expect(normalizeTuiProfile({ sidebarPreviewCount: 99 }).sidebarPreviewCount).toBe(50)
    expect(normalizeTuiProfile({ sidebarPreviewCount: 7.9 }).sidebarPreviewCount).toBe(7)
    expect(normalizeTuiProfile({ sidebarPreviewCount: "x" }).sidebarPreviewCount).toBe(5)
    expect(normalizeTuiProfile({ sidebarPreviewCount: Number.NaN }).sidebarPreviewCount).toBe(5)
  })

  test("the protocol's check accepts integers 1..50 only", () => {
    expect(tuiProblems({ sidebarPreviewCount: 12 })).toEqual([])
    expect(tuiProblems({ sidebarPreviewCount: 0 })[0]).toContain("1..50")
    expect(tuiProblems({ sidebarPreviewCount: 51 })[0]).toContain("1..50")
    expect(tuiProblems({ sidebarPreviewCount: 2.5 })[0]).toContain("1..50")
  })

  test("sidebarProjectCount: 0 (automatic) by default, normalized into 0..30, and the protocol agrees", () => {
    expect(normalizeTuiProfile({ sidebar: "auto" }).sidebarProjectCount).toBe(0)
    expect(DEFAULT_TUI_PROFILE.sidebarProjectCount).toBe(0)
    expect(TUI_DEFAULTS.sidebarProjectCount).toBe(0)
    expect(normalizeTuiProfile({ sidebarProjectCount: 0 }).sidebarProjectCount).toBe(0)
    expect(normalizeTuiProfile({ sidebarProjectCount: -3 }).sidebarProjectCount).toBe(0)
    expect(normalizeTuiProfile({ sidebarProjectCount: 99 }).sidebarProjectCount).toBe(30)
    expect(normalizeTuiProfile({ sidebarProjectCount: "x" }).sidebarProjectCount).toBe(0)
    expect(tuiProblems({ sidebarProjectCount: 12 })).toEqual([])
    expect(tuiProblems({ sidebarProjectCount: 31 })[0]).toContain("0..30")
    expect(tuiProblems({ sidebarProjectCount: -1 })[0]).toContain("0..30")
  })

  test("the layout gives the sections and their order; an explicit list wins; none hides all", () => {
    const sections = (over: Record<string, unknown>) => sidebarSectionsOf(normalizeTuiProfile(over))
    expect(sections({})).toEqual(["bots", "projects", "sessions"])
    expect(sections({ sidebarLayout: "projects-first" })).toEqual(["projects", "bots", "sessions"])
    expect(sections({ sidebarLayout: "bots-first" })).toEqual(["bots", "projects", "sessions"])
    expect(sections({ sidebarLayout: "icons-only" })).toEqual(["bots", "projects", "sessions"])
    expect(sections({ sidebarLayout: "scratch" })).toEqual([])
    expect(sections({ sidebarLayout: "scratch", sidebarSections: "bots" })).toEqual(["bots"])
    expect(sections({ sidebarSections: "sessions,bots" })).toEqual(["sessions", "bots"])
    expect(sections({ sidebarSections: "none" })).toEqual([])
  })
})
