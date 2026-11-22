import { describe, expect, test } from "bun:test"
import { glyphSet } from "../src/ui/theme"
import { createProjectProbe, eligibleDirectory, rankProjects, type ProjectInspection } from "../src/view/sidebar-projects"
import { groupDirectory, isGroupId, multiStops, renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import { plain } from "./session-ui-harness"

const HOME = "/Users/me"
const TMP = ["/tmp", "/private/tmp", "/var/folders/ab/T"]
const NOW = new Date(2026, 10, 15, 15, 0).getTime()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

describe("which folders can be projects", () => {
  const ok = (directory: string) => eligibleDirectory({ directory, home: HOME, tmpRoots: TMP })
  test("a folder in the work tree counts; the home folder, hidden folders and temp folders never do", () => {
    expect(ok(`${HOME}/Code/app`)).toBe(true)
    expect(ok(`${HOME}/Code/app/`)).toBe(true)
    expect(ok(HOME)).toBe(false)
    expect(ok(`${HOME}/`)).toBe(false)
    expect(ok(`${HOME}/.ssh`)).toBe(false)
    expect(ok(`${HOME}/Code/repos/.claude/skills`)).toBe(false)
    expect(ok("/tmp/kit-fix-v-1")).toBe(false)
    expect(ok("/private/tmp/ui4-login--2")).toBe(false)
    expect(ok("/var/folders/ab/T/kit-lite2-v-3")).toBe(false)
    expect(ok("/tmpfiles/app")).toBe(true)
  })
})

describe("the git probe: asked once per folder, off the render path", () => {
  const harness = (git: ReadonlySet<string>, worktrees: Record<string, string> = {}) => {
    const calls: string[] = []
    let changes = 0
    const inspect = async (directory: string): Promise<ProjectInspection> => {
      calls.push(directory)
      return { git: git.has(directory), ...(worktrees[directory] ? { main: worktrees[directory] } : {}) }
    }
    const probe = createProjectProbe({ home: HOME, tmpRoots: TMP, inspect, onChange: () => void changes++ })
    return { probe, calls, changes: () => changes }
  }
  const settle = () => Bun.sleep(5)

  test("a git work tree root is a project once the answer is in; before it, no", async () => {
    const h = harness(new Set(["/work/app"]))
    expect(h.probe.isProject("/work/app")).toBe(false)
    await settle()
    expect(h.probe.isProject("/work/app")).toBe(true)
    expect(h.changes()).toBe(1)
  })

  test("a folder without git, the home, hidden and temp folders are not; none of the last three is even asked", async () => {
    const h = harness(new Set(["/work/app", HOME, "/tmp/x", `${HOME}/.ssh`]))
    for (const directory of ["/work/plain", HOME, "/tmp/x", `${HOME}/.ssh`, "/var/folders/ab/T/y"]) h.probe.isProject(directory)
    await settle()
    for (const directory of ["/work/plain", HOME, "/tmp/x", `${HOME}/.ssh`, "/var/folders/ab/T/y"]) expect(h.probe.isProject(directory)).toBe(false)
    expect(h.calls).toEqual(["/work/plain"])
  })

  test("many frames ask the disk once per folder", async () => {
    const h = harness(new Set(["/work/app"]))
    for (let frame = 0; frame < 50; frame++) for (const directory of ["/work/app", "/work/plain"]) { h.probe.isProject(directory); h.probe.canonical(directory) }
    await settle()
    for (let frame = 0; frame < 50; frame++) for (const directory of ["/work/app", "/work/plain"]) { h.probe.isProject(directory); h.probe.canonical(directory) }
    expect(h.calls.sort()).toEqual(["/work/app", "/work/plain"])
  })

  test("a linked worktree is named by its main repo, when that repo may be a project", async () => {
    const h = harness(new Set(["/lanes/fix-a", "/lanes/fix-b", "/tmp/clone"]), { "/lanes/fix-a": "/work/app", "/lanes/fix-b": "/work/app", "/tmp/clone": "/tmp/main" })
    for (const directory of ["/lanes/fix-a", "/lanes/fix-b"]) h.probe.isProject(directory)
    await settle()
    expect(h.probe.canonical("/lanes/fix-a")).toBe("/work/app")
    expect(h.probe.canonical("/lanes/fix-b")).toBe("/work/app")
    expect(h.probe.canonical("/work/app")).toBe("/work/app")
    expect(h.probe.isProject("/lanes/fix-a")).toBe(true)
  })

  test("a failing inspection leaves the folder out and does not ask again", async () => {
    const calls: string[] = []
    const probe = createProjectProbe({ home: HOME, tmpRoots: TMP, inspect: async (directory) => { calls.push(directory); throw new Error("EACCES") }, onChange: () => undefined })
    probe.isProject("/work/locked")
    await settle()
    expect(probe.isProject("/work/locked")).toBe(false)
    expect(calls).toEqual(["/work/locked"])
  })
})

describe("ranking and the cap", () => {
  const s = (directory: string, ago: number, id = `${directory}:${ago}`) => ({ sessionId: id, directory, updatedAt: NOW - ago })
  const rank = (sessions: ReturnType<typeof s>[], over: Partial<Parameters<typeof rankProjects>[0]> = {}) => rankProjects({ sessions: sessions as never, opened: "/work/open", now: NOW, count: 3, busy: () => false, isProject: () => true, ...over })

  test("projects rank by their latest activity; the opened one takes its place by that rank, not first", () => {
    const out = rank([s("/p/old", 5 * DAY), s("/p/new", MINUTE), s("/work/open", 9 * DAY), s("/p/mid", DAY)], { count: 10 })
    expect(out.shown).toEqual(["/p/new", "/p/mid", "/p/old", "/work/open"])
    expect(out.rest).toEqual([])
  })

  test("the whole ranking stays in activity order when the opened project is older than the ones past the cap", () => {
    const out = rank([s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/c", 3 * MINUTE), s("/work/open", 9 * DAY)], { count: 2 })
    expect(out.shown).toEqual(["/p/a", "/work/open"])
    expect(out.rest).toEqual(["/p/b", "/p/c"])
    expect(out.all).toEqual(["/p/a", "/p/b", "/p/c", "/work/open"])
  })

  test("projects with a working or waiting session show past the cap, at their rank", () => {
    const out = rank([s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/busy1", 30 * DAY, "busy1"), s("/p/busy2", 40 * DAY, "busy2")], { count: 2, busy: (session) => String(session.sessionId).startsWith("busy") })
    expect(out.shown).toEqual(["/p/busy1", "/p/busy2", "/work/open"])
    expect(out.rest).toEqual(["/p/a", "/p/b"])
  })

  test("the cap counts the opened project; the rest keep their rank", () => {
    const out = rank([s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/c", 3 * MINUTE), s("/p/d", 4 * MINUTE)], { count: 3 })
    expect(out.shown).toEqual(["/p/a", "/p/b", "/work/open"])
    expect(out.rest).toEqual(["/p/c", "/p/d"])
  })

  test("equal latest activity is broken by sessions in the last 14 days", () => {
    const out = rank([s("/p/few", MINUTE, "f1"), s("/p/many", MINUTE, "m1"), s("/p/many", DAY, "m2"), s("/p/many", 3 * DAY, "m3"), s("/p/many", 20 * DAY, "m4")], { count: 2 })
    expect(out.shown).toEqual(["/p/many", "/work/open"])
    expect(out.rest).toEqual(["/p/few"])
  })

  test("a folder used today counts without being a git root, shows past the cap, and ranks by its latest activity", () => {
    // The owner's sequence: a new folder (no git) was opened and used; the opened folder then moved to a session elsewhere.
    const sessions = [s("/work/app", 5 * MINUTE), s("/new/x", 30 * MINUTE), s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/old", 3 * DAY)]
    const gitOnly = (directory: string) => directory.startsWith("/p/")
    const eligible = (directory: string) => !directory.startsWith("/tmp")
    const before = rank(sessions, { opened: "/work/app", count: 2, isProject: gitOnly })
    expect(before.shown).toEqual(["/p/a", "/work/app"])
    const after = rank(sessions, { opened: "/work/app", count: 2, isProject: gitOnly, eligible })
    // Like a busy project it shows past the cap (and counts toward it).
    expect(after.shown).toEqual(["/work/app", "/new/x"])
    expect(after.rest).toEqual(["/p/a", "/p/b", "/p/old"])
    // A day later it is an ordinary non-project again; temp folders never count.
    expect(rank([s("/new/x", 2 * DAY), s("/tmp/y", MINUTE)], { opened: "/work/app", count: 5, isProject: gitOnly, eligible }).shown).toEqual(["/work/app"])
  })

  test("ranking is by the latest activity first; the number of sessions in 14 days only breaks a tie", () => {
    const out = rank([s("/p/busy", 3 * MINUTE, "x1"), s("/p/busy", DAY, "x2"), s("/p/busy", 2 * DAY, "x3"), s("/p/new", MINUTE, "n1")], { count: 3 })
    expect(out.shown).toEqual(["/p/new", "/p/busy", "/work/open"])
  })

  test("folders that are not projects are left out, the opened one never", () => {
    const out = rank([s("/tmp/x", MINUTE), s("/p/a", 2 * MINUTE)], { count: 5, isProject: (directory) => directory === "/p/a" })
    expect(out.shown).toEqual(["/p/a", "/work/open"])
    expect(out.rest).toEqual([])
  })
})

describe("the list the sidebar draws", () => {
  const sessions = [
    { sessionId: "o1", title: "Opened one", directory: "/work/open", state: "idle", queued: 0, updatedAt: NOW - MINUTE },
    { sessionId: "o2", title: "Opened two", directory: "/work/open", state: "idle", queued: 0, updatedAt: NOW - 2 * MINUTE },
    { sessionId: "o3", title: "Opened three", directory: "/work/open", state: "idle", queued: 0, updatedAt: NOW - 3 * MINUTE },
    { sessionId: "o4", title: "Opened four", directory: "/work/open", state: "idle", queued: 0, updatedAt: NOW - 4 * MINUTE },
    ...["a", "b", "c", "d", "e"].flatMap((name, index) => [1, 2, 3, 4, 5].map((n) => ({ sessionId: `${name}${n}`, title: `${name} chat ${n}`, directory: `/p/${name}`, state: "idle", queued: 0, updatedAt: NOW - (index + 1) * 10 * MINUTE - n * 1000 }))),
  ]
  const base: MultiInput = { sessions: sessions as never, current: "o1", directory: "/work/open", focused: false, height: 60, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), glyphs: glyphSet("unicode"), previewCount: 5, projects: { isProject: () => true, count: 3 } }
  const text = (over: Partial<MultiInput> = {}) => renderMultiSidebar({ ...base, ...over }).rows.map(plain)

  test("every shown group starts open and previews the setting, the opened project like the others", () => {
    const rows = text().join("\n")
    expect(rows).toContain("▾ open")
    expect(rows).toContain("▾ a")
    expect(rows).toContain("▾ b")
    expect(rows).toContain("Opened four")
    expect(rows).toContain("a chat 5")
    expect(rows).not.toMatch(/\+ \d more\s+│/)
    const three = text({ previewCount: 3 }).join("\n")
    expect(three).toContain("Opened three")
    expect(three).not.toContain("Opened four")
    expect(three).toContain("a chat 3")
    expect(three).not.toContain("a chat 4")
    expect(three).toMatch(/\+ 1 more\s+│/)
    expect(three).toMatch(/\+ 2 more\s+│/)
  })

  test("the rest sit behind one row that expands the ranked list, and show fewer folds it", () => {
    const closed = text()
    expect(closed.join("\n")).not.toContain("▾ c")
    expect(closed.some((row) => /\+ 3 more projects\s+│$/.test(row))).toBe(true)
    const opened = text({ projectsExpanded: true })
    expect(opened.join("\n")).toContain("▾ e")
    expect(opened.some((row) => /show fewer\s+│$/.test(row))).toBe(true)
    expect(opened.join("\n")).not.toContain("more projects")
  })

  test("the expanded list keeps its groups in activity order, an old opened project last", () => {
    const old = [{ sessionId: "o1", title: "Old opened", directory: "/work/open", state: "idle", queued: 0, updatedAt: NOW - 9 * DAY }, ...["a", "b", "c"].map((name, index) => ({ sessionId: `${name}1`, title: `${name} chat`, directory: `/p/${name}`, state: "idle", queued: 0, updatedAt: NOW - (index + 1) * MINUTE }))]
    const groups = (over: Partial<MultiInput>) => text({ sessions: old as never, projects: { isProject: () => true, count: 2 }, ...over }).map((row) => /[▾▸] (\w+)/.exec(row)?.[1]).filter(Boolean)
    expect(groups({})).toEqual(["a", "open"])
    expect(groups({ projectsExpanded: true })).toEqual(["a", "b", "c", "open"])
  })

  test("with the automatic count a folder used today stays listed past the height cut, like a busy one", () => {
    const crowd = Array.from({ length: 8 }, (_, n) => ({ sessionId: `g${n}`, title: `git chat ${n}`, directory: `/p/g${n}`, state: "idle", queued: 0, updatedAt: NOW - (n + 1) * MINUTE }))
    const plain1 = { sessionId: "pl", title: "Plain notes", directory: "/work/plain", state: "idle", queued: 0, updatedAt: NOW - 60 * MINUTE }
    const input = { ...base, sessions: [sessions[0]!, ...crowd, plain1] as never, height: 12, projects: { isProject: (directory: string) => directory !== "/work/plain", eligible: () => true, count: 0 } }
    const groups = multiStops(input).filter(isGroupId).map(groupDirectory)
    expect(groups).toContain("/work/plain")
    expect(groups).not.toContain("/p/g7")
  })

  test("a group the user folded stays folded; a folded group keeps its count", () => {
    const rows = text({ open: new Map([["/p/a", false]]) })
    expect(rows.join("\n")).toContain("▸ a")
    expect(rows.join("\n")).not.toContain("a chat 1")
  })

  test("the preview setting caps the other projects below three too", () => {
    const rows = text({ previewCount: 1 }).join("\n")
    expect(rows).toContain("a chat 1")
    expect(rows).not.toContain("a chat 2")
  })

  test("worktrees named by their main repo list their sessions under it", () => {
    const aliased = { ...base, sessions: [...sessions, { sessionId: "w1", title: "Lane work", directory: "/lanes/fix", state: "idle", queued: 0, updatedAt: NOW }] as never, projects: { isProject: () => true, canonical: (directory: string) => directory === "/lanes/fix" ? "/p/a" : directory, count: 10 } }
    const rows = renderMultiSidebar(aliased).rows.map(plain).join("\n")
    expect(rows).toContain("Lane work")
    expect(rows).not.toContain("fix")
  })

  test("folder mode and a list without a project filter are as they were", () => {
    const rows = text({ scope: "folder", projects: undefined }).join("\n")
    expect(rows).toContain("▾ open")
    expect(rows).not.toContain("▾ a")
    expect(rows).not.toContain("more projects")
  })
})

describe("whose projects the all-projects list shows", () => {
  const s = (directory: string, ago: number, extra: Record<string, unknown> = {}) => ({ sessionId: `${directory}:${ago}:${Object.keys(extra).join("")}`, directory, updatedAt: NOW - ago, ...extra })
  const rank = (sessions: ReturnType<typeof s>[], over: Partial<Parameters<typeof rankProjects>[0]> = {}) => rankProjects({ sessions: sessions as never, opened: "/work/open", now: NOW, count: 10, busy: () => false, isProject: () => true, ...over })

  test("you: a project where a person typed shows; tool-only projects wait behind the more row", () => {
    const sessions = [s("/p/typed", MINUTE, { origin: "cli", lastHumanAt: NOW - MINUTE }), s("/p/tools", 2 * MINUTE, { origin: "agent" }), s("/p/cli", 3 * MINUTE, { origin: "cli" })]
    const out = rank(sessions, { from: "you" })
    expect(out.shown).toEqual(["/p/typed", "/work/open"])
    expect(out.rest).toEqual(["/p/tools", "/p/cli"])
  })

  test("all: every project shows as before", () => {
    const sessions = [s("/p/typed", MINUTE, { origin: "tui", lastHumanAt: NOW }), s("/p/tools", 2 * MINUTE, { origin: "auto" })]
    expect(rank(sessions, { from: "all" })).toMatchObject({ shown: ["/p/typed", "/p/tools", "/work/open"], rest: [] })
  })

  test("you: a session with no recorded origin counts as a person's, so older data is not hidden", () => {
    expect(rank([s("/p/old", DAY)], { from: "you" }).shown).toEqual(["/p/old", "/work/open"])
  })

  test("you: a project with a session working or waiting now shows, and so does the opened folder, whoever made them", () => {
    const sessions = [s("/p/running", DAY, { origin: "auto" }), s("/work/open", DAY, { origin: "auto" }), s("/p/quiet", MINUTE, { origin: "auto" })]
    const out = rank(sessions, { from: "you", busy: (session) => String(session.directory) === "/p/running" })
    expect(out.shown).toEqual(["/p/running", "/work/open"])
    expect(out.rest).toEqual(["/p/quiet"])
  })

  test("you: a folder used today for tools only is not forced onto the list", () => {
    const out = rank([s("/new/x", MINUTE, { origin: "agent" })], { from: "you", isProject: () => false, eligible: () => true })
    expect(out.shown).toEqual(["/work/open"])
    expect(out.rest).toEqual(["/new/x"])
  })

  test("a hidden project never shows, not even behind the more row; the opened folder ignores it", () => {
    const sessions = [s("/p/gone", MINUTE, { lastHumanAt: NOW }), s("/p/kept", 2 * MINUTE, { lastHumanAt: NOW }), s("/work/open", 3 * MINUTE, { lastHumanAt: NOW })]
    const out = rank(sessions, { from: "all", hidden: new Set(["/p/gone", "/work/open"]) })
    expect(out.shown).toEqual(["/p/kept", "/work/open"])
    expect(out.rest).toEqual([])
  })
})
