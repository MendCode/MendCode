import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, createResponsesProvider, joinSystemParts, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { ExtensionsReport, GlobalEvent, SessionEvent, SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { systemPartsWith } from "../src/extensions"

const cleanups: Array<() => Promise<void> | void> = []
const calls = () => ((globalThis as { __extCalls?: string[] }).__extCalls ??= [])
beforeEach(() => {
  ;(globalThis as { __extCalls?: string[] }).__extCalls = []
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`
const push = (expression: string) => `globalThis.__extCalls.push(${expression})`

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown, callId = `call-${name}`): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]

function scripted(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted: the model must not be called here")
      yield* step
    },
  }
  return { provider, requests }
}

const echoTool = defineTool({ name: "echo", description: "echo text", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: text, truncated: false, title: "echo", isError: false }) })

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

type Boot = {
  steps?: ModelEvent[][]
  provider?: ModelProvider
  hookTimeoutMs?: number
  setup?(input: { user: string; project: string }): void
}

async function boot(options: Boot = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-ext-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-ext-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  options.setup?.({ user: dir, project })
  const script = scripted(options.steps ?? [])
  const logs: string[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    extensionHookTimeoutMs: options.hookTimeoutMs ?? 200,
    engine: ({ store, extensions }) => {
      const tools = [echoTool]
      extensions.setBuiltinTools(tools)
      return createNativeEngine({
        provider: options.provider ?? script.provider,
        tools,
        history: memoryHistory(),
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: (root) => joinSystemParts(systemPartsWith({ files: extensions.prompts.read(root), root, packaged: (r) => `BASE ${r}`, rest: [] })),
        systemParts: (root) => systemPartsWith({ files: extensions.prompts.read(root), root, packaged: (r) => `BASE ${r}`, rest: [] }),
        compactionPrompt: (root) => extensions.prompts.read(root).compaction ?? "SUMMARIZE",
        hooks: extensions.hooks,
        projectTools: (root, sessionId) => extensions.tools(root, sessionId),
      })
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const globals: GlobalEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "ext", onEvent: (event) => void events.push(event), onGlobal: (event) => void globals.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  const finished = () => events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed").length
  /** Submits a message and waits until its turn (and any compaction) has finished. */
  async function say(text: string) {
    const before = finished()
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (ack.ok && ack.result?.handled !== true) await until(() => finished() > before)
    return ack
  }
  const list = async () => {
    const reply = await client.send({ type: "extensions.list", directory: project })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result as ExtensionsReport).extensions
  }
  return { dir, project, client, sessionId, events, globals, say, list, logs, requests: script.requests, daemon }
}

const toolMessages = (request: ModelRequest) => request.messages.filter((m) => m.role === "tool")

describe("extension hooks in a native-engine session", () => {
  test("tool.before blocks or rewrites arguments and tool.after rewrites what the model sees", async () => {
    const { say, requests } = await boot({
      steps: [callTool("echo", { text: "hi" }), stop("one"), callTool("echo", { text: "secret" }, "call-2"), stop("two")],
      setup: ({ user }) => {
        put(user, "extensions/guard.ts", extension("guard", `api.on("tool.before", (e) => (e.args.text === "secret" ? { block: "no secrets here" } : { args: { text: e.args.text + "!" } }))
          api.on("tool.after", (e) => ({ output: e.output + " [seen by " + e.tool + "]" }))`))
      },
    })
    await say("first")
    expect(toolMessages(requests[1]!)).toMatchObject([{ name: "echo", output: "hi! [seen by echo]", isError: false }])
    await say("second")
    // A blocked call never ran, so tool.after does not see it: the model gets exactly the reason.
    expect(toolMessages(requests[3]!).at(-1)).toMatchObject({ output: "no secrets here", isError: true })
  })

  test("a hook that throws and one that times out are skipped and recorded; the turn still completes", async () => {
    const { say, list, requests, logs } = await boot({
      hookTimeoutMs: 60,
      steps: [callTool("echo", { text: "x" }), stop("finished")],
      setup: ({ user }) => {
        put(user, "extensions/1-throws.ts", extension("thrower", `api.on("tool.before", () => { throw new Error("boom") }); api.on("prompt.system", () => { throw new Error("boom too") }); api.on("turn.start", () => { throw new Error("observer boom") })`))
        put(user, "extensions/2-slow.ts", extension("slow", `api.on("tool.after", () => new Promise((resolve) => setTimeout(() => resolve({ output: "too late" }), 1000))); api.on("context", () => new Promise(() => {}))`))
        put(user, "extensions/3-fine.ts", extension("fine", `api.on("tool.after", (e) => ({ output: e.output + " fine" }))`))
      },
    })
    await say("go")
    expect(toolMessages(requests[1]!)).toMatchObject([{ output: "x fine" }])
    expect(requests[0]!.system.startsWith("BASE ")).toBe(true)
    const errors = Object.fromEntries((await list()).map((e) => [e.name, e.errors]))
    expect(errors.thrower).toContain("tool.before: boom")
    expect(errors.thrower).toContain("prompt.system: boom too")
    expect(errors.slow).toContain("tool.after: timed out after 60 ms")
    expect(errors.slow).toContain("context: timed out after 60 ms")
    expect(errors.fine).toEqual([])
    expect(logs.filter((line) => line.includes("thrower"))).toHaveLength(1)
  })

  test("input rewrites the text before it becomes a turn, and handled swallows it with a notice and no turn", async () => {
    const { say, events, requests } = await boot({
      steps: [stop("ok")],
      setup: ({ user }) => {
        put(user, "extensions/input.ts", extension("input", `api.on("input", (e) => (e.text === "ping" ? { handled: true, notice: "pong" } : { text: e.text + " (via extension)" }))`))
      },
    })
    const handled = await say("ping")
    expect(handled).toMatchObject({ ok: true, result: { handled: true, notice: "pong" } })
    expect(events.some((e) => e.type === "queue.added")).toBe(false)
    expect(requests).toHaveLength(0)
    const accepted = await say("hello")
    expect(accepted).toMatchObject({ ok: true, result: { queueId: expect.any(String) } })
    expect(requests[0]!.messages[0]).toMatchObject({ role: "user", content: "hello (via extension)" })
    expect(events.find((e) => e.type === "queue.added")).toMatchObject({ text: "hello (via extension)" })
  })

  test("session.start, turn.start and turn.end are reported with their ids and outcome", async () => {
    const { say, sessionId, client, project } = await boot({
      steps: [stop("a")],
      setup: ({ user }) => {
        put(user, "extensions/life.ts", extension("life", `api.on("session.start", (e) => { ${push(`"start:" + e.cwd + ":" + (e.parentId ?? "-")`)} }); api.on("turn.start", (e) => { ${push(`"turn:" + e.text`)} }); api.on("turn.end", (e) => { ${push(`"end:" + e.outcome`)} })`))
      },
    })
    await say("hello there")
    await until(() => calls().includes("end:completed"))
    expect(calls()).toEqual([`start:${project}:-`, "turn:hello there", "end:completed"])
    const child = await client.send({ type: "session.create", directory: project, parentId: sessionId })
    expect(child.ok).toBe(true)
    await until(() => calls().length === 4)
    expect(calls()[3]).toBe(`start:${project}:${sessionId}`)
  })

  test("notify queues a notice turn in the session", async () => {
    const { say, events } = await boot({
      steps: [stop("a"), stop("noticed")],
      setup: ({ user }) => {
        put(user, "extensions/notify.ts", extension("notify", `let done = false; api.on("turn.end", (e) => { if (!done) { done = true; api.notify(e.sessionId, "follow up from the extension") } })`))
      },
    })
    await say("hello")
    await until(() => events.filter((e) => e.type === "turn.completed").length === 2)
    expect(events.find((e) => e.type === "queue.added" && "notice" in e && e.notice)).toMatchObject({ text: "follow up from the extension" })
  })

  test("compact.before supplies the summary without a model call, or cancels; compact.after sees the summary", async () => {
    const supplied = await boot({
      steps: [stop("first answer"), stop("after compaction")],
      setup: ({ user }) => {
        put(user, "extensions/compact.ts", extension("compact", `api.on("compact.before", (e) => ({ summary: "SUPPLIED SUMMARY (" + e.reason + ")" })); api.on("compact.after", (e) => { ${push(`"after:" + e.summary`)} })`))
      },
    })
    await supplied.say("hello")
    const before = supplied.requests.length
    const done = supplied.events.filter((e) => e.type === "turn.completed").length
    expect(await supplied.client.send({ type: "session.compact", sessionId: supplied.sessionId })).toMatchObject({ ok: true })
    await until(() => supplied.events.filter((e) => e.type === "turn.completed").length > done)
    expect(supplied.requests).toHaveLength(before)
    expect(calls()).toEqual(["after:SUPPLIED SUMMARY (manual)"])
    await supplied.say("next")
    expect(supplied.requests[before]!.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("SUPPLIED SUMMARY (manual)") })

    const cancelled = await boot({
      steps: [stop("first answer"), stop("second")],
      setup: ({ user }) => {
        put(user, "extensions/cancel.ts", extension("cancel", `api.on("compact.before", () => ({ cancel: true }))`))
      },
    })
    await cancelled.say("hello")
    const turns = cancelled.events.filter((e) => e.type === "turn.completed").length
    await cancelled.client.send({ type: "session.compact", sessionId: cancelled.sessionId })
    await until(() => cancelled.events.filter((e) => e.type === "turn.completed").length > turns)
    await cancelled.say("again")
    // The history was left alone: the user's first message and the answer are still there.
    expect(cancelled.requests.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  })

  test("a compaction without a hook asks the model with COMPACTION.md when a layer has one (project over user)", async () => {
    const { say, requests, client, sessionId, events } = await boot({
      steps: [stop("answer"), stop("the summary")],
      setup: ({ user, project }) => {
        put(user, "COMPACTION.md", "USER COMPACTION PROMPT")
        put(project, ".mendcode/COMPACTION.md", "PROJECT COMPACTION PROMPT")
      },
    })
    await say("hello")
    const done = events.filter((e) => e.type === "turn.completed").length
    await client.send({ type: "session.compact", sessionId })
    await until(() => events.filter((e) => e.type === "turn.completed").length > done)
    const prompt = requests[1]!.messages.at(-1)
    expect(prompt).toMatchObject({ role: "user", content: expect.stringContaining("PROJECT COMPACTION PROMPT") })
    expect(JSON.stringify(prompt)).not.toContain("USER COMPACTION PROMPT")
  })

  test("prompt.system rewrites the final prompt; SYSTEM.md replaces the base, APPEND_SYSTEM.md is its own part of /context (project over user)", async () => {
    const { say, requests, project, client, sessionId } = await boot({
      steps: [stop("a")],
      setup: ({ user, project }) => {
        put(user, "SYSTEM.md", "USER SYSTEM {{cwd}}")
        put(user, "APPEND_SYSTEM.md", "USER APPEND")
        put(project, ".mendcode/SYSTEM.md", "PROJECT SYSTEM {{cwd}}")
        put(project, ".mendcode/APPEND_SYSTEM.md", "PROJECT APPEND")
        put(user, "extensions/prompt.ts", extension("prompt", `api.on("prompt.system", (e) => e.system + "\\nEXT role=" + e.role)`))
      },
    })
    await say("hi")
    expect(requests[0]!.system).toBe(`PROJECT SYSTEM ${project}\n\nPROJECT APPEND\nEXT role=main`)
    const report = await client.send({ type: "context.query", sessionId })
    const sections = report.ok ? (report.result as { sections: Array<{ id: string; label: string; chars: number }> }).sections : []
    expect(sections.filter((s) => s.id.startsWith("system:")).map((s) => [s.id, s.label, s.chars])).toEqual([
      ["system:base", "system · base prompt (SYSTEM.md)", `PROJECT SYSTEM ${project}`.length],
      ["system:append", "system · appended prompt (APPEND_SYSTEM.md)", "PROJECT APPEND".length],
    ])
  })

  test("context replaces the messages of a request and cannot corrupt the history it was handed", async () => {
    const { say, requests } = await boot({
      steps: [stop("a"), stop("b")],
      setup: ({ user }) => {
        put(user, "extensions/context.ts", extension("context", `api.on("context", (e) => { const copy = e.messages.map((m) => ({ ...m })); e.messages.length = 0; return [...copy, { role: "user", content: "injected context" }] })`))
      },
    })
    await say("first")
    await say("second")
    expect(requests[0]!.messages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual(["first", "injected context"])
    // History kept only the real conversation; the injected message is per request, never saved.
    expect(requests[1]!.messages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual(["first", "assistant", "second", "injected context"])
  })

  test("request.before shapes the Responses request body right before it is sent", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    const provider = createResponsesProvider({
      id: "chatgpt",
      model: "m-default",
      baseUrl: "http://example.invalid/v1",
      headers: async () => ({}),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return sse([{ type: "response.output_text.delta", delta: "hi" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }])
      },
    })
    const { say } = await boot({
      provider,
      setup: ({ user }) => {
        put(user, "extensions/body.ts", extension("body", `api.on("request.before", (e) => { ${push(`"body:" + e.provider + ":" + e.model`)}; return { ...e.body, metadata: { tagged: "yes" } } })`))
      },
    })
    await say("hello")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: "m-default", stream: true, metadata: { tagged: "yes" } })
    expect(calls()).toEqual(["body:chatgpt:m-default"])
  })
})

describe("extension tools and commands in a native-engine session", () => {
  test("a new tool reaches the model with its own schema; an override replaces the built-in and can wrap it", async () => {
    const { say, requests } = await boot({
      steps: [callTool("greet", { who: "Ana" }), callTool("echo", { text: "quiet" }), stop("done")],
      setup: ({ user }) => {
        put(
          user,
          "extensions/tools.ts",
          extension(
            "tools",
            `const inner = api.builtinTool("echo")
             api.registerTool({ name: "greet", description: "greets someone", parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] }, permission: "read", execute: async (args, ctx) => ({ output: "hello " + args.who + " (" + (ctx.sessionId.length > 0) + ")" }) })
             api.registerTool({ name: "echo", description: "LOUD echo", parameters: inner.parameters, permission: "read", override: true, execute: async (args, ctx) => { const r = await inner.execute(args, ctx); return { ...r, output: r.output.toUpperCase() } } })`,
          ),
        )
      },
    })
    await say("use the tools")
    const first = requests[0]!
    expect(first.tools.map((t) => t.name).sort()).toEqual(["echo", "greet", "plan_exit", "plan_review", "plan_submit"])
    expect(first.tools.find((t) => t.name === "greet")).toMatchObject({ description: "greets someone", parameters: { type: "object", required: ["who"] } })
    expect(first.tools.find((t) => t.name === "echo")?.description).toBe("LOUD echo")
    expect(toolMessages(requests[2]!)).toMatchObject([{ name: "greet", output: "hello Ana (true)" }, { name: "echo", output: "QUIET" }])
  })

  test("/name args runs an extension command: prompt becomes the user message, notice is shown, nothing starts no turn; the palette lists them", async () => {
    const { say, requests, events, client, project } = await boot({
      steps: [stop("ok")],
      setup: ({ user, project }) => {
        put(project, ".mendcode/commands/md.md", "---\ndescription: markdown one\n---\nDo $ARGUMENTS")
        put(user, "extensions/commands.ts", extension("commands", `api.registerCommand({ name: "ask", description: "ask with context", run: (args, ctx) => ({ prompt: "Please " + args + " (" + ctx.sessionId.slice(0, 4) + ")" }) })
          api.registerCommand({ name: "say", description: "say something", run: (args) => ({ notice: "said: " + args }) })
          api.registerCommand({ name: "quiet", description: "does nothing", run: () => {} })`))
      },
    })
    const listed = await client.send({ type: "commands.list", directory: project })
    expect(listed.ok && (listed.result as { commands: Array<{ name: string; description: string }> }).commands.map((c) => c.name)).toEqual(["ask", "bughunter", "commit", "commit-pr", "commit-push", "init", "md", "pr-comments", "quiet", "review", "say", "security-review", "ultraplan", "verify", "wiki"])
    expect(await client.send({ type: "commands.expand", directory: project, name: "ask", args: "fix it" })).toMatchObject({ ok: true, result: { prompt: "/ask fix it" } })
    expect(await client.send({ type: "commands.expand", directory: project, name: "md", args: "x" })).toMatchObject({ ok: true, result: { prompt: "Do x" } })

    expect(await say("/say hello")).toMatchObject({ ok: true, result: { handled: true, notice: "said: hello" } })
    expect(await say("/quiet")).toMatchObject({ ok: true, result: { handled: true } })
    expect(events.some((e) => e.type === "queue.added")).toBe(false)
    expect(requests).toHaveLength(0)

    expect(await say("/ask fix it")).toMatchObject({ ok: true, result: { queueId: expect.any(String) } })
    expect(requests[0]!.messages[0]).toMatchObject({ role: "user", content: expect.stringMatching(/^Please fix it \(ses_\)$/) })
  })
})

describe("extensions.list and trust", () => {
  test("project extensions are listed as untrusted and inert until the directory is trusted, and inert again after", async () => {
    const { say, list, client, project, requests } = await boot({
      steps: [stop("a"), stop("b"), stop("c")],
      setup: ({ user, project }) => {
        put(user, "extensions/user-ext.ts", extension("user-ext", `api.on("input", (e) => ({ text: e.text + " +user" }))`))
        put(project, ".mendcode/extensions/project-ext.ts", extension("project-ext", `${push(`"project-loaded"`)}; api.on("input", (e) => ({ text: e.text + " +project" })); api.registerCommand({ name: "p", description: "d", run: () => {} })`))
      },
    })
    expect(await list()).toMatchObject([
      { name: "user-ext", source: "user", trusted: true, daemon: true, tui: false, hooks: ["input"], tools: [], commands: [], errors: [] },
      { name: "project-ext", source: "project", trusted: false, daemon: false, hooks: [], commands: [] },
    ])
    await say("one")
    expect(requests[0]!.messages[0]).toMatchObject({ content: "one +user" })
    expect(calls()).toEqual([])

    expect(await client.send({ type: "tools.trust", directory: project, trusted: true })).toMatchObject({ ok: true })
    expect(await list()).toMatchObject([{ name: "user-ext", trusted: true }, { name: "project-ext", trusted: true, daemon: true, hooks: ["input"], commands: ["p"] }])
    await say("two")
    expect(requests[1]!.messages.at(-1)).toMatchObject({ content: "two +user +project" })
    expect(calls()).toEqual(["project-loaded"])

    expect(await client.send({ type: "tools.trust", directory: project, trusted: false })).toMatchObject({ ok: true })
    await say("three")
    expect(requests[2]!.messages.at(-1)).toMatchObject({ content: "three +user" })
    expect((await list())[1]).toMatchObject({ name: "project-ext", trusted: false, daemon: false })
  })

  test("the report matches the protocol schema for an extension with errors, tools, commands and hooks", async () => {
    const { list } = await boot({
      setup: ({ user }) => {
        put(user, "extensions/full.ts", extension("full", `api.on("tool.before", () => {}); api.on("turn.end", () => {}); api.registerTool({ name: "t1", description: "d", parameters: { type: "object" }, permission: "write", execute: async () => ({ output: "x" }) }); api.registerCommand({ name: "c1", description: "d", run: () => {} }); api.on("nope", () => {})`))
        put(user, "extensions/broken.ts", "export default 5")
      },
    })
    const { ExtensionsReport: Schema } = await import("@mendcode/protocol")
    const extensions = await list()
    expect(Schema.safeParse({ extensions }).success).toBe(true)
    expect(extensions).toMatchObject([
      { name: "broken", daemon: false, tui: false, errors: [expect.stringContaining("default export")] },
      { name: "full", tools: ["t1"], commands: ["c1"], hooks: ["tool.before", "turn.end"], errors: ['unknown hook "nope"'] },
    ])
  })
})

describe("MENDCODE_EXTENSIONS=0", () => {
  const original = process.env.MENDCODE_EXTENSIONS
  afterEach(() => {
    if (original === undefined) delete process.env.MENDCODE_EXTENSIONS
    else process.env.MENDCODE_EXTENSIONS = original
  })

  test("nothing is discovered, imported or applied: hooks, commands, tools and prompt files are all off", async () => {
    process.env.MENDCODE_EXTENSIONS = "0"
    const { say, list, requests, client, project } = await boot({
      steps: [stop("a")],
      setup: ({ user, project }) => {
        put(user, "extensions/off.ts", extension("off", `${push(`"imported"`)}; api.on("input", (e) => ({ text: e.text + " +ext" })); api.on("prompt.system", () => "REPLACED"); api.registerCommand({ name: "x", description: "d", run: () => ({ notice: "n" }) })`))
        put(project, ".mendcode/SYSTEM.md", "SHOULD NOT APPLY")
      },
    })
    expect(await list()).toEqual([])
    await say("/x now")
    expect(calls()).toEqual([])
    expect(requests[0]!.messages[0]).toMatchObject({ content: "/x now" })
    expect(requests[0]!.system).toBe(`BASE ${project}`)
    const listed = await client.send({ type: "commands.list", directory: project })
    expect(listed.ok && (listed.result as { commands: Array<{ name: string; source: string }> }).commands.map((command) => [command.name, command.source])).toEqual(["bughunter", "commit", "commit-pr", "commit-push", "init", "pr-comments", "review", "security-review", "ultraplan", "verify", "wiki"].map((name) => [name, "builtin"]))
  })
})

describe("extensions that coexist: disable, feedback and context cost", () => {
  test("extensions.disable turns an extension off for every hook, persists, and turning it on restores it", async () => {
    const { say, list, client, project, requests } = await boot({
      steps: [stop("a"), stop("b"), stop("c")],
      setup: ({ user }) => {
        put(user, "extensions/loud.ts", extension("loud", `api.on("input", (e) => ({ text: e.text + " +loud" }))`))
        put(user, "extensions/calm.ts", extension("calm", `api.on("input", (e) => ({ text: e.text + " +calm" }))`))
      },
    })
    await say("one")
    expect(requests[0]!.messages[0]).toMatchObject({ content: "one +calm +loud" })
    expect(await client.send({ type: "extensions.disable", directory: project, name: "loud", disabled: true })).toMatchObject({ ok: true })
    expect(await list()).toMatchObject([{ name: "calm" }, { name: "loud", disabled: true, hooks: [], errors: [] }])
    await say("two")
    expect(requests[1]!.messages.at(-1)).toMatchObject({ content: "two +calm" })
    const settings = await client.send({ type: "settings.get" })
    expect(settings.ok && (settings.result as { settings: { disabledExtensions?: string[] } }).settings.disabledExtensions).toEqual(["loud"])
    expect(await client.send({ type: "extensions.disable", directory: project, name: "loud", disabled: false })).toMatchObject({ ok: true })
    await say("three")
    expect(requests[2]!.messages.at(-1)).toMatchObject({ content: "three +calm +loud" })
    const after = await client.send({ type: "settings.get" })
    expect(after.ok && (after.result as { settings: { disabledExtensions?: string[] } }).settings.disabledExtensions).toBeUndefined()
  })

  test("a bad extension name is refused by the schema, never reaching the daemon's setting", async () => {
    const { client, project } = await boot()
    expect(await client.send({ type: "extensions.disable", directory: project, name: "../etc", disabled: true })).toMatchObject({ ok: false })
  })

  test("api.toast reaches terminals as a global event and stays out of the transcript and the model's context", async () => {
    const { say, globals, events, requests } = await boot({
      steps: [stop("a")],
      setup: ({ user }) => {
        put(user, "extensions/progress.ts", extension("progress", `api.on("input", () => { api.toast("indexing 40 files", { level: "success" }) })`))
      },
    })
    await say("work")
    await until(() => globals.some((event) => event.type === "extension.feedback"))
    expect(globals.filter((event) => event.type === "extension.feedback")).toMatchObject([{ extension: "progress", text: "indexing 40 files", level: "success" }])
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("indexing")
    expect(JSON.stringify(events)).not.toContain("indexing")
  })

  test("a handler that keeps failing is stopped by the breaker and the session still answers", async () => {
    const { say, list, requests } = await boot({
      steps: [stop("a"), stop("b"), stop("c"), stop("d"), stop("e")],
      setup: ({ user }) => {
        put(user, "extensions/flaky.ts", extension("flaky", `api.on("input", () => { ${push(`"flaky"`)}; throw new Error("boom") })`))
      },
    })
    for (const text of ["1", "2", "3", "4", "5"]) await say(text)
    expect(requests).toHaveLength(5)
    expect(calls()).toHaveLength(3)
    expect(await list()).toMatchObject([{ name: "flaky", breaker: ["input#0"] }])
  })

  test("context.query names the extensions that add tool schemas, with their estimated tokens", async () => {
    const { client, sessionId } = await boot({
      setup: ({ user }) => {
        put(user, "extensions/heavy.ts", extension("heavy", `api.registerTool({ name: "big", description: ${JSON.stringify("d".repeat(800))}, parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
        put(user, "extensions/none.ts", extension("none", `api.on("turn.end", () => {})`))
      },
    })
    const reply = await client.send({ type: "context.query", sessionId })
    expect(reply.ok).toBe(true)
    const report = reply.ok ? (reply.result as { extensions?: Array<{ id: string; label: string; tokens: number; count?: number }> }) : {}
    expect(report.extensions).toHaveLength(1)
    expect(report.extensions![0]).toMatchObject({ id: "extension:heavy", label: "heavy", count: 1 })
    expect(report.extensions![0]!.tokens).toBeGreaterThan(200)
    const { estimateTokens } = await import("@mendcode/protocol/wire")
    expect(report.extensions![0]!.tokens).toBe(estimateTokens(JSON.stringify({ name: "big", description: "d".repeat(800), parameters: { type: "object" } }).length))
    const { ContextReport } = await import("@mendcode/protocol")
    expect(ContextReport.safeParse(reply.ok ? reply.result : undefined).success).toBe(true)
    // The rent table names the same tool by its extension and shows it was never called.
    const rent = (reply.ok ? reply.result as { rent?: Array<{ tool: string; owner: string; tokens: number; uses: number }> } : {}).rent
    expect(rent?.find((entry) => entry.tool === "big")).toMatchObject({ owner: "extension:heavy", uses: 0 })
    expect(rent!.filter((entry) => entry.tool !== "big").every((entry) => entry.owner === "built-in")).toBe(true)
  })
})
