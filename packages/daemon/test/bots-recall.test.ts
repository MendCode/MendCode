import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { threadsTool } from "../src/thread-tool"
import { boot, callTool, openSession, put, say, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
const extra: string[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = (name: string) => { const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "bots-recall-"))), name); extra.push(path.dirname(dir)); put(path.join(dir, ".keep"), ""); return dir }
const bot = (body = "You review calmly.") => `---\ndescription: A calm reviewer\nmode: primary\npermission: smart\nbot:\n  shape: circle\n  color: success\n---\n${body}`
const start = async (options: Parameters<typeof boot>[0] = {}, on = true) => {
  const h = await boot(options)
  harnesses.push(h)
  put(path.join(h.dir, "agents", "calm.md"), bot())
  put(path.join(h.dir, "agents", "other.md"), bot("You are the other bot."))
  if (on) await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
  return h
}
/** A session in `directory` that runs as `agent` (none: a plain session) and has said one thing. */
async function chat(h: NativeHarness, input: { directory?: string; agent?: string; title: string; text: string; mode?: "ask" | "full" }) {
  const created = await h.client.send({ type: "session.create", directory: input.directory ?? h.project, title: input.title })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await h.client.subscribe(sessionId, 0)
  await h.client.send({ type: "session.permission.set", sessionId, mode: input.mode ?? "full" })
  if (input.agent) await h.client.send({ type: "session.agent.set", sessionId, agent: input.agent })
  await say(h, sessionId, input.text)
  return sessionId
}
const system = (h: NativeHarness, index: number) => h.requests[index]!.system as string

describe("a bot's turn knows what it has been doing", () => {
  test("the digest lists the bot's own sessions of every folder, not other bots' or plain ones, after the memory and before the hint", async () => {
    const h = await start({ steps: Array.from({ length: 8 }, () => stop("ok")) })
    const site = folder("site")
    await chat(h, { agent: "calm", title: "Fix the parser", text: "parser please" })
    await chat(h, { agent: "calm", directory: site, title: "Plan the release", text: "release please" })
    await chat(h, { agent: "other", title: "Other bot chat", text: "hi" })
    await chat(h, { title: "Plain chat", text: "hi" })
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "Prefers short answers." })
    const now = h.requests.length
    await chat(h, { agent: "calm", title: "Fresh chat", text: "what was I doing?" })
    const text = system(h, now)
    expect(text).toContain("# What you have been doing")
    expect(text).toContain('"Fix the parser"')
    expect(text).toContain(`${path.basename(site)} · "Plan the release"`.replace(path.basename(site), "site"))
    for (const hidden of ["Other bot chat", "Plain chat", "Fresh chat"]) expect(text).not.toContain(hidden)
    const at = (needle: string) => text.indexOf(needle)
    expect(at("You are calm, a MendCode bot.")).toBeLessThan(at("You review calmly."))
    expect(at("You review calmly.")).toBeLessThan(at("- Prefers short answers."))
    expect(at("- Prefers short answers.")).toBeLessThan(at("# What you have been doing"))
    expect(at("# What you have been doing")).toBeLessThan(at("threads tool lists your own chats"))
  })

  test("a saved summary is the gist; the digest asks for no model call on the turn itself", async () => {
    let completions = 0
    const h = await start({ steps: [stop("a"), stop("b")], complete: async () => { completions++; return "never on the critical path" } })
    const earlier = await chat(h, { agent: "calm", title: "Fix the parser", text: "parser please" })
    h.store.meta.set(`session.summary:${earlier}`, "Parser handles nested quotes now.")
    h.store.meta.set(`session.summary.seq:${earlier}`, String(h.store.lastSeq(earlier) ?? 0))
    const before = completions
    const now = h.requests.length
    await chat(h, { agent: "calm", title: "Fresh chat", text: "again" })
    expect(system(h, now)).toContain("— Parser handles nested quotes now.")
    expect(completions).toBe(before)
  })

  test("with the flag off a bot's turn carries no digest, no hint, and the tool is not offered", async () => {
    const h = await start({ steps: [stop("a"), stop("b")], extraTools: [threadsTool] }, false)
    await chat(h, { agent: "calm", title: "Fix the parser", text: "parser please" })
    const now = h.requests.length
    await chat(h, { agent: "calm", title: "Fresh chat", text: "again" })
    expect(system(h, now)).not.toContain("What you have been doing")
    expect(system(h, now)).not.toContain("threads tool lists your own chats")
    expect(JSON.stringify(h.requests[now]!.tools ?? [])).not.toContain("threads")
  })

  test("a plain session never gets a digest", async () => {
    const h = await start({ steps: [stop("a"), stop("b")] })
    await chat(h, { agent: "calm", title: "Fix the parser", text: "parser please" })
    const now = h.requests.length
    await chat(h, { title: "Plain", text: "hi" })
    expect(system(h, now)).not.toContain("What you have been doing")
  })
})


