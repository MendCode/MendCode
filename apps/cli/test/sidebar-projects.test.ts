import { describe, expect, test } from "bun:test"
import { glyphSet } from "../src/ui/theme"
import { createProjectProbe, eligibleDirectory, rankProjects, type ProjectInspection } from "../src/view/sidebar-projects"
import { renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import { plain } from "./session-ui-harness"

const HOME = "/Users/obed"
const TMP = ["/tmp", "/private/tmp", "/var/folders/ab/T"]
const NOW = new Date(2026, 10, 15, 15, 0).getTime()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

describe("which folders can be projects", () => {
  const ok = (directory: string) => eligibleDirectory({ directory, home: HOME, tmpRoots: TMP })
  test("a folder in the work tree counts; the home folder, hidden folders and temp folders never do", () => {
    expect(ok("/Users/obed/Code/app")).toBe(true)
    expect(ok("/Users/obed/Code/app/")).toBe(true)
    expect(ok(HOME)).toBe(false)
    expect(ok(`${HOME}/`)).toBe(false)
    expect(ok("/Users/obed/.ssh")).toBe(false)
    expect(ok("/Users/obed/Code/repos/.claude/skills")).toBe(false)
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

  test("the opened project first, then the most recently used", () => {
    const out = rank([s("/p/old", 5 * DAY), s("/p/new", MINUTE), s("/work/open", 9 * DAY), s("/p/mid", DAY)], { count: 10 })
    expect(out.shown).toEqual(["/work/open", "/p/new", "/p/mid", "/p/old"])
    expect(out.rest).toEqual([])
  })

  test("projects with a working or waiting session come right after the opened one, past the cap", () => {
    const out = rank([s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/busy1", 30 * DAY, "busy1"), s("/p/busy2", 40 * DAY, "busy2")], { count: 2, busy: (session) => String(session.sessionId).startsWith("busy") })
    expect(out.shown).toEqual(["/work/open", "/p/busy1", "/p/busy2"])
    expect(out.rest).toEqual(["/p/a", "/p/b"])
  })

  test("the cap counts the opened project; the rest keep their rank", () => {
    const out = rank([s("/p/a", MINUTE), s("/p/b", 2 * MINUTE), s("/p/c", 3 * MINUTE), s("/p/d", 4 * MINUTE)], { count: 3 })
    expect(out.shown).toEqual(["/work/open", "/p/a", "/p/b"])
    expect(out.rest).toEqual(["/p/c", "/p/d"])
  })

  test("equal latest activity is broken by sessions in the last 14 days", () => {
    const out = rank([s("/p/few", MINUTE, "f1"), s("/p/many", MINUTE, "m1"), s("/p/many", DAY, "m2"), s("/p/many", 3 * DAY, "m3"), s("/p/many", 20 * DAY, "m4")], { count: 2 })
    expect(out.shown).toEqual(["/work/open", "/p/many"])
    expect(out.rest).toEqual(["/p/few"])
  })

  test("folders that are not projects are left out, the opened one never", () => {
    const out = rank([s("/tmp/x", MINUTE), s("/p/a", 2 * MINUTE)], { count: 5, isProject: (directory) => directory === "/p/a" })
    expect(out.shown).toEqual(["/work/open", "/p/a"])
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

  test("every shown group starts open; the opened project previews the setting, the others at most three", () => {
    const rows = text().join("\n")
    expect(rows).toContain("▾ open")
    expect(rows).toContain("▾ a")
    expect(rows).toContain("▾ b")
    expect(rows).toContain("Opened four")
    expect(rows).toContain("a chat 3")
    expect(rows).not.toContain("a chat 4")
    expect(rows).toMatch(/\+ 2 more\s+│/)
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
