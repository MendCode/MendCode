import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseAgentFile } from "@mendcode/packages"
import { AgentCreateReport, BotListReport } from "@mendcode/protocol"
import { botStateOf, lookFromText, type BotConnector } from "../src/bot-service"
import { boot, hang, openSession, put, say, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
const extra: string[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const start = async (options: Parameters<typeof boot>[0] = {}, on = true) => {
  const h = await boot(options)
  harnesses.push(h)
  if (on) await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
  return h
}
const error = (ack: { ok: boolean }) => (ack as { ok: false; error: { code: string; message: string } }).error
const result = <T>(ack: { ok: boolean; result?: unknown }) => { if (!ack.ok) throw new Error(JSON.stringify(ack)); return (ack as { result: T }).result }
const folder = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "bots-proj-"))); extra.push(dir); return dir }
const botFile = (extraLines = "", body = "You review.") => `---\ndescription: A calm reviewer\nmode: primary\npermission: smart\nbot:\n  shape: circle\n  color: success\n${extraLines}---\n${body}`
const list = async (h: NativeHarness) => BotListReport.parse(result(await h.client.send({ type: "bot.list" })))

describe("the bots flag", () => {
  test("every bot command is refused while the flag is off, and a bot file is an ordinary agent", async () => {
    const h = await start({ steps: [stop("ok")] }, false)
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    for (const command of [{ type: "bot.list" }, { type: "bot.create", directory: h.project, description: "x" }, { type: "bot.duplicate", name: "calm", newName: "calm2" }, { type: "bot.file", name: "calm" }, { type: "bot.memory", name: "calm", op: "list" }] as const) {
      expect(error(await h.client.send(command as never))).toMatchObject({ code: "forbidden", message: expect.stringContaining("/experimental bots on") })
    }
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "calm" })
    await say(h, sessionId, "hi")
    expect(h.requests[0]!.system).toBe("BASE\n\n# Agent: calm\n\nYou review.")
    // Nothing is stored for bots: no memory folder, so a session costs the same bytes as before bots existed.
    expect(existsSync(path.join(h.dir, "bots"))).toBe(false)
  })

  test("the first turn with the flag on loads the memory reader; a bot's memory reaches that very turn", async () => {
    const h = await start({ steps: [stop("ok")] }, false)
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    put(path.join(h.dir, "bots", "calm", "memory.md"), "- Prefers short answers.\n")
    await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "calm" })
    await say(h, sessionId, "hi")
    expect(h.requests[0]!.system).toContain("- Prefers short answers.")
  })
})

describe("bot.list", () => {
  test("lists the bots of the user's layer with identity and origin, and an empty external slot", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    put(path.join(h.dir, "agents", "plain.md"), "---\ndescription: Not a bot\n---\nPlain.")
    put(path.join(h.project, ".mendcode", "agents", "local.md"), botFile())
    const report = await list(h)
    expect(report.external).toEqual([])
    expect(report.bots.map((bot) => bot.name)).toEqual(["calm"])
    expect(report.bots[0]).toMatchObject({ name: "calm", identity: { shape: "circle", color: "success", origin: "mendcode" }, permission: "smart", state: "idle", projects: [], file: path.join(h.dir, "agents", "calm.md") })
  })

  test("groups the bot's sessions by project directory; the state follows its sessions", async () => {
    const h = await start({ steps: [hang, stop("done")] })
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    const other = folder()
    const first = await openSession(h)
    const second = result<{ sessionId: typeof first }>(await h.client.send({ type: "session.create", directory: other })).sessionId
    await h.client.subscribe(second, 0)
    await h.client.send({ type: "session.permission.set", sessionId: second, mode: "full" })
    for (const sessionId of [first, second]) await h.client.send({ type: "session.agent.set", sessionId, agent: "calm" })
    // An unrelated session of the same project never counts.
    await openSession(h)
    let report = await list(h)
    expect(report.bots[0]!.state).toBe("idle")
    expect(report.bots[0]!.projects.map((project) => [project.directory, project.sessions.map((session) => session.sessionId)])).toEqual([[h.project, [first]], [other, [second]]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) as never)

    // The first session works (the scripted model hangs): the bot works, that project too, the other stays idle.
    await h.client.send({ type: "user.submit", sessionId: first, text: "go", attachments: [] })
    await until(() => h.requests.length === 1)
    report = await list(h)
    expect(report.bots[0]!.state).toBe("working")
    expect(Object.fromEntries(report.bots[0]!.projects.map((project) => [project.directory, project.state]))).toEqual({ [h.project]: "working", [other]: "idle" })
  })

  test("a session that failed makes a problem, unless another session still works", async () => {
    const h = await start({ steps: [() => { throw new Error("provider down") }] })
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "calm" })
    await h.client.send({ type: "user.submit", sessionId, text: "go", attachments: [] })
    await until(() => h.store.lastTurnStatus(sessionId) === "failed")
    expect((await list(h)).bots[0]).toMatchObject({ state: "problem", projects: [{ state: "problem" }] })
  })

  test("what connectors list is carried in external, and a failing connector is a problem, not an error", async () => {
    const h = await boot({})
    harnesses.push(h)
    // The slot is typed: a connector answers ExternalBotInfo rows. Exercised on the service because no connector ships yet.
    const { listBots } = await import("../src/bot-service")
    const good: BotConnector = { id: "hermes", list: async () => [{ origin: "hermes", id: "h-1", name: "Hermes", state: "working" }] }
    const bad: BotConnector = { id: "broken", list: async () => { throw new Error("socket closed") } }
    const report = await listBots({ dir: h.dir, agents: () => ({ directory: h.dir, agents: [], problems: [] }), sessions: () => [], connectors: () => [good, bad] })
    expect(BotListReport.safeParse(report).success).toBe(true)
    expect(report.external).toEqual([{ origin: "hermes", id: "h-1", name: "Hermes", state: "working" }])
    expect(report.problems).toEqual([{ file: "connector:broken", message: "socket closed" }])
  })

  test("the bot state: a waiting session first, then working, then a failure, else idle", () => {
    expect(botStateOf([])).toBe("idle")
    expect(botStateOf(["idle", "completed", "cancelled"])).toBe("idle")
    expect(botStateOf(["completed", "failed"])).toBe("problem")
    expect(botStateOf(["failed", "running"])).toBe("working")
    expect(botStateOf(["running", "waiting_for_approval", "failed"])).toBe("waiting")
    expect(botStateOf(["waiting_for_input"])).toBe("waiting")
  })
})