describe("a bot reads its own chats and notes", () => {
  const approvals = (h: NativeHarness, sessionId: SessionId) => h.events.filter((event) => event.type === "server.request" && event.sessionId === sessionId)
  const seen = (h: NativeHarness) => JSON.stringify(h.requests.at(-1)!.messages)
  const threads = (args: Record<string, unknown>) => () => callTool("threads", args)

  test("with thread_tools off a bot lists, searches and reads its own chat in another folder and its notes without being asked; the rest of the tool is refused", async () => {
    const site = folder("site")
    let other = "" as SessionId
    const h = await start({
      extraTools: [threadsTool],
      steps: [
        stop("seeded"),
        threads({ action: "list", mine: true }),
        () => callTool("threads", { action: "search", sessionId: other, text: "unique-needle" }),
        () => callTool("threads", { action: "read", sessionId: other }),
        threads({ action: "notes", text: "pnpm" }),
        stop("done"),
      ],
    })
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "Always use pnpm here." })
    other = await chat(h, { agent: "calm", directory: site, title: "Plan the release", text: "the unique-needle is in this chat" })
    const me = await chat(h, { agent: "calm", title: "Reader", text: "go", mode: "ask" })
    expect(approvals(h, me)).toEqual([])
    expect(JSON.stringify(h.requests.at(-1)!.tools)).toContain('"threads"')
    const result = seen(h)
    expect(result).toContain("Your own chats, newest first")
    expect(result).toContain(other)
    expect(result).toContain("Plan the release")
    expect(result).toContain("the unique-needle is in this chat")
    expect(result).toContain("Always use pnpm here.")
  })

  test("a bot without thread_tools gets the recall actions only: anything that writes or waits is refused by the tool itself", async () => {
    const port = { recallOnly: true } as unknown as import("@mendcode/tools").ThreadPort
    const context = { threads: port, cwd: "/", signal: new AbortController().signal } as unknown as import("@mendcode/tools").ToolContext
    for (const action of ["message", "wait", "interrupt", "merge_back", "start"] as const) {
      const result = await threadsTool.execute({ action, sessionId: "ses_0123456789", text: "x", directory: "/tmp" }, context)
      expect(result.isError).toBe(true)
      expect(result.output).toContain("is not available to a bot unless experimental.thread_tools is on")
    }
    const notes = await threadsTool.execute({ action: "notes" }, context)
    expect(notes.output).toContain("notes are for a bot's own sessions")
  })

  test("a bot sees all sessions (owner's choice): a plain chat and another bot's chat are read without asking, even in the same folder", async () => {
    let plain = "" as SessionId
    let theirs = "" as SessionId
    const h = await start({
      extraTools: [threadsTool],
      steps: [stop("a"), stop("b"), () => callTool("threads", { action: "read", sessionId: plain }), () => callTool("threads", { action: "read", sessionId: theirs }), stop("done")],
    })
    plain = await chat(h, { title: "Plain chat", text: "secret plain words" })
    theirs = await chat(h, { agent: "other", title: "Other bot chat", text: "secret other words" })
    const created = await h.client.send({ type: "session.create", directory: h.project, title: "Reader" })
    const reader = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(reader, 0)
    await h.client.send({ type: "session.permission.set", sessionId: reader, mode: "ask" })
    await h.client.send({ type: "session.agent.set", sessionId: reader, agent: "calm" })
    await h.client.send({ type: "user.submit", sessionId: reader, text: "go", attachments: [] })
    await until(() => h.store.turns.list(reader).some((turn) => turn.status !== "running"))
    expect(approvals(h, reader)).toEqual([])
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("secret plain words")
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("secret other words")
  })

  test("on the full tier, with thread_tools never set, a bot messages another session like the main agent does", async () => {
    let plain = "" as SessionId
    const h = await start({ extraTools: [threadsTool], steps: [stop("a"), () => callTool("threads", { action: "message", sessionId: plain, text: "status please" }), ...Array.from({ length: 6 }, () => stop("ok"))] })
    // Tool discovery stays off so the tool is offered at once, as in the bot that hit the refusal.
    expect((await h.client.send({ type: "settings.set", patch: { tier: "full" } })).ok).toBe(true)
    expect((await h.client.send({ type: "settings.set", patch: { experimental: { bots: true, tool_discovery: false } } })).ok).toBe(true)
    plain = await chat(h, { title: "Plain chat", text: "hi" })
    const sending = chat(h, { agent: "calm", title: "Sender", text: "ask the plain chat" })
    // The bot's own permission (smart) asks before it writes to another session, as it does for the main agent.
    await until(() => h.events.some((event) => event.type === "server.request" && event.title === "Message another session"))
    const asked = h.events.find((event) => event.type === "server.request" && event.title === "Message another session") as Extract<(typeof h.events)[number], { type: "server.request" }>
    await h.client.send({ type: "request.resolve", sessionId: asked.sessionId, requestId: asked.requestId, decision: { kind: "approve", scope: "once" } })
    await sending
    await until(() => h.requests.some((request) => JSON.stringify(request.messages).includes(`Message queued for ${plain}`)))
    expect(JSON.stringify(h.requests.map((request) => request.messages))).not.toContain("is not available to a bot")
  }, 30_000)

  test("with the flag off the threads tool is not a bot's: no recall without thread_tools", async () => {
    const h = await start({ extraTools: [threadsTool], steps: [stop("a")] }, false)
    await chat(h, { agent: "calm", title: "Reader", text: "go" })
    expect(JSON.stringify(h.requests[0]!.tools ?? [])).not.toContain("threads")
  })
})

