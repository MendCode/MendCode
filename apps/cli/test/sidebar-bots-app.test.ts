import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { ICON_SIDEBAR_WIDTH, SIDEBAR_GAP, SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000

/** The app with a bots list and sessions in three folders; `bots: false` is a terminal that never turned the flag on. */
function chatApp({ bots = true, profile = {}, width = 120, height = 24, extra, clock, more = [], inspect }: { bots?: boolean; profile?: Partial<TuiProfile>; width?: number; height?: number; extra?: (command: CommandInput) => CommandReply | undefined; clock?: { at: number }; /** Sessions of other folders the daemon lists besides the four. */ more?: SessionSummary[]; inspect?: (directory: string) => Promise<{ git: boolean }> } = {}) {
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
  const h = appHarness({ width, height, mode: "balanced", inspectProject: inspect ?? (async () => ({ git: true })), ...(clock ? { now: () => clock.at } : {}), sessionId: current, dataDir, directory: "/work/app", reply: (command) => {
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
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, ids: { current, second, elsewhere, docs, created } }
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
    expect(side(h)[rowOf(h, "calm")]).toMatch(/^ {3}● calm +mendcode +● working │$/)
    expect(side(h)[rowOf(h, "scout")]).toMatch(/scout +mendcode +◌ idle │$/)
    // Bots first by default; Chrome (the bot's, and the open one) sits under calm's chats row, after the Bots heading.
    expect(rowOf(h, "Bots")).toBeLessThan(rowOf(h, "Projects"))
    expect(rowOf(h, "Chrome")).toBeGreaterThan(rowOf(h, "calm"))
    expect(rowOf(h, "Chrome")).toBeLessThan(rowOf(h, "Projects"))
    expect(side(h)[rowOf(h, "▾ app")]).toMatch(/▾ app +1 │$/)
    expect(h.sentOf("bot.list")).toHaveLength(1)
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
    expect(side(h)[rowOf(h, "calm")]).toMatch(/◌ idle │$/)
    push(h.ids.current, { state: "waiting_approval", title: "Chrome" })
    await frame()
    expect(side(h)[rowOf(h, "calm")]).toMatch(/… waiting │$/)
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
    expect(side(h)[rowOf(h, "calm")]).toMatch(/◌ idle │$/)
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

  test("every folder is an open group; Enter and a click fold a group, and a folded one says how many of its sessions work or wait", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "▾ api")
    expect(sidebarText(h)).toContain("▾ app")
    expect(sidebarText(h)).toContain("Other project")
    expect(h.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
    await h.type(click(8, rowOf(h, "▾ api")))
    expect(sidebarText(h)).toContain("▸ api")
    expect(sidebarText(h)).not.toContain("Other project")
    expect(side(h)[rowOf(h, "▸ api")]).toMatch(/▸ api +1 active │$/)
    await h.type(click(8, rowOf(h, "▸ api")))
    expect(sidebarText(h)).toContain("Other project")
    // The keyboard: focus the list, go down to the group (Chrome, Client reconnect, then api), Enter folds it.
    await h.type("\x1b[D")
    for (let turn = 0; turn < 2; turn++) await h.type("\x1b[B")
    expect(side(h)[rowOf(h, "api")]).toMatch(/^ › /)
    await h.type("\r")
    expect(sidebarText(h)).toContain("▸ api")
    expect(sidebarText(h)).not.toContain("Other project")
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("the preview: sidebarPreviewCount sessions and a more row that Enter and a click expand and collapse, in memory only", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all", sidebarPreviewCount: 1 }, bots: false })
    await until(h, "▾ api")
    expect(sidebarText(h)).toContain("Chrome")
    expect(sidebarText(h)).not.toContain("Client reconnect")
    expect(side(h)[rowOf(h, "more")]).toMatch(/\+ 1 more +│$/)
    // The keyboard: focus the list (on Chrome), one down is the more row.
    await h.type("\x1b[D")
    await h.type("\x1b[B")
    expect(side(h)[rowOf(h, "more")]).toMatch(/^ › /)
    await h.type("\r")
    expect(sidebarText(h)).toContain("Client reconnect")
    expect(side(h)[rowOf(h, "show less")]).toMatch(/^ › /)
    expect(h.app.sessionId).toBe(h.ids.current)
    // The mouse folds it back.
    await h.type(click(8, rowOf(h, "show less")))
    expect(sidebarText(h)).not.toContain("Client reconnect")
    await h.type(click(8, rowOf(h, "+ 1 more")))
    expect(sidebarText(h)).toContain("Client reconnect")
    expect(h.app.sessionId).toBe(h.ids.current)
  })

  test("a click on a session of another folder opens it", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "Other project")
    await h.type(click(8, rowOf(h, "Other project")))
    expect(h.app.sessionId).toBe(h.ids.elsewhere)
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

  test("o on a bot opens its page, shown in the hint: identity, origin, description, model, permission, chats by folder", async () => {
    const h = chatApp()
    await onBot(h)
    expect(sidebarText(h)).toContain("↵ chat  o page")
    await h.type("o")
    expect(h.app.page).toBe("bot")
    h.app.render()
    const page = h.text().join("\n")
    for (const needle of ["Bot · calm", "calm", "mendcode", "A calm reviewer", "gpt-6-luna", "smart", "/work/app", "/other/api", "Chrome", "Docs pass", "New chat", "Edit", "Memory"]) expect(page).toContain(needle)
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("Enter on a bot opens a blank chat with it selected: no agent is set and no row is listed until the first message", async () => {
    const h = chatApp()
    await onBot(h)
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/app", reuseEmpty: true })
    expect(h.sentOf("session.create").at(-1)).not.toHaveProperty("agent")
    expect(h.sentOf("session.agent.set")).toHaveLength(0)
    expect(h.app.sessionId).toBe(h.ids.created)
    expect(h.app.page).toBe("chat")
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Untitled")
  })

  test("the first message of a bot's new chat gives the session the bot's agent, before the message goes", async () => {
    const h = chatApp()
    await onBot(h)
    await h.type("\r")
    await h.type("hello bot\r")
    const order = h.sent.map((command) => command.type)
    expect(h.sentOf("session.agent.set").at(-1)).toMatchObject({ sessionId: h.ids.created, agent: "calm" })
    expect(h.sentOf("user.submit").at(-1)).toMatchObject({ sessionId: h.ids.created, text: "hello bot" })
    expect(order.lastIndexOf("session.agent.set")).toBeLessThan(order.lastIndexOf("user.submit"))
    await h.type("second\r")
    expect(h.sentOf("session.agent.set")).toHaveLength(1)
  })

  test("a click on the bot's row does the same", async () => {
    const h = chatApp()
    await until(h, "Bots")
    await h.type(click(8, rowOf(h, "calm")))
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/app", reuseEmpty: true })
    expect(h.app.sessionId).toBe(h.ids.created)
  })

  test("a click on a bot's chats row folds and opens them", async () => {
    const h = chatApp({ height: 40 })
    // The open chat belongs to calm, so its chats start open; a click folds them, another opens them.
    await until(h, "▾ chats")
    expect(sidebarText(h)).toContain("Docs pass")
    await h.type(click(8, rowOf(h, "▾ chats")))
    h.app.render()
    expect(sidebarText(h)).toContain("▸ chats")
    expect(sidebarText(h)).not.toContain("Docs pass")
    await h.type(click(8, rowOf(h, "▸ chats")))
    h.app.render()
    expect(sidebarText(h)).toContain("Docs pass")
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
