import { SETTINGS_APPLY, SETTINGS_PROPOSAL_LOCAL } from "../src/settings-tool"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { createChannelBridge, type BridgeHost } from "../src/channels-bridge"
import { replayAfter, watchCursor } from "../src/channels"
import { channelStore, createChannelsConfig, createPairing, MAX_CHAT_TOPICS, resolveTelegramToken } from "../src/channels-config"
import { createTelegramApi, splitMessage, telegramUpdate, type TelegramUpdate } from "../src/channels-telegram"
import { balanceFences, markdownToTelegramHtml } from "../src/channels-format"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const SESSION = "ses_phone" as SessionId
let update = 0

function setup(options: { live?: boolean; topics?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mend-channels-"))
  const dir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(project, { recursive: true })
  mkdirSync(dir, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let clock = 1_000
  const pairing = createPairing({ now: () => clock })
  const config = createChannelsConfig(dir)
  const messages: Array<{ chat: string; text: string; buttons?: unknown; thread?: string; markdown?: boolean }> = []
  const topics: Array<{ chat: string; name: string; thread: string }> = []
  const documents: Array<{ chat: string; name: string; size: number }> = []
  const callbacks: Array<{ id: string; text?: string | undefined }> = []
  const sent: CommandInput[] = []
  const unwatched: string[] = []
  const watched: string[] = []
  const edits: Array<{ chat: string; id: number; text: string }> = []
  const answers: Record<string, (command: CommandInput) => CommandReply> = {}
  const hooks: { onWatch?: (id: string) => Promise<CommandReply | undefined> } = {}
  const host: BridgeHost = {
    async send(command) {
      sent.push(command)
      const custom = answers[command.type]
      if (custom) return custom(command)
      if (command.type === "session.create") return { ok: true, result: { sessionId: SESSION } }
      if (command.type === "user.submit") return { ok: true, result: { queueId: "queue_1" } }
      return { ok: true }
    },
    // `onWatch` stands for what the daemon streams while the watch starts (the replay, and live events of another chat's subscription).
    async watch(id) { watched.push(id); return (await hooks.onWatch?.(id)) ?? { ok: true } },
    unwatch: (id) => { unwatched.push(id) },
    mask: (_id, text) => text.replaceAll("hunter2", "[secret]"),
  }
  const bridge = createChannelBridge({
    api: {
      sendMessage: async (chat, text, buttons, send) => {
        if (send?.thread !== undefined && !topics.some((topic) => topic.thread === send.thread)) throw new Error("[CHANNELS]: telegram sendMessage failed: Bad Request: message thread not found")
        messages.push({ chat, text, ...(buttons ? { buttons } : {}), ...(send?.thread !== undefined ? { thread: send.thread } : {}), ...(send?.markdown ? { markdown: true } : {}) })
        return String(messages.length)
      },
      ...(options.topics ? { createTopic: async (chat: string, name: string) => { const thread = String(100 + topics.length); topics.push({ chat, name, thread }); return thread }, topicLink: (_chat: string, thread: string) => `https://t.me/mend_bot/${thread}` } : {}),
      ...(options.live ? { editMessage: async (chat: string, id: string, text: string) => { edits.push({ chat, id: Number(id), text }) } } : {}),
      answerCallback: async (id, text) => { callbacks.push({ id, text }) },
      sendTyping: async () => {},
      sendDocument: async (chat, file) => { documents.push({ chat, name: file.name, size: file.bytes.length }) },
    },
    host, store: channelStore(config, "telegram"), pairing, dataDir: dir, log: () => {}, now: () => clock,
  })
  // Updates go through the Telegram adapter, as the daemon reads them.
  const placed = (raw: TelegramUpdate) => telegramUpdate(raw)!
  const text = (chat: number, value: string, type = "private", thread?: number) => placed({ update_id: ++update, message: { message_id: update, chat: { id: chat, type, first_name: "Ana" }, text: value, ...(thread === undefined ? {} : { message_thread_id: thread, is_topic_message: true }) } })
  const press = (chat: number, data: string, thread?: number) => placed({ update_id: ++update, callback_query: { id: `cb${update}`, data, message: { chat: { id: chat, type: "private" }, ...(thread === undefined ? {} : { message_thread_id: thread, is_topic_message: true }) } } })
  // Every event gets the next seq, as the daemon's log does.
  let seq = 0
  const event = (body: Record<string, unknown>) => bridge.onEvent({ sessionId: SESSION, seq: ++seq, at: 1, ...body } as unknown as SessionEvent)
  const nextSeq = () => ++seq
  async function pair(chat = 7) {
    const { code } = pairing.create(project)
    await bridge.update(text(chat, `/pair ${code}`))
    return code
  }
  return { root, dir, project, bridge, config, pairing, messages, topics, documents, callbacks, sent, unwatched, watched, edits, answers, hooks, text, press, event, nextSeq, pair, advance: (ms: number) => { clock += ms } }
}

const lastMessage = (h: ReturnType<typeof setup>) => h.messages.at(-1)?.text ?? ""

describe("pairing", () => {
  test("an unpaired chat is ignored, a valid code pairs it once, in the code's project", async () => {
    const h = setup()
    await h.bridge.update(h.text(7, "hello"))
    await h.bridge.update(h.text(7, "/status"))
    expect(h.messages).toHaveLength(0)
    const code = await h.pair(7)
    expect(lastMessage(h)).toContain("Paired")
    expect(h.config.read().telegram.chats).toMatchObject([{ id: "7", name: "Ana", directory: h.project }])
    await h.bridge.update(h.text(8, `/pair ${code}`))
    expect(lastMessage(h)).toContain("not valid")
    expect(h.config.read().telegram.chats).toHaveLength(1)
  })

  test("codes expire and five wrong guesses silence the chat for a while", async () => {
    const h = setup()
    const { code } = h.pairing.create(h.project)
    h.advance(11 * 60_000)
    await h.bridge.update(h.text(7, `/pair ${code}`))
    expect(lastMessage(h)).toContain("not valid")
    const fresh = h.pairing.create(h.project).code
    for (let attempt = 0; attempt < 4; attempt++) await h.bridge.update(h.text(7, "/pair AAAAAAAA"))
    const before = h.messages.length
    await h.bridge.update(h.text(7, `/pair ${fresh}`))
    expect(h.messages.length).toBe(before)
    expect(h.config.read().telegram.chats).toHaveLength(0)
    h.advance(16 * 60_000)
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(h.project).code}`))
    expect(h.config.read().telegram.chats).toHaveLength(1)
  })

  test("group chats never pair or run", async () => {
    const h = setup()
    const { code } = h.pairing.create(h.project)
    await h.bridge.update(h.text(-100, `/pair ${code}`, "supergroup"))
    expect(h.messages).toHaveLength(0)
    expect(h.config.read().telegram.chats).toHaveLength(0)
  })

  test("/unpair removes the chat and stops watching its session", async () => {
    const h = setup()
    await h.pair()
    await h.bridge.update(h.text(7, "hi"))
    await h.bridge.update(h.text(7, "/unpair"))
    expect(h.config.read().telegram.chats).toHaveLength(0)
    expect(h.unwatched).toEqual([SESSION])
    await h.bridge.update(h.text(7, "hi again"))
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
  })
})

describe("turns", () => {
  test("a message runs a turn in a session of the paired project and the answer comes back, masked", async () => {
    const h = setup()
    await h.pair()
    await h.bridge.update(h.text(7, "fix the bug"))
    expect(h.sent.find((command) => command.type === "session.create")).toMatchObject({ directory: h.project })
    expect(h.sent.find((command) => command.type === "user.submit")).toMatchObject({ sessionId: SESSION, text: "fix the bug" })
    expect(h.config.read().telegram.chats[0]!.sessionId).toBe(SESSION)
    h.event({ type: "turn.started", turnId: "t1", queueId: "queue_1" })
    h.event({ type: "item.started", turnId: "t1", itemId: "i1", kind: "agent_message" })
    h.event({ type: "item.delta", turnId: "t1", itemId: "i1", text: "password is " })
    h.event({ type: "item.delta", turnId: "t1", itemId: "i1", text: "hunter2" })
    h.event({ type: "turn.completed", turnId: "t1" })
    expect(lastMessage(h)).toBe("password is [secret]")
  })

  test("events that arrive before the submit ack are not lost, and other turns' events are ignored", async () => {
    const h = setup()
    await h.pair()
    h.answers["user.submit"] = () => {
      h.event({ type: "turn.started", turnId: "t9", queueId: "other" })
      h.event({ type: "turn.started", turnId: "t1", queueId: "queue_1" })
      h.event({ type: "item.started", turnId: "t1", itemId: "i1", kind: "agent_message" })
      h.event({ type: "item.delta", turnId: "t1", itemId: "i1", text: "early" })
      h.event({ type: "turn.completed", turnId: "t1" })
      return { ok: true, result: { queueId: "queue_1" } }
    }
    await h.bridge.update(h.text(7, "go"))
    expect(lastMessage(h)).toBe("early")
  })

  test("a second message during a turn is refused; /stop cancels the turn; failures are reported", async () => {
    const h = setup()
    await h.pair()
    await h.bridge.update(h.text(7, "long job"))
    await h.bridge.update(h.text(7, "another"))
    expect(lastMessage(h)).toContain("/stop")
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
    await h.bridge.update(h.text(7, "/stop"))
    expect(lastMessage(h)).toContain("still starting")
    h.event({ type: "turn.started", turnId: "t1", queueId: "queue_1" })
    await h.bridge.update(h.text(7, "/stop"))
    expect(h.sent.at(-1)).toMatchObject({ type: "turn.cancel", sessionId: SESSION, turnId: "t1" })
    h.event({ type: "turn.cancelled", turnId: "t1" })
    expect(lastMessage(h)).toBe("Stopped.")
    await h.bridge.update(h.text(7, "again"))
    h.event({ type: "turn.started", turnId: "t2", queueId: "queue_1" })
    h.event({ type: "turn.failed", turnId: "t2", error: { code: "provider", message: "rate limited" } })
    expect(lastMessage(h)).toBe("Failed: provider: rate limited")
  })

  test("a rejected submit is reported and leaves the chat free", async () => {
    const h = setup()
    await h.pair()
    h.answers["user.submit"] = () => ({ ok: false, error: { code: "invalid_command", message: "no model" } })
    await h.bridge.update(h.text(7, "go"))
    expect(lastMessage(h)).toContain("no model")
    h.answers["user.submit"] = () => ({ ok: true, result: { queueId: "queue_2" } })
    await h.bridge.update(h.text(7, "go again"))
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(2)
  })

  test("/new starts a fresh session; unknown commands never reach the model", async () => {
    const h = setup()
    await h.pair()
    await h.bridge.update(h.text(7, "one"))
    h.event({ type: "turn.started", turnId: "t1", queueId: "queue_1" })
    h.event({ type: "turn.completed", turnId: "t1" })
    await h.bridge.update(h.text(7, "/new"))
    expect(h.config.read().telegram.chats[0]!.sessionId).toBeUndefined()
    await h.bridge.update(h.text(7, "/frobnicate"))
    expect(lastMessage(h)).toContain("Unknown command")
    await h.bridge.update(h.text(7, "two"))
    expect(h.sent.filter((command) => command.type === "session.create")).toHaveLength(2)
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(2)
  })
})

describe("approvals and questions", () => {
  async function waiting(h: ReturnType<typeof setup>) {
    await h.pair()
    await h.bridge.update(h.text(7, "write it"))
    h.event({ type: "turn.started", turnId: "t1", queueId: "queue_1" })
  }

  test("an approval is asked with buttons; Allow once resolves it once, for that chat only", async () => {
    const h = setup()
    await waiting(h)
    h.event({ type: "server.request", turnId: "t1", requestId: "req_1", kind: "approval", title: "write file", detail: "token hunter2 in notes.txt", tool: "write", permission: "write" })
    expect(lastMessage(h)).toContain("Approve write?")
    expect(lastMessage(h)).not.toContain("hunter2")
    const buttons = JSON.stringify(h.messages.at(-1)!.buttons)
    const allow = /ap:\d+:y/.exec(buttons)![0]
    await h.bridge.update(h.press(99, allow))
    expect(h.sent.some((command) => command.type === "request.resolve")).toBe(false)
    await h.bridge.update(h.press(7, allow))
    expect(h.sent.at(-1)).toMatchObject({ type: "request.resolve", sessionId: SESSION, requestId: "req_1", decision: { kind: "approve", scope: "once" } })
    expect(h.callbacks.at(-1)?.text).toBe("Allowed")
    await h.bridge.update(h.press(7, allow))
    expect(h.callbacks.at(-1)?.text).toBe("Expired")
    expect(h.sent.filter((command) => command.type === "request.resolve")).toHaveLength(1)
  })

  test("Deny sends a denial; a request resolved elsewhere stops being answerable", async () => {
    const h = setup()
    await waiting(h)
    h.event({ type: "server.request", turnId: "t1", requestId: "req_1", kind: "approval", title: "run", detail: "rm -rf x", tool: "shell", permission: "execute" })
    const deny = /ap:\d+:n/.exec(JSON.stringify(h.messages.at(-1)!.buttons))![0]
    await h.bridge.update(h.press(7, deny))
    expect(h.sent.at(-1)).toMatchObject({ decision: { kind: "deny" } })
    h.event({ type: "server.request", turnId: "t1", requestId: "req_2", kind: "approval", title: "run", detail: "ls", tool: "shell", permission: "execute" })
    const second = /ap:\d+:y/.exec(JSON.stringify(h.messages.at(-1)!.buttons))![0]
    h.event({ type: "server.request.resolved", requestId: "req_2", resolution: "approved" })
    await h.bridge.update(h.press(7, second))
    expect(h.callbacks.at(-1)?.text).toBe("Expired")
  })

  test("a question takes a button or a typed reply; plan reviews are left to the computer", async () => {
    const h = setup()
    await waiting(h)
    h.event({ type: "server.request", turnId: "t1", requestId: "req_q", kind: "question", title: "Which store?", detail: "", options: [{ label: "SQLite" }, { label: "Postgres" }] })
    const second = /q:\d+:1/.exec(JSON.stringify(h.messages.at(-1)!.buttons))![0]
    await h.bridge.update(h.press(7, second))
    expect(h.sent.at(-1)).toMatchObject({ requestId: "req_q", decision: { kind: "answer", text: "Postgres" } })
    h.event({ type: "server.request", turnId: "t1", requestId: "req_t", kind: "question", title: "Name?", detail: "" })
    await h.bridge.update(h.text(7, "Ada"))
    expect(h.sent.at(-1)).toMatchObject({ requestId: "req_t", decision: { kind: "answer", text: "Ada" } })
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
    h.event({ type: "server.request", turnId: "t1", requestId: "req_p", kind: "approval", title: "Plan", detail: "", planReview: { title: "x" } })
    expect(lastMessage(h)).toContain("on the computer")
  })

  test("a settings change only the machine running MendCode sets has no buttons and a typed reply never answers it", async () => {
    const h = setup()
    await waiting(h)
    h.event({ type: "server.request", turnId: "t1", requestId: "req_s", kind: "question", title: SETTINGS_PROPOSAL_LOCAL, detail: "defaultPermission: \"ask\" → \"full\"", options: [{ label: SETTINGS_APPLY }, { label: "Don't apply" }] })
    expect(h.messages.at(-1)!.buttons).toBeUndefined()
    expect(lastMessage(h)).toContain("on the computer that runs MendCode")
    await h.bridge.update(h.text(7, SETTINGS_APPLY))
    expect(h.sent.some((command) => command.type === "request.resolve" && command.requestId === "req_s")).toBe(false)
  })
})

describe("/file", () => {
  test("sends a project file and refuses escapes, credentials, private data and oversized files", async () => {
    const h = setup()
    await h.pair()
    writeFileSync(path.join(h.project, "notes.txt"), "hello")
    mkdirSync(path.join(h.project, "sub"))
    writeFileSync(path.join(h.project, "sub", "a.md"), "# a")
    writeFileSync(path.join(h.project, ".env"), "KEY=1")
    writeFileSync(path.join(h.project, "server.pem"), "pem")
    mkdirSync(path.join(h.project, ".git"))
    writeFileSync(path.join(h.project, ".git", "config"), "x")
    writeFileSync(path.join(h.dir, "remote-tokens.json"), "{}")
    writeFileSync(path.join(h.root, "outside.txt"), "outside")
    symlinkSync(path.join(h.root, "outside.txt"), path.join(h.project, "link.txt"))
    await h.bridge.update(h.text(7, "/file notes.txt"))
    await h.bridge.update(h.text(7, "/file sub/a.md"))
    expect(h.documents).toEqual([{ chat: "7", name: "notes.txt", size: 5 }, { chat: "7", name: "a.md", size: 3 }])
    for (const refused of [".env", "server.pem", ".git/config", "../outside.txt", "link.txt", "../remote-tokens.json", "missing.txt", "sub", "/etc/hosts", ""]) {
      await h.bridge.update(h.text(7, `/file ${refused}`))
      expect(lastMessage(h)).toContain("Not sent")
    }
    expect(h.documents).toHaveLength(2)
  })
})

describe("helpers", () => {
  test("long answers split under Telegram's limit, at line breaks when possible", () => {
    const text = Array.from({ length: 300 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n")
    const parts = splitMessage(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3800)
    expect(parts.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""))
  })

  test("the token file must be private and well formed; the environment wins", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-channels-token-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const good = "123456789:AAEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e"
    expect(resolveTelegramToken({ dir, env: {} })).toBeUndefined()
    writeFileSync(path.join(dir, "telegram-token"), `${good}\n`, { mode: 0o644 })
    expect(resolveTelegramToken({ dir, env: {} })).toEqual({ error: "the Telegram token file must be private (chmod 600)" })
    rmSync(path.join(dir, "telegram-token"))
    writeFileSync(path.join(dir, "telegram-token"), `${good}\n`, { mode: 0o600 })
    expect(resolveTelegramToken({ dir, env: {} })).toEqual({ token: good })
    expect(resolveTelegramToken({ dir, env: { MENDCODE_TELEGRAM_TOKEN: "nonsense" } })).toMatchObject({ error: expect.any(String) })
    expect(resolveTelegramToken({ dir, env: { MENDCODE_TELEGRAM_TOKEN: "987654321:BBEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e" } })).toEqual({ token: "987654321:BBEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e" })
  })
})

describe("following the terminal's session", () => {
  const TERMINAL = "ses_terminal" as SessionId
  const history = { turns: [
    { turnId: "t1", at: 1, seq: 1, preview: "first", outcome: "completed", items: [{ itemId: "u1", kind: "user_message", text: "add a login page", status: "ok" }, { itemId: "a1", kind: "agent_message", text: "Added it; the password is hunter2", status: "ok" }] },
    { turnId: "t2", at: 2, seq: 5, preview: "second", outcome: "cancelled", items: [{ itemId: "u2", kind: "user_message", text: "now the tests", status: "ok" }] },
  ], older: 1 }

  async function pairWithTerminal(h: ReturnType<typeof setup>) {
    h.answers["session.history"] = () => ({ ok: true, result: history })
    const { code } = h.pairing.create(h.project, TERMINAL)
    await h.bridge.update(h.text(7, `/pair ${code}`))
  }
  const terminalEvent = (h: ReturnType<typeof setup>, body: Record<string, unknown>) => h.bridge.onEvent({ sessionId: TERMINAL, seq: h.nextSeq(), at: 1, ...body } as unknown as SessionEvent)

  test("a code made in a session pairs the chat to that session and shows its last turns, masked", async () => {
    const h = setup()
    await pairWithTerminal(h)
    expect(h.watched).toEqual([TERMINAL])
    expect(h.config.read().telegram.chats[0]!.sessionId).toBe(TERMINAL)
    expect(h.sent.find((command) => command.type === "session.history")).toMatchObject({ sessionId: TERMINAL, limit: 5 })
    const recap = lastMessage(h)
    expect(recap).toContain("Last 2 turns")
    expect(recap).toContain("**You:** add a login page\n**MendCode:** Added it; the password is [secret]")
    expect(recap).toContain("**You:** now the tests\n_(cancelled)_")
    // The phone continues that session; no new one is made.
    await h.bridge.update(h.text(7, "and the docs"))
    expect(h.sent.some((command) => command.type === "session.create")).toBe(false)
    expect(h.sent.find((command) => command.type === "user.submit")).toMatchObject({ sessionId: TERMINAL, text: "and the docs" })
  })

  test("a turn typed in the terminal shows in the chat: the prompt, then the answer", async () => {
    const h = setup()
    await pairWithTerminal(h)
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "u7", kind: "user_message" })
    terminalEvent(h, { type: "item.completed", itemId: "u7", status: "ok", text: "rename the hunter2 helper" })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "a7", kind: "agent_message" })
    terminalEvent(h, { type: "item.delta", itemId: "a7", text: "Renamed." })
    terminalEvent(h, { type: "turn.completed", turnId: "t7" })
    await Bun.sleep(0)
    expect(h.messages.slice(-2).map((message) => message.text)).toEqual(["**From the computer:**\nrename the [secret] helper", "Renamed."])
    // The next terminal turn is followed too.
    terminalEvent(h, { type: "turn.started", turnId: "t8", queueId: "queue_terminal_2" })
    terminalEvent(h, { type: "turn.failed", turnId: "t8", error: { code: "provider", message: "rate limited" } })
    await Bun.sleep(0)
    expect(lastMessage(h)).toBe("Failed: provider: rate limited")
  })

  test("an approval asked in a terminal turn can be answered from the phone; /stop cancels that turn", async () => {
    const h = setup()
    await pairWithTerminal(h)
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "server.request", turnId: "t7", requestId: "r1", kind: "approval", title: "Run bash", detail: "rm -rf build", tool: "bash" })
    const approval = h.messages.at(-1)!
    expect(approval.text).toContain("Approve bash?")
    const data = (approval.buttons as Array<Array<{ data: string }>>)[0]![0]!.data
    await h.bridge.update(h.press(7, data))
    expect(h.sent.find((command) => command.type === "request.resolve")).toMatchObject({ sessionId: TERMINAL, requestId: "r1", decision: { kind: "approve", scope: "once" } })
    await h.bridge.update(h.text(7, "/stop"))
    expect(h.sent.find((command) => command.type === "turn.cancel")).toMatchObject({ sessionId: TERMINAL, turnId: "t7" })
  })

  test("the live progress is one message, edited, closed with the outcome before the answer", async () => {
    const h = setup({ live: true })
    await pairWithTerminal(h)
    const before = h.messages.length
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "c1", kind: "tool_call", meta: { tool: "bash ls" } })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "c2", kind: "tool_call", meta: { tool: "injected recall", injected: true } })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "c3", kind: "tool_call", meta: { tool: "read a.ts" } })
    await Bun.sleep(0)
    expect(h.messages.slice(before).map((message) => message.text)).toEqual(["Working · 1 tool · bash ls · 0s"])
    h.advance(42_000)
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "a7", kind: "agent_message" })
    terminalEvent(h, { type: "item.delta", itemId: "a7", text: "All good." })
    terminalEvent(h, { type: "turn.completed", turnId: "t7" })
    await Bun.sleep(0)
    await Bun.sleep(0)
    const progressId = before + 1
    expect(h.edits.at(-1)).toEqual({ chat: "7", id: progressId, text: "Done · 2 tools · 42s" })
    expect(h.messages.slice(before).map((message) => message.text)).toEqual(["Working · 1 tool · bash ls · 0s", "All good."])
  })

  test("/sessions lists the project's sessions as buttons and moves the chat; /history shows more turns", async () => {
    const h = setup()
    await pairWithTerminal(h)
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [
      { sessionId: TERMINAL, title: "Login page", state: "idle" },
      { sessionId: "ses_other", title: "Release notes", state: "generating" },
    ] } })
    await h.bridge.update(h.text(7, "/sessions"))
    expect(h.sent.find((command) => command.type === "session.list")).toMatchObject({ directory: h.project, roots: true, hideEmpty: true })
    const pick = h.messages.at(-1)!
    expect((pick.buttons as Array<Array<{ text: string; data: string }>>).map((row) => row[0]!.text)).toEqual(["• Login page", "Release notes (working)"])
    const buttonOf = (message: typeof pick, row: number) => (message.buttons as Array<Array<{ data: string }>>)[row]![0]!.data
    await h.bridge.update(h.press(7, buttonOf(pick, 1)))
    expect(h.callbacks.at(-1)?.text).toBe("Switched")
    expect(h.unwatched).toContain(TERMINAL)
    expect(h.watched.at(-1)).toBe("ses_other")
    expect(h.config.read().telegram.chats[0]!.sessionId).toBe("ses_other")
    await h.bridge.update(h.text(7, "/history 50"))
    expect(h.sent.filter((command) => command.type === "session.history").at(-1)).toMatchObject({ sessionId: "ses_other", limit: 20 })
  })

  test("a button of an older /sessions list still picks the session it names, not the one now at its place", async () => {
    const h = setup()
    await pairWithTerminal(h)
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: TERMINAL, title: "Login page", state: "idle" }, { sessionId: "ses_other", title: "Release notes", state: "idle" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    const older = h.messages.at(-1)!
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: "ses_third", title: "Docs", state: "idle" }, { sessionId: TERMINAL, title: "Login page", state: "idle" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, (older.buttons as Array<Array<{ data: string }>>)[1]![0]!.data))
    expect(h.config.read().telegram.chats[0]!.sessionId).toBe("ses_other")
    // A session no list offered is refused.
    await h.bridge.update(h.press(7, "s:ses_never"))
    expect(h.callbacks.at(-1)?.text).toBe("Expired")
  })

  test("leaving a session drops its open questions: the next message runs in the new session", async () => {
    const h = setup()
    await pairWithTerminal(h)
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "server.request", turnId: "t7", requestId: "r1", kind: "question", title: "Which port?", detail: "" })
    const question = h.messages.at(-1)!
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: "ses_other", title: "Release notes", state: "idle" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, "s:ses_other"))
    await h.bridge.update(h.text(7, "8080"))
    expect(h.sent.some((command) => command.type === "request.resolve")).toBe(false)
    expect(h.sent.find((command) => command.type === "user.submit")).toMatchObject({ sessionId: "ses_other", text: "8080" })
    expect(question.text).toContain("Which port?")
  })

  test("two chats on one session: one leaving keeps the other subscribed, and each reads an event once", async () => {
    const h = setup()
    await pairWithTerminal(h)
    const { code } = h.pairing.create(h.project, TERMINAL)
    await h.bridge.update(h.text(8, `/pair ${code}`))
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "item.started", turnId: "t7", itemId: "a7", kind: "agent_message" })
    terminalEvent(h, { type: "item.delta", itemId: "a7", text: "Both see it." })
    terminalEvent(h, { type: "turn.completed", turnId: "t7" })
    await Bun.sleep(0)
    expect(h.messages.filter((message) => message.text === "Both see it.").map((message) => message.chat)).toEqual(["7", "8"])
    await h.bridge.update(h.text(8, "/new"))
    expect(h.unwatched).not.toContain(TERMINAL)
    await h.bridge.update(h.text(7, "/new"))
    expect(h.unwatched).toContain(TERMINAL)
  })

  test("live events that arrive before the replay while a chat joins are held: the joining chat reads the whole turn in order", async () => {
    const h = setup()
    await pairWithTerminal(h)
    const at = (seq: number, body: Record<string, unknown>) => h.bridge.onEvent({ sessionId: "ses_other", seq, at: 1, ...body } as unknown as SessionEvent)
    h.hooks.onWatch = async (id) => {
      if (id !== "ses_other") return undefined
      // Another chat already follows ses_other: a live event streams before the replay of the running turn.
      at(52, { type: "item.started", turnId: "t5", itemId: "c2", kind: "tool_call", meta: { tool: "bash" } })
      at(50, { type: "turn.started", turnId: "t5", queueId: "queue_terminal" })
      at(51, { type: "server.request", turnId: "t5", requestId: "r5", kind: "approval", title: "Run bash", detail: "make", tool: "bash" })
      return undefined
    }
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: "ses_other", title: "Release notes", state: "generating" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, "s:ses_other"))
    expect(h.messages.some((message) => message.text.startsWith("**Approve bash?**"))).toBe(true)
    await h.bridge.update(h.text(7, "/stop"))
    expect(h.sent.find((command) => command.type === "turn.cancel")).toMatchObject({ sessionId: "ses_other", turnId: "t5" })
  })

  test("a phone message while a terminal turn runs is refused, not left as a turn that never starts; after the answer it runs", async () => {
    const h = setup()
    await pairWithTerminal(h)
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    await h.bridge.update(h.text(7, "and the docs"))
    expect(lastMessage(h)).toBe("A turn from the computer is running. Wait for its answer, or /stop it.")
    expect(h.sent.some((command) => command.type === "user.submit")).toBe(false)
    terminalEvent(h, { type: "turn.completed", turnId: "t7" })
    await Bun.sleep(0)
    await h.bridge.update(h.text(7, "and the docs"))
    // Queued: a terminal turn that starts meanwhile cannot take it in, so it starts a turn of its own that names it.
    expect(h.sent.find((command) => command.type === "user.submit")).toMatchObject({ sessionId: TERMINAL, text: "and the docs", delivery: "queue" })
  })

  test("a replay for a joining chat reads the log to its end however many pages, and fails when a page does not advance", async () => {
    const pages = (total: number, size: number) => async (after: number) => {
      const events = Array.from({ length: Math.min(size, total - after) }, (_, index) => ({ seq: after + index + 1 }) as unknown as SessionEvent)
      return { ok: true as const, window: { events, lastSeq: after + events.length, more: after + events.length < total } }
    }
    const seen: number[] = []
    expect(await replayAfter(pages(12_345, 200), 0, (event) => void seen.push(event.seq))).toEqual({ ok: true })
    expect(seen).toHaveLength(12_345)
    expect(seen.at(-1)).toBe(12_345)
    const stuck = await replayAfter(async () => ({ ok: true as const, window: { events: [], lastSeq: 5, more: true } }), 5, () => {})
    expect(stuck.ok).toBe(false)
  })

  test("the watch cursor: after the log's end, or from a running turn's start when that is earlier", () => {
    expect(watchCursor(120, undefined)).toBe(120)
    expect(watchCursor(120, 100)).toBe(99)
    // A turn that started after the end was read is past the cursor already, so it replays from there.
    expect(watchCursor(120, 125)).toBe(120)
  })

  test("a chat unpaired while its watch starts gets nothing that was held, and the watch is released", async () => {
    const h = setup()
    await pairWithTerminal(h)
    h.hooks.onWatch = async (id) => {
      if (id !== "ses_other") return undefined
      h.bridge.onEvent({ sessionId: "ses_other", seq: 50, at: 1, type: "turn.started", turnId: "t5", queueId: "queue_terminal" } as unknown as SessionEvent)
      h.bridge.onEvent({ sessionId: "ses_other", seq: 51, at: 1, type: "server.request", turnId: "t5", requestId: "r5", kind: "approval", title: "Run bash", detail: "secret plan", tool: "bash" } as unknown as SessionEvent)
      // `/remote-control unpair` on the computer, as createChannels.change does it.
      h.config.update((value) => { value.telegram.chats = [] })
      h.bridge.forget("7")
      return undefined
    }
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: "ses_other", title: "Release notes", state: "generating" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, "s:ses_other"))
    // The history went out while the chat was still paired; nothing held during the watch does.
    expect(h.messages.some((message) => message.text.includes("secret plan") || message.text.startsWith("**Approve"))).toBe(false)
    expect(h.unwatched).toContain("ses_other")
  })

  test("a switch whose watch fails leaves the chat on its session with its running turn and open question", async () => {
    const h = setup()
    await pairWithTerminal(h)
    terminalEvent(h, { type: "turn.started", turnId: "t7", queueId: "queue_terminal" })
    terminalEvent(h, { type: "server.request", turnId: "t7", requestId: "r1", kind: "question", title: "Which port?", detail: "" })
    h.hooks.onWatch = async (id) => (id === "ses_gone" ? { ok: false, error: { code: "unknown_session", message: "no such session" } } as CommandReply : undefined)
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: "ses_gone", title: "Deleted", state: "idle" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, "s:ses_gone"))
    expect(h.callbacks.at(-1)?.text).toBe("Not switched")
    expect(h.config.read().telegram.chats[0]!.sessionId).toBe(TERMINAL)
    await h.bridge.update(h.text(7, "8080"))
    expect(h.sent.find((command) => command.type === "request.resolve")).toMatchObject({ sessionId: TERMINAL, requestId: "r1", decision: { kind: "answer", text: "8080" } })
    await h.bridge.update(h.text(7, "/stop"))
    expect(h.sent.find((command) => command.type === "turn.cancel")).toMatchObject({ sessionId: TERMINAL, turnId: "t7" })
  })

  test("a session joined while its turn runs is followed from that turn's start (the watch replays it)", async () => {
    const h = setup()
    await pairWithTerminal(h)
    // The replay arrives again on the shared client when a second chat joins: the first chat ignores what it already read.
    const replay = (seq: number, body: Record<string, unknown>) => h.bridge.onEvent({ sessionId: TERMINAL, seq, at: 1, ...body } as unknown as SessionEvent)
    replay(100, { type: "turn.started", turnId: "t9", queueId: "queue_terminal" })
    replay(101, { type: "server.request", turnId: "t9", requestId: "r9", kind: "approval", title: "Run bash", detail: "make", tool: "bash" })
    replay(100, { type: "turn.started", turnId: "t9", queueId: "queue_terminal" })
    replay(101, { type: "server.request", turnId: "t9", requestId: "r9", kind: "approval", title: "Run bash", detail: "make", tool: "bash" })
    expect(h.messages.filter((message) => message.text.startsWith("**Approve bash?**"))).toHaveLength(1)
    await h.bridge.update(h.text(7, "/stop"))
    expect(h.sent.find((command) => command.type === "turn.cancel")).toMatchObject({ sessionId: TERMINAL, turnId: "t9" })
  })

  test("a paired chat that claims a new code moves to its session; a wrong code keeps it paired", async () => {
    const h = setup()
    await h.pair()
    await h.bridge.update(h.text(7, "/pair WRONGCOD"))
    expect(lastMessage(h)).toContain("stays paired")
    expect(h.config.read().telegram.chats).toHaveLength(1)
    await pairWithTerminal(h)
    expect(h.config.read().telegram.chats).toMatchObject([{ id: "7", sessionId: TERMINAL }])
  })

  test("after a restart the bridge follows each chat's session again before any phone message", async () => {
    const h = setup()
    await pairWithTerminal(h)
    h.watched.length = 0
    await h.bridge.resume()
    expect(h.watched).toEqual([TERMINAL])
  })
})

describe("topics: several sessions and projects in one chat", () => {
  const A = "ses_alpha" as SessionId
  const B = "ses_beta" as SessionId
  const on = (h: ReturnType<typeof setup>, sessionId: SessionId, body: Record<string, unknown>) => h.bridge.onEvent({ sessionId, seq: h.nextSeq(), at: 1, ...body } as unknown as SessionEvent)
  const answer = (h: ReturnType<typeof setup>, sessionId: SessionId, turnId: string, text: string) => {
    on(h, sessionId, { type: "turn.started", turnId, queueId: `q_${turnId}` })
    on(h, sessionId, { type: "item.started", turnId, itemId: `a_${turnId}`, kind: "agent_message" })
    on(h, sessionId, { type: "item.delta", itemId: `a_${turnId}`, text })
    on(h, sessionId, { type: "turn.completed", turnId })
  }

  test("each pairing opens a topic: sessions of two projects are followed at once, each in its own topic", async () => {
    const h = setup({ topics: true })
    const other = path.join(h.root, "other")
    mkdirSync(other)
    h.answers["session.history"] = () => ({ ok: true, result: { turns: [] } })
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(h.project, A).code}`))
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(other, B).code}`))
    expect(h.topics.map((topic) => topic.name)).toEqual(["project", "other"])
    expect(h.config.read().telegram.chats[0]!.topics).toEqual([{ thread: "100", directory: h.project, sessionId: A }, { thread: "101", directory: other, sessionId: B }])
    expect(h.watched).toEqual([A, B])
    expect(h.messages.at(-1)).toMatchObject({ chat: "7", buttons: [[{ text: "Open the topic", url: "https://t.me/mend_bot/101" }]] })
    expect(h.messages.at(-1)!.thread).toBeUndefined()

    answer(h, A, "t1", "**alpha** done")
    answer(h, B, "t2", "beta done")
    await Bun.sleep(0)
    expect(h.messages.slice(-2)).toMatchObject([{ thread: "100", text: "**alpha** done", markdown: true }, { thread: "101", text: "beta done", markdown: true }])

    await h.bridge.update(h.text(7, "ship it", "private", 101))
    expect(h.sent.filter((command) => command.type === "user.submit").at(-1)).toMatchObject({ sessionId: B, text: "ship it" })
    expect(h.sent.some((command) => command.type === "session.create")).toBe(false)

    h.watched.length = 0
    h.bridge.stop()
    await h.bridge.resume()
    expect(h.watched).toEqual([A, B])
  })

  test("a /sessions pick and /new open topics; a topic made in Telegram gets its own session; a deleted topic is dropped", async () => {
    const h = setup({ topics: true })
    await h.pair()
    h.answers["session.history"] = () => ({ ok: true, result: { turns: [] } })
    h.answers["session.list"] = () => ({ ok: true, result: { sessions: [{ sessionId: A, title: "Release notes", state: "idle" }] } })
    await h.bridge.update(h.text(7, "/sessions"))
    await h.bridge.update(h.press(7, `s:${A}`))
    expect(h.topics.at(-1)).toMatchObject({ name: "project · Release notes", thread: "100" })
    expect(h.callbacks.at(-1)?.text).toBe("Opened")
    expect(h.watched).toEqual([A])
    await h.bridge.update(h.press(7, `s:${A}`))
    expect(h.callbacks.at(-1)?.text).toBe("Already open")
    expect(h.topics).toHaveLength(1)

    await h.bridge.update(h.text(7, "/new"))
    expect(h.topics.at(-1)).toMatchObject({ name: "project · new", thread: "101" })
    expect(h.messages.find((message) => message.thread === "101")?.text).toContain("Fresh session")
    await h.bridge.update(h.text(7, "start here", "private", 101))
    expect(h.sent.find((command) => command.type === "session.create")).toMatchObject({ directory: h.project })
    expect(h.config.read().telegram.chats[0]!.topics?.find((topic) => topic.thread === "101")?.sessionId).toBe(SESSION)

    // The user deleted topic 100: the next message there fails, and its session stops being followed.
    h.topics.splice(0, 1)
    answer(h, A, "t3", "late answer")
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(h.config.read().telegram.chats[0]!.topics?.map((topic) => topic.thread)).toEqual(["101"])
    expect(h.unwatched).toContain(A)
  })

  test("stopping releases every topic's session; past the cap the oldest topic is let go with its session", async () => {
    const h = setup({ topics: true })
    const other = path.join(h.root, "other")
    mkdirSync(other)
    h.answers["session.history"] = () => ({ ok: true, result: { turns: [] } })
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(h.project, A).code}`))
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(other, B).code}`))
    h.bridge.stop()
    expect(h.unwatched).toEqual(expect.arrayContaining([A, B]))

    await h.bridge.resume()
    h.unwatched.length = 0
    // Two topics are open (A's and B's): these fill the cap.
    for (let opened = 0; opened < MAX_CHAT_TOPICS - 2; opened++) await h.bridge.update(h.text(7, "/new"))
    const stored = () => h.config.read().telegram.chats[0]!.topics ?? []
    expect(stored()).toHaveLength(MAX_CHAT_TOPICS)
    expect(h.unwatched).toEqual([])
    await h.bridge.update(h.text(7, "/new"))
    expect(stored()).toHaveLength(MAX_CHAT_TOPICS)
    expect(stored().some((topic) => topic.sessionId === A)).toBe(false)
    expect(h.unwatched).toEqual([A])
  })

  test("without topic mode a second pairing still moves the chat", async () => {
    const h = setup()
    h.answers["session.history"] = () => ({ ok: true, result: { turns: [] } })
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(h.project, A).code}`))
    await h.bridge.update(h.text(7, `/pair ${h.pairing.create(h.project, B).code}`))
    expect(h.topics).toHaveLength(0)
    expect(h.config.read().telegram.chats).toMatchObject([{ id: "7", sessionId: B }])
  })
})

