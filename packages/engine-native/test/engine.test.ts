import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode } from "@mendcode/protocol"
import { applyPatch, defineTool, edit, write as writeFileTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, questionTool, RetryableProviderError, todoTool, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()

/** Replays one scripted response per model call and records every request it received. */
function scriptedProvider(steps: Array<ModelEvent[] | Error | ((request: ModelRequest) => AsyncIterable<ModelEvent>)>) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      if (step instanceof Error) throw step
      if (typeof step === "function") return yield* step(request)
      yield* step
    },
  }
  return { provider, requests }
}

const echoTool = defineTool({
  name: "echo",
  description: "echo text",
  permission: "read",
  args: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ output: `echoed ${text}`, truncated: false, title: "echo", isError: false }),
})

function writeTool(log: string[]): Tool {
  return defineTool({
    name: "write",
    description: "write a file",
    permission: "write",
    args: z.object({ path: z.string() }),
    execute: async ({ path }) => (log.push(path), { output: `wrote ${path}`, truncated: false, title: `Write ${path}`, isError: false }),
  })
}

function turn(options: { text: string; answers?: EngineResolution[]; signal?: AbortSignal; sessionId?: ReturnType<typeof ids<"session">>; mode?: () => PermissionMode; onModeChange?: (mode: PermissionMode) => void }) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const answers = [...(options.answers ?? [])]
  const input: TurnInput = {
    permissionMode: options.mode ?? (() => "ask"),
    setPermissionMode: (mode) => options.onModeChange?.(mode),
    sessionId: options.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: options.text,
    attachments: [],
    signal: options.signal ?? new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny" }),
  }
  return { input, events, asked }
}

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown, callId = ids("item")): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]
const noSleep = async () => {}

