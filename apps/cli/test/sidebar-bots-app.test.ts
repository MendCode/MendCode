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
function chatApp({ bots = true, profile = {}, width = 120, height = 24, extra, clock }: { bots?: boolean; profile?: Partial<TuiProfile>; width?: number; height?: number; extra?: (command: CommandInput) => CommandReply | undefined; clock?: { at: number } } = {}) {
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
  const h = appHarness({ width, height, mode: "balanced", ...(clock ? { now: () => clock.at } : {}), sessionId: current, dataDir, directory: "/work/app", reply: (command) => {
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
  test("a row per bot with its state, and the bot's session marked with its icon", async () => {
    const h = chatApp()
    await until(h, "Bots")
    expect(side(h)[rowOf(h, "calm")]).toMatch(/^ {3}● calm +mendcode +● working │$/)
    expect(side(h)[rowOf(h, "scout")]).toMatch(/scout +mendcode +◌ idle │$/)
    expect(side(h)[rowOf(h, "Chrome")]).toMatch(/● Chrome +1m │$/)
    expect(h.sentOf("bot.list")).toHaveLength(1)
  })

  test("an activity push refreshes the bots, at most once every two seconds", async () => {
    const clock = { at: NOW }
    const h = chatApp({ clock })
    await until(h, "Bots")
    const push = (gseq: number) => h.app.onGlobal({ type: "session.activity", gseq, at: clock.at, sessionId: h.ids.second, directory: "/work/app", title: "Client reconnect", state: "generating", updatedAt: clock.at } as never)
    push(1)
    push(2)
    await Bun.sleep(10)
    expect(h.sentOf("bot.list")).toHaveLength(1)
    clock.at += 3000
    push(3)
    push(4)
    await Bun.sleep(10)
    expect(h.sentOf("bot.list")).toHaveLength(2)
  })
})

describe("all projects", () => {
  test("auto (the default) lists every project with bots on, and an explicit folder keeps the opened one only", async () => {
    const auto = chatApp()
    await until(auto, "▸ api")
    expect(auto.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
    const folder = chatApp({ profile: { sidebarProjects: "folder" } })
    await until(folder, "calm")
    expect(sidebarText(folder)).not.toContain("▸ api")
  })

  test("every folder is a group: the opened one open, the rest folded with a count; Enter and a click fold or open", async () => {
    const h = chatApp({ profile: { sidebarProjects: "all" }, bots: false })
    await until(h, "▸ api")
    expect(sidebarText(h)).toContain("▾ app")
    expect(sidebarText(h)).not.toContain("Other project")
    expect(side(h)[rowOf(h, "▸ api")]).toMatch(/▸ api +1 active │$/)
    expect(h.sentOf("session.list").some((command) => (command as { directory?: string }).directory === undefined)).toBe(true)
    await h.type(click(8, rowOf(h, "▸ api")))
    expect(sidebarText(h)).toContain("▾ api")
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
    await until(h, "▸ api")
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
    await until(h, "▸ api")
    await h.type(click(8, rowOf(h, "▸ api")))
    await h.type(click(8, rowOf(h, "Other project")))
    expect(h.app.sessionId).toBe(h.ids.elsewhere)
  })
})

describe("the bot card", () => {
  test("Enter on a bot opens its page: identity, origin, description, model, permission, sessions by folder", async () => {
    const h = chatApp()
    await until(h, "Bots")
    await h.type("\x1b[D")
    // Walk down to the calm row.
    for (let turn = 0; turn < 12 && h.app.page === "chat"; turn++) {
      h.app.render()
      if (h.text().some((row) => /^ › .*calm/.test(row.slice(0, SIDEBAR_WIDTH)))) { await h.type("\r"); break }
      await h.type("\x1b[B")
    }
    expect(h.app.page).toBe("bot")
    const page = h.text().join("\n")
    for (const needle of ["calm", "mendcode", "A calm reviewer", "gpt-6-luna", "smart", "/work/app", "/other/api", "Chrome", "Docs pass", "New session", "Edit", "Memory"]) expect(page).toContain(needle)
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("a click on the bot's row opens the same page", async () => {
    const h = chatApp()
    await until(h, "Bots")
    await h.type(click(8, rowOf(h, "calm")))
    expect(h.app.page).toBe("bot")
  })

  async function card() {
    const h = chatApp()
    await until(h, "Bots")
    await h.type(click(8, rowOf(h, "calm")))
    expect(h.app.page).toBe("bot")
    return h
  }

  test("Enter on one of its sessions opens that session", async () => {
    const h = await card()
    const lines = () => h.text()
    // Rows: actions first, then the sessions; move to the Docs pass row.
    for (let turn = 0; turn < 12 && !lines().some((row) => /^\s*›.*Docs pass/.test(row)); turn++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.ids.docs)
    expect(h.app.page).toBe("chat")
  })

  test("New session in a folder creates it there, sets the bot's agent and opens it", async () => {
    const h = await card()
    await h.type("n")
    expect(h.text().join("\n")).toContain("Folder")
    // The folders the bot works in come first; pick /other/api.
    for (let turn = 0; turn < 8 && !h.text().some((row) => /^\s*›.*\/other\/api/.test(row)); turn++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api", agent: "calm" })
    expect(h.sentOf("session.agent.set").at(-1)).toMatchObject({ sessionId: h.ids.created, agent: "calm" })
    expect(h.app.sessionId).toBe(h.ids.created)
    expect(h.app.page).toBe("chat")
  })

  test("e edits through /bot edit and m shows the memory", async () => {
    const h = chatApp({ extra: (command) => command.type === "bot.memory" ? reply({ global: "- likes short answers", project: "" }) : command.type === "bot.file" ? reply({ file: "/d/agents/calm.md", text: "x", saved: false }) : undefined })
    await until(h, "Bots")
    await h.type(click(8, rowOf(h, "calm")))
    await h.type("m")
    expect(h.sentOf("bot.memory").at(-1)).toMatchObject({ name: "calm" })
    expect(h.text().join("\n")).toContain("likes short answers")
    await h.type("\x1b")
    await h.type(click(8, rowOf(h, "calm")))
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
