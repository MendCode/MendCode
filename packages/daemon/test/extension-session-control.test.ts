import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { EXTENSION_DIALOGS_CAPABILITY } from "@mendcode/extension-api"
import { createNativeEngine, joinSystemParts, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { ExtensionsReport, ModelInfo, SessionEvent, SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { resolveModel } from "../src/models"
import { systemPartsWith } from "../src/extensions"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const seen = () => ((globalThis as { __gapCalls?: unknown[] }).__gapCalls ??= [])

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const echo = (name: string) => defineTool({ name, description: `${name} text`, permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: text, truncated: false, title: name, isError: false }) })
const MODELS: ModelInfo[] = [
  { id: "m-small", name: "Small", efforts: ["low", "high"], contextWindow: 100_000 },
  { id: "m-large", name: "Large", efforts: ["low", "high"], contextWindow: 200_000 },
  { id: "claude-x", name: "Claude X", efforts: [], engine: "claude" },
]

async function boot(setup: (input: { user: string; project: string }) => void, options: { capabilities?: string[] } = {}) {
  ;(globalThis as { __gapCalls?: unknown[] }).__gapCalls = []
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-gap-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-gap-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  setup({ user: dir, project })
  const requests: ModelRequest[] = []
  const provider: ModelProvider = { id: "scripted", model: "m-small", async *stream(request) { requests.push({ ...request, messages: structuredClone(request.messages) }); yield* stop(`answer ${requests.length}`) } }
  const catalog = { selectable: true, list: () => MODELS, defaults: { model: "m-small" } }
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    extensionHookTimeoutMs: 2_000,
    models: catalog,
    engine: ({ store, extensions, runLimits }) => {
      const tools = [echo("echo"), echo("shout")]
      extensions.setBuiltinTools(tools)
      return createNativeEngine({
        provider,
        tools,
        history: memoryHistory(),
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: (root) => joinSystemParts(systemPartsWith({ files: extensions.prompts.read(root), root, packaged: () => "BASE", rest: [] })),
        compactionPrompt: () => "SUMMARIZE",
        hooks: extensions.hooks,
        runLimits: (sessionId) => runLimits.get(sessionId),
        modelFor: (sessionId, role) => resolveModel({ role, session: store.sessionModel(sessionId), roles: {}, catalog }),
        projectTools: (root, sessionId) => extensions.tools(root, sessionId),
      })
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "gap", ...(options.capabilities ? { capabilities: options.capabilities } : {}), onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  const finished = () => events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length
  async function say(text: string) {
    const before = finished()
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (ack.ok && ack.result?.handled !== true) await until(() => finished() > before)
    return ack
  }
  const list = async () => ((await client.send({ type: "extensions.list", directory: project })) as { result?: ExtensionsReport }).result!.extensions
  return { dir, project, client, sessionId, events, requests, say, finished, list }
}

const notice = (ack: { ok: boolean; result?: Record<string, unknown> }) => String(ack.result?.notice ?? "")

describe("an extension controls its session the way /model, a narrower tool list and a typed message do", () => {
  test("setModel and setThinkingLevel change the next model call; an unknown model, another engine or an unlisted effort is refused", async () => {
    const h = await boot(({ user }) => put(user, "extensions/model.ts", extension("model", `
      api.registerCommand({ name: "big", description: "large model", run: async (_a, { sessionId }) => ({ notice: JSON.stringify([await api.setModel(sessionId, "m-large"), await api.setThinkingLevel(sessionId, "high"), api.getModel(sessionId)]) }) })
      api.registerCommand({ name: "bad", description: "refused", run: async (_a, { sessionId }) => ({ notice: JSON.stringify([await api.setModel(sessionId, "nope"), await api.setModel(sessionId, "claude-x"), await api.setThinkingLevel(sessionId, "max")]) }) })`)))
    await h.say("first")
    expect(h.requests[0]!.model).toBe("m-small")
    const changed = JSON.parse(notice(await h.say("/big")))
    expect(changed).toEqual([{ ok: true }, { ok: true }, { model: "m-large", effort: "high" }])
    await h.say("second")
    expect(h.requests.at(-1)).toMatchObject({ model: "m-large", effort: "high" })
    const refused = JSON.parse(notice(await h.say("/bad"))) as Array<{ ok: boolean; error?: string }>
    expect(refused.map((entry) => entry.ok)).toEqual([false, false, false])
    expect(refused[0]!.error).toContain("unknown model nope")
    expect(refused[1]!.error).toContain("another engine")
    expect(refused[2]!.error).toContain("effort max")
  })

  test("setActiveTools narrows the offered tools from the next call, never adds one, and null lifts it", async () => {
    const h = await boot(({ user }) => put(user, "extensions/tools.ts", extension("tools", `
      api.registerCommand({ name: "quiet", description: "only echo", run: (_a, { sessionId }) => ({ notice: JSON.stringify([api.setActiveTools(sessionId, ["echo", "not_a_tool"]), api.getActiveTools(sessionId)]) }) })
      api.registerCommand({ name: "loud", description: "every tool", run: (_a, { sessionId }) => ({ notice: JSON.stringify(api.setActiveTools(sessionId, null)) }) })`)))
    await h.say("one")
    expect(h.requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["echo", "shout"]))
    expect(JSON.parse(notice(await h.say("/quiet")))).toEqual([{ ok: true }, ["echo", "not_a_tool"]])
    await h.say("two")
    expect(h.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(["echo"])
    await h.say("/loud")
    await h.say("three")
    expect(h.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["echo", "shout"]))
  })

  test("sendUserMessage queues a user message that starts a turn; a turn.end loop stops at 5 a minute", async () => {
    const h = await boot(({ user }) => put(user, "extensions/again.ts", extension("again", `
      api.on("turn.end", async (e) => { globalThis.__gapCalls.push(await api.sendUserMessage(e.sessionId, "keep going")) })`)))
    await h.say("start")
    await until(() => h.finished() >= 6)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.finished()).toBe(6)
    expect(h.requests.slice(1).every((request) => JSON.stringify(request.messages.at(-1)).includes("keep going"))).toBe(true)
    const answers = seen() as Array<{ ok: boolean; error?: string }>
    expect(answers.slice(0, 5).every((answer) => answer.ok)).toBe(true)
    expect(answers[5]).toMatchObject({ ok: false, error: expect.stringContaining("at most 5") })
  })
})