describe("making bots", () => {
  test("bot.create writes the agent file with a bot block and smart permission, and the bot is listed", async () => {
    const h = await start()
    const created = result<unknown>(await h.client.send({ type: "bot.create", directory: h.project, name: "calm", description: "a calm green reviewer" }))
    expect(AgentCreateReport.safeParse(created).success).toBe(true)
    const file = path.join(h.dir, "agents", "calm.md")
    expect(created).toMatchObject({ file, generation: "deterministic", callsProviders: false })
    const parsed = parseAgentFile({ text: readFileSync(file, "utf8"), stem: "calm", file, source: "user" })
    expect(parsed).toMatchObject({ agent: { name: "calm", mode: "primary", permission: "smart", bot: { color: "success", origin: "mendcode" } } })
    expect((await list(h)).bots.map((bot) => bot.name)).toEqual(["calm"])
    // The name is taken by now, whether as a bot or as any other agent.
    expect(error(await h.client.send({ type: "bot.create", directory: h.project, name: "calm", description: "again" })).message).toContain("already")
    expect(error(await h.client.send({ type: "bot.create", directory: h.project, name: "build", description: "no" })).message).toContain("already")
  })

  test("from a description in chat: the model names it and writes the prompt, the look comes from the words", async () => {
    const calls: string[] = []
    const h = await start({ complete: async (request) => { calls.push(request.prompt); return JSON.stringify({ identifier: "Calm Reviewer", whenToUse: "Use this agent when a diff needs a gentle review.", systemPrompt: "You are a calm reviewer." }) } })
    const created = result<{ file: string; generation: string; callsProviders: boolean }>(await h.client.send({ type: "bot.create", directory: h.project, description: "a calm green reviewer", generate: true }))
    expect(created).toMatchObject({ generation: "model", callsProviders: true, file: path.join(h.dir, "agents", "calm-reviewer.md") })
    expect(calls[0]).toContain("a calm green reviewer")
    const text = readFileSync(created.file, "utf8")
    expect(text).toContain("permission: smart")
    expect(parseAgentFile({ text, stem: "calm-reviewer", file: created.file, source: "user" })).toMatchObject({ agent: { prompt: "You are a calm reviewer.", bot: { color: "success" } } })
  })

  test("when generation fails the plain template is written and the reason is reported", async () => {
    const h = await start({ complete: async () => "not json" })
    const created = result<{ fallback?: string; generation: string }>(await h.client.send({ type: "bot.create", directory: h.project, name: "plainer", description: "a red square tester", generate: true }))
    expect(created).toMatchObject({ generation: "deterministic", fallback: expect.stringContaining("unusable") })
    expect(readFileSync(path.join(h.dir, "agents", "plainer.md"), "utf8")).toContain("shape: square")
  })

  test("color and shape words of a request", () => {
    expect(lookFromText("a calm green reviewer")).toEqual({ color: "success" })
    expect(lookFromText("a Red triangular tester")).toEqual({ color: "error", shape: "triangle" })
    expect(lookFromText("someone who reads logs")).toEqual({})
  })

  test("bot.duplicate copies the file under a new name, keeps the original and refuses a taken name", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "calm.md"), botFile("name: calm\n"))
    const copy = result<{ file: string }>(await h.client.send({ type: "bot.duplicate", name: "calm", newName: "calm-2" }))
    expect(copy.file).toBe(path.join(h.dir, "agents", "calm-2.md"))
    expect(readFileSync(copy.file, "utf8")).toContain("name: calm-2")
    expect(readFileSync(path.join(h.dir, "agents", "calm.md"), "utf8")).toContain("name: calm\n")
    expect((await list(h)).bots.map((bot) => bot.name)).toEqual(["calm", "calm-2"])
    expect(error(await h.client.send({ type: "bot.duplicate", name: "calm", newName: "calm-2" })).message).toContain("already")
    expect(error(await h.client.send({ type: "bot.duplicate", name: "nobody", newName: "x" })).message).toContain("no bot named nobody")
  })
})

