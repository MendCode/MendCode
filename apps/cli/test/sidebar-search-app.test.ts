import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000
const LEFT = "\x1b[D"
const DOWN = "\x1b[B"

/** Sessions in two folders and two bots; `bots: false` is the classic one-folder list. */
function searchApp({ bots = true, profile = {}, found = [] }: { bots?: boolean; profile?: Partial<TuiProfile>; /** What `session.list` with `find` answers. */ found?: SessionSummary[] } = {}) {
  const current = ids("session")
  const second = ids("session")
  const elsewhere = ids("session")
  const docs = ids("session")
  const created = ids("session")
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - MINUTE, lastSeq: 9, state: "idle", queued: 0 },
    { sessionId: second, title: "Client reconnect", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 10 * MINUTE, lastSeq: 9, state: "idle", queued: 0 },
    { sessionId: elsewhere, title: "Other project", directory: "/other/api", createdAt: NOW, updatedAt: NOW, lastSeq: 9, state: "idle", queued: 0 },
    { sessionId: docs, title: "Docs pass", directory: "/other/api", createdAt: NOW, updatedAt: NOW - 120 * MINUTE, lastSeq: 9, state: "idle", queued: 0 },
  ]
  const report = {
    bots: [{ name: "scout", description: "Finds things", identity: { origin: "mendcode" }, file: "/d/agents/scout.md", state: "idle", projects: [] }],
    external: [],
    problems: [],
  }
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...(bots ? {} : { sidebarProjects: "folder" }), ...profile })
  const h = appHarness({ width: 120, height: 24, mode: "balanced", inspectProject: async () => ({ git: true }), sessionId: current, dataDir, directory: "/work/app", reply: (command: CommandInput) => {
    if (command.type === "session.list" && (command as { find?: string }).find) return reply({ sessions: found })
    if (command.type === "session.list") return reply({ sessions: (command as { directory?: string }).directory ? sessions.filter((session) => session.directory === (command as { directory?: string }).directory) : sessions })
    if (command.type === "bot.list") return reply(report)
    if (command.type === "session.create") return reply({ sessionId: created })
    if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
    if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
    return undefined
  } })
  h.app.applySettings(bots ? { experimental: { bots: true } } : {})
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, ids: { current, second, elsewhere, docs, created } }
}
type App = ReturnType<typeof searchApp>
const side = (h: App) => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH))
const sidebarText = (h: App) => side(h).join("\n")
async function until(h: App, needle: string) {
  for (let turn = 0; turn < 80; turn++) {
    h.app.render()
    if (sidebarText(h).includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${sidebarText(h)}`)
}
/** Focus the list, open the search and type `query`. */
async function search(h: App, query: string) {
  await h.type(LEFT)
  await h.type("/")
  for (const char of query) await h.type(char)
}

describe("opening and closing", () => {
  test("`/` in the focused list opens the field on top", async () => {
    const h = searchApp()
    await until(h, "scout")
    await h.type(LEFT)
    await h.type("/")
    expect(side(h)[0]).toMatch(/^ {3}\/ {2,}\d+ │$/)
    expect(sidebarText(h)).toContain("esc back")
  })

  test("typing filters at once, and Esc restores the list, its focus and its selection", async () => {
    const h = searchApp()
    await until(h, "scout")
    await h.type(LEFT)
    await h.type(DOWN)
    const listed = side(h)
    expect(listed.join("\n")).toContain("→ prompt")
    await h.type("/")
    for (const char of "docs") await h.type(char)
    expect(side(h)[0]).toMatch(/^ {3}\/ docs +1 │$/)
    expect(sidebarText(h)).toContain("Docs pass")
    expect(sidebarText(h)).not.toContain("Client reconnect")
    await h.type("\x1b")
    // The same rows, the same `›` on the same row and the header still saying the list has the keyboard.
    expect(side(h)).toEqual(listed)
  })

  test("a bracketed paste goes into the query, not the prompt behind it", async () => {
    const h = searchApp()
    await until(h, "scout")
    await h.type(LEFT)
    await h.type("/")
    await h.type("\x1b[200~docs\x1b[201~")
    expect(side(h)[0]).toMatch(/^ {3}\/ docs +1 │$/)
    expect(sidebarText(h)).not.toContain("Client reconnect")
    await h.type("\x1b")
    await h.type("\x1b[C")
    expect(h.text().join("\n")).not.toContain("docs")
  })

  test("Esc after opening from the chat (ctrl+x <) gives the keyboard back to the prompt", async () => {
    const h = searchApp()
    await until(h, "scout")
    const unfocused = side(h)
    expect(unfocused.join("\n")).toContain("← focus")
    await h.type("\x18")
    await h.type("<")
    expect(side(h)[0]).toMatch(/^ {3}\/ /)
    await h.type("\x1b")
    expect(side(h)).toEqual(unfocused)
    // The prompt has the keyboard again: typing goes into it.
    await h.type("x")
    expect(side(h)).toEqual(unfocused)
  })

  test("the classic one-folder list has the search too", async () => {
    const h = searchApp({ bots: false })
    await until(h, "Client reconnect")
    await search(h, "recon")
    expect(sidebarText(h)).toContain("Client reconnect")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.ids.second)
  })
})

describe("Enter on a match", () => {
  test("a session opens", async () => {
    const h = searchApp()
    await until(h, "scout")
    await search(h, "docs")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.ids.docs)
    expect(side(h)[0]).not.toMatch(/^ {3}\/ /)
    expect(sidebarText(h)).not.toContain("→ prompt")
  })

  test("a project starts a new chat in its folder", async () => {
    const h = searchApp()
    await until(h, "scout")
    await search(h, "api")
    // The project `api` starts with the query; `Other project` has no run of it.
    expect(side(h).find((row) => row.startsWith(" › "))).toMatch(/api +project │$/)
    await h.type("\r")
    expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/other/api" })
    expect(h.app.sessionId).toBe(h.ids.created)
  })

  test("a bot starts a chat with it", async () => {
    const h = searchApp()
    await until(h, "scout")
    await search(h, "scout")
    await h.type("\r")
    // The bot's own new chat: in the opened folder, as Enter on its row in the list does.
    expect(h.sentOf("session.create")).toHaveLength(1)
    expect(h.sentOf("session.create")[0]).toMatchObject({ directory: "/work/app" })
    expect(h.app.sessionId).toBe(h.ids.created)
  })

  test("↓ moves between matches and Enter opens the one picked", async () => {
    const h = searchApp()
    await until(h, "scout")
    await search(h, "pass")
    for (let turn = 0; turn < 3; turn++) await h.type("\x7f")
    expect(side(h)[0]).toMatch(/^ {3}\/ p /)
    // Both titles have `p` at a word start: the earlier one first; ↓ goes to the next.
    const picked = () => side(h).find((row) => row.startsWith(" › ")) ?? ""
    expect(picked()).toContain("Docs pass")
    await h.type(DOWN)
    expect(picked()).toContain("Other project")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.ids.elsewhere)
  })

  test("a click on a match opens it", async () => {
    const h = searchApp()
    await until(h, "scout")
    await search(h, "docs")
    const row = side(h).findIndex((line) => line.includes("Docs pass"))
    await h.type(`\x1b[<0;9;${row + 1}M`)
    expect(h.app.sessionId).toBe(h.ids.docs)
  })
})

describe("past the lists held here", () => {
  const old: SessionSummary = { sessionId: ids("session"), title: "Ancient migration notes", directory: "/work/app", createdAt: NOW - 400 * 86_400_000, updatedAt: NOW - 400 * 86_400_000, lastSeq: 9, state: "idle", queued: 0 }

  test("one daemon question after the typing stops adds what it found", async () => {
    const h = searchApp({ found: [old] })
    await until(h, "scout")
    await search(h, "migra")
    expect(sidebarText(h)).not.toContain("Ancient migration")
    expect(h.sentOf("session.list").filter((command) => (command as { find?: string }).find)).toHaveLength(0)
    await Bun.sleep(220)
    h.app.render()
    const asked = h.sentOf("session.list").filter((command) => (command as { find?: string }).find)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ find: "migra", limit: 50 })
    expect(sidebarText(h)).toContain("Ancient migration")
  })

  test("closed before the pause, nothing is asked", async () => {
    const h = searchApp({ found: [old] })
    await until(h, "scout")
    await search(h, "migra")
    await h.type("\x1b")
    await Bun.sleep(220)
    expect(h.sentOf("session.list").filter((command) => (command as { find?: string }).find)).toHaveLength(0)
  })
})
