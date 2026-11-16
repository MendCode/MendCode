import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { BOT_TOOLS } from "../src/bot-tools"
import { threadsTool } from "../src/thread-tool"
import { boot, callTool, hang, put, say, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup() })
const bot = (body = "You review calmly.") => `---\ndescription: A calm reviewer\nmode: primary\npermission: smart\nbot:\n  shape: circle\n  color: success\n---\n${body}`
const start = async (options: Parameters<typeof boot>[0] = {}, on = true) => {
  const h = await boot({ extraTools: [threadsTool, ...BOT_TOOLS], ...options })
  harnesses.push(h)
  put(path.join(h.dir, "agents", "calm.md"), bot())
  put(path.join(h.dir, "agents", "other.md"), bot("You are the other bot."))
  if (on) await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
  return h
}
async function open(h: NativeHarness, input: { agent?: string; title: string; mode?: "ask" | "full" }) {
  const created = await h.client.send({ type: "session.create", directory: h.project, title: input.title })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await h.client.subscribe(sessionId, 0)
  await h.client.send({ type: "session.permission.set", sessionId, mode: input.mode ?? "full" })
  if (input.agent) await h.client.send({ type: "session.agent.set", sessionId, agent: input.agent })
  return sessionId
}
const approvals = (h: NativeHarness, sessionId: SessionId) => h.events.filter((event) => event.type === "server.request" && event.sessionId === sessionId)
async function approve(h: NativeHarness, sessionId: SessionId, nth = 0) {
  await until(() => approvals(h, sessionId).length > nth)
  const request = approvals(h, sessionId)[nth]!
  if (request.type !== "server.request") throw new Error("not a request")
  await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
  return request
}
const system = (h: NativeHarness, index: number) => h.requests[index]!.system as string
const toolNames = (h: NativeHarness, index: number) => JSON.stringify(h.requests[index]!.tools ?? [])

describe("a bot schedules its own work", () => {
  test("bot_schedule asks even in full access, then makes a loop the bot owns; a run is a chat with that bot", async () => {
    const h = await start({ steps: [callTool("bot_schedule", { action: "create", name: "Morning digest", objective: "Summarize what changed overnight.", trigger: "external" }), stop("scheduled"), stop("run done")] })
    const me = await open(h, { agent: "calm", title: "Planner" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "do the digest every morning", attachments: [] })
    const request = await approve(h, me)
    expect(JSON.stringify(request)).toContain("Schedule of calm")
    await until(() => h.requests.length >= 2)
    const listed = await h.client.send({ type: "loop.list" })
    const loops = (listed.ok ? (listed.result as { loops: Array<{ loopId: string; agent?: string; sessionId: SessionId; name: string }> }).loops : [])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toMatchObject({ name: "Morning digest", agent: "calm" })
    expect(h.store.sessionAgent(loops[0]!.sessionId)).toBe("calm")
    const now = h.requests.length
    await h.client.send({ type: "loop.fire", loopId: loops[0]!.loopId as never })
    await until(() => h.requests.length > now)
    expect(system(h, now)).toContain("You are calm, a MendCode bot.")
    const bots = await h.client.send({ type: "bot.list" })
    const calm = (bots.ok ? (bots.result as { bots: Array<{ name: string; schedules?: Array<{ name: string; trigger: string }> }> }).bots : []).find((entry) => entry.name === "calm")
    expect(calm?.schedules).toEqual([expect.objectContaining({ name: "Morning digest", trigger: "external" })])
  })

  test("list shows only the bot's own schedules and cancel stops one; another bot cannot cancel it", async () => {
    const h = await start({ steps: [callTool("bot_schedule", { action: "create", name: "Weekly", objective: "Review the open PRs.", trigger: "weekly mon 09:00" }), stop("ok")] })
    const me = await open(h, { agent: "calm", title: "Planner" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "every monday", attachments: [] })
    await approve(h, me)
    await until(() => h.requests.length >= 2)
    const loops = ((await h.client.send({ type: "loop.list" })) as { ok: true; result: { loops: Array<{ loopId: string }> } }).result.loops
    const loopId = loops[0]!.loopId
    h.steps.push(callTool("bot_schedule", { action: "cancel", loopId }), stop("refused"))
    await say(h, await open(h, { agent: "other", title: "Stranger" }), "cancel it")
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain(`no schedule ${loopId} of yours`)
    h.steps.push(callTool("bot_schedule", { action: "list" }), callTool("bot_schedule", { action: "cancel", loopId }), stop("cancelled"))
    await say(h, await open(h, { agent: "calm", title: "Again" }), "what do I have, then cancel it")
    const seen = JSON.stringify(h.requests.at(-1)!.messages)
    expect(seen).toContain("weekly mon 09:00")
    expect(seen).toContain('Cancelled \\"Weekly\\"')
    const after = ((await h.client.send({ type: "loop.list" })) as { ok: true; result: { loops: Array<{ state: string }> } }).result.loops
    expect(after[0]!.state).toBe("stopped")
  })

  test("a plain session is not offered the tool and a bad trigger is reported before anything is created", async () => {
    const h = await start({ steps: [stop("a"), callTool("bot_schedule", { action: "create", name: "x", objective: "y", trigger: "whenever" }), stop("b")] })
    await say(h, await open(h, { title: "Plain" }), "hi")
    expect(toolNames(h, 0)).not.toContain("bot_schedule")
    const me = await open(h, { agent: "calm", title: "Planner" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "go", attachments: [] })
    await approve(h, me)
    await until(() => h.requests.length >= 3)
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("unknown trigger")
    const listed = (await h.client.send({ type: "loop.list" })) as { ok: true; result: { loops: unknown[] } }
    expect(listed.result.loops).toHaveLength(0)
  })
})