describe("per-session entries and events between extensions", () => {
  test("appendEntry keeps records in the extension's data folder, never in the model's context; events reach listeners of other extensions", async () => {
    const h = await boot(({ user }) => {
      put(user, "extensions/a-notes.ts", extension("notes", `
        api.on("turn.end", (e) => { api.appendEntry(e.sessionId, "turn", { outcome: e.outcome }); api.events.emit("notes:turn", { sessionId: e.sessionId }) })
        api.registerCommand({ name: "notes", description: "count", run: (_a, { sessionId }) => ({ notice: JSON.stringify([api.entries(sessionId).length, api.entries(sessionId, "turn")[0], api.appendEntry(sessionId, "Bad Type!", 1), api.appendEntry("no-such-session", "turn", 1)]) }) })`))
      put(user, "extensions/b-listener.ts", extension("listener", `api.events.on("notes:turn", (data, meta) => { globalThis.__gapCalls.push({ data, from: meta.from }) })`))
    })
    await h.say("one")
    await h.say("two")
    await until(() => seen().length >= 2)
    const [count, first, badType, unknown] = JSON.parse(notice(await h.say("/notes")))
    expect(count).toBe(2)
    expect(first).toMatchObject({ type: "turn", data: { outcome: "completed" } })
    expect([badType, unknown]).toEqual([false, false])
    expect(seen()[0]).toEqual({ data: { sessionId: h.sessionId }, from: "notes" })
    const file = path.join(h.dir, "extensions-data/notes/sessions", `${h.sessionId}.jsonl`)
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2)
    expect(JSON.stringify(h.requests.map((request) => request.messages))).not.toContain("outcome")
    expect((await h.list()).find((entry) => entry.name === "listener")?.events).toEqual(["notes:turn"])
    expect((await h.list()).find((entry) => entry.name === "notes")?.errors.join(" ")).toContain("unknown session")
    await h.client.send({ type: "session.delete", sessionId: h.sessionId })
    await until(() => !existsSync(file))
  })
})

