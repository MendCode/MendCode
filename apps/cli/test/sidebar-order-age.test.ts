import { describe, expect, test } from "bun:test"
import { renderMultiSidebar, type MultiInput, type MultiSession } from "../src/view/sidebar-multi"
import { rankProjects } from "../src/view/sidebar-projects"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { TUI_DEFAULTS, tuiProblems } from "@mendcode/protocol"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const NOW = 1_800_000_000_000
const session = (id: string, directory: string, age: number, extra: Partial<MultiSession> = {}): MultiSession => ({ sessionId: id, title: `chat ${id}`, directory, updatedAt: NOW - age, state: "idle", queued: 0, lastSeq: 9, ...extra })

const input = (over: Partial<MultiInput> & { sessions: MultiSession[] }): MultiInput => ({ current: "s-app", directory: "/work/app", focused: false, height: 60, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), projects: { isProject: () => true, count: Number.POSITIVE_INFINITY }, ...over })
const groups = (rows: ReturnType<typeof renderMultiSidebar>["rows"]) => rows.map((row) => row.map((span) => span.text).join("")).filter((text) => /[▾▸] /.test(text)).map((text) => text.replace(/[│▌›]/g, "").trim().split(/\s+/)[1])
const text = (rows: ReturnType<typeof renderMultiSidebar>["rows"]) => rows.map((row) => row.map((span) => span.text).join("").slice(0, SIDEBAR_WIDTH)).join("\n")

const two = [session("s-app", "/work/app", 10 * MINUTE), session("s-api", "/other/api", MINUTE), session("s-site", "/work/site", 3 * MINUTE)]

describe("the project order is stable while the user navigates", () => {
  test("opening a chat of the lower project does not move any group", () => {
    const before = groups(renderMultiSidebar(input({ sessions: two })).rows)
    const after = groups(renderMultiSidebar(input({ sessions: two, current: "s-site", directory: "/work/site" })).rows)
    expect(after).toEqual(before)
    // Ranked by the latest activity of each project, not by which one is open.
    expect(before).toEqual(["api", "site", "app"])
  })

  test("a busy project keeps its rank by activity; it only decides whether it shows past the cap", () => {
    const sessions = [...two, session("s-old", "/work/old", 3 * DAY, { state: "generating" })]
    expect(groups(renderMultiSidebar(input({ sessions })).rows)).toEqual(["api", "site", "app", "old"])
  })

  test("typing a draft in a chat does not rank its project higher", () => {
    const draft = { updatedAt: NOW, text: "hi" } as never
    const sessions = [session("s-app", "/work/app", 10 * MINUTE, { draft }), session("s-api", "/other/api", MINUTE)]
    expect(groups(renderMultiSidebar(input({ sessions })).rows)).toEqual(["api", "app"])
  })

  test("a burst of pushes settles: a project already ranked keeps its place for a minute", () => {
    const stamps = new Map<string, number>()
    const rank = (sessions: MultiSession[], now: number) => rankProjects({ sessions, opened: "/work/app", now, count: 10, busy: () => false, isProject: () => true, stamps }).shown
    const front = session("s-api", "/other/api", 90_000)
    const behind = session("s-site", "/work/site", 2 * MINUTE)
    const app = session("s-app", "/work/app", 10 * MINUTE)
    expect(rank([app, front, behind], NOW)).toEqual(["/other/api", "/work/site", "/work/app"])
    // The site chat streams: its activity moves 50 seconds, past the api's, and the order holds.
    expect(rank([app, front, { ...behind, updatedAt: NOW - 70_000 }], NOW)).toEqual(["/other/api", "/work/site", "/work/app"])
    // A new turn well after: it moves up.
    expect(rank([app, front, { ...behind, updatedAt: NOW + 5 * MINUTE }], NOW + 5 * MINUTE)).toEqual(["/work/site", "/other/api", "/work/app"])
  })
})

describe("old sessions stay behind a row", () => {
  const old = (n: number) => session(`s-old${n}`, "/work/app", (8 + n) * DAY)
  const sessions = [session("s-app", "/work/app", MINUTE), session("s-new", "/work/app", 2 * DAY), old(1), old(2), old(3)]

  test("only sessions active in the last 7 days list; the rest are one `+ N older` row", () => {
    const drawn = text(renderMultiSidebar(input({ sessions, recentDays: 7 })).rows)
    expect(drawn).toContain("chat s-new")
    expect(drawn).not.toContain("chat s-old1")
    expect(drawn).toMatch(/\+ 3 older/)
  })

  test("the older row opens everything and `show less` folds it again", () => {
    const drawn = text(renderMultiSidebar(input({ sessions, recentDays: 7, expanded: new Set(["/work/app"]) })).rows)
    expect(drawn).toContain("chat s-old3")
    expect(drawn).toContain("show less")
  })

  test("running, waiting, pinned and the open session show whatever their age", () => {
    const kept = [
      session("s-app", "/work/app", 30 * DAY),
      session("s-run", "/work/app", 20 * DAY, { state: "generating" }),
      session("s-wait", "/work/app", 21 * DAY, { state: "waiting_approval" }),
      session("s-pin", "/work/app", 22 * DAY, { lifecycle: { pinnedAt: NOW - 22 * DAY } as never }),
      old(1),
    ]
    const drawn = text(renderMultiSidebar(input({ sessions: kept, recentDays: 7 })).rows)
    for (const id of ["s-app", "s-run", "s-wait", "s-pin"]) expect(drawn).toContain(`chat ${id}`)
    expect(drawn).not.toContain("chat s-old1")
    expect(drawn).toMatch(/\+ 1 older/)
  })

  test("a project with nothing recent still lists as a group: its header and the older row", () => {
    const sessions2 = [session("s-app", "/work/app", MINUTE), session("s-x", "/work/stale", 40 * DAY), session("s-y", "/work/stale", 41 * DAY)]
    const drawn = text(renderMultiSidebar(input({ sessions: sessions2, recentDays: 7 })).rows)
    expect(drawn).toContain("▾ stale")
    expect(drawn).toMatch(/\+ 2 older/)
    expect(drawn).not.toContain("chat s-x")
  })

  test("0 lists every age, and no setting is the same as 7", () => {
    expect(text(renderMultiSidebar(input({ sessions, recentDays: 0 })).rows)).toContain("chat s-old1")
    expect(text(renderMultiSidebar(input({ sessions })).rows)).not.toContain("chat s-old1")
  })

  test("the preview count still caps the recent ones, with `+ N more`", () => {
    const many = [session("s-app", "/work/app", MINUTE), ...[1, 2, 3, 4].map((n) => session(`s-r${n}`, "/work/app", n * DAY))]
    const drawn = text(renderMultiSidebar(input({ sessions: many, recentDays: 7, previewCount: 2 })).rows)
    expect(drawn).toMatch(/\+ 3 more/)
  })
})