describe("a bot keeps notes from its finished sessions", () => {
  const twoTurns = async (h: NativeHarness, agent: string | undefined) => {
    const created = await h.client.send({ type: "session.create", directory: h.project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(sessionId, 0)
    await h.client.send({ type: "session.permission.set", sessionId, mode: "full" })
    if (agent) await h.client.send({ type: "session.agent.set", sessionId, agent })
    await say(h, sessionId, "We build with pnpm and deploy through staging")
    await say(h, sessionId, "And answers go in Spanish")
    return sessionId
  }
  const notes = [
    { scope: "project" as const, category: "commands", text: "Build this repository with pnpm build" },
    { scope: "user" as const, category: "preferences", text: "Prefers answers in Spanish" },
    { scope: "user" as const, category: "preferences", text: "Prefers answers in spanish." },
    { scope: "project" as const, category: "secrets", text: "The key is sk-abcdefghijklmnopqrstuvwxyz0123456789" },
  ]
  const globalNotes = (h: NativeHarness) => { try { return readFileSync(path.join(h.dir, "bots", "calm", "memory.md"), "utf8") } catch { return "" } }

  test("after the session's review, extracted notes are appended to the bot's memory once and redacted, and its next chat starts knowing them", async () => {
    const h = await start({ steps: Array.from({ length: 6 }, () => stop("ok")), dreamEligible: () => true, extractMemory: async () => notes })
    await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryReviewEveryTurns: 2 } })
    await twoTurns(h, "calm")
    await until(() => globalNotes(h).includes("Spanish"))
    await until(() => h.store.extraction.list().length === 0)
    expect(globalNotes(h).match(/Spanish/gi)).toHaveLength(1)
    const projects = path.join(h.dir, "bots", "calm", "projects")
    const project = readFileSync(path.join(projects, readdirSync(projects)[0]!), "utf8")
    expect(project).toContain("Build this repository with pnpm build")
    expect(project).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    const now = h.requests.length
    await chat(h, { agent: "calm", title: "Next", text: "hello again" })
    expect(system(h, now)).toContain("Prefers answers in Spanish")
    expect(system(h, now)).toContain("Build this repository with pnpm build")
  })

  test("a plain session's review writes no bot memory, and neither does a bot's with the flag off", async () => {
    const h = await start({ steps: Array.from({ length: 6 }, () => stop("ok")), dreamEligible: () => true, extractMemory: async () => notes }, false)
    await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryReviewEveryTurns: 2 } })
    await twoTurns(h, undefined)
    await twoTurns(h, "calm")
    await until(() => h.store.extraction.list().length === 0)
    await Bun.sleep(50)
    expect(existsSync(path.join(h.dir, "bots"))).toBe(false)
  })
})