describe("editing a bot's file", () => {
  test("reads the file, saves a valid change and refuses one that breaks the agent or stops it being this bot", async () => {
    const h = await start()
    const file = path.join(h.dir, "agents", "calm.md")
    put(file, botFile())
    const read = result<{ text: string; saved: boolean }>(await h.client.send({ type: "bot.file", name: "calm" }))
    expect(read).toMatchObject({ text: readFileSync(file, "utf8"), saved: false })
    const changed = read.text.replace("You review.", "You review gently.")
    expect(result<{ saved: boolean }>(await h.client.send({ type: "bot.file", name: "calm", text: changed })).saved).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(changed)
    for (const text of ["---\nbot:\n  shape: blob\n---\nx", changed.replace(/bot:[\s\S]*---\nYou/, "---\nYou"), changed.replace("description:", "name: other\ndescription:")]) {
      expect(error(await h.client.send({ type: "bot.file", name: "calm", text })).message).toContain("[BOT]")
    }
    expect(readFileSync(file, "utf8")).toBe(changed)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })
})

describe("a bot's memory", () => {
  test("one memory everywhere and one per project, read into that bot's prompt only", async () => {
    const h = await start({ steps: [stop("a"), stop("b"), stop("c"), stop("d")] })
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    put(path.join(h.dir, "agents", "other.md"), botFile("", "You are other."))
    const elsewhere = folder()
    mkdirSync(elsewhere, { recursive: true })
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "Prefers short answers." })
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", scope: "project", directory: h.project, text: "This repo uses tabs." })
    const listed = result<{ global: string; project: string }>(await h.client.send({ type: "bot.memory", name: "calm", op: "list", directory: h.project }))
    expect(listed).toEqual({ global: "- Prefers short answers.", project: "- This repo uses tabs." })
    expect(result<{ project: string }>(await h.client.send({ type: "bot.memory", name: "calm", op: "list", directory: elsewhere })).project).toBe("")

    const here = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId: here, agent: "calm" })
    await say(h, here, "hi")
    expect(h.requests[0]!.system).toContain("## Everywhere\n- Prefers short answers.")
    expect(h.requests[0]!.system).toContain("## This project")
    expect(h.requests[0]!.system).toContain("- This repo uses tabs.")

    const away = result<{ sessionId: typeof here }>(await h.client.send({ type: "session.create", directory: elsewhere })).sessionId
    await h.client.subscribe(away, 0)
    await h.client.send({ type: "session.permission.set", sessionId: away, mode: "full" })
    await h.client.send({ type: "session.agent.set", sessionId: away, agent: "calm" })
    await say(h, away, "hi")
    expect(h.requests[1]!.system).toContain("- Prefers short answers.")
    expect(h.requests[1]!.system).not.toContain("tabs")

    const stranger = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId: stranger, agent: "other" })
    await say(h, stranger, "hi")
    expect(h.requests[2]!.system).not.toContain("short answers")

    const plain = await openSession(h)
    await say(h, plain, "hi")
    expect(h.requests[3]!.system).not.toContain("Bot memory")
  })

  test("clear empties one memory, secrets are redacted, a full file refuses, and only a real bot has memory", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "key sk-abcdefghijklmnopqrstuvwxyz0123456789 here" })
    expect(result<{ global: string }>(await h.client.send({ type: "bot.memory", name: "calm", op: "list" })).global).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(result<{ global: string }>(await h.client.send({ type: "bot.memory", name: "calm", op: "clear" })).global).toBe("")
    for (let i = 0; i < 20; i++) await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "x".repeat(500) })
    expect(error(await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "y".repeat(600) })).message).toContain("full")
    expect(error(await h.client.send({ type: "bot.memory", name: "nobody", op: "list" })).message).toContain("no bot named")
    expect(error(await h.client.send({ type: "bot.memory", name: "calm", op: "add", scope: "project", text: "needs a directory" })).message).toContain("directory")
  })

  test("with the flag off a bot's memory is not read into its prompt", async () => {
    const h = await start({ steps: [stop("a")] })
    put(path.join(h.dir, "agents", "calm.md"), botFile())
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "Prefers short answers." })
    await h.client.send({ type: "settings.set", patch: { experimental: { bots: false } } })
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "calm" })
    await say(h, sessionId, "hi")
    expect(h.requests[0]!.system).not.toContain("short answers")
  })
})
