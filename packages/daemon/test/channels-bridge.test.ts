import { SETTINGS_APPLY, SETTINGS_PROPOSAL_LOCAL } from "../src/settings-tool"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { createChannelBridge, type BridgeHost } from "../src/channels-bridge"
import { createChannelsConfig, createPairing, resolveTelegramToken } from "../src/channels-config"
import { splitMessage, type TelegramUpdate } from "../src/channels-telegram"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const SESSION = "ses_phone" as SessionId
let update = 0

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "mend-channels-"))
  const dir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(project, { recursive: true })
  mkdirSync(dir, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let clock = 1_000
  const pairing = createPairing({ now: () => clock })
  const config = createChannelsConfig(dir)
  const messages: Array<{ chat: string; text: string; buttons?: unknown }> = []
  const documents: Array<{ chat: string; name: string; size: number }> = []
  const callbacks: Array<{ id: string; text?: string | undefined }> = []
  const sent: CommandInput[] = []
  const unwatched: string[] = []
  const answers: Record<string, (command: CommandInput) => CommandReply> = {}
  const host: BridgeHost = {
    async send(command) {
      sent.push(command)
      const custom = answers[command.type]
      if (custom) return custom(command)
      if (command.type === "session.create") return { ok: true, result: { sessionId: SESSION } }
      if (command.type === "user.submit") return { ok: true, result: { queueId: "queue_1" } }
      return { ok: true }
    },
    async watch() { return { ok: true } },
    unwatch: (id) => { unwatched.push(id) },
    mask: (_id, text) => text.replaceAll("hunter2", "[secret]"),
  }
  const bridge = createChannelBridge({
    api: {
      sendMessage: async (chat, text, buttons) => { messages.push({ chat, text, ...(buttons ? { buttons } : {}) }) },
      answerCallback: async (id, text) => { callbacks.push({ id, text }) },
      sendTyping: async () => {},
      sendDocument: async (chat, file) => { documents.push({ chat, name: file.name, size: file.bytes.length }) },
    },
    host, config, pairing, dataDir: dir, log: () => {},
  })
  const text = (chat: number, value: string, type = "private"): TelegramUpdate => ({ update_id: ++update, message: { message_id: update, chat: { id: chat, type, first_name: "Ana" }, text: value } })
  const press = (chat: number, data: string): TelegramUpdate => ({ update_id: ++update, callback_query: { id: `cb${update}`, data, message: { chat: { id: chat, type: "private" } } } })
  const event = (body: Record<string, unknown>) => bridge.onEvent({ sessionId: SESSION, seq: 1, at: 1, ...body } as unknown as SessionEvent)
  async function pair(chat = 7) {
    const { code } = pairing.create(project)
    await bridge.update(text(chat, `/pair ${code}`))
    return code
  }
  return { root, dir, project, bridge, config, pairing, messages, documents, callbacks, sent, unwatched, answers, text, press, event, pair, advance: (ms: number) => { clock += ms } }
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