describe("native engine loop", () => {
  test("cumulative usage records one final total and missing usage stays unknown", async () => {
    const { provider } = scriptedProvider([[{ type: "usage", usage: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "usage", usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, ...stop("done")], stop("no usage")])
    let missing = 0
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", onMissingUsage: () => { missing++ } })
    const first = turn({ text: "hi" })
    await engine.runTurn(first.input)
    expect(first.events.filter((event) => event.type === "usage")).toHaveLength(1)
    expect(first.events.find((event) => event.type === "usage")).toMatchObject({ input: 10, output: 5 })
    // With no window known the call says the 160k default as where it packs; with a 500k window, 90% of it.
    expect(first.events.find((event) => event.type === "usage")).toMatchObject({ compactAt: 160_000 })
    const wide = createNativeEngine({ provider: scriptedProvider([[{ type: "usage", usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, ...stop("ok")]]).provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", contextWindowFor: () => 500_000 })
    const sol = turn({ text: "hi" })
    await wide.runTurn(sol.input)
    expect(sol.events.find((event) => event.type === "usage")).toMatchObject({ compactAt: 450_000 })
    expect(missing).toBe(0)
    await engine.runTurn(turn({ text: "again" }).input)
    expect(missing).toBe(1)
  })
  test("budget checks run before every model step and stop before the next tool-loop call", async () => {
    const { provider, requests } = scriptedProvider([callTool("echo", { text: "x" }), stop("must not run")])
    let checks = 0
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", beforeModel: async ({ model, ask }) => {
      expect(model).toBe("script-1")
      expect(ask).toBeDefined()
      if (++checks === 2) throw new Error("Budget stop reached")
    } })
    expect(await engine.runTurn(turn({ text: "use echo" }).input)).toMatchObject({ status: "error", message: expect.stringContaining("Budget stop reached") })
    expect(checks).toBe(2)
    expect(requests).toHaveLength(1)
  })
  test("model retries recheck the budget before contacting the provider", async () => {
    const { provider, requests } = scriptedProvider([new RetryableProviderError("busy"), stop("must not run")])
    let checks = 0
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", sleep: noSleep, beforeModel: async () => { if (++checks === 2) throw new Error("Budget stop reached") } })
    expect(await engine.runTurn(turn({ text: "hi" }).input)).toMatchObject({ status: "error", message: expect.stringContaining("Budget stop reached") })
    expect(requests).toHaveLength(1)
  })
  test("a plain answer streams into one agent message and is kept in history", async () => {
    const { provider, requests } = scriptedProvider([stop("hello"), stop("again")])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [echoTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const first = turn({ text: "hi" })
    expect(await engine.runTurn(first.input)).toEqual({ status: "ok" })
    expect(first.events.map((e) => e.type)).toEqual(["item.started", "item.delta", "item.completed"])
    expect(first.events.at(-1)).toMatchObject({ status: "ok", text: "hello" })
    await engine.runTurn(turn({ text: "more", sessionId: first.input.sessionId }).input)
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(requests[0]!.tools[0]).toMatchObject({ name: "echo", parameters: { type: "object" } })
    // Every call of a session shares one cache key, so the provider can reuse the growing prefix.
    expect(requests.map((r) => r.cacheKey)).toEqual([first.input.sessionId, first.input.sessionId])
  })

  test("tool calls run, their results go back to the model, and the loop ends when the model stops", async () => {
    const { provider, requests } = scriptedProvider([callTool("echo", { text: "x" }), stop("done")])
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input, events, asked } = turn({ text: "use echo" })
    await engine.runTurn(input)
    expect(asked).toEqual([])
    expect(events.find((e) => e.type === "item.started" && e.kind === "tool_call")).toMatchObject({ meta: { tool: "echo" } })
    expect(events.find((e) => e.type === "item.completed" && e.text === "echoed x")).toMatchObject({ status: "ok" })
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "echo", output: "echoed x", isError: false })
  })

  test("write tools ask first; a denial is persisted and stops the turn without writing", async () => {
    const log: string[] = []
    const { provider, requests } = scriptedProvider([callTool("write", { path: "a.ts" }), stop("ok")])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [writeTool(log)], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input, asked, events } = turn({ text: "write", answers: [{ kind: "deny", reason: "not now" }] })
    await engine.runTurn(input)
    // The request names the tool card it belongs to, so clients can tie the prompt to it.
    const card = events.find((e) => e.type === "item.started" && e.kind === "tool_call")
    expect(asked).toEqual([{ kind: "approval", title: "Edit files", detail: "a.ts", itemId: card?.type === "item.started" ? card.itemId : ("" as never), tool: "write", permission: "write", permissionContext: { name: "edit", patterns: ["/repo/a.ts"], always: ["/repo/a.ts"] } }])
    expect(log).toEqual([])
    expect(requests).toHaveLength(1)
    expect((await history.load(input.sessionId))?.at(-1)).toMatchObject({ role: "tool", output: "denied by user: not now", isError: true })
  })

  test("an edit approval carries the diff of what would change, and nothing is written before approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-preview-"))
    try {
      writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n")
      const { provider } = scriptedProvider([callTool("edit", { path: "a.ts", oldString: "two", newString: "TWO" }), stop("ok")])
      const engine = createNativeEngine({ provider, tools: [edit], history: memoryHistory(), cwdFor: () => dir, system: () => "sys", compactionPrompt: "summarize" })
      const { input, asked } = turn({ text: "edit", answers: [{ kind: "deny" }] })
      await engine.runTurn(input)
      expect(asked).toMatchObject([{ kind: "approval", title: "Edit files", detail: "a.ts\n\n@@ -2,1 +2,1 @@\n-two\n+TWO", tool: "edit", permission: "write" }])
      expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("one\ntwo\nthree\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a preview that cannot be computed leaves the approval detail as the plain path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-preview-"))
    try {
      const { provider } = scriptedProvider([callTool("edit", { path: "missing.ts", oldString: "x", newString: "y" }), stop("ok")])
      const engine = createNativeEngine({ provider, tools: [edit, writeFileTool], history: memoryHistory(), cwdFor: () => dir, system: () => "sys", compactionPrompt: "summarize" })
      const { input, asked } = turn({ text: "edit", answers: [{ kind: "deny" }] })
      await engine.runTurn(input)
      expect(asked).toMatchObject([{ kind: "approval", title: "Edit files", detail: "missing.ts" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("afterWrite text is appended to a successful write tool's output, from edit, write and apply_patch paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-after-"))
    try {
      writeFileSync(join(dir, "a.ts"), "one\n")
      writeFileSync(join(dir, "b.ts"), "two\n")
      writeFileSync(join(dir, "gone.ts"), "bye\n")
      const patch = ["*** Begin Patch", "*** Update File: b.ts", "@@", "-two", "+TWO", "*** Add File: c.ts", "+new", "*** Delete File: gone.ts", "*** End Patch"].join("\n")
      const { provider, requests } = scriptedProvider([
        callTool("edit", { path: "a.ts", oldString: "one", newString: "ONE" }),
        callTool("write", { path: "w.ts", content: "x" }),
        callTool("apply_patch", { patch }),
        callTool("edit", { path: "a.ts", oldString: "nope", newString: "x" }),
        stop("done"),
      ])
      const seen: Array<{ cwd: string; paths: string[] }> = []
      const engine = createNativeEngine({
        provider,
        tools: [edit, writeFileTool, applyPatch],
        history: memoryHistory(),
        cwdFor: () => dir,
        system: () => "sys",
        compactionPrompt: "summarize",
        afterWrite: async ({ cwd, paths, signal }) => {
          expect(signal).toBeDefined()
          seen.push({ cwd, paths })
          return "\n\nDiagnostics:\na.ts:1:1 error boom"
        },
      })
      const { input, events } = turn({ text: "go", mode: () => "full" })
      await engine.runTurn(input)
      expect(seen).toEqual([
        { cwd: dir, paths: ["a.ts"] },
        { cwd: dir, paths: ["w.ts"] },
        { cwd: dir, paths: ["b.ts", "c.ts"] },
      ])
      const tools = requests[4]!.messages.filter((m) => m.role === "tool")
      expect(tools).toHaveLength(4)
      expect(tools[0]).toMatchObject({ isError: false })
      for (const index of [0, 1, 2]) expect((tools[index] as { output: string }).output).toEndWith("\n\nDiagnostics:\na.ts:1:1 error boom")
      expect((tools[3] as { output: string }).output).not.toContain("Diagnostics")
      // The model is told which files the patch changed; the card shows the diff it made, with the same diagnostics.
      expect((tools[2] as { output: string }).output).toStartWith("M b.ts\nA c.ts\nD gone.ts")
      expect((tools[2] as { output: string }).output).not.toContain("+TWO")
      const card = events.find((event) => event.type === "item.completed" && "text" in event && event.text.includes("*** Update File: b.ts")) as { text: string } | undefined
      expect(card?.text).toContain("-two")
      expect(card?.text).toContain("+TWO")
      expect(card?.text).toContain("*** Add File: c.ts\n+new")
      expect(card?.text).toContain("*** Delete File: gone.ts")
      expect(card?.text).toEndWith("Diagnostics:\na.ts:1:1 error boom")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing or absent afterWrite never changes the tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-after-"))
    try {
      writeFileSync(join(dir, "a.ts"), "one\n")
      const { provider, requests } = scriptedProvider([callTool("edit", { path: "a.ts", oldString: "one", newString: "two" }), stop("done")])
      const engine = createNativeEngine({ provider, tools: [edit], history: memoryHistory(), cwdFor: () => dir, system: () => "sys", compactionPrompt: "summarize", afterWrite: async () => { throw new Error("lsp down") } })
      const { input } = turn({ text: "go", mode: () => "full" })
      await engine.runTurn(input)
      expect((requests[1]!.messages.at(-1) as { output: string }).output).toBe("@@ -1,1 +1,1 @@\n-one\n+two")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe("tool images", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const shotTool = (images: NonNullable<Parameters<typeof defineTool>[0]["execute"] extends (...a: never[]) => Promise<infer R> ? R : never>["images"]) =>
      defineTool({ name: "shot", description: "take a picture", permission: "read", args: z.object({}), execute: async () => ({ output: "shot 8x8", truncated: false, title: "shot", isError: false, ...(images ? { images } : {}) }) })
    const blobStore = () => {
      const stored: Array<{ bytes: Uint8Array; mime: string; sessionId: string }> = []
      const storeBlob = async (bytes: Uint8Array, mime: string, sessionId: string) => {
        stored.push({ bytes, mime, sessionId })
        return { sha256: "a".repeat(63) + String(stored.length), bytes: bytes.byteLength, mime }
      }
      return { stored, storeBlob }
    }

    test("an image result becomes a following user message: the request carries the image, the history only a blob ref", async () => {
      const { stored, storeBlob } = blobStore()
      const history = memoryHistory()
      const sessionId = ids("session")
      const { provider, requests } = scriptedProvider([callTool("shot", {}), stop("I see it")])
      const engine = createNativeEngine({
        provider,
        tools: [shotTool([{ mime: "image/png", bytes: png }])],
        history,
        cwdFor: () => "/repo",
        system: () => "sys",
        compactionPrompt: "summarize",
        storeBlob,
        readBlob: async () => png,
      })
      const { input } = turn({ text: "look", sessionId })
      await engine.runTurn(input)
      expect(stored).toEqual([{ bytes: png, mime: "image/png", sessionId }])
      const second = requests[1]!.messages
      expect(second.at(-2)).toMatchObject({ role: "tool", name: "shot", output: "shot 8x8" })
      expect(second.at(-1)).toMatchObject({ role: "user", content: "[image from shot call]", images: [{ mime: "image/png", base64: Buffer.from(png).toString("base64") }] })
      const saved = (await history.load(sessionId))!
      const imageMessage = saved.find((m) => m.role === "user" && m.content.startsWith("[image from"))!
      expect(imageMessage).toEqual({ role: "user", content: "[image from shot call]", attachments: [{ sha256: "a".repeat(63) + "1", bytes: 8, mime: "image/png" }] })
      expect(JSON.stringify(saved)).not.toContain(Buffer.from(png).toString("base64"))
    })

    test("images follow all tool outputs of a step, one user message per call with images", async () => {
      const { storeBlob } = blobStore()
      const { provider, requests } = scriptedProvider([
        [{ type: "tool_call", call: { callId: "c1", name: "shot", args: {} } }, { type: "tool_call", call: { callId: "c2", name: "echo", args: { text: "x" } } }, { type: "finish", reason: "tool_calls" }],
        stop("done"),
      ])
      const engine = createNativeEngine({ provider, tools: [shotTool([{ mime: "image/png", bytes: png }]), echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", storeBlob, readBlob: async () => png })
      await engine.runTurn(turn({ text: "go" }).input)
      expect(requests[1]!.messages.slice(-3).map((m) => (m.role === "tool" ? `tool:${m.name}` : m.role))).toEqual(["tool:shot", "tool:echo", "user"])
    })

    test("at most 2 images per result and none over 5 MB are stored", async () => {
      const { stored, storeBlob } = blobStore()
      const many = [png, new Uint8Array(6 * 1024 * 1024), png, png].map((bytes) => ({ mime: "image/png" as const, bytes }))
      const { provider } = scriptedProvider([callTool("shot", {}), stop("ok")])
      const engine = createNativeEngine({ provider, tools: [shotTool(many)], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", storeBlob, readBlob: async () => png })
      await engine.runTurn(turn({ text: "go" }).input)
      expect(stored.map((s) => s.bytes.byteLength)).toEqual([8])
    })

    test("without a blob store the image is dropped and the model is told; a failing store never breaks the turn", async () => {
      const { provider, requests } = scriptedProvider([callTool("shot", {}), stop("ok")])
      const engine = createNativeEngine({ provider, tools: [shotTool([{ mime: "image/png", bytes: png }])], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
      await engine.runTurn(turn({ text: "go" }).input)
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: "shot 8x8\n[image not shown: no blob store]" })
      const failing = scriptedProvider([callTool("shot", {}), stop("ok")])
      const engine2 = createNativeEngine({ provider: failing.provider, tools: [shotTool([{ mime: "image/png", bytes: png }])], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", storeBlob: async () => { throw new Error("disk full") } })
      const { input, events } = turn({ text: "go" })
      await engine2.runTurn(input)
      expect(failing.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "shot" })
      expect(events.some((e) => e.type === "item.completed" && e.text === "ok")).toBe(true)
    })
  })

  test("custom tools ask like any execute tool, showing their name and the full arguments; plan mode denies them", async () => {
    const custom = defineTool({ name: "custom__word_count", description: "count", permission: "execute", args: z.object({ path: z.string() }), execute: async () => ({ output: "3", truncated: false, title: "wc", isError: false }) })
    const { provider } = scriptedProvider([callTool("custom__word_count", { path: "a.txt" }), stop("ok")])
    const engine = createNativeEngine({ provider, tools: [custom], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input, asked } = turn({ text: "count", answers: [{ kind: "deny" }] })
    await engine.runTurn(input)
    expect(asked).toMatchObject([{ kind: "approval", title: "Run custom tool word_count", detail: '{"path":"a.txt"}', tool: "custom__word_count", permission: "execute" }])
    const planned = scriptedProvider([callTool("custom__word_count", { path: "a.txt" }), stop("ok")])
    const planEngine = createNativeEngine({ provider: planned.provider, tools: [custom], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const plan = turn({ text: "count", mode: () => "plan" })
    await planEngine.runTurn(plan.input)
    expect(plan.asked).toEqual([])
    expect(planned.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", isError: true })
  })

  test("approve for session is remembered per tool within the session only", async () => {
    const log: string[] = []
    const sessionId = ids("session")
    const { provider } = scriptedProvider([callTool("write", { path: "a" }), callTool("write", { path: "b" }), stop("ok"), callTool("write", { path: "c" }), stop("ok")])
    const engine = createNativeEngine({ provider, tools: [writeTool(log)], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const first = turn({ text: "go", sessionId, answers: [{ kind: "approve", scope: "session" }] })
    await engine.runTurn(first.input)
    expect(first.asked).toHaveLength(1)
    const other = turn({ text: "go", answers: [{ kind: "approve", scope: "once" }] })
    await engine.runTurn(other.input)
    expect(other.asked).toHaveLength(1)
    expect(log).toEqual(["a", "b", "c"])
  })

  test("permission modes: edits auto-approves writes but asks for commands; full asks for nothing; changes apply mid-turn", async () => {
    const log: string[] = []
    const run = defineTool({ name: "shell", description: "run", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => (log.push(command), { output: "ran", truncated: false, title: command, isError: false }) })
    const tools = [writeTool(log), run]
    const edits = scriptedProvider([callTool("write", { path: "a" }), callTool("shell", { command: "ls" }), stop("ok")])
    const editsTurn = turn({ text: "go", mode: () => "edits", answers: [{ kind: "approve", scope: "once" }] })
    await createNativeEngine({ provider: edits.provider, tools, history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(editsTurn.input)
    expect(editsTurn.asked.map((a) => a.title)).toEqual(["Run command"])
    let mode: PermissionMode = "ask"
    const switching = scriptedProvider([
      async function* () {
        mode = "full"
        yield* callTool("shell", { command: "pwd" })
      },
      stop("ok"),
    ])
    const fullTurn = turn({ text: "go", mode: () => mode })
    await createNativeEngine({ provider: switching.provider, tools, history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(fullTurn.input)
    expect(fullTurn.asked).toEqual([])
    expect(log).toEqual(["a", "ls", "pwd"])
  })

  test("live tool output stops streaming at the cap while the completed item carries the full bounded result", async () => {
    const noisy = defineTool({
      name: "noisy",
      description: "prints a lot",
      permission: "read",
      args: z.object({}),
      execute: async (_args, context) => {
        for (let i = 0; i < 100; i++) context.onOutput?.("x".repeat(1_000))
        return { output: "head…tail", truncated: true, title: "noisy", isError: false }
      },
    })
    const { provider } = scriptedProvider([callTool("noisy", {}), stop("ok")])
    const { input, events } = turn({ text: "go" })
    await createNativeEngine({ provider, tools: [noisy], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(input)
    const deltas = events.filter((e) => e.type === "item.delta" && e.text.includes("x"))
    expect(deltas.reduce((sum, e) => sum + (e.type === "item.delta" ? e.text.length : 0), 0)).toBeLessThan(33_000)
    expect(events.find((e) => e.type === "item.completed" && e.text === "head…tail")).toBeDefined()
  })

  test("the question tool asks the user through the kernel and returns the typed answer to the model", async () => {
    const { provider, requests } = scriptedProvider([callTool("question", { question: "Which database?", context: "sqlite\npostgres" }), stop("ok")])
    const { input, asked } = turn({ text: "set up db", answers: [{ kind: "answer", text: "postgres" }] })
    await createNativeEngine({ provider, tools: [questionTool, todoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(input)
    expect(asked).toEqual([{ kind: "question", title: "Which database?", detail: "sqlite\npostgres" }])
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: "postgres", isError: false })
  })

  test("question options and multi-select reach the user; without options the question stays free text", async () => {
    const options = [{ label: "SQLite", description: "one file, no server" }, { label: "Postgres" }]
    const { provider } = scriptedProvider([
      callTool("question", { question: "Which databases?", options, multiple: true }),
      callTool("question", { question: "Name?", options: [], multiple: true }),
      stop("ok"),
    ])
    const { input, asked } = turn({ text: "db", answers: [{ kind: "answer", text: "SQLite, Postgres" }, { kind: "answer", text: "x" }] })
    await createNativeEngine({ provider, tools: [questionTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(input)
    expect(asked).toEqual([
      { kind: "question", title: "Which databases?", detail: "", options, multiple: true },
      { kind: "question", title: "Name?", detail: "" },
    ])
  })

  test("continue_loop_on_deny lets a declined question reach the model; todo renders a checklist", async () => {
    const { provider, requests } = scriptedProvider([
      callTool("question", { question: "Deploy now?" }),
      callTool("todo", { items: [{ text: "write tests", status: "done" }, { text: "ship", status: "in_progress" }] }),
      stop("ok"),
    ])
    const { input } = turn({ text: "go", answers: [{ kind: "deny", reason: "headless" }] })
    await createNativeEngine({ provider, tools: [questionTool, todoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", permissionPolicy: () => ({ experimental: { continue_loop_on_deny: true } }) }).runTurn(input)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ output: "not answered: headless", isError: true })
    expect(requests[2]!.messages.at(-1)).toMatchObject({ output: "[x] write tests\n[~] ship" })
  })

  test("task runs a sub-agent with a fresh context and a reduced tool set; only its answer returns", async () => {
    const { provider, requests } = scriptedProvider([
      callTool("task", { description: "find the entry point", prompt: "Find main entry. Return the path." }),
      callTool("echo", { text: "look" }),
      stop("src/main.ts"),
      stop("The entry is src/main.ts"),
    ])
    const { input, events } = turn({ text: "where is the entry point?" })
    await createNativeEngine({ provider, tools: [echoTool, questionTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", subagents: true }).runTurn(input)
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["echo", "question", "plan_submit", "task", "plan_review", "plan_exit"])
    expect(requests[1]!.messages).toEqual([{ role: "user", content: "Find main entry. Return the path." }])
    expect(requests[1]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect(requests[3]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task", output: "src/main.ts", isError: false })
    const taskItem = events.find((e) => e.type === "item.started" && e.meta?.tool === "task: find the entry point")!
    expect(events.filter((e) => e.type === "item.delta" && e.itemId === (taskItem as { itemId: string }).itemId).map((e) => (e as { text: string }).text)).toEqual(["◆ echo\n"])
    // The task card's completion carries its tool-call count and duration for the summary line.
    const taskDone = events.find((e) => e.type === "item.completed" && e.itemId === (taskItem as { itemId: string }).itemId)
    expect(taskDone).toMatchObject({ meta: { toolCalls: 1, durationMs: expect.any(Number) } })
    expect(events.filter((e) => e.type === "item.started" && e.kind === "agent_message")).toHaveLength(1)
  })

  test("a forked task repeats the parent's request with its task appended; the parent's main-agent tools fail in it", async () => {
    const { provider, requests } = scriptedProvider([
      callTool("task", { description: "check", prompt: "Check it.", fork: true }),
      callTool("question", { question: "may I?" }),
      callTool("echo", { text: "look" }),
      stop("checked"),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, tools: [echoTool, questionTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", subagents: true, permissionPolicy: () => ({ features: { task_fork: true } }) })
    await engine.runTurn(turn({ text: "look at it" }).input)
    const [parent, child, second] = requests as [ModelRequest, ModelRequest, ModelRequest]
    expect(JSON.stringify(parent.tools.find((tool) => tool.name === "task")!.parameters)).toContain("\"fork\"")
    expect([child.system, child.tools, child.cacheKey]).toEqual([parent.system, parent.tools, parent.cacheKey])
    expect(child.messages.slice(0, -1)).toEqual(parent.messages)
    expect(child.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/^You are now a sub-agent forked[\s\S]*Task:\nCheck it\.$/) })
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", name: "question", output: "unknown tool: question", isError: true })
    expect(requests[4]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task", output: "context: forked\nchecked" })
  })

  test("a forked task leaves out the parent's hosted tools its own rules refuse, and a cache turned off since stays off", async () => {
    let promptCache: "legacy" | "off" = "legacy"
    const { provider, requests } = scriptedProvider([
      (request) => {
        promptCache = "off"
        return (async function* () { yield* callTool("task", { description: "check", prompt: "Check it.", fork: true }) })()
      },
      stop("checked"),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", subagents: true, hostedTools: () => ["web_search"], promptCache: () => promptCache, permissionPolicy: () => ({ features: { task_fork: true }, experimental: { primary_tools: ["web_search"] } }) })
    await engine.runTurn(turn({ text: "look at it", mode: () => "full" }).input)
    const [parent, child] = requests as [ModelRequest, ModelRequest]
    expect(parent.hostedTools).toEqual(["web_search"])
    expect(parent.cacheKey).toBeString()
    expect(child.hostedTools).toBeUndefined()
    expect([child.cacheMode, child.cacheKey]).toEqual(["off", undefined])
  })

  test("without subagents the task tool is not offered and a stray call is an unknown tool", async () => {
    const { provider, requests } = scriptedProvider([callTool("task", { description: "x", prompt: "y" }), stop("ok")])
    await createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(turn({ text: "go" }).input)
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["echo", "plan_submit", "plan_review", "plan_exit"])
    expect(requests[1]!.messages.at(-1)).toMatchObject({ output: "unknown tool: task", isError: true })
  })

  test("plan mode: changes are refused, the plan is shown and approval leaves plan mode so the build can proceed", async () => {
    const log: string[] = []
    let mode: PermissionMode = "plan"
    const { provider, requests } = scriptedProvider([
      callTool("write", { path: "a.ts" }),
      callTool("plan_submit", { plan: "1. edit a.ts\n2. run tests" }),
      callTool("write", { path: "a.ts" }),
      stop("done"),
    ])
    const { input, events, asked } = turn({
      text: "fix it",
      mode: () => mode,
      onModeChange: (next) => (mode = next),
      answers: [{ kind: "approve", scope: "once" }, { kind: "approve", scope: "once" }],
    })
    await createNativeEngine({ provider, tools: [writeTool(log)], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(input)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ isError: true })
    expect((requests[1]!.messages.at(-1) as { output: string }).output).toContain("plan mode is read-only")
    expect(asked.map((a) => a.title)).toEqual(["Review plan", "Edit files"])
    expect(events.some((e) => e.type === "item.delta" && e.text.includes("1. edit a.ts"))).toBe(true)
    expect(mode as PermissionMode).toBe("ask")
    expect(log).toEqual(["a.ts"])
  })

  test("plan feedback typed by the user comes back to the model as revision notes", async () => {
    const { provider, requests } = scriptedProvider([callTool("plan_submit", { plan: "p1" }), stop("revising")])
    const { input } = turn({ text: "go", mode: () => "plan", answers: [{ kind: "deny", reason: "also update the docs" }] })
    await createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(input)
    expect((requests[1]!.messages.at(-1) as { output: string }).output).toContain("Feedback: also update the docs")
  })

  test("project tools (MCP) are offered with their own JSON schema, per session directory, and a failing source is skipped", async () => {
    const mcpEcho = { ...echoTool, name: "mcp__srv__echo", jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
    const { provider, requests } = scriptedProvider([callTool("mcp__srv__echo", { text: "hi" }), stop("ok"), stop("again")])
    const roots = new Map<string, string>()
    const engine = createNativeEngine({
      provider,
      tools: [],
      history: memoryHistory(),
      cwdFor: (id) => roots.get(id)!,
      system: () => "sys",
      compactionPrompt: "s",
      projectTools: async (cwd) => {
        if (cwd === "/broken") throw new Error("server died")
        return cwd === "/with-mcp" ? [mcpEcho] : []
      },
    })
    const a = turn({ text: "go" })
    roots.set(a.input.sessionId, "/with-mcp")
    await engine.runTurn(a.input)
    expect(requests[0]!.tools.find((t) => t.name === "mcp__srv__echo")?.parameters).toEqual(mcpEcho.jsonSchema)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ output: "echoed hi", isError: false })
    const b = turn({ text: "go" })
    roots.set(b.input.sessionId, "/broken")
    expect(await engine.runTurn(b.input)).toEqual({ status: "ok" })
    expect(requests[2]!.tools.map((t) => t.name)).toEqual(["plan_submit", "plan_review", "plan_exit"])
  })

  test("an abandoned approval ends the turn and still leaves a result for every call", async () => {
    const { provider } = scriptedProvider([
      [
        { type: "tool_call", call: { callId: "c1", name: "write", args: { path: "a" } } },
        { type: "tool_call", call: { callId: "c2", name: "write", args: { path: "b" } } },
        { type: "finish", reason: "tool_calls" },
      ],
    ])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [writeTool([])], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input } = turn({ text: "go", answers: [{ kind: "abandoned" }] })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    const saved = (await history.load(input.sessionId))!
    expect(saved.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.callId : ""))).toEqual(["c1", "c2"])
  })

  test("unknown tools and invalid arguments become error results, not crashes", async () => {
    const { provider, requests } = scriptedProvider([callTool("nope", {}), callTool("echo", { text: 5 }), stop("ok")])
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    await engine.runTurn(turn({ text: "go" }).input)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ output: "unknown tool: nope", isError: true })
    expect(requests[2]!.messages.at(-1)).toMatchObject({ isError: true })
    expect((requests[2]!.messages.at(-1) as { output: string }).output).toContain("invalid arguments for echo")
  })

  test("the OS sandbox policy reaches the model's shell calls only, never the user's !command or other tools", async () => {
    const policy = { mode: "workspace-write" as const, network: false, writable: ["/repo"], protect: [] }
    const seen: Array<{ tool: string; sandbox: unknown }> = []
    const spy = (name: string, permission: "read" | "execute") => defineTool({ name, description: name, permission, args: z.object({ command: z.string().optional() }), execute: async (_args, context) => (seen.push({ tool: name, sandbox: context.sandbox }), { output: "ok", truncated: false, title: name, isError: false }) })
    const asked: Array<{ sessionId: string; cwd: string }> = []
    const options = { tools: [spy("shell", "execute"), spy("echo", "read")], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", sandbox: (input: { sessionId: string; cwd: string }) => (asked.push(input), policy) }
    const model = scriptedProvider([callTool("shell", { command: "ls" }), callTool("echo", {}), stop("done")])
    await createNativeEngine({ ...options, provider: model.provider, history: memoryHistory() }).runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(seen).toEqual([{ tool: "shell", sandbox: policy }, { tool: "echo", sandbox: undefined }])
    expect(asked).toHaveLength(1)
    expect(asked[0]!.cwd).toBe("/repo")
    seen.length = 0
    await createNativeEngine({ ...options, provider: scriptedProvider([]).provider, history: memoryHistory() }).runShell!(turn({ text: "ls" }).input)
    expect(seen).toEqual([{ tool: "shell", sandbox: undefined }])
  })

  test("runShell runs the user's !command without the model or an approval, and records it for the next answer", async () => {
    const ran: string[] = []
    const shellTool = defineTool({
      name: "shell",
      description: "run a command",
      permission: "execute",
      args: z.object({ command: z.string() }),
      execute: async ({ command }, context) => (ran.push(command), context.onOutput?.("On branch main\n"), { output: "On branch main", truncated: false, title: command, isError: false }),
    })
    const { provider, requests } = scriptedProvider([])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [shellTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" })
    const { input, asked, events } = turn({ text: "git status" })
    expect(await engine.runShell!(input)).toEqual({ status: "ok" })
    expect(ran).toEqual(["git status"])
    expect(asked).toEqual([])
    expect(requests).toEqual([])
    expect(events.map((e) => e.type)).toEqual(["item.started", "item.delta", "item.completed"])
    expect(events.at(-1)).toMatchObject({ status: "ok", text: "On branch main" })
    expect((await history.load(input.sessionId))!.at(-1)).toEqual({ role: "user", content: "I ran a shell command myself:\n$ git status\n```\nOn branch main\n```" })
    const bare = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" })
    expect(await bare.runShell!(turn({ text: "ls" }).input)).toMatchObject({ status: "error", code: "no_shell" })
  })

  test("runShell with localShell (!!command) runs and shows the command but leaves the model's history alone", async () => {
    const ran: string[] = []
    const shellTool = defineTool({
      name: "shell",
      description: "run a command",
      permission: "execute",
      args: z.object({ command: z.string() }),
      execute: async ({ command }) => (ran.push(command), { output: "secret-ish output", truncated: false, title: command, isError: false }),
    })
    const { provider, requests } = scriptedProvider([])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [shellTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" })
    const { input, asked, events } = turn({ text: "cat notes.txt" })
    expect(await engine.runShell!({ ...input, localShell: true })).toEqual({ status: "ok" })
    expect(ran).toEqual(["cat notes.txt"])
    expect(asked).toEqual([])
    expect(requests).toEqual([])
    expect(events.at(-1)).toMatchObject({ status: "ok", text: "secret-ish output" })
    expect(await history.load(input.sessionId)).toBeUndefined()
    // The same command through `!` is recorded, so the difference is the flag and nothing else.
    expect(await engine.runShell!(input)).toEqual({ status: "ok" })
    expect(JSON.stringify(await history.load(input.sessionId))).toContain("secret-ish output")
  })

  test("retryable provider errors are retried with backoff before any output", async () => {
    const waits: number[] = []
    const { provider } = scriptedProvider([new RetryableProviderError("429", 1_000), new RetryableProviderError("503"), stop("finally")])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", sleep: async (ms) => void waits.push(ms) })
    const { input, events } = turn({ text: "go" })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(waits).toEqual([1_000, 1_000])
    expect(events.at(-1)).toMatchObject({ text: "finally" })
    // Each wait is announced first, with the provider's message minus the tag.
    expect(events.filter((e) => e.type === "retrying")).toEqual([
      { type: "retrying", attempt: 1, delayMs: 1_000, message: "429" },
      { type: "retrying", attempt: 2, delayMs: 1_000, message: "503" },
    ])
  })

  test("a stream that fails after output is surfaced as an error, not replayed", async () => {
    const { provider } = scriptedProvider([
      async function* () {
        yield { type: "text", delta: "partial" } as ModelEvent
        throw new RetryableProviderError("dropped")
      },
    ])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", sleep: noSleep })
    const { input, events } = turn({ text: "go" })
    expect(await engine.runTurn(input)).toMatchObject({ status: "error", code: "provider_error" })
    expect(events.filter((e) => e.type === "item.started")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: "item.completed", text: "partial" })
  })

  test("usage is reported with the provider, model and completed request profile", async () => {
    const { provider, requests } = scriptedProvider([[{ type: "usage", usage: { input: 10, output: 2, reasoning: 0, cacheRead: 4, cacheWrite: 0 } }, ...stop("x")]])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input, events } = turn({ text: "go" })
    await engine.runTurn(input)
    const usage = events.find((event) => event.type === "usage")
    expect(usage).toEqual({ type: "usage", provider: "scripted", model: "script-1", input: 10, output: 2, reasoning: 0, cacheRead: 4, cacheWrite: 0, compactAt: 160_000, profile: { estimatedTokens: expect.any(Object), firstTokenMs: expect.any(Number), durationMs: expect.any(Number), toolCount: requests[0]!.tools.length, imageCount: 0 } })
    expect(usage!.profile!.durationMs).toBeGreaterThanOrEqual(usage!.profile!.firstTokenMs!)
  })

  test("cancel mid-stream closes the open item as cancelled and returns promptly", async () => {
    const controller = new AbortController()
    const { provider } = scriptedProvider([
      async function* () {
        yield { type: "text", delta: "thinking" } as ModelEvent
        controller.abort()
        yield { type: "text", delta: " more" } as ModelEvent
      },
    ])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const { input, events } = turn({ text: "go", signal: controller.signal })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(events.at(-1)).toMatchObject({ type: "item.completed", status: "cancelled", text: "thinking" })
  })

  test("each session runs tools and builds its prompt in its own project root", async () => {
    const seen: string[] = []
    const where = defineTool({ name: "where", description: "cwd", permission: "read", args: z.object({}), execute: async (_args, context) => (seen.push(context.cwd), { output: context.cwd, truncated: false, title: "where", isError: false }) })
    const { provider, requests } = scriptedProvider([callTool("where", {}), stop("a"), callTool("where", {}), stop("b")])
    const a = ids("session")
    const b = ids("session")
    const roots = new Map([[a, "/project-a"], [b, "/project-b"]])
    const engine = createNativeEngine({ provider, tools: [where], history: memoryHistory(), cwdFor: (id) => roots.get(id)!, system: (cwd) => `root ${cwd}`, compactionPrompt: "summarize" })
    await engine.runTurn(turn({ text: "go", sessionId: a }).input)
    await engine.runTurn(turn({ text: "go", sessionId: b }).input)
    expect(seen).toEqual(["/project-a", "/project-b"])
    expect(requests.map((r) => r.system)).toEqual(["root /project-a", "root /project-a", "root /project-b", "root /project-b"])
  })

  test("crossing the token threshold triggers compaction, which replaces history with a streamed summary", async () => {
    const usage = (input: number): ModelEvent => ({ type: "usage", usage: { input, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    const { provider, requests } = scriptedProvider([[usage(500), ...stop("small")], [usage(995), ...stop("big")], [...stop("SUMMARY: fixed add()")], stop("next")])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize now", compactAtTokens: 1_000, compaction: () => ({ tail_turns: 0 }) })
    const sessionId = ids("session")
    await engine.runTurn(turn({ text: "one", sessionId }).input)
    expect(engine.needsCompaction(sessionId)).toBe(false)
    await engine.runTurn(turn({ text: "two", sessionId }).input)
    expect(engine.needsCompaction(sessionId)).toBe(true)
    const events: EngineEvent[] = []
    const outcome = await engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: (e) => void events.push(e) })
    expect(outcome).toEqual({ status: "ok", compacted: true })
    // The summary request repeats the turn's last call (the provider's cached prefix), tool list included, and appends the prompt.
    expect(requests[2]!.tools).toEqual(requests[1]!.tools)
    expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual(requests[1]!.messages)
    // The base prompt leads; the evidence blocks (latest request, phase, trigger) follow it.
    const prompt = requests[2]!.messages.at(-1) as { role: string; content: string }
    expect(prompt.role).toBe("user")
    expect(prompt.content.startsWith("Create a new anchored summary")).toBe(true)
    expect(prompt.content).toContain("summarize now")
    expect(prompt.content).toContain("Latest Real User Request Evidence")
    expect(events.find((e) => e.type === "item.started")).toMatchObject({ kind: "compaction" })
    expect(engine.needsCompaction(sessionId)).toBe(false)
    const saved = (await history.load(sessionId))!
    expect(saved).toHaveLength(1)
    expect((saved[0] as { content: string }).content).toContain("SUMMARY: fixed add()")
    await engine.runTurn(turn({ text: "three", sessionId }).input)
    expect(requests[3]!.messages.map((m) => m.role)).toEqual(["user", "user"])
  })

  test("a failed or cancelled compaction leaves the history untouched", async () => {
    const { provider } = scriptedProvider([stop("answer"), new Error("boom")])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", compactAtTokens: 1 })
    const sessionId = ids("session")
    await engine.runTurn(turn({ text: "one", sessionId }).input)
    const before = await history.load(sessionId)
    const outcome = await engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })
    expect(outcome).toMatchObject({ status: "error", code: "compaction_failed" })
    expect(await history.load(sessionId)).toEqual(before)
  })

  describe("hosted image generation", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])
    const generated = (extra: Partial<ModelEvent> = {}): ModelEvent[] => [
      { type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "started" },
      { type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "completed", detail: "A small green square icon", image: { mime: "image/png", base64: Buffer.from(png).toString("base64") }, ...extra } as ModelEvent,
      ...stop("Done."),
    ]
    const blobs = () => {
      const stored: Array<{ bytes: Uint8Array; mime: string; sessionId: string }> = []
      return {
        stored,
        storeBlob: async (bytes: Uint8Array, mime: string, sessionId: string) => (stored.push({ bytes, mime, sessionId }), { sha256: "b".repeat(64), bytes: bytes.byteLength, mime }),
        blobPath: (ref: { sha256: string }) => `/data/blobs/bb/${ref.sha256}`,
      }
    }

    test("the image is stored as a blob, the card carries the revised prompt, path and ref, and history keeps only the ref", async () => {
      const { stored, storeBlob, blobPath } = blobs()
      const { provider, requests } = scriptedProvider([generated(), stop("next")])
      const history = memoryHistory()
      const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["image_generation"], storeBlob, blobPath, readBlob: async () => png })
      const sessionId = ids("session")
      const run = turn({ text: "draw", sessionId })
      expect(await engine.runTurn(run.input)).toEqual({ status: "ok" })
      expect(requests[0]!.hostedTools).toEqual(["image_generation"])
      expect(stored).toEqual([{ bytes: png, mime: "image/png", sessionId }])
      const ref = { sha256: "b".repeat(64), bytes: png.byteLength, mime: "image/png" }
      const started = run.events.find((e) => e.type === "item.started" && e.kind === "tool_call")!
      expect(started).toMatchObject({ meta: { tool: "image_generation" } })
      expect(run.events.find((e) => e.type === "item.completed" && "itemId" in started && e.itemId === (started as { itemId: string }).itemId)).toMatchObject({
        status: "ok",
        text: `A small green square icon\n/data/blobs/bb/${"b".repeat(64)}`,
        attachments: [ref],
      })
      const saved = (await history.load(sessionId))!
      expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "user"])
      // The model is told where the file is, so "save it in Downloads" is a copy it can make.
      expect(saved[2]).toMatchObject({ role: "user", attachments: [ref] })
      const note = (saved[2] as { content: string }).content
      expect(note.split("\n")[0]).toBe("[image from image_generation call]")
      expect(note).toContain(`/data/blobs/bb/${"b".repeat(64)} (image/png)`)
      expect(note).toContain("copy the file with the shell")
      expect(JSON.stringify(saved)).not.toContain(Buffer.from(png).toString("base64"))
      // The next turn shows the model the image it made, resolved from the ref.
      await engine.runTurn(turn({ text: "make it blue", sessionId }).input)
      expect(requests[1]!.messages.at(-2)).toMatchObject({ role: "user", content: expect.stringContaining("[image from image_generation call]\nSaved by MendCode as this file"), images: [{ mime: "image/png" }] })
    })

    test("with tool calls in the same step the image message follows the tool outputs", async () => {
      const { storeBlob } = blobs()
      const step: ModelEvent[] = [
        ...generated().slice(0, 2),
        { type: "tool_call", call: { callId: "c1", name: "echo", args: { text: "x" } } },
        { type: "finish", reason: "tool_calls" },
      ]
      const { provider, requests } = scriptedProvider([step, stop("ok")])
      const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["image_generation"], storeBlob, readBlob: async () => png })
      await engine.runTurn(turn({ text: "go" }).input)
      expect(requests[1]!.messages.slice(-3).map((m) => (m.role === "tool" ? `tool:${m.name}` : m.role))).toEqual(["assistant", "tool:echo", "user"])
    })

    test("a failed call, or an image with nowhere to store it, is an error card and adds nothing to history", async () => {
      const failed: ModelEvent[] = [{ type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "started" }, { type: "hosted_tool", id: "ig_1", tool: "image_generation", status: "failed" }, ...stop("Sorry.")]
      const run = turn({ text: "draw" })
      const history = memoryHistory()
      const { provider } = scriptedProvider([failed])
      await createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["image_generation"], storeBlob: blobs().storeBlob }).runTurn(run.input)
      expect(run.events.find((e) => e.type === "item.completed" && e.status === "error")).toBeDefined()
      expect((await history.load(run.input.sessionId))!.map((m) => m.role)).toEqual(["user", "assistant"])

      const nowhere = turn({ text: "draw" })
      const second = scriptedProvider([generated()])
      await createNativeEngine({ provider: second.provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["image_generation"] }).runTurn(nowhere.input)
      expect(nowhere.events.find((e) => e.type === "item.completed" && e.status === "error")).toBeDefined()
    })
  })

  test("hosted web search is offered on answer calls only and shows as a tool card with its queries", async () => {
    const searched: ModelEvent[] = [
      { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "started" },
      { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "completed", detail: "bun latest version" },
      ...stop("Bun is v1.4.2."),
    ]
    const { provider, requests } = scriptedProvider([searched, stop("SUMMARY")])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["web_search"] })
    const sessionId = ids("session")
    const run = turn({ text: "latest bun?", sessionId })
    expect(await engine.runTurn(run.input)).toEqual({ status: "ok" })
    expect(requests[0]!.hostedTools).toEqual(["web_search"])
    const started = run.events.find((e) => e.type === "item.started" && e.kind === "tool_call")
    expect(started).toMatchObject({ meta: { tool: "web_search" } })
    expect(run.events.find((e) => e.type === "item.completed" && "itemId" in started! && e.itemId === started.itemId)).toMatchObject({ status: "ok", text: "bun latest version" })
    // History keeps only the answer; the search itself is not replayed.
    expect((await history.load(sessionId))!.map((m) => m.role)).toEqual(["user", "assistant"])
    await engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })
    // A summary request that repeats the answer call (the cached prefix) repeats its hosted tools too; the compaction's own request has none (shared-compaction.test.ts).
    expect(requests[1]!.hostedTools).toEqual(["web_search"])
  })

  test("a provider that fails twice after its own web search is asked again without it, told why, and the turn ends", async () => {
    async function* fails(): AsyncIterable<ModelEvent> {
      yield { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "started" }
      yield { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "completed", detail: "example page" }
      throw new RetryableProviderError("[PROVIDER]: chatgpt An error occurred while processing your request.")
    }
    const { provider, requests } = scriptedProvider([fails, fails, stop("I could not search the web.")])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["web_search"], sleep: noSleep })
    const run = turn({ text: "search the web for the example page" })
    expect(await engine.runTurn(run.input)).toEqual({ status: "ok" })
    expect(requests.map((request) => request.hostedTools)).toEqual([["web_search"], ["web_search"], undefined])
    expect(requests[1]!.system).toBe("sys")
    expect(requests[2]!.system).toContain("web search is failing right now and is off for this step")
    const retries = run.events.filter((e) => e.type === "retrying").map((e) => "message" in e && e.message)
    expect(retries).toEqual(["chatgpt An error occurred while processing your request.", "web search failed at the provider 2 times; continuing without it"])
  })

  test("a hosted search still running when the stream breaks is closed as cancelled", async () => {
    async function* broken(): AsyncIterable<ModelEvent> {
      yield { type: "hosted_tool", id: "ws_1", tool: "web_search", status: "started" }
      throw new Error("dropped")
    }
    const { provider } = scriptedProvider([broken])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", hostedTools: () => ["web_search"], sleep: noSleep })
    const run = turn({ text: "search" })
    await engine.runTurn(run.input)
    expect(run.events.filter((e) => e.type === "item.completed").map((e) => "status" in e && e.status)).toEqual(["cancelled"])
  })

  test("each call asks modelFor with its role: main, plan, subagent and compaction; usage names the model used", async () => {
    const usage: ModelEvent = { type: "usage", usage: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
    const { provider, requests } = scriptedProvider([
      callTool("task", { description: "look", prompt: "Look around." }),
      [usage, ...stop("found")],
      stop("done"),
      [usage, ...stop("planned")],
      stop("SUMMARY"),
    ])
    const asked: string[] = []
    const modelFor = (_: unknown, role: string) => (asked.push(role), role === "subagent" ? { model: "gpt-6-luna", effort: "low" as const } : { model: "gpt-6-sol", effort: "high" as const })
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", subagents: true, modelFor })
    const sessionId = ids("session")
    const first = turn({ text: "go", sessionId })
    await engine.runTurn(first.input)
    const plan = turn({ text: "plan it", sessionId, mode: () => "plan" })
    await engine.runTurn(plan.input)
    await engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })
    // Tail selection reads the main model's limits; the summary still runs on the compaction role.
    expect(asked).toEqual(["main", "subagent", "main", "plan", "main", "compaction"])
    expect(requests.map((r) => [r.model, r.effort])).toEqual([
      ["gpt-6-sol", "high"],
      ["gpt-6-luna", "low"],
      ["gpt-6-sol", "high"],
      ["gpt-6-sol", "high"],
      ["gpt-6-sol", "high"],
    ])
    expect(first.events.find((e) => e.type === "usage")).toMatchObject({ model: "gpt-6-luna" })
    expect(plan.events.find((e) => e.type === "usage")).toMatchObject({ model: "gpt-6-sol" })
  })

  test("without modelFor requests carry no model and usage names the provider's", async () => {
    const { provider, requests } = scriptedProvider([[{ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, ...stop("hi")]])
    const run = turn({ text: "hi" })
    await createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(run.input)
    expect(requests[0]!.model).toBeUndefined()
    expect(run.events.find((e) => e.type === "usage")).toMatchObject({ model: "script-1" })
  })

  test("a tool's render spec reaches the completed item when valid (normalized) and is dropped when not", async () => {
    const renderTool = (render: unknown) =>
      defineTool({ name: "pkg", description: "package info", permission: "read", args: z.object({}), execute: async () => ({ output: '{"v":"1"}', truncated: false, title: "pkg", isError: false, render }) })
    for (const [render, expected] of [
      [{ type: "kv", items: [{ key: "version", value: 1 }] }, { type: "kv", items: [{ key: "version", value: "1" }] }],
      [{ type: "script", src: "x" }, undefined],
    ] as const) {
      const { provider } = scriptedProvider([callTool("pkg", {}), stop("done")])
      const run = turn({ text: "info" })
      await createNativeEngine({ provider, tools: [renderTool(render)], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" }).runTurn(run.input)
      const completed = run.events.find((e) => e.type === "item.completed" && "text" in e && e.text === '{"v":"1"}') as { render?: unknown }
      expect(completed.render).toEqual(expected)
    }
  })

  test("a model that never stops calling tools is cut off at maxSteps", async () => {
    const { provider } = scriptedProvider(Array.from({ length: 3 }, () => callTool("echo", { text: "x" })))
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", maxSteps: 3, permissionPolicy: () => ({ permission: { doom_loop: "allow" } }) })
    expect(await engine.runTurn(turn({ text: "loop" }).input)).toMatchObject({ status: "error", code: "max_steps" })
  })
})
