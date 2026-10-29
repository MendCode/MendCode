import { afterEach, describe, expect, test } from "bun:test"
import type { Client, CommandInput, CommandReply } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { parseStartup, prepareStartup } from "../src/startup"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const LEADER = "\x18"

function client(answer: (command: CommandInput) => CommandReply = () => ({ ok: true, result: { sessionId: "ses_new" } })) {
  const sent: CommandInput[] = []
  return { sent, client: { send: async (command: CommandInput) => (sent.push(command), answer(command)) } as Pick<Client, "send"> }
}

describe("a new chat from the terminal asks for the project's empty chat", () => {
  test("/new, ctrl+x n and the palette entry all send reuseEmpty and switch to the answer", async () => {
    const other = ids("session")
    const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, reply: (command) => (command.type === "session.create" ? { ok: true, result: { sessionId: other, reused: true } } : undefined) })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    await h.type("/new\r")
    const sentOf = () => h.sent.filter((command) => command.type === "session.create")
    expect(sentOf()).toHaveLength(1)
    expect(sentOf()[0]).toMatchObject({ type: "session.create", title: "", reuseEmpty: true })
    expect(h.sentOf("client.unsubscribe").length + h.subscriptions.length).toBeGreaterThan(0)
    // Already on the empty chat: opening "new" again changes nothing and creates nothing else.
    await h.type(`${LEADER}n`)
    expect(sentOf()).toHaveLength(2)
    expect(sentOf().every((command) => command.type === "session.create" && command.reuseEmpty === true)).toBe(true)
    expect(h.subscriptions.filter((entry) => entry.sessionId === other)).toHaveLength(1)
  })

  test("the session list, the title lookup and the palette ask for lists without empty chats", async () => {
    const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, reply: (command) => (command.type === "session.list" ? { ok: true, result: { sessions: [] } } : undefined) })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    await h.type("/sessions\r")
    await Bun.sleep(10)
    const lists = h.sent.filter((command) => command.type === "session.list")
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every((command) => command.type === "session.list" && command.hideEmpty === true)).toBe(true)
  })

})

describe("startup", () => {
  test("the terminal opens a blank chat through reuseEmpty; run, a title, a model and a resumed session do not", async () => {
    const tui = client()
    expect(await prepareStartup(tui.client, parseStartup([]), "/project")).toEqual({ sessionId: "ses_new" as SessionId, directory: "/project" })
    expect(tui.sent[0]).toMatchObject({ type: "session.create", directory: "/project", title: "", reuseEmpty: true })

    const run = client()
    await prepareStartup(run.client, parseStartup(["run", "go"]), "/project", "go")
    expect(run.sent[0]).toMatchObject({ type: "session.create" })
    expect(run.sent[0]).not.toHaveProperty("reuseEmpty")

    const resumed = client((command) => ({ ok: true, result: command.type === "session.get" ? { session: { directory: "/original" } } : {} }))
    const id = ids("session")
    await prepareStartup(resumed.client, parseStartup(["--session", id]), "/project")
    expect(resumed.sent.some((command) => command.type === "session.create")).toBe(false)
  })

  test("an ACP or app-server session is created without it, so it stays an explicit session", async () => {
    const acp = client()
    await prepareStartup(acp.client, parseStartup(["acp"]), "/project")
    expect(acp.sent[0]).not.toHaveProperty("reuseEmpty")
  })
})