describe("formatting for Telegram", () => {
  test("the model's Markdown becomes Telegram HTML: bold, code, links, lists, quotes, tables and code blocks, all escaped", () => {
    const html = markdownToTelegramHtml([
      "## Result",
      "Fixed **two things** in `src/a_b.ts` and *also* snake_case_name <here>.",
      "- see [docs](https://x.dev/a_b?c=1&d=2)",
      "  - nested **bold *italic***",
      "> a quote",
      "",
      "| File | Lines |",
      "|---|---|",
      "| a.ts | **12** |",
      "",
      "```ts",
      "if (a < b && c) {}",
      "```",
      "- [x] done",
    ].join("\n"))
    expect(html).toBe([
      "<b>Result</b>",
      "Fixed <b>two things</b> in <code>src/a_b.ts</code> and <i>also</i> snake_case_name &lt;here&gt;.",
      "• see <a href=\"https://x.dev/a_b?c=1&amp;d=2\">docs</a>",
      "   • nested <b>bold <i>italic</i></b>",
      "<blockquote>a quote</blockquote>",
      "",
      "<pre>File  Lines\n────  ─────\na.ts  12</pre>",
      "",
      "<pre><code class=\"language-ts\">if (a &lt; b &amp;&amp; c) {}</code></pre>",
      "☑ done",
    ].join("\n"))
  })

  test("a link whose label is code keeps the label", () => {
    expect(markdownToTelegramHtml("see [`src/a.ts`](https://x.dev/a)")).toBe("see <a href=\"https://x.dev/a\"><code>src/a.ts</code></a>")
  })

  test("a part that formatting makes longer than Telegram allows goes as its plain text", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const api = createTelegramApi({
      token: "123456789:AAEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return Response.json({ ok: true, result: { message_id: bodies.length } })
      }) as unknown as typeof fetch,
    })
    const table = ["| Name | N |", "|---|---|", `| ${"x".repeat(100)} | 1 |`, ...Array.from({ length: 45 }, (_, row) => `| r${row} | ${row} |`)].join("\n")
    expect(table.length).toBeLessThan(3800)
    expect(markdownToTelegramHtml(table).length).toBeGreaterThan(4096)
    await api.sendMessage("7", table, undefined, { markdown: true })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: table })
    expect(bodies[0]!.parse_mode).toBeUndefined()
  })

  test("a code block split between two messages is closed and opened again", () => {
    expect(balanceFences(["intro\n```js\nconst a = 1", "const b = 2\n```\nafter"])).toEqual(["intro\n```js\nconst a = 1\n```", "```js\nconst b = 2\n```\nafter"])
  })

  test("formatted sends go to the topic as HTML, and a part Telegram cannot parse is sent again as plain text", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const api = createTelegramApi({
      token: "123456789:AAEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e",
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        if (body.parse_mode && String(body.text).includes("broken")) return Response.json({ ok: false, description: "Bad Request: can't parse entities: unexpected end tag" }, { status: 400 })
        return Response.json({ ok: true, result: { message_id: bodies.length } })
      }) as unknown as typeof fetch,
    })
    await api.sendMessage("7", "**hi**", undefined, { thread: 100, markdown: true })
    expect(bodies[0]).toMatchObject({ chat_id: "7", message_thread_id: 100, parse_mode: "HTML", text: "<b>hi</b>" })
    await api.sendMessage("7", "broken **x**", undefined, { markdown: true })
    expect(bodies.slice(1)).toMatchObject([{ parse_mode: "HTML" }, { text: "broken **x**" }])
    expect(bodies[2]!.parse_mode).toBeUndefined()
    await api.sendMessage("7", "plain *text*")
    expect(bodies[3]).toMatchObject({ text: "plain *text*" })
    expect(bodies[3]!.parse_mode).toBeUndefined()
  })
})