describe("a bot saves skills of its own", () => {
  const skill = { action: "create", name: "release-notes", description: "Write the release notes from the merged PRs", body: "1. List merged PRs\n2. Group by area\n3. Keep each line short" }

  test("the first save of a skill asks, writes into the bot's folder, and the next turn's prompt lists it", async () => {
    const h = await start({ steps: [callTool("bot_skill", skill), stop("saved"), stop("later")] })
    const me = await open(h, { agent: "calm", title: "Notes", mode: "full" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "that worked, keep it", attachments: [] })
    const request = await approve(h, me)
    expect(JSON.stringify(request)).toContain("release-notes")
    await until(() => h.requests.length >= 2)
    const file = path.join(h.dir, "bots", "calm", "skills", "release-notes", "SKILL.md")
    await until(() => existsSync(file))
    expect(readFileSync(file, "utf8")).toContain("name: release-notes")
    expect(readFileSync(file, "utf8")).toContain("Group by area")
    const now = h.requests.length
    await say(h, await open(h, { agent: "calm", title: "Later" }), "hello")
    expect(system(h, now)).toContain("# Your skills")
    expect(system(h, now)).toContain("- release-notes: Write the release notes from the merged PRs")
  })

  test("an update of an approved skill does not ask again; the skill is invisible to other bots and plain sessions", async () => {
    const h = await start({ steps: [callTool("bot_skill", skill), stop("saved"), callTool("bot_skill", { action: "update", name: "release-notes", body: "1. Use the changelog" }), stop("updated"), stop("other"), stop("plain")] })
    const me = await open(h, { agent: "calm", title: "Notes" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "save it", attachments: [] })
    await approve(h, me)
    await until(() => h.requests.length >= 2)
    await say(h, await open(h, { agent: "calm", title: "Update" }), "improve it")
    expect(approvals(h, me)).toHaveLength(1)
    expect(readFileSync(path.join(h.dir, "bots", "calm", "skills", "release-notes", "SKILL.md"), "utf8")).toContain("Use the changelog")
    const before = h.requests.length
    await say(h, await open(h, { agent: "other", title: "Other" }), "hi")
    await say(h, await open(h, { title: "Plain" }), "hi")
    expect(system(h, before)).not.toContain("release-notes")
    expect(system(h, before + 1)).not.toContain("release-notes")
    expect(existsSync(path.join(h.dir, "bots", "other", "skills"))).toBe(false)
  })

  test("a denied save writes nothing", async () => {
    const h = await start({ steps: [callTool("bot_skill", skill), stop("done")] })
    const me = await open(h, { agent: "calm", title: "Notes" })
    await h.client.send({ type: "user.submit", sessionId: me, text: "save it", attachments: [] })
    await until(() => approvals(h, me).length === 1)
    const request = approvals(h, me)[0]!
    if (request.type !== "server.request") throw new Error("not a request")
    await h.client.send({ type: "request.resolve", sessionId: me, requestId: request.requestId, decision: { kind: "deny", reason: "no" } })
    await until(() => h.store.turns.list(me).some((turn) => turn.status !== "running"))
    expect(existsSync(path.join(h.dir, "bots", "calm", "skills"))).toBe(false)
  })

  test("bot_note keeps a note in the bot's memory and the next turn knows it", async () => {
    const h = await start({ steps: [callTool("bot_note", { text: "The user wants answers in Spanish", scope: "everywhere" }), stop("noted"), stop("later")] })
    await say(h, await open(h, { agent: "calm", title: "Notes" }), "remember I like Spanish")
    expect(readFileSync(path.join(h.dir, "bots", "calm", "memory.md"), "utf8")).toContain("The user wants answers in Spanish")
    const now = h.requests.length
    await say(h, await open(h, { agent: "calm", title: "Later" }), "hello")
    expect(system(h, now)).toContain("The user wants answers in Spanish")
  })
})

