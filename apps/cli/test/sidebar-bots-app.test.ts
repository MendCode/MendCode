import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { ICON_SIDEBAR_WIDTH, SIDEBAR_GAP, SIDEBAR_WIDTH } from "../src/view/sidebar"
import { CLICK_GUARD_MS } from "../src/view/sidebar-window"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000

/** The app with a bots list and sessions in three folders; `bots: false` is a terminal that never turned the flag on. */
function chatApp({ bots = true, profile = {}, width = 120, height = 24, extra, clock = { at: NOW }, more = [], inspect, waitingChild, home = false }: { /** An empty conversation: the home screen with its own Bots block. */ home?: boolean; /** A sub-agent of the open session that waits on you with this kind of request. */ waitingChild?: "approval" | "question" | "plan"; bots?: boolean; profile?: Partial<TuiProfile>; width?: number; height?: number; extra?: (command: CommandInput) => CommandReply | undefined; clock?: { at: number }; /** Sessions of other folders the daemon lists besides the four. */ more?: SessionSummary[]; inspect?: (directory: string) => Promise<{ git: boolean }> } = {}) {
  const current = ids("session")
  const second = ids("session")
  const elsewhere = ids("session")
  const docs = ids("session")
  const created = ids("session")
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - MINUTE, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: second, title: "Client reconnect", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 10 * MINUTE, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: elsewhere, title: "Other project", directory: "/other/api", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "waiting_approval", queued: 0 },
    { sessionId: docs, title: "Docs pass", directory: "/other/api", createdAt: NOW, updatedAt: NOW - 120 * MINUTE, lastSeq: 0, state: "idle", queued: 0 },
    ...more,
    ...(waitingChild ? [{ sessionId: ids("session"), title: "Sub task", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "waiting_approval", pendingKind: waitingChild, queued: 0, parentId: current } as SessionSummary] : []),
  ]
  const report = {
    bots: [
      { name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, model: "gpt-6-luna", permission: "smart", file: "/d/agents/calm.md", state: "working", projects: [
        { directory: "/work/app", state: "working", sessions: [{ sessionId: current, title: "Chrome", status: "running", updatedAt: NOW }] },
        { directory: "/other/api", state: "idle", sessions: [{ sessionId: docs, title: "Docs pass", status: "idle", updatedAt: NOW }] },
      ] },
      { name: "scout", description: "Finds things", identity: { origin: "mendcode" }, file: "/d/agents/scout.md", state: "idle", projects: [] },
    ],
    external: [],
    problems: [],
  }
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
  const h = appHarness({ width, height, mode: "balanced", inspectProject: inspect ?? (async () => ({ git: true })), now: () => clock.at, sessionId: current, dataDir, directory: "/work/app", reply: (command) => {
    const extraReply = extra?.(command)
    if (extraReply) return extraReply
    if (command.type === "session.list") return reply({ sessions: (command as { directory?: string }).directory ? sessions.filter((session) => session.directory === (command as { directory?: string }).directory) : sessions })
    if (command.type === "bot.list") return reply(report)
    if (command.type === "session.create") return reply({ sessionId: created })
    if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
    if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
    return undefined
  } })
  h.app.applySettings(bots ? { experimental: { bots: true } } : {})
  // A started conversation: with an empty one the arrow keys belong to the home screen's list.
  if (!home) conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, clock, ids: { current, second, elsewhere, docs, created } }
}
type App = ReturnType<typeof chatApp>
const side = (h: App, cells = SIDEBAR_WIDTH) => h.text().map((row) => row.slice(0, cells))
const sidebarText = (h: App) => side(h).join("\n")
/** Frames until the lazily loaded sidebar has drawn `needle` (the first frame still draws today's list). */
async function until(h: App, needle: string, over = sidebarText) {
  for (let turn = 0; turn < 80; turn++) {
    h.app.render()
    if (over(h).includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${over(h)}`)
}
const rowOf = (h: App, needle: string) => side(h).findIndex((row) => row.includes(needle))
const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
/** The list has stood still for longer than the click guard, as it has by the time a hand reaches a row. */
function steady(h: App) {
  h.clock.at += CLICK_GUARD_MS + 50
  h.app.render()
}

describe("flag off and default settings: today's sidebar, nothing new asked", () => {
  test("the sidebar is the one it was, and no bot or all-project request goes out", async () => {
    const h = chatApp({ bots: false, height: 16 })
    await Bun.sleep(20)
    h.app.render()
    expect(side(h)).toEqual([
      "   Sessions                  ← focus │",
      "                                     │",
      "   Today                             │",
      " ▌ · Chrome                       1m │",
      "   · Client reconnect            10m │",
      ...Array.from({ length: 11 }, () => "                                     │"),
    ])
    expect(h.sentOf("bot.list")).toHaveLength(0)
    expect(h.sentOf("session.list").every((command) => (command as { directory?: string }).directory === "/work/app")).toBe(true)
  })

  test("with the flag off a stale bots profile (layout, sections) changes nothing", async () => {
    const h = chatApp({ bots: false, height: 16, profile: { sidebarLayout: "scratch", sidebarSections: "bots" } })
    await Bun.sleep(20)
    h.app.render()
    expect(sidebarText(h)).toContain("Client reconnect")
    expect(h.sentOf("bot.list")).toHaveLength(0)
  })
})

describe("flag on: the bots section and the bot's icon in its project", () => {
  test("a row per bot with its state; the bot's chat lives under the bot, not in the project", async () => {
    const h = chatApp()
    await until(h, "Bots")
    expect(side(h)[rowOf(h, "calm")]).toMatch(/^ {3}● calm +mendcode +● working \+ │$/)
    expect(side(h)[rowOf(h, "scout")]).toMatch(/scout +mendcode +◌ idle \+ │$/)
    // Bots first by default; Chrome (the bot's, and the open one) sits under calm's chats row, after the Bots heading.
    expect(rowOf(h, "Bots")).toBeLessThan(rowOf(h, "Projects"))
    expect(rowOf(h, "Chrome")).toBeGreaterThan(rowOf(h, "calm"))
    expect(rowOf(h, "Chrome")).toBeLessThan(rowOf(h, "Projects"))
    expect(side(h)[rowOf(h, "▾ app")]).toMatch(/▾ app +1 \+ │$/)
    expect(h.sentOf("bot.list")).toHaveLength(1)
  })
})

describe("the first frames ask for the bots once, with the session lists", () => {
  test("the left list asks for the bots and the other folders in the same frame, and the home's Bots block waits for that answer instead of asking again", async () => {
    const h = chatApp({ home: true })
    for (let turn = 0; turn < 20; turn++) { h.app.render(); await Bun.sleep(5) }
    expect(h.sentOf("bot.list")).toHaveLength(1)
    expect(h.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
  })
})

describe("the lists follow pushes without asking", () => {
  const MINUTE_MS = 60_000
  /** The app on a fake clock after its first answers; the requests it made so far are the baseline. */
  async function live() {
    const clock = { at: NOW }
    const h = chatApp({ clock, height: 60 })
    await until(h, "Bots")
    await Bun.sleep(10)
    let gseq = 0
    const push = (sessionId: string, over: Record<string, unknown> = {}) => h.app.onGlobal({ type: "session.activity", gseq: ++gseq, at: clock.at, sessionId, directory: "/work/app", title: "Elsewhere", state: "idle", updatedAt: clock.at, ...over } as never)
    const count = () => ({ lists: h.sentOf("session.list").length, bots: h.sentOf("bot.list").length })
    const frame = async () => { h.app.render(); await Bun.sleep(5) }
    return { h, clock, push, count, frame, base: count() }
  }

  test("a burst of 50 pushes asks for no session list, and the list shows them", async () => {
    const { h, push, count, frame, base } = await live()
    for (let n = 0; n < 50; n++) push(`ses_other${String(n).padStart(2, "0")}`, { directory: "/far/away", title: `Far ${n}`, state: n % 2 ? "generating" : "idle" })
    await frame()
    expect(count().lists).toBe(base.lists)
    expect(sidebarText(h)).toContain("▾ away")
    expect(sidebarText(h)).toMatch(/Far \d+/)
  })

  test("a session no list holds may be a bot's new chat: one bot list per window, however many", async () => {
    const { clock, push, count, frame, base } = await live()
    for (let n = 0; n < 10; n++) push(`ses_new${String(n).padStart(2, "0")}`)
    await frame()
    // Inside the one-second window nothing goes out yet; once it passes there is one request for all ten.
    expect(count().bots).toBe(base.bots)
    clock.at += 1000
    await frame()
    await frame()
    expect(count().bots).toBe(base.bots + 1)
    // The ten are classified: pushing them again asks for nothing.
    for (let n = 0; n < 10; n++) push(`ses_new${String(n).padStart(2, "0")}`, { title: "again" })
    clock.at += 5000
    await frame()
    expect(count().bots).toBe(base.bots + 1)
    expect(count().lists).toBe(base.lists)
  })

  test("a push for a session of a listed bot moves the bot's state with no request", async () => {
    const { h, push, count, frame, base } = await live()
    push(h.ids.current, { state: "idle", title: "Chrome" })
    await frame()
    expect(side(h)[rowOf(h, "calm")]).toMatch(/◌ idle \+ │$/)
    push(h.ids.current, { state: "waiting_approval", title: "Chrome" })
    await frame()
    expect(side(h)[rowOf(h, "calm")]).toMatch(/… waiting \+ │$/)
    expect(count()).toEqual(base)
  })

  test("hidden, the sidebar does nothing but note it; shown again it asks once for both lists", async () => {
    const { h, clock, push, count, frame, base } = await live()
    h.size.width = 60
    await frame()
    for (let n = 0; n < 20; n++) push(`ses_hidden${String(n).padStart(2, "0")}`, { directory: "/far/away" })
    clock.at += 5 * MINUTE_MS
    await frame()
    expect(count()).toEqual(base)
    h.size.width = 120
    await frame()
    await frame()
    expect(count()).toEqual({ lists: base.lists + 1, bots: base.bots + 1 })
    await frame()
    expect(count()).toEqual({ lists: base.lists + 1, bots: base.bots + 1 })
  })

  test("the slow safety refresh runs only while the sidebar shows, at 60 s", async () => {
    const { h, clock, count, frame, base } = await live()
    clock.at += 59_000
    await frame()
    expect(count()).toEqual(base)
    clock.at += 1000
    await frame()
    await frame()
    expect(count()).toEqual({ lists: base.lists + 1, bots: base.bots + 1 })
    // Hidden for ten minutes: nothing, even when frames draw.
    h.size.width = 60
    clock.at += 10 * MINUTE_MS
    await frame()
    await frame()
    expect(count()).toEqual({ lists: base.lists + 1, bots: base.bots + 1 })
  })

  test("a reconnect asks for both lists whole", async () => {
    const { h, count, frame, base } = await live()
    h.app.onConnection("reconnecting")
    h.app.onConnection("connected")
    await frame()
    await frame()
    expect(count()).toEqual({ lists: base.lists + 1, bots: base.bots + 1 })
  })

  test("a push that comes while a bot list is on its way still lands: the older answer does not bring back the state it replaced", async () => {
    const clock = { at: NOW }
    let hold = false
    let release: (() => void) | undefined
    let current = ""
    const working = () => ({ bots: [{ name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, file: "/d/agents/calm.md", state: "working", projects: [{ directory: "/work/app", state: "working", sessions: [{ sessionId: current, title: "Chrome", status: "running", updatedAt: NOW }] }] }], external: [], problems: [] })
    const h = chatApp({ clock, height: 60, extra: (command) => command.type === "bot.list" && hold ? new Promise<CommandReply>((resolve) => { release = () => resolve(reply(working())) }) : undefined })
    current = h.ids.current
    await until(h, "Bots")
    await Bun.sleep(10)
    let gseq = 0
    const push = (sessionId: string, over: Record<string, unknown> = {}) => h.app.onGlobal({ type: "session.activity", gseq: ++gseq, at: clock.at, sessionId, directory: "/work/app", title: "Chrome", state: "idle", updatedAt: clock.at, ...over } as never)
    const frame = async () => { h.app.render(); await Bun.sleep(5) }
    // A session no list holds asks for the bot list; the answer is held back, and the bot's chat finishes meanwhile.
    hold = true
    push("ses_01M7C3T9P0JHRKM9")
    clock.at += 3000
    await frame()
    await frame()
    expect(release).toBeDefined()
    push(h.ids.current, { state: "idle" })
    release!()
    await Bun.sleep(10)
    await frame()
    expect(side(h)[rowOf(h, "calm")]).toMatch(/◌ idle \+ │$/)
  })
})

describe("a chat deleted while the bot list is on its way", () => {
  test("the answer may still hold it: the list is asked again after it, so the deleted chat does not stay listed", async () => {
    const clock = { at: NOW }
    let hold = false
    let release: (() => void) | undefined
    const h = chatApp({ clock, height: 60, extra: (command) => command.type === "bot.list" && hold ? new Promise<CommandReply>((resolve) => { release = () => resolve(reply({ bots: [], external: [], problems: [] })) }) : undefined })
    await until(h, "Bots")
    await Bun.sleep(10)
    const frame = async () => { h.app.render(); await Bun.sleep(5) }
    hold = true
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: clock.at, sessionId: "ses_01M7C3T9P0JHRKM9", directory: "/work/app", title: "New", state: "idle", updatedAt: clock.at } as never)
    clock.at += 3000
    await frame()
    await frame()
    expect(release).toBeDefined()
    const asked = h.sentOf("bot.list").length
    h.app.onGlobal({ type: "session.removed", gseq: 2, at: clock.at, sessionId: h.ids.docs } as never)
    hold = false
    release!()
    await Bun.sleep(10)
    clock.at += 3000
    await frame()
    await frame()
    await Bun.sleep(30)
    await frame()
    expect(h.sentOf("bot.list").length).toBeGreaterThan(asked)
  })
})

describe("a folder used today stays after the opened folder moves on", () => {
  test("the new folder and its chat are still listed after the switch and after the refresh that follows it", async () => {
    const clock = { at: NOW }
    const x: SessionSummary = { sessionId: ids("session"), title: "Notes in X", directory: "/new/x", createdAt: NOW, updatedAt: NOW - 20 * MINUTE, lastSeq: 9, state: "idle", queued: 0 }
    // X is no git root; every other folder is. Six more recent folders fill the project cap.
    const crowd = ["a", "b", "c", "d", "e", "f"].map((name, index): SessionSummary => ({ sessionId: ids("session"), title: `${name} chat`, directory: `/p/${name}`, createdAt: NOW, updatedAt: NOW - (index + 1) * MINUTE, lastSeq: 9, state: "idle", queued: 0 }))
    const h = chatApp({ clock, height: 60, more: [x, ...crowd], inspect: async (directory) => ({ git: directory !== "/new/x" }) })
    await until(h, "Bots")
    await Bun.sleep(20)
    h.app.render()
    // The owner's step: switch from the sidebar to a session in another folder, then wait past the refresh interval.
    await h.type("\x1b[D")
    for (let turn = 0; turn < 40 && h.app.sessionId !== h.ids.docs; turn++) {
      h.app.render()
      if (h.text().some((row) => /^ › .*Docs pass/.test(row.slice(0, SIDEBAR_WIDTH)))) { await h.type("\r"); break }
      await h.type("\x1b[B")
    }
    expect(h.app.sessionId).toBe(h.ids.docs)
    for (const wait of [1000, 40_000, 70_000]) {
      clock.at += wait
      for (let turn = 0; turn < 4; turn++) { h.app.render(); await Bun.sleep(5) }
      expect(sidebarText(h)).toContain("▾ x")
      expect(sidebarText(h)).toContain("Notes in X")
    }
    expect(h.sentOf("session.list").length).toBeGreaterThan(1)
  })
})

describe("all projects", () => {
  test("auto (the default) lists every project with bots on, and an explicit folder keeps the opened one only", async () => {
    const auto = chatApp()
    await until(auto, "▾ api")
    expect(auto.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
    const folder = chatApp({ profile: { sidebarProjects: "folder" } })
    await until(folder, "calm")
    expect(sidebarText(folder)).not.toContain("▾ api")
  })

  test("every folder is an open group; Space and a click on the arrow fold a group, and a folded one says how many of its sessions work or wait", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "▾ api")
    expect(sidebarText(h)).toContain("▾ app")
    expect(sidebarText(h)).toContain("Other project")
    expect(h.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
    const glyph = side(h)[rowOf(h, "▾ api")]!.indexOf("▾")
    await steady(h)
    await h.type(click(glyph, rowOf(h, "▾ api")))
    expect(sidebarText(h)).toContain("▸ api")
    expect(sidebarText(h)).not.toContain("Other project")
    expect(side(h)[rowOf(h, "▸ api")]).toMatch(/▸ api +1 active 2 \+ │$/)
    await h.type(click(glyph, rowOf(h, "▸ api")))
    expect(sidebarText(h)).toContain("Other project")
    // A click on the group's name folds it too, and starts no chat: only the `+` that ends the row does.
    await h.type(click(glyph + 3, rowOf(h, "▾ api")))
    expect(sidebarText(h)).toContain("▸ api")
    expect(h.sentOf("session.create")).toHaveLength(0)
    await h.type(click(glyph + 3, rowOf(h, "▸ api")))
    expect(sidebarText(h)).toContain("Other project")
    // The keyboard: focus the list on the open session, go to the api group, Space folds it and Enter opens it again.
    await h.type("\x1b[D")
    for (let turn = 0; turn < 12 && !/^ › /.test(side(h)[rowOf(h, "▾ api")]!); turn++) await h.type("\x1b[B")
    expect(side(h)[rowOf(h, "api")]).toMatch(/^ › /)
    await h.type(" ")
    expect(sidebarText(h)).toContain("▸ api")
    expect(sidebarText(h)).not.toContain("Other project")
    await h.type("\r")
    expect(sidebarText(h)).toContain("▾ api")
    expect(sidebarText(h)).toContain("Other project")
    expect(h.sentOf("session.create")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("a new chat in a project: `n` on its row, or a click on the `+` that ends it", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "▾ api")
    await steady(h)
    const row = side(h)[rowOf(h, "▾ api")]!
    expect(row).toMatch(/ \+ │$/)
    await h.type(click(row.lastIndexOf("+"), rowOf(h, "▾ api")))
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", title: "", reuseEmpty: true })
    expect(h.app.sessionId).toBe(h.ids.created)
    // `n` on one of the project's sessions starts the chat in that session's folder.
    await h.type("\x1b[D")
    for (let turn = 0; turn < 12 && !/^ › /.test(side(h)[rowOf(h, "Client reconnect")]!); turn++) await h.type("\x1b[B")
    await h.type("n")
    expect(h.sentOf("session.create")).toHaveLength(2)
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/app", reuseEmpty: true })
  })

  test("the preview: sidebarPreviewCount sessions and a more row that Enter and a click expand and collapse, in memory only", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all", sidebarPreviewCount: 1 }, bots: false })
    await until(h, "▾ api")
    expect(sidebarText(h)).toContain("Chrome")
    expect(sidebarText(h)).not.toContain("Client reconnect")
    // Groups rank by activity, not by which one is open: the open project's more row is the one under Chrome.
    const appMore = (needle: string) => side(h).findIndex((row, index) => index > rowOf(h, "Chrome") && row.includes(needle))
    expect(side(h)[appMore("more")]).toMatch(/\+ 1 more +│$/)
    // The keyboard: focus the list (on Chrome), one down is the more row.
    await h.type("\x1b[D")
    await h.type("\x1b[B")
    expect(side(h)[appMore("more")]).toMatch(/^ › /)
    await h.type("\r")
    expect(sidebarText(h)).toContain("Client reconnect")
    // The cursor lands on the first row that appeared.
    expect(side(h)[rowOf(h, "Client reconnect")]).toMatch(/^ › /)
    expect(h.app.sessionId).toBe(h.ids.current)
    // The mouse folds it back.
    await h.type(click(8, rowOf(h, "show less")))
    expect(sidebarText(h)).not.toContain("Client reconnect")
    await h.type(click(8, appMore("+ 1 more")))
    expect(sidebarText(h)).toContain("Client reconnect")
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("a click on a session of another folder opens it", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "Other project")
    await steady(h)
    await h.type(click(8, rowOf(h, "Other project")))
    expect(h.app.sessionId).toBe(h.ids.elsewhere)
  })

  test("a click on a line whose row changed a moment ago is dropped; once the list has stood still it goes through", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "Other project")
    await steady(h)
    const line = rowOf(h, "Docs pass")
    // A session appears in the project from another terminal: every row below slides down one line under the pointer.
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: h.clock.at, sessionId: "ses_01M7C3T9P0JHRKM9", directory: "/other/api", title: "Arrived", state: "idle", updatedAt: h.clock.at + MINUTE } as never)
    h.app.render()
    expect(rowOf(h, "Docs pass")).not.toBe(line)
    await h.type(click(8, line))
    expect(h.app.sessionId).toBe(h.ids.current)
    await steady(h)
    await h.type(click(8, rowOf(h, "Docs pass")))
    expect(h.app.sessionId).toBe(h.ids.docs)
  })
})

describe("a list that holds still under the hand", () => {
  const arrive = (h: App, title: string) => h.app.onGlobal({ type: "session.activity", gseq: Math.floor(h.clock.at), at: h.clock.at, sessionId: `ses_01M7C3T9P0JHRK${title.slice(0, 2).toUpperCase()}`, directory: "/other/api", title, state: "idle", createdAt: h.clock.at, updatedAt: h.clock.at } as never)
  const move = (col: number, row: number) => `\x1b[<35;${col + 1};${row + 1}M`

  test("while the list has the keyboard no row comes or goes; `r` lets it catch up", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false, height: 30 })
    await until(h, "Other project")
    await h.type("\x1b[D")
    // Each row keeps its line; what a row says stays live (the project's count already includes the newcomer).
    const places = () => side(h).slice(2).map((row) => row.replace(/^ [›▌] /, "   ").replace(/\d+ \+ │$/, "+ │"))
    const before = places()
    arrive(h, "MMnew one")
    h.clock.at += 500
    h.app.render()
    expect(sidebarText(h)).not.toContain("MMnew one")
    expect(places()).toEqual(before)
    expect(side(h)[rowOf(h, "▾ api")]).toMatch(/▾ api +3 \+ │$/)
    await h.type("r")
    expect(sidebarText(h)).toContain("MMnew one")
  })

  test("the pointer over the list holds it too, and it catches up by itself a moment after the pointer leaves", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false, height: 30 })
    await until(h, "Other project")
    await h.app.onKey(move(8, rowOf(h, "Docs pass")))
    h.app.render()
    arrive(h, "PPnew one")
    h.clock.at += 500
    h.app.render()
    expect(sidebarText(h)).not.toContain("PPnew one")
    // The row under the pointer is the one it was: the click opens it.
    steady(h)
    await h.type(click(8, rowOf(h, "Docs pass")))
    expect(h.app.sessionId).toBe(h.ids.docs)
    await h.app.onKey(move(80, 8))
    h.clock.at += 1000
    h.app.render()
    expect(sidebarText(h)).not.toContain("PPnew one")
    h.clock.at += 1500
    h.app.render()
    expect(sidebarText(h)).toContain("PPnew one")
  })

  test("a reply or a working session never moves a row: only what you send does", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false, height: 30 })
    await until(h, "Other project")
    const order = () => ["Chrome", "Client reconnect"].map((title) => rowOf(h, title))
    const first = order()
    expect(first[0]).toBeLessThan(first[1]!)
    // The older session works and answers: its activity is the newest of the project now.
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: h.clock.at, sessionId: h.ids.second, directory: "/work/app", title: "Client reconnect", state: "generating", updatedAt: h.clock.at + 5 * MINUTE } as never)
    h.clock.at += 5000
    h.app.render()
    expect(order()).toEqual(first)
  })
})

describe("what a bot of another app is doing there", () => {
  const ada = { origin: "hermes", id: "ada", name: "Ada", state: "working", chat: "acp:hermes-ada", app: "Hermes", identity: { origin: "hermes" }, activity: [{ id: "run-1", title: "Flash the board", source: "telegram", startedAt: NOW - 10 * MINUTE, activeAt: NOW - MINUTE }] }
  const bots = { bots: [], external: [ada], problems: [] }
  const messages = { messages: [{ role: "user", text: "Flash the board", at: NOW - 10 * MINUTE }, { role: "tool", tool: "terminal", text: "ok" }, { role: "assistant", text: "Flashed and verified." }], more: false }
  async function onRun(h: App) {
    await until(h, "Flash the board")
    await h.type("\x1b[D")
    for (let turn = 0; turn < 20 && !/^ › .*Flash the board/.test(side(h)[rowOf(h, "Flash the board")]!); turn++) await h.type("\x1b[B")
    expect(side(h)[rowOf(h, "Flash the board")]).toMatch(/^ › /)
  }

  test("a working bot lists its sessions there; Enter on one shows its messages to read, and nothing is made in MendCode", async () => {
    const h = chatApp({ height: 40, extra: (command) => command.type === "bot.list" ? reply(bots) : command.type === "bot.activity" ? reply(messages) : undefined })
    await onRun(h)
    expect(side(h)[rowOf(h, "Flash the board")]).toMatch(/Flash the board +1m │$/)
    expect(side(h)[0]).toContain("↵ read")
    await h.type("\r")
    for (let turn = 0; turn < 40 && !h.text().join("\n").includes("Flashed and verified."); turn++) { await Bun.sleep(5); h.app.render() }
    expect(h.app.page).toBe("text")
    const page = h.text().join("\n")
    for (const needle of ["Ada in Hermes", "read-only", "started by telegram", "Asked", "Flash the board", "terminal: ok", "Answered", "Flashed and verified."]) expect(page).toContain(needle)
    expect(h.sentOf("bot.activity").at(-1)).toMatchObject({ origin: "hermes", bot: "ada", session: "run-1" })
    expect(h.sentOf("session.create")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.current)
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("an idle bot lists the newest chats it finished in its own app, and Enter reads one", async () => {
    const chief = { origin: "hermes", id: "default", name: "Chief", state: "idle", chat: "acp:hermes-default", app: "Hermes", identity: { origin: "hermes" }, recent: [{ id: "done-1", title: "Wiring notes", source: "desktop", startedAt: NOW - 61 * MINUTE, activeAt: NOW - 60 * MINUTE }] }
    const h = chatApp({ height: 40, extra: (command) => command.type === "bot.list" ? reply({ bots: [], external: [chief], problems: [] }) : command.type === "bot.activity" ? reply(messages) : undefined })
    await until(h, "Wiring notes")
    expect(side(h)[rowOf(h, "Wiring notes")]).toMatch(/· Wiring notes +1h/)
    await h.type("\x1b[D")
    for (let turn = 0; turn < 20 && !/^ › .*Wiring notes/.test(side(h)[rowOf(h, "Wiring notes")]!); turn++) await h.type("\x1b[B")
    await h.type("\r")
    for (let turn = 0; turn < 40 && !h.text().join("\n").includes("Flashed and verified."); turn++) { await Bun.sleep(5); h.app.render() }
    expect(h.sentOf("bot.activity").at(-1)).toMatchObject({ origin: "hermes", bot: "default", session: "done-1" })
    expect(h.sentOf("session.create")).toHaveLength(0)
  })

  test("when the app will not give the messages the page says so and keeps what the list knew", async () => {
    const h = chatApp({ height: 40, extra: (command) => command.type === "bot.list" ? reply(bots) : command.type === "bot.activity" ? { ok: false, error: { code: "failed", message: "[HERMES]: Hermes is not running" } } as never : undefined })
    await onRun(h)
    await h.type("\r")
    for (let turn = 0; turn < 40 && !h.text().join("\n").includes("Messages not read"); turn++) { await Bun.sleep(5); h.app.render() }
    const page = h.text().join("\n")
    for (const needle of ["Flash the board", "started by telegram", "Messages not read", "Hermes is not running"]) expect(page).toContain(needle)
    expect(page).not.toContain("[HERMES]")
    expect(h.sentOf("session.create")).toHaveLength(0)
  })

  test("Enter or a click on the bot's own row makes no empty session: it folds; `n` asks for the folder", async () => {
    const h = chatApp({ height: 40, extra: (command) => command.type === "bot.list" ? reply(bots) : undefined })
    await until(h, "Ada")
    steady(h)
    await h.type(click(8, rowOf(h, "Ada")))
    await h.type("\x1b[D")
    for (let turn = 0; turn < 20 && !/^ › .*Ada/.test(side(h)[rowOf(h, "Ada")]!); turn++) await h.type("\x1b[A")
    await h.type("\r")
    expect(h.sentOf("session.create")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.current)
    await h.type("n")
    for (let turn = 0; turn < 40 && !sidebarText(h).includes("Chat with Ada in…"); turn++) { await Bun.sleep(5); h.app.render() }
    expect(sidebarText(h)).toContain("Chat with Ada in…")
    expect(h.sentOf("session.create")).toHaveLength(0)
  })
})

describe("the bot card", () => {
  /** ← takes the list, `b` goes to the first bot. */
  async function onBot(h: App) {
    await until(h, "Bots")
    await h.type("\x1b[D")
    await h.type("b")
    h.app.render()
  }
  /** `n` on the bot's row asks for the folder, the open one on top; Enter takes it. */
  async function chatWithBot(h: App) {
    await h.type("n")
    for (let turn = 0; turn < 40 && !sidebarText(h).includes("Chat with"); turn++) { await Bun.sleep(5); h.app.render() }
    await h.type("\r")
  }

  test("o on a bot opens its page, shown in the hint: identity, origin, description, model, permission, chats by folder", async () => {
    const h = chatApp()
    await onBot(h)
    expect(sidebarText(h)).toContain("↵ fold n chat o page")
    await h.type("o")
    expect(h.app.page).toBe("bot")
    h.app.render()
    const page = h.text().join("\n")
    for (const needle of ["Bot · calm", "calm", "mendcode", "A calm reviewer", "gpt-6-luna", "smart", "/work/app", "/other/api", "Chrome", "Docs pass", "New chat", "Edit", "Memory"]) expect(page).toContain(needle)
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("Enter or a click on a bot only folds and opens its chats: no chat is started and no session is made", async () => {
    const h = chatApp({ height: 40 })
    await onBot(h)
    expect(sidebarText(h)).toContain("Docs pass")
    await h.type("\r")
    expect(sidebarText(h)).toContain("▸ chats")
    expect(sidebarText(h)).not.toContain("Docs pass")
    await h.type("\r")
    expect(sidebarText(h)).toContain("Docs pass")
    await steady(h)
    await h.type(click(8, rowOf(h, "calm")))
    expect(sidebarText(h)).toContain("▸ chats")
    expect(h.sentOf("session.create")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("`n` on a bot asks where, the open folder on top: Enter opens a blank chat with it selected, no agent set and no row listed until the first message", async () => {
    const h = chatApp({ height: 40 })
    await onBot(h)
    await h.type("n")
    for (let turn = 0; turn < 40 && !sidebarText(h).includes("Chat with"); turn++) { await Bun.sleep(5); h.app.render() }
    const picker = side(h)
    expect(picker[0]).toContain("Chat with calm in…")
    expect(picker.find((row) => row.includes("app"))).toMatch(/^ › app +open +│$/)
    expect(sidebarText(h)).toContain("api")
    expect(h.sentOf("session.create")).toHaveLength(0)
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/app", reuseEmpty: true })
    expect(h.sentOf("session.create").at(-1)).not.toHaveProperty("agent")
    expect(h.sentOf("session.agent.set")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.created)
    expect(h.app.page).toBe("chat")
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Untitled")
  })

  test("a chat with a bot in another folder: the `+` that ends its row, a typed name, Enter", async () => {
    const h = chatApp({ height: 40 })
    await until(h, "Bots")
    await steady(h)
    const row = side(h)[rowOf(h, "calm")]!
    await h.type(click(row.lastIndexOf("+"), rowOf(h, "calm")))
    for (let turn = 0; turn < 40 && !sidebarText(h).includes("Chat with"); turn++) { await Bun.sleep(5); h.app.render() }
    await h.type("api")
    expect(sidebarText(h)).not.toContain("open")
    expect(side(h).find((row) => /^ › /.test(row))).toContain("api")
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", reuseEmpty: true })
    expect(h.app.sessionId).toBe(h.ids.created)
    await h.type("hello there\r")
    expect(h.sentOf("session.agent.set").at(-1)).toMatchObject({ sessionId: h.ids.created, agent: "calm" })
    // Esc in the picker starts nothing and gives the list back.
    await h.type("\x1b[D")
    await h.type("N")
    for (let turn = 0; turn < 40 && !sidebarText(h).includes("New chat in…"); turn++) { await Bun.sleep(5); h.app.render() }
    await h.type("\x1b")
    expect(sidebarText(h)).toContain("Bots")
    expect(h.sentOf("session.create")).toHaveLength(1)
  })

  describe("a bot's chat wears the bot's colour", () => {
    const rowWith = (h: App, needle: string) => h.frames.at(-1)!.find((line) => line.map((span) => span.text).join("").includes(needle))
    const borders = (h: App) => h.frames.at(-1)!.filter((line) => line.some((span) => /^─+$/.test(span.text.trim()) && span.text.length > 20))

    test("in a bot's chat, even a blank one, the prompt rules and the lead glyph take the bot's colour and the footer names the bot", async () => {
      const h = chatApp({ height: 30, extra: (command) => command.type === "agents.list" ? { ok: true, result: { directory: "/work/app", current: "build", agents: [{ name: "calm", mode: "primary", model: "claude-sonnet", source: "user" }], problems: [] } } as never : undefined })
      await until(h, "Bots")
      h.app.render()
      // The open chat (Chrome) is calm's.
      expect(borders(h).length).toBeGreaterThan(0)
      for (const line of borders(h)) expect(line.find((span) => /─/.test(span.text))?.fg).toBe("success")
      await onBot(h)
      await chatWithBot(h)
      for (let turn = 0; turn < 40 && h.app.sessionId !== h.ids.created; turn++) await Bun.sleep(5)
      await Bun.sleep(20)
      h.app.render()
      expect(rowWith(h, "❭")?.find((span) => span.text.includes("❭"))).toMatchObject({ fg: "success", bold: true })
      for (const line of borders(h)) expect(line.find((span) => /─/.test(span.text))?.fg).toBe("success")
      const footer = h.text().at(-1)!
      expect(footer).toContain("● calm · Sonnet")
    })

    test("a plain session keeps the prompt as it was", async () => {
      const h = chatApp({ height: 30 })
      await until(h, "Other project")
      await steady(h)
      await h.type(click(8, rowOf(h, "Other project")))
      expect(h.app.sessionId).toBe(h.ids.elsewhere)
      h.app.render()
      expect(borders(h).length).toBeGreaterThan(0)
      for (const line of borders(h)) expect(line.find((span) => /─/.test(span.text))?.fg).toBe("primary")
      expect(rowWith(h, "❭")?.find((span) => span.text.includes("❭"))?.fg).toBe("muted")
    })
  })

  test("a bot's blank chat names the bot's own model under the prompt, not the session's default", async () => {
    const h = chatApp({ height: 30, extra: (command) => command.type === "agents.list" ? { ok: true, result: { directory: "/work/app", current: "build", agents: [{ name: "calm", mode: "primary", model: "claude-sonnet", source: "user" }], problems: [] } } as never : undefined })
    await onBot(h)
    await chatWithBot(h)
    for (let turn = 0; turn < 40 && h.app.page !== "chat"; turn++) await Bun.sleep(5)
    await Bun.sleep(20)
    h.app.render()
    const footer = h.text().at(-1)!
    expect(footer).toContain("● calm · Sonnet")
    expect(footer).not.toContain("GPT-6-Luna")
  })

  test("a chat with a bot that reuses the blank chat already open names the bot's model under the prompt", async () => {
    let h!: App
    h = chatApp({ height: 30, extra: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: h.ids.current } } as never : command.type === "models.list" ? { ok: true, result: { engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6.1-terra" }, effective: { model: "gpt-6.1-terra" }, roles: {} } } as never : undefined })
    await until(h, "Bots")
    await Bun.sleep(20)
    h.app.render()
    expect(h.text().at(-1)!.toLowerCase()).toContain("terra")
    await onBot(h)
    await chatWithBot(h)
    for (let turn = 0; turn < 40 && !h.sentOf("session.create").length; turn++) await Bun.sleep(5)
    await Bun.sleep(20)
    h.app.render()
    const footer = h.text().at(-1)!.toLowerCase()
    expect(footer).toContain("luna")
    expect(footer).not.toContain("terra")
  })

  test("/new on the blank chat a bot opened is a plain chat: the first message does not give it the bot", async () => {
    let h!: App
    h = chatApp({ height: 30, extra: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: h.ids.current } } as never : undefined })
    await onBot(h)
    await chatWithBot(h)
    for (let turn = 0; turn < 40 && !h.sentOf("session.create").length; turn++) await Bun.sleep(5)
    await h.type("/new\r")
    for (let turn = 0; turn < 40 && h.sentOf("session.create").length < 2; turn++) await Bun.sleep(5)
    await Bun.sleep(20)
    await h.type("plain question\r")
    expect(h.sentOf("user.submit").at(-1)).toMatchObject({ sessionId: h.ids.current, text: "plain question" })
    expect(h.sentOf("session.agent.set")).toHaveLength(0)
  })

  test("/new on the blank chat a bot opened also drops the bot's name and accent from the open chat", async () => {
    let h!: App
    const agents = { directory: "/work/app", current: "build", agents: [{ name: "build", mode: "primary", source: "builtin" }, { name: "calm", mode: "primary", model: "claude-sonnet", source: "user", bot: { shape: "square", color: "success", origin: "mendcode" } }], problems: [] }
    // The bot list does not know this chat: only what the app itself holds makes it the bot's.
    const bots = { bots: [{ name: "calm", description: "", identity: { shape: "circle", color: "success", origin: "mendcode" }, model: "claude-sonnet", file: "/d/agents/calm.md", state: "idle", projects: [] }], external: [], problems: [] }
    // Enter on the bot switches to the new blank chat (the harness answers session.create with it, `/new` reuses it), which loads its agent report.
    h = chatApp({ height: 30, extra: (command) => command.type === "agents.list" ? { ok: true, result: agents } as never : command.type === "bot.list" ? reply(bots) : undefined })
    await onBot(h)
    await chatWithBot(h)
    for (let turn = 0; turn < 40 && !h.sentOf("session.create").length; turn++) await Bun.sleep(5)
    for (let turn = 0; turn < 40 && !h.text().at(-1)!.includes("calm"); turn++) { await Bun.sleep(5); h.app.render() }
    expect(h.text().at(-1)!).toContain("calm")
    await h.type("/new\r")
    for (let turn = 0; turn < 40 && h.sentOf("session.create").length < 2; turn++) await Bun.sleep(5)
    for (let turn = 0; turn < 40; turn++) { await Bun.sleep(5); h.app.render() }
    expect(h.text().at(-1)!).not.toContain("calm")
  })

  test("a chat that already runs as a bot names the bot's model under the prompt, even when the models answer gives the default", async () => {
    const h = chatApp({ height: 30, extra: (command) => command.type === "agents.list" ? { ok: true, result: { directory: "/work/app", current: "calm", agents: [{ name: "calm", mode: "primary", model: "claude-sonnet", source: "user", bot: { shape: "square", color: "success", origin: "mendcode" } }], problems: [] } } as never : undefined })
    await until(h, "Bots")
    for (let turn = 0; turn < 40 && !h.text().at(-1)!.includes("Sonnet"); turn++) { await Bun.sleep(5); h.app.render() }
    const footer = h.text().at(-1)!
    expect(footer).toContain("Sonnet")
    expect(footer).not.toContain("GPT-6-Luna")
  })

  test("a chat that already runs as a bot keeps the bot's variant in the status row", async () => {
    const h = chatApp({ height: 30, profile: { statusRight: "variant" }, extra: (command) => command.type === "agents.list" ? { ok: true, result: { directory: "/work/app", current: "calm", agents: [{ name: "calm", mode: "primary", model: "claude-sonnet", variant: "zenith", source: "user", bot: { shape: "square", color: "success", origin: "mendcode" } }], problems: [] } } as never : command.type === "models.list" ? { ok: true, result: { engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "claude-sonnet", variant: "zenith" }, roles: {} } } as never : undefined })
    await until(h, "Bots")
    for (let turn = 0; turn < 40 && !h.text().join("\n").includes("zenith"); turn++) { await Bun.sleep(5); h.app.render() }
    expect(h.text().join("\n")).toContain("zenith")
  })

  test("the first message of a bot's new chat gives the session the bot's agent, before the message goes", async () => {
    const h = chatApp()
    await onBot(h)
    await chatWithBot(h)
    await h.type("hello bot\r")
    const order = h.sent.map((command) => command.type)
    expect(h.sentOf("session.agent.set").at(-1)).toMatchObject({ sessionId: h.ids.created, agent: "calm" })
    expect(h.sentOf("user.submit").at(-1)).toMatchObject({ sessionId: h.ids.created, text: "hello bot" })
    expect(order.lastIndexOf("session.agent.set")).toBeLessThan(order.lastIndexOf("user.submit"))
    await h.type("second\r")
    expect(h.sentOf("session.agent.set")).toHaveLength(1)
  })

  test("opening another chat while the bot is being assigned leaves that message in its own chat", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const h = chatApp({ height: 30, extra: (command) => command.type === "session.agent.set" ? held.then(() => ({ ok: true, result: {} }) as never) as never : undefined })
    await onBot(h)
    await chatWithBot(h)
    expect(h.app.sessionId).toBe(h.ids.created)
    const sending = h.app.onInput("hello bot\r")
    for (let turn = 0; turn < 40 && !h.sentOf("session.agent.set").length; turn++) await Bun.sleep(5)
    h.app.render()
    await h.type(click(6, rowOf(h, "Client reconnect")))
    expect(h.app.sessionId).toBe(h.ids.second)
    release()
    await sending
    await Bun.sleep(10)
    expect(h.sentOf("user.submit").every((command) => (command as { sessionId: string }).sessionId === h.ids.created)).toBe(true)
    expect(h.sentOf("user.submit")).toHaveLength(1)
  })

  test("a new chat with a bot sits under the bot's chats the moment its summary arrives, never under Projects; folded chats stay folded and carry its bar", async () => {
    const h = chatApp({ height: 60 })
    await onBot(h)
    // Fold calm's chats first: starting a chat does not open them again.
    await h.type(" ")
    expect(sidebarText(h)).toContain("▸ chats")
    await chatWithBot(h)
    await h.type("hello bot\r")
    // The daemon pushes the new session as an ordinary summary (no agent in it).
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.ids.created, directory: "/work/app", title: "hello bot", state: "generating", updatedAt: NOW } as never)
    h.app.render()
    expect(sidebarText(h)).not.toContain("hello bot")
    // The folded row holds the open chat (its bar) and counts the one that works out of sight.
    expect(side(h)[rowOf(h, "▸ chats")]).toMatch(/^ ▌ +▸ chats +1 active \d+ │$/)
    expect(side(h)[rowOf(h, "▾ app")]).toMatch(/▾ app +1 \+ │$/)
    // Opened by hand, the chat is there, once, under the bot.
    await h.type("\x1b[D")
    await h.type("b")
    await h.type(" ")
    const text = sidebarText(h)
    expect(text).toContain("▾ chats")
    expect(text.indexOf("hello bot")).toBeGreaterThan(text.indexOf("Bots"))
    expect(text.indexOf("hello bot")).toBeLessThan(text.indexOf("Projects"))
    expect(text.match(/hello bot/g)).toHaveLength(1)
  })

  test("a bot chat stays in the list under Projects once the bots flag is turned off", async () => {
    const h = chatApp({ height: 60, profile: { sidebarProjects: "all" } })
    await onBot(h)
    await chatWithBot(h)
    await h.type("hello bot\r")
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.ids.created, directory: "/work/app", title: "hello bot", state: "generating", updatedAt: NOW } as never)
    h.app.applySettings({})
    h.app.render()
    const text = sidebarText(h)
    expect(text).not.toContain("Bots")
    expect(text).toContain("hello bot")
  })

  test("a click anywhere on a bot's chats row folds and opens them, and starts no chat", async () => {
    const h = chatApp({ height: 40 })
    // A MendCode bot's chats start open; a click on the arrow folds them, another opens them.
    await until(h, "▾ chats")
    expect(sidebarText(h)).toContain("Docs pass")
    const glyph = side(h)[rowOf(h, "▾ chats")]!.indexOf("▾")
    await steady(h)
    await h.type(click(glyph, rowOf(h, "▾ chats")))
    h.app.render()
    expect(sidebarText(h)).toContain("▸ chats")
    expect(sidebarText(h)).not.toContain("Docs pass")
    await h.type(click(glyph, rowOf(h, "▸ chats")))
    h.app.render()
    expect(sidebarText(h)).toContain("Docs pass")
    expect(h.sentOf("session.create")).toHaveLength(0)
    await h.type(click(glyph + 3, rowOf(h, "▾ chats")))
    h.app.render()
    expect(sidebarText(h)).toContain("▸ chats")
    expect(h.sentOf("session.create")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("Space or Enter on a bot or on its chats row folds the chats; `n` on the chats row asks where to chat with the bot", async () => {
    const h = chatApp({ height: 40 })
    await onBot(h)
    await h.type(" ")
    h.app.render()
    expect(sidebarText(h)).toContain("▸ chats")
    expect(sidebarText(h)).not.toContain("Docs pass")
    await h.type(" ")
    h.app.render()
    expect(sidebarText(h)).toContain("Docs pass")
    await h.type("\x1b[B")
    expect(sidebarText(h)).toContain("↵ fold  n chat")
    await h.type("\r")
    expect(sidebarText(h)).toContain("▸ chats")
    expect(h.sentOf("session.create")).toHaveLength(0)
    await h.type("\r")
    expect(sidebarText(h)).toContain("Docs pass")
    await chatWithBot(h)
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/app", reuseEmpty: true })
    expect(h.app.sessionId).toBe(h.ids.created)
  })

  test("/bot open <name> opens the page from a chat, and without a name the open chat's bot", async () => {
    const h = chatApp()
    await until(h, "Bots")
    await h.type("/bot open calm\r")
    expect(h.app.page).toBe("bot")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  async function card() {
    const h = chatApp()
    await onBot(h)
    await h.type("o")
    expect(h.app.page).toBe("bot")
    return h
  }

  test("Enter on one of its sessions opens that session", async () => {
    const h = await card()
    const lines = () => h.text()
    // Rows: actions first, then the sessions; move to the Docs pass row.
    for (let turn = 0; turn < 12 && !lines().some((row) => /›.*Docs pass/.test(row)); turn++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.ids.docs)
    expect(h.app.page).toBe("chat")
  })

  test("New chat in a folder opens a blank chat there and gives it the bot on the first message", async () => {
    const h = await card()
    await h.type("n")
    expect(h.text().join("\n")).toContain("Folder for a new chat")
    // The folders the bot works in come first; pick /other/api.
    for (let turn = 0; turn < 8 && !h.text().some((row) => /›.*\/other\/api/.test(row)); turn++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", reuseEmpty: true })
    expect(h.sentOf("session.agent.set")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.created)
    expect(h.app.page).toBe("chat")
    await h.type("hi\r")
    expect(h.sentOf("session.agent.set").at(-1)).toMatchObject({ sessionId: h.ids.created, agent: "calm" })
  })

  test("e edits through /bot edit and m shows the memory", async () => {
    const h = chatApp({ extra: (command) => command.type === "bot.memory" ? reply({ global: "- likes short answers", project: "" }) : command.type === "bot.file" ? reply({ file: "/d/agents/calm.md", text: "x", saved: false }) : undefined })
    await until(h, "Bots")
    await h.type("/bot open calm\r")
    await h.type("m")
    expect(h.sentOf("bot.memory").at(-1)).toMatchObject({ name: "calm" })
    expect(h.text().join("\n")).toContain("likes short answers")
    // Esc from the memory text goes back to the bot's page.
    await h.type("\x1b")
    expect(h.app.page).toBe("bot")
    await h.type("e")
    expect(h.sentOf("bot.file").at(-1)).toMatchObject({ name: "calm" })
  })
})

describe("layouts and widths", () => {
  test("icons only is a narrow column and gives the chat the rest", async () => {
    const h = chatApp({ profile: { sidebarLayout: "icons-only" } })
    await until(h, "◌", (app) => side(app, ICON_SIDEBAR_WIDTH).join("\n"))
    for (const row of side(h, ICON_SIDEBAR_WIDTH + 1)) expect(row[ICON_SIDEBAR_WIDTH - 1]).toBe("│")
    expect(sidebarText(h)).not.toContain("mendcode")
    // The chat text starts right after the narrow column and its gap, not after 38 cells.
    expect(h.text()[0]!.slice(ICON_SIDEBAR_WIDTH, ICON_SIDEBAR_WIDTH + SIDEBAR_GAP)).toBe(" ")
  })

  test("a narrow terminal shows the icons column with bots on, and nothing without", async () => {
    const narrow = chatApp({ width: 90 })
    await until(narrow, "◌", (app) => side(app, ICON_SIDEBAR_WIDTH).join("\n"))
    const off = chatApp({ width: 90, bots: false })
    await Bun.sleep(20)
    off.app.render()
    expect(side(off, ICON_SIDEBAR_WIDTH).join("").trim()).not.toContain("│")
    expect(side(narrow, ICON_SIDEBAR_WIDTH).every((row) => row.endsWith("│"))).toBe(true)
  })

  test("from scratch shows no section and says where to add them", async () => {
    const h = chatApp({ profile: { sidebarLayout: "scratch" } })
    await until(h, "Nothing shown")
    expect(sidebarText(h)).toContain("/customize")
    expect(sidebarText(h)).not.toContain("calm")
  })

  test("bots first puts the bots above the projects", async () => {
    const h = chatApp({ profile: { sidebarLayout: "bots-first" } })
    await until(h, "Bots")
    expect(rowOf(h, "calm")).toBeLessThan(rowOf(h, "Chrome"))
  })
})

describe("a failed refresh never empties the list", () => {
  const headingOf = (h: App, title: string) => side(h).find((row) => row.trimStart().startsWith(title)) ?? ""
  test("an all-projects list that fails keeps what the list had, says stale, and is asked again within seconds; the answer replaces it", async () => {
    let failing = true
    const h = chatApp({ height: 40, extra: (command) => command.type === "session.list" && !(command as { directory?: string }).directory && failing ? { ok: false, error: { code: "internal", message: "busy" } } as CommandReply : undefined })
    await until(h, "Projects")
    await until(h, "stale")
    expect(headingOf(h, "Projects")).toContain("stale")
    expect(sidebarText(h)).not.toContain("api")
    const asked = h.sentOf("session.list").length
    failing = false
    h.clock.at += 7_000
    await until(h, "api")
    expect(h.sentOf("session.list").length).toBeGreaterThan(asked)
    expect(headingOf(h, "Projects")).not.toContain("stale")
  })

  test("a bot list whose connector failed keeps that connector's bots from the last answer, marked stale", async () => {
    let broken = false
    const ada = { origin: "hermes", id: "ada", name: "Ada", identity: { origin: "hermes" }, state: "idle", chat: "acp:hermes-ada" }
    const h = chatApp({ height: 40, extra: (command) => command.type === "bot.list" ? reply({ bots: [], external: broken ? [] : [ada], problems: broken ? [{ file: "connector:hermes", message: "[HERMES]: Hermes does not answer" }] : [] }) : undefined })
    await until(h, "hermes · 1")
    expect(headingOf(h, "Bots")).not.toContain("stale")
    broken = true
    const asked = h.sentOf("bot.list").length
    h.clock.at += 65_000
    for (let turn = 0; turn < 40 && h.sentOf("bot.list").length === asked; turn++) { h.app.render(); await Bun.sleep(5) }
    await Bun.sleep(10)
    h.app.render()
    expect(h.sentOf("bot.list").length).toBeGreaterThan(asked)
    expect(sidebarText(h)).toContain("hermes · 1")
    expect(headingOf(h, "Bots")).toContain("stale")
  })
})

describe("a sub-agent waiting on you keeps the plain arrows for the sub-agents", () => {
  const marked = (h: App) => side(h).some((row) => /^ › /.test(row))
  /** Whether a row is selected (›) after the left arrow and one down: the list took the arrows, or the chat kept them. */
  const afterLeftThenDown = async (h: App, left: string) => {
    await until(h, "Bots")
    await Bun.sleep(20)
    h.app.render()
    await h.type(left)
    await h.type("\x1b[B")
    h.app.render()
    return marked(h)
  }
  test("with no sub-agent the plain left arrow enters the list", async () => {
    expect(await afterLeftThenDown(chatApp(), "\x1b[D")).toBe(true)
  })
  for (const kind of ["approval", "question", "plan"] as const) {
    test(`a sub-agent waiting with ${kind}: the plain left arrow stays with the chat and Alt+left enters the list`, async () => {
      expect(await afterLeftThenDown(chatApp({ waitingChild: kind }), "\x1b[D")).toBe(false)
      expect(await afterLeftThenDown(chatApp({ waitingChild: kind }), "\x1b[1;3D")).toBe(true)
    })
  }
})
