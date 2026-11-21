import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const PASTED = "line of pasted log output\n".repeat(200)
const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`

/** The app on a started chat with a bot listed, and a daemon's drafts: a draft keeps its chat, so a bot's next new chat is another session. */
function botApp() {
  const current = ids("session")
  const other = ids("session")
  const created = ids("session")
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 60_000, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: other, title: "Client reconnect", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 600_000, lastSeq: 0, state: "idle", queued: 0 },
  ]
  const report = { bots: [{ name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, model: "gpt-6-luna", permission: "smart", file: "/d/agents/calm.md", state: "idle", projects: [] }], external: [], problems: [] }
  const drafts = new Map<string, { text: string; attachments: unknown[] }>()
  let creates = 0
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  const h = appHarness({ width: 120, height: 40, mode: "balanced", inspectProject: async () => ({ git: true }), sessionId: current, dataDir, directory: "/work/app", reply: (command: CommandInput) => {
    const c = command as CommandInput & { sessionId?: string; text?: string; attachments?: unknown[] }
    if (command.type === "draft.set") { if (c.text?.trim() || c.attachments?.length) drafts.set(c.sessionId!, { text: c.text ?? "", attachments: c.attachments ?? [] }); else drafts.delete(c.sessionId!); return reply({}) }
    if (command.type === "draft.get") return reply(drafts.has(c.sessionId!) ? { draft: drafts.get(c.sessionId!) } : {})
    if (command.type === "session.list") return reply({ sessions })
    if (command.type === "bot.list") return reply(report)
    if (command.type === "session.create") return reply({ sessionId: creates++ === 0 ? created : ids("session") })
    if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
    if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
    return undefined
  } })
  h.app.applySettings({ experimental: { bots: true } })
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  const side = () => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH))
  const rowOf = (needle: string) => side().findIndex((row) => row.includes(needle))
  const onBot = async () => {
    for (let turn = 0; turn < 80 && !side().join("\n").includes("Bots"); turn++) { h.app.render(); await Bun.sleep(5) }
    await h.type("\x1b[D")
    await h.type("b")
    h.app.render()
  }
  return { h, ids: { current, other, created }, rowOf, onBot, drafts }
}

describe("an unsent message in a bot's new chat", () => {
  test("leaving for another chat and coming back to the bot's chat shows the draft as left, the paste as its chip", async () => {
    const t = botApp()
    await t.onBot()
    await t.h.type("\r")
    expect(t.h.app.sessionId).toBe(t.ids.created)
    await t.h.type("look at ")
    await t.h.type(`\x1b[200~${PASTED}\x1b[201~`)
    await t.h.type(" please")
    const typed = t.h.app.editor.text
    expect(typed).toMatch(/^look at \[Pasted Content \d+ chars\] please$/)
    await t.h.type(click(6, t.rowOf("Client reconnect")))
    expect(t.h.app.sessionId).toBe(t.ids.other)
    expect(t.h.app.editor.text).toBe("")
    await t.onBot()
    await t.h.type("\r")
    for (let turn = 0; turn < 20; turn++) await Bun.sleep(5)
    expect(t.h.app.sessionId).toBe(t.ids.created)
    expect(t.h.app.editor.text).toBe(typed)
    await t.h.type("\r")
    expect(t.h.sentOf("user.submit").at(-1)).toMatchObject({ sessionId: t.ids.created, text: `look at ${PASTED} please` })
  })
})