describe("a bot sees every session, a plain session does not", () => {
  test("a bot in ask mode reads and searches a plain session without being asked", async () => {
    let plain = "" as SessionId
    const h = await start({ steps: [stop("plain answer"), () => callTool("threads", { action: "read", sessionId: plain }), () => callTool("threads", { action: "search", sessionId: plain, text: "needle" }), stop("done")] })
    plain = await open(h, { title: "Plain chat" })
    await say(h, plain, "the secret needle words")
    const me = await open(h, { agent: "calm", title: "Reader", mode: "ask" })
    await say(h, me, "go")
    expect(approvals(h, me)).toEqual([])
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("secret needle words")
  })

  test("a plain session still asks before reading another plain session", async () => {
    let plain = "" as SessionId
    const h = await start({ steps: [stop("a"), () => callTool("threads", { action: "read", sessionId: plain }), stop("done")], extraTools: [threadsTool] })
    await h.client.send({ type: "settings.set", patch: { experimental: { bots: true, thread_tools: true } } })
    plain = await open(h, { title: "Plain chat" })
    await say(h, plain, "private words")
    const reader = await open(h, { title: "Reader", mode: "ask" })
    await h.client.send({ type: "user.submit", sessionId: reader, text: "go", attachments: [] })
    await until(() => approvals(h, reader).length === 1)
    expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("private words")
  })
})

describe("a bot's prompt order and the flag", () => {
  test("identity, personality, skills, memory, digest, workspace overview, then the hint", async () => {
    const h = await start({ steps: [stop("first"), hang, stop("fresh")] })
    put(path.join(h.dir, "bots", "calm", "skills", "triage", "SKILL.md"), '---\nname: triage\ndescription: "Sort incoming issues"\n---\nSteps')
    await h.client.send({ type: "bot.memory", name: "calm", op: "add", text: "Prefers short answers." })
    await say(h, await open(h, { agent: "calm", title: "Earlier chat" }), "before")
    const busy = await open(h, { title: "Long refactor" })
    await h.client.send({ type: "user.submit", sessionId: busy, text: "refactor everything", attachments: [] })
    await until(() => h.requests.length >= 2)
    const now = h.requests.length
    await say(h, await open(h, { agent: "calm", title: "Fresh chat" }), "what is going on?")
    const text = system(h, now)
    const order = ["You are calm, a MendCode bot.", "You review calmly.", "# Your skills", "- Prefers short answers.", "# What you have been doing", "# Workspace now", "threads tool lists your own chats", "bot_schedule"].map((needle) => text.indexOf(needle))
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain('"Long refactor" · running')
    expect(toolNames(h, now)).toContain("bot_note")
  })

  test("with the flag off nothing of this loads: no tools, no skills index, no overview", async () => {
    const h = await start({ steps: [stop("a")] }, false)
    put(path.join(h.dir, "bots", "calm", "skills", "triage", "SKILL.md"), '---\nname: triage\ndescription: "Sort incoming issues"\n---\nSteps')
    await say(h, await open(h, { agent: "calm", title: "Chat" }), "hi")
    expect(system(h, 0)).not.toContain("# Your skills")
    expect(system(h, 0)).not.toContain("# Workspace now")
    expect(system(h, 0)).not.toContain("bot_schedule")
    for (const name of ["bot_note", "bot_skill", "bot_schedule", "threads"]) expect(toolNames(h, 0)).not.toContain(name)
  })
})