describe("extension flags", () => {
  test("extensions.flags keeps the values a CLI invocation passed; an unknown name or a wrong type is refused", async () => {
    const h = await boot(({ user }) => put(user, "extensions/flags.ts", extension("flags", `
      api.registerFlag("plan-first", { type: "boolean", description: "start in plan mode", default: false })
      api.registerFlag("ticket", { type: "string", description: "the ticket" })
      api.registerCommand({ name: "flags", description: "show", run: (_a, { sessionId }) => ({ notice: JSON.stringify([api.getFlag("plan-first", sessionId), api.getFlag("ticket", sessionId), api.getFlag("plan-first")]) }) })`)))
    expect(JSON.parse(notice(await h.say("/flags")))).toEqual([false, null, false])
    const unknown = await h.client.send({ type: "extensions.flags", sessionId: h.sessionId, flags: { nope: true } })
    expect(unknown.ok ? "" : unknown.error.message).toContain("unknown flag --nope; extension flags: --plan-first, --ticket")
    const typed = await h.client.send({ type: "extensions.flags", sessionId: h.sessionId, flags: { ticket: true } })
    expect(typed.ok ? "" : typed.error.message).toContain("--ticket needs a value")
    const set = await h.client.send({ type: "extensions.flags", sessionId: h.sessionId, flags: { "plan-first": true, ticket: "ABC-12" } })
    expect(set.ok).toBe(true)
    expect(JSON.parse(notice(await h.say("/flags")))).toEqual([true, "ABC-12", false])
    expect((await h.list())[0]?.flags).toEqual(["plan-first", "ticket"])
  })
})

describe("dialogs from daemon hooks", () => {
  const dialogs = extension("ask", `
    api.registerCommand({ name: "ask", description: "asks", run: async (_a, { sessionId }) => ({ notice: JSON.stringify([await api.ui.confirm(sessionId, "Deploy", "Deploy now?", { default: false, timeoutMs: 1500 }), await api.ui.select(sessionId, "Env", ["dev", "prod"], { default: "dev", timeoutMs: 1500 })]) }) })
    api.registerCommand({ name: "nodefault", description: "no default", run: async (_a, { sessionId }) => ({ notice: JSON.stringify(await api.ui.confirm(sessionId, "x", "y", {})) }) })`)

  test("with no terminal that draws dialogs (a headless run), each answers its default at once", async () => {
    const h = await boot(({ user }) => put(user, "extensions/ask.ts", dialogs))
    const started = Date.now()
    expect(JSON.parse(notice(await h.say("/ask")))).toEqual([false, "dev"])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(h.events.some((event) => event.type === "server.request")).toBe(false)
    expect(JSON.parse(notice(await h.say("/nodefault")))).toBe(false)
    expect((await h.list())[0]?.errors.join(" ")).toContain("options.default")
  })

  test("a terminal that declared extension-dialogs gets them as questions; an answer is used, an unanswered one takes its default and is withdrawn", async () => {
    const h = await boot(({ user }) => put(user, "extensions/ask.ts", dialogs), { capabilities: [EXTENSION_DIALOGS_CAPABILITY] })
    const pending = h.say("/ask")
    await until(() => h.events.some((event) => event.type === "server.request"))
    const request = h.events.find((event): event is Extract<SessionEvent, { type: "server.request" }> => event.type === "server.request")!
    expect(request).toMatchObject({ kind: "question", async: true, questions: [{ question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }], custom: false }] })
    expect(request.questions?.[0]?.context).toContain("takes its default")
    await h.client.send({ type: "request.resolve", sessionId: h.sessionId, requestId: request.requestId, decision: { kind: "answer", text: "Yes", answers: [["Yes"]] } })
    // The second dialog is left alone: it times out into "dev".
    expect(JSON.parse(notice(await pending))).toEqual([true, "dev"])
    const resolutions = h.events.filter((event): event is Extract<SessionEvent, { type: "server.request.resolved" }> => event.type === "server.request.resolved").map((event) => event.resolution)
    expect(resolutions).toEqual(["answered", "abandoned"])
  })
})