describe("the project list fills the height unless a cap is set", () => {
  const many = Array.from({ length: 40 }, (_, n) => session(`s-${n}`, `/p/proj${String(n).padStart(2, "0")}`, (n + 1) * MINUTE))
  const withCurrent = [session("s-app", "/work/app", 0), ...many]
  const count = (height: number, projects: MultiInput["projects"]) => groups(renderMultiSidebar(input({ sessions: withCurrent, height, projects, recentDays: 7 })).rows).length

  test("auto shows more projects than the old cap of 6 and grows with the height", () => {
    const small = count(24, { isProject: () => true, count: 0 })
    const tall = count(60, { isProject: () => true, count: 0 })
    expect(small).toBeGreaterThanOrEqual(6)
    expect(tall).toBeGreaterThanOrEqual(small + 5)
  })

  test("auto leaves the rest behind the `+ N more projects` row", () => {
    const drawn = text(renderMultiSidebar(input({ sessions: withCurrent, height: 30, projects: { isProject: () => true, count: 0 } })).rows)
    expect(drawn).toMatch(/\+ \d+ more projects/)
  })

  test("an explicit cap still wins", () => {
    expect(count(60, { isProject: () => true, count: 4 })).toBe(4)
  })
})

describe("the profile", () => {
  test("sidebarRecentDays: 7 by default, 0 means no limit, and an old profile gets 7", () => {
    expect(DEFAULT_TUI_PROFILE.sidebarRecentDays).toBe(7)
    expect(TUI_DEFAULTS.sidebarRecentDays).toBe(7)
    expect(normalizeTuiProfile({ sidebar: "auto" }).sidebarRecentDays).toBe(7)
    expect(normalizeTuiProfile({ sidebarRecentDays: 0 }).sidebarRecentDays).toBe(0)
    expect(normalizeTuiProfile({ sidebarRecentDays: 30.9 }).sidebarRecentDays).toBe(30)
    expect(normalizeTuiProfile({ sidebarRecentDays: 9999 }).sidebarRecentDays).toBe(365)
    expect(normalizeTuiProfile({ sidebarRecentDays: "x" }).sidebarRecentDays).toBe(7)
    expect(tuiProblems({ sidebarRecentDays: 0 })).toEqual([])
    expect(tuiProblems({ sidebarRecentDays: 366 })[0]).toContain("0..365")
  })

  test("sidebarProjectCount: 0 is automatic and the default", () => {
    expect(DEFAULT_TUI_PROFILE.sidebarProjectCount).toBe(0)
    expect(TUI_DEFAULTS.sidebarProjectCount).toBe(0)
    expect(normalizeTuiProfile({ sidebar: "auto" }).sidebarProjectCount).toBe(0)
    expect(normalizeTuiProfile({ sidebarProjectCount: 12 }).sidebarProjectCount).toBe(12)
    expect(tuiProblems({ sidebarProjectCount: 0 })).toEqual([])
    expect(tuiProblems({ sidebarProjectCount: 31 })[0]).toContain("0..30")
  })
})

describe("the project lists share the row marks", () => {
  const one = (extra: Partial<MultiSession>) => text(renderMultiSidebar(input({ sessions: [session("s-app", "/work/app", MINUTE, extra)], blink: true })).rows)

  test("a running row counts up from its turn's start; a merged PR shows number and word", () => {
    expect(one({ state: "tool", since: NOW - (2 * MINUTE + 14_000) })).toMatch(/chat s-app\s+2m14s/)
    expect(one({ lifecycle: { pr: { number: 812, url: "u", title: "t", state: "MERGED", branch: "b", checkedAt: NOW } } })).toMatch(/chat s-app\s+1m #812 merged/)
  })

  test("question and plan waits get their own marks and keep the project busy", () => {
    expect(one({ state: "waiting_approval", pendingKind: "question" })).toMatch(/◎ chat s-app/)
    expect(one({ state: "waiting_approval", pendingKind: "plan" })).toMatch(/◈ chat s-app/)
    expect(one({ state: "waiting_approval", pendingKind: "approval" })).toMatch(/\? chat s-app/)
    const header = text(renderMultiSidebar(input({ sessions: [session("s-app", "/work/app", MINUTE, { state: "waiting_approval", pendingKind: "question" })], sections: ["projects"] })).rows)
    expect(header).toContain("? 1")
  })
})
