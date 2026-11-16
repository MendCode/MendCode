import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/protocol"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const HOME = process.env.HOME ?? "/Users/me"

const REPOS = ["/work/app", "/other/api", "/work/site", "/repos/r1", "/repos/r2", "/repos/r3", "/repos/r4", ...Array.from({ length: 12 }, (_, n) => `/repos/x${n}`)]
const NOT_REPOS = ["/work/plain", HOME, `${HOME}/.ssh`, "/tmp/kit-fix-v-1", "/private/tmp/ui4-login--2"]

/** The app with the owner's shape of data: a few repos with a different recency, scratch folders, the home and a hidden one. */
function chatApp({ profile = {}, bots = true, empty = false, extraSessions = [], child, height = 60 }: { profile?: Partial<TuiProfile>; bots?: boolean; empty?: boolean; extraSessions?: SessionSummary[]; /** A sub-agent of the opened session, in this state. */ child?: string; height?: number } = {}) {
  const current = ids("session")
  const created = ids("session")
  const make =(directory: string, title: string, age: number, state = "idle"): SessionSummary => ({ sessionId: ids("session"), title, directory, createdAt: NOW, updatedAt: NOW - age, lastSeq: 0, state, queued: 0 }) as SessionSummary
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - MINUTE, lastSeq: 0, state: "idle", queued: 0 } as SessionSummary,
    make("/work/app", "Client reconnect", 10 * MINUTE),
    make("/other/api", "Waiting review", 5 * DAY, "waiting_approval"),
    make("/work/site", "Marketing", 2 * MINUTE),
    ...[1, 2, 3, 4].map((n) => make(`/repos/r${n}`, `repo ${n} chat`, n * 60 * MINUTE)),
    // Older than a day: a plain folder only counts as a project for the day after its last use.
    ...NOT_REPOS.map((directory, index) => make(directory, `scratch ${index}`, (index + 2) * DAY)),
    ...extraSessions,
    ...(child ? [{ sessionId: ids("session"), title: "Sub agent", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: child, queued: 0, parentId: current } as SessionSummary] : []),
  ]
  const report = { bots: [{ name: "calm", description: "", identity: { shape: "circle", color: "success", origin: "mendcode" }, model: "gpt-6-luna", permission: "smart", file: "/d/agents/calm.md", state: "idle", projects: [] }], external: [], problems: [] }
  const inspected: string[] = []
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
  const h = appHarness({
    width: 120, height, mode: "balanced", sessionId: current, dataDir, directory: "/work/app",
    inspectProject: async (directory: string) => { inspected.push(directory); return { git: REPOS.includes(directory) } },
    reply: (command: CommandInput) => {
      if (command.type === "session.list") return reply({ sessions })
      if (command.type === "bot.list") return reply(report)
      if (command.type === "session.create") return reply({ sessionId: created })
      if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
      if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
      return undefined
    },
  })
  h.app.applySettings(bots ? { experimental: { bots: true } } : {})
  if (!empty) conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, inspected, sessions, current, created, dataDir }
}
type App = ReturnType<typeof chatApp>
const side = (h: App) => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH))
const sidebarText = (h: App) => side(h).join("\n")
async function until(h: App, needle: string) {
  for (let turn = 0; turn < 100; turn++) {
    h.app.render()
    if (sidebarText(h).includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${sidebarText(h)}`)
}
/** The row the keyboard is on: marked `›`, or `▌` while it is the open session; its text without the border. */
const picked = (h: App) => (side(h).find((row) => /^ › /.test(row)) ?? side(h).find((row) => /^ ▌ /.test(row)))?.replace(/│$/, "").replace(/\s+/g, " ").trim()
/** Moves the list's selection with the arrows (down first, then up) until the picked row matches. */
async function goTo(h: App, match: RegExp) {
  for (let turn = 0; turn < 80 && !match.test(picked(h) ?? ""); turn++) await h.type("\x1b[B")
  for (let turn = 0; turn < 80 && !match.test(picked(h) ?? ""); turn++) await h.type("\x1b[A")
  expect(picked(h) ?? "").toMatch(match)
}
const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const LEFT = "\x1b[D"
const RIGHT = "\x1b[C"
const UP = "\x1b[A"
const DOWN = "\x1b[B"

describe("which projects the sidebar lists", () => {
  test("git work trees and the opened folder; not the home, hidden, temp or plain folders", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    const text = sidebarText(h)
    for (const name of ["app", "api", "site", "r1", "r4"]) expect(text).toContain(`▾ ${name}`)
    for (const hidden of ["scratch", "plain", ".ssh", "kit-fix", "ui4-login"]) expect(text).not.toContain(hidden)
  })

  test("a plain folder used in the last day is listed too, and never the home, hidden or temp ones", async () => {
    const used = { sessionId: ids("session"), title: "Plain today", directory: "/work/plain", createdAt: NOW, updatedAt: NOW - 30 * MINUTE, lastSeq: 9, state: "idle", queued: 0 } as SessionSummary
    const h = chatApp({ profile: { sidebarProjectCount: 2 }, extraSessions: [used] })
    await until(h, "▾ plain")
    expect(sidebarText(h)).toContain("Plain today")
    for (const hidden of [".ssh", "kit-fix", "ui4-login"]) expect(sidebarText(h)).not.toContain(hidden)
  })

  test("the opened folder is a project even without git", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    h.app.render()
    expect(sidebarText(h)).not.toBe("")
  })

  test("the disk is asked once per folder however many frames draw", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    for (let frame = 0; frame < 40; frame++) h.app.render()
    await Bun.sleep(10)
    for (let frame = 0; frame < 40; frame++) h.app.render()
    expect(new Set(h.inspected).size).toBe(h.inspected.length)
    expect(h.inspected.some((directory) => directory === HOME || directory.startsWith("/tmp") || directory.includes("/."))).toBe(false)
  })
})

describe("ranking, the cap and the more-projects row", () => {
  test("by latest activity, the opened and working ones always in; the most recent fill up to the setting; the rest behind one row", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 3 } })
    await until(h, "more projects")
    const groups = side(h).filter((row) => /[▾▸] /.test(row)).map((row) => row.replace(/\s+/g, " ").trim())
    expect(groups.map((row) => row.slice(2).split(" ")[0])).toEqual(["app", "site", "api"])
    expect(sidebarText(h)).toMatch(/\+ 4 more projects/)
    expect(sidebarText(h)).not.toContain("▾ r1")
  })

  test("Enter on the more row opens the rest of a short list and show fewer folds it", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 3 } })
    await until(h, "more projects")
    await h.type(LEFT)
    await goTo(h, /\+ 4 more projects/)
    await h.type("\r")
    expect(sidebarText(h)).toContain("▾ r1")
    expect(sidebarText(h)).toContain("▾ r4")
    expect(picked(h)).toMatch(/^› [▾▸] r1/)
    await goTo(h, /show fewer/)
    await h.type("\r")
    expect(sidebarText(h)).not.toContain("▾ r1")
    expect(picked(h)).toContain("+ 4 more projects")
    expect(h.app.sessionId).toBe(h.current)
  })

  test("Enter on the more row reveals one page, keeps the row for the rest and puts the cursor on the first new project", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ sessionId: ids("session"), title: `extra ${n}`, directory: `/repos/x${n}`, createdAt: NOW, updatedAt: NOW - (n + 5) * 60 * MINUTE, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary)
    const h = chatApp({ profile: { sidebarProjectCount: 3 }, extraSessions: many, height: 120 })
    await until(h, "more projects")
    const groups = () => side(h).flatMap((row) => /[▾▸] (\S+)/.exec(row)?.[1] ?? [])
    const before = groups()
    expect(sidebarText(h)).toMatch(/\+ 16 more projects/)
    await h.type(LEFT)
    await goTo(h, /\+ 16 more projects/)
    await h.type("\r")
    const after = groups()
    expect(after.length).toBe(before.length + 8)
    expect(sidebarText(h)).toMatch(/\+ 8 more projects/)
    // Revealed projects take their place in the activity ranking: the cursor goes to the first one that was not listed before.
    const firstNew = after.find((name) => !before.includes(name))
    expect(picked(h)).toMatch(new RegExp(`^› [▾▸] ${firstNew}`))
    await goTo(h, /\+ 8 more projects/)
    await h.type("\r")
    expect(groups().length).toBe(before.length + 16)
    expect(picked(h)).toMatch(new RegExp(`^› [▾▸] ${groups().find((name) => !after.includes(name))}`))
    expect(sidebarText(h)).toContain("show fewer")
    await goTo(h, /show fewer/)
    await h.type("\r")
    expect(groups()).toEqual(before)
    expect(picked(h)).toContain("+ 16 more projects")
  })

  test("the cap is a setting; the default fills the height", () => {
    expect(DEFAULT_TUI_PROFILE.sidebarProjectCount).toBe(0)
  })

  test("switching to a chat of another project moves no group", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    const order = () => side(h).filter((row) => /[▾▸] /.test(row)).map((row) => row.replace(/\s+/g, " ").trim().slice(2).split(" ")[0])
    const before = order()
    await h.type(LEFT)
    await goTo(h, /repo 4 chat/)
    await h.type("\r")
    expect(h.app.sessionId).not.toBe(h.current)
    h.app.render()
    expect(order()).toEqual(before)
  })

  test("with the default count a tall sidebar lists more projects than the old six", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ sessionId: ids("session"), title: `extra ${n}`, directory: `/repos/x${n}`, createdAt: NOW, updatedAt: NOW - (n + 5) * 60 * MINUTE, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary)
    const h = chatApp({ extraSessions: many, height: 80 })
    await until(h, "▾ app")
    expect(side(h).filter((row) => /[▾▸] /.test(row)).length).toBeGreaterThan(6)
  })

  test("the arrow keys stop on every project the sidebar draws, past the first six", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ sessionId: ids("session"), title: `extra ${n}`, directory: `/repos/x${n}`, createdAt: NOW, updatedAt: NOW - (n + 5) * 60 * MINUTE, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary)
    const h = chatApp({ extraSessions: many, height: 80 })
    await until(h, "▾ app")
    const groups = side(h).filter((row) => /[▾▸] /.test(row)).map((row) => row.replace(/│$/, "").replace(/\s+/g, " ").trim())
    expect(groups.length).toBeGreaterThan(6)
    await h.type(LEFT)
    const reached = new Set<string>()
    for (let turn = 0; turn < 200 && reached.size < groups.length; turn++) {
      await h.type("\x1b[B")
      const row = picked(h)
      if (row && /[▾▸] /.test(row)) reached.add(row.replace(/^[›▌] /, ""))
    }
    for (const group of groups) expect([...reached].some((row) => row.startsWith(group.replace(/\s+\d+( active)?$/, "")))).toBe(true)
  })
})

describe("every group opens by default and can be folded", () => {
  test("the sessions of the shown projects are listed at once; Space on a group folds it and unfolds it", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    for (const title of ["Chrome", "Waiting review", "Marketing", "repo 1 chat"]) expect(sidebarText(h)).toContain(title)
    await h.type(LEFT)
    await goTo(h, /^› ▾ api/)
    await h.type(" ")
    expect(sidebarText(h)).toContain("▸ api")
    expect(sidebarText(h)).not.toContain("Waiting review")
    expect(picked(h)).toMatch(/^› ▸ api/)
    await h.type(" ")
    expect(sidebarText(h)).toContain("Waiting review")
    expect(h.sentOf("session.create")).toHaveLength(0)
  })
})

describe("folding a project past the first six with the default count", () => {
  test("Space folds a project only the tall sidebar draws", async () => {
    // Older than a day, so none is forced past the height's cut the way today's projects are.
    const many = Array.from({ length: 12 }, (_, n) => ({ sessionId: ids("session"), title: `extra ${n}`, directory: `/repos/x${n}`, createdAt: NOW, updatedAt: NOW - (n + 6) * DAY, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary)
    const h = chatApp({ extraSessions: many, height: 80 })
    await until(h, "▾ app")
    const groups = side(h).filter((row) => /▾ /.test(row)).map((row) => row.replace(/│$/, "").replace(/\s+/g, " ").trim())
    expect(groups.length).toBeGreaterThan(6)
    const last = groups.at(-1)!.replace(/^[›▌] /, "").replace(/\s+\d+( active)?$/, "")
    const title = last.replace(/^▾ /, "")
    await h.type(LEFT)
    await goTo(h, new RegExp(`^› ▾ ${title}`))
    await h.type(" ")
    expect(sidebarText(h)).toContain(`▸ ${title}`)
  })
})

describe("Enter on a project starts a chat in it; Space, the arrows and the glyph fold it", () => {
  const onApi = async (h: App) => {
    await until(h, "▾ api")
    await h.type(LEFT)
    await goTo(h, /^› ▾ api/)
  }

  test("Enter reuses a blank chat in that folder and opens it; the folder is the terminal's now", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await onApi(h)
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", reuseEmpty: true, title: "" })
    expect(h.app.sessionId).toBe(h.created)
    expect(h.app.page).toBe("chat")
    expect(sidebarText(h)).not.toContain("→ prompt")
  })

  test("Enter on a folded project opens it too, so the new chat shows in it", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await onApi(h)
    await h.type(" ")
    expect(sidebarText(h)).toContain("▸ api")
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api" })
    h.app.render()
    expect(sidebarText(h)).toContain("▾ api")
  })

  test("left folds an open project, right opens a folded one, and right on an open one returns to the prompt", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await onApi(h)
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("▸ api")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("▸ api")
    await h.type(RIGHT)
    expect(sidebarText(h)).toContain("▾ api")
    expect(sidebarText(h)).toContain("Waiting review")
    expect(picked(h)).toMatch(/^› ▾ api/)
    await h.type(RIGHT)
    expect(sidebarText(h)).not.toContain("→ prompt")
    expect(h.sentOf("session.create")).toHaveLength(0)
  })

  test("a click on the arrow glyph folds the project and a click on its name starts the chat", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    const row = side(h).findIndex((line) => line.includes("▾ api"))
    const glyph = side(h)[row]!.indexOf("▾")
    await h.type(click(glyph, row))
    h.app.render()
    expect(sidebarText(h)).toContain("▸ api")
    expect(h.sentOf("session.create")).toHaveLength(0)
    await h.type(click(glyph + 3, row))
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", reuseEmpty: true })
    expect(h.app.sessionId).toBe(h.created)
  })

  test("the header hint names the keys on a project row", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await onApi(h)
    expect(side(h)[0]).toContain("↵ new")
    expect(side(h)[0]).toContain("spc fold")
    expect(side(h)[0]).toContain("x hide")
  })
})

describe("the keyboard drives the whole list", () => {
  test("left focuses the list, up and down visit every kind of row, right and Esc return to the prompt", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 3, sidebarPreviewCount: 1 } })
    await until(h, "more projects")
    expect(sidebarText(h)).not.toContain("→ prompt")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("→ prompt")
    const seen: string[] = []
    await h.type(UP)
    for (let turn = 0; turn < 60; turn++) {
      const row = picked(h)
      if (row && !seen.includes(row)) seen.push(row)
      await h.type(DOWN)
    }
    expect(seen.some((row) => /^› [▾▸] app/.test(row))).toBe(true)
    expect(seen.some((row) => row.includes("Chrome"))).toBe(true)
    expect(seen.some((row) => /\+ \d+ more$/.test(row))).toBe(true)
    expect(seen.some((row) => row.includes("calm"))).toBe(true)
    expect(seen.some((row) => row.includes("more projects"))).toBe(true)
    // Up walks back.
    await h.type(UP)
    expect(picked(h)).not.toBe(seen.at(-1))
    await h.type(RIGHT)
    expect(sidebarText(h)).not.toContain("→ prompt")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("→ prompt")
    await h.type("\x1b")
    expect(sidebarText(h)).not.toContain("→ prompt")
  })

  test("the application-mode arrows work the same", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    await h.type("\x1b[D")
    await h.type("\x1bOB")
    expect(picked(h)).toContain("Client reconnect")
    await h.type("\x1bOA")
    expect(picked(h)).toContain("Chrome")
  })

  test("Enter on a session opens it, on a more row expands its project, on a bot starts a chat and o opens its card", async () => {
    const extra = [1, 2, 3].map((n) => ({ sessionId: ids("session"), title: `Site extra ${n}`, directory: "/work/site", createdAt: NOW, updatedAt: NOW - (3 + n) * MINUTE, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary)
    const h = chatApp({ profile: { sidebarProjectCount: 30, sidebarPreviewCount: 5 }, extraSessions: extra })
    await until(h, "▾ site")
    expect(sidebarText(h)).toMatch(/\+ 1 more/)
    await h.type(LEFT)
    await goTo(h, /\+ 1 more$/)
    await h.type("\r")
    expect(sidebarText(h)).toContain("Site extra 3")
    await goTo(h, /Site extra 3/)
    await h.type("\r")
    expect(h.app.sessionId).not.toBe(h.current)
    await h.type(LEFT)
    await goTo(h, /calm/)
    await h.type("o")
    expect(h.app.page).toBe("bot")
  })

  test("a mouse click still works beside the keyboard", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    const row = side(h).findIndex((line) => line.includes("Waiting review"))
    await h.type(click(8, row))
    expect(h.app.sessionId).not.toBe(h.current)
  })

  test("on a fresh session the home list does not take the arrows once the list has focus", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 }, empty: true })
    await until(h, "▾ api")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("→ prompt")
    await h.type(DOWN)
    expect(picked(h)).toContain("Client reconnect")
    await h.type(DOWN)
    expect(picked(h)).not.toContain("Client reconnect")
  })
})

describe("left and the sub-agents' arrows", () => {
  test("with no working sub-agent, left focuses the list", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ api")
    const asked = h.sentOf("session.get").length
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("→ prompt")
    expect(h.sentOf("session.get")).toHaveLength(asked)
  })

  test("with a working sub-agent, left and right stay the sub-agent keys and Alt+left focuses the list", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 }, child: "generating" })
    await until(h, "▾ api")
    const asked = h.sentOf("session.get").length
    await h.type(LEFT)
    expect(sidebarText(h)).not.toContain("→ prompt")
    expect(h.sentOf("session.get").length).toBeGreaterThan(asked)
    await h.type("\x1b[1;3D")
    expect(sidebarText(h)).toContain("→ prompt")
  })

  test("a finished sub-agent does not take the key", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 }, child: "idle" })
    await until(h, "▾ api")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("→ prompt")
  })
})

describe("sections are jumpable from the keyboard", () => {
  const focused = async (profile: Partial<TuiProfile> = { sidebarProjectCount: 3, sidebarPreviewCount: 1 }) => {
    const h = chatApp({ profile })
    await until(h, "more projects")
    await h.type(LEFT)
    return h
  }

  test("Tab jumps to the next section's first row and Shift+Tab to the previous one, wrapping at the ends", async () => {
    const h = await focused()
    await h.type("\t")
    expect(picked(h)).toMatch(/calm/)
    await h.type("\t")
    expect(picked(h)).toMatch(/^› [▾▸] app/)
    await h.type("\x1b[Z")
    expect(picked(h)).toMatch(/calm/)
    await h.type("\x1b[Z")
    expect(picked(h)).toMatch(/^› [▾▸] app/)
  })

  test("up on the first row wraps to the last row and down on the last wraps to the first", async () => {
    const h = await focused()
    await h.type("\t\t")
    expect(picked(h)).toMatch(/^› [▾▸] app/)
    await h.type(UP)
    expect(picked(h)).toMatch(/calm/)
    await h.type(DOWN)
    expect(picked(h)).toMatch(/^› [▾▸] app/)
  })

  test("b jumps to the first bot", async () => {
    const h = await focused()
    await h.type("b")
    expect(picked(h)).toMatch(/calm/)
    await h.type(DOWN)
    await h.type("b")
    expect(picked(h)).toMatch(/calm/)
  })

  test("the header says Tab changes section while the list has focus, and Tab does nothing to the list otherwise", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 3, sidebarPreviewCount: 1 } })
    await until(h, "more projects")
    expect(sidebarText(h)).not.toContain("tab section")
    await h.type("\t")
    expect(sidebarText(h)).not.toContain("→ prompt")
    await h.type(LEFT)
    expect(sidebarText(h)).toContain("tab section")
    expect(sidebarText(h)).toContain("→ prompt")
  })
})

describe("the projects you typed in, and hiding one by hand", () => {
  const tool = (directory: string, title: string, age: number): SessionSummary => ({ sessionId: ids("session"), title, directory, createdAt: NOW, updatedAt: NOW - age, lastSeq: 0, state: "idle", queued: 0, origin: "agent" }) as SessionSummary
  const toolOnly = [tool("/repos/x0", "bridge chat", 3 * MINUTE)]

  test("by default a project only tools worked in waits behind the more row, and all lists it", async () => {
    const you = chatApp({ profile: { sidebarProjectCount: 30 }, extraSessions: toolOnly })
    await until(you, "▾ app")
    expect(sidebarText(you)).not.toContain("bridge chat")
    expect(sidebarText(you)).toMatch(/\+ 1 more projects/)
    const all = chatApp({ profile: { sidebarProjectCount: 30, sidebarProjectsFrom: "all" }, extraSessions: toolOnly })
    await until(all, "bridge chat")
    expect(sidebarText(all)).not.toContain("more projects")
  })

  test("x on a project row hides it with a one-line notice, and it stays out of the more row too", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ site")
    await h.type(LEFT)
    await goTo(h, /^› [▾▸] site/)
    expect(sidebarText(h)).toContain("x hide")
    await h.type("x")
    h.app.render()
    expect(sidebarText(h)).not.toContain("▾ site")
    expect(h.text().join("\n")).toContain("hid site · /customize to bring it back")
    expect(readTuiProfile(h.dataDir).sidebarHiddenProjects).toEqual(["/work/site"])
  })

  test("the opened project cannot be hidden", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30 } })
    await until(h, "▾ app")
    await h.type(LEFT)
    await goTo(h, /^› [▾▸] app/)
    await h.type("x")
    h.app.render()
    expect(sidebarText(h)).toContain("▾ app")
    expect(readTuiProfile(h.dataDir).sidebarHiddenProjects).toEqual([])
  })

  test("a project hidden in the profile never lists", async () => {
    const h = chatApp({ profile: { sidebarProjectCount: 30, sidebarHiddenProjects: ["/work/site"] } })
    await until(h, "▾ app")
    expect(sidebarText(h)).not.toContain("site")
  })
})
