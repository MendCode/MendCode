import { describe, expect, test } from "bun:test"
import type { EngineEvent } from "@mendcode/kernel"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelMessage, type ModelRequest } from "../src"
import { echoTool, ids, scriptedProvider, stop, turn } from "./harness"
import { fileTool } from "./prefix-harness"

/**
 * A manual or automatic portable compaction repeats the session's last main request and appends the summary prompt, so the provider
 * reads the history from its prompt cache (idle-compaction-prefix.test.ts holds the three adapters to the bytes). Here: when it does,
 * when it keeps its own request instead (no tools, pruned history), and the one retry after a reply that is not a summary.
 */
type Session = ReturnType<typeof ids<"session">>
type Options = Partial<Parameters<typeof createNativeEngine>[0]>
const SUMMARY = "## Goal\nFix pagination and test the empty page."
const usage = (input: number, output = 10): ModelEvent => ({ type: "usage", usage: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })

function fixture(steps: Parameters<typeof scriptedProvider>[0], options: Options = {}) {
  const scripted = scriptedProvider(steps)
  const history = options.history ?? memoryHistory()
  const engine = createNativeEngine({ provider: scripted.provider, tools: [echoTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "Summarize", ...options })
  const sessionId = ids("session")
  const say = (text: string) => engine.runTurn(turn({ text, sessionId, mode: () => "full" }).input)
  const compact = async (extra: { instructions?: string; idle?: true; selection?: { model: { model: string; effort?: "low" | "high" } } } = {}) => {
    const events: EngineEvent[] = []
    const outcome = await engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ...extra })
    return { outcome, events, cards: events.flatMap((event) => event.type === "item.started" && event.kind === "compaction" ? [event.meta ?? {}] : []) }
  }
  return { ...scripted, engine, history, sessionId, say, compact }
}

/** The request begins with the whole earlier one (tools, system prompt, every message) and ends with the summary prompt. */
function expectShared(request: ModelRequest, previous: ModelRequest) {
  expect(request.tools).toEqual(previous.tools)
  expect(request.system).toBe(previous.system)
  expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
  expect((request.messages.at(-1) as { content: string }).content).toContain("Do not call any tool")
}
/** The compaction's own request: no tools, and nothing after the prompt about them. */
function expectOwn(request: ModelRequest) {
  expect(request.tools).toEqual([])
  expect(request.hostedTools).toBeUndefined()
  expect((request.messages.at(-1) as { content: string }).content).not.toContain("Do not call any tool")
}
const summarized = async (history: ReturnType<typeof memoryHistory>, sessionId: Session) => ((await history.load(sessionId))![0] as { content: string }).content

/** Like the daemon's store: `save` only appends, so what a turn changes in memory never reaches the stored rows. */
function appendOnlyHistory(): ReturnType<typeof memoryHistory> {
  const rows = new Map<string, string[]>()
  return {
    load: async (sessionId) => rows.get(sessionId)?.map((row) => JSON.parse(row) as ModelMessage),
    save: async (sessionId, messages) => {
      const stored = rows.get(sessionId) ?? []
      for (let index = stored.length; index < messages.length; index++) stored.push(JSON.stringify(messages[index]))
      rows.set(sessionId, stored)
    },
    replace: async (sessionId, messages) => void rows.set(sessionId, messages.map((message) => JSON.stringify(message))),
  }
}

describe("when a manual or automatic compaction repeats the last main request", () => {
  test("the compaction role falls back to the main model: shared, the card says so, and the usage is not a main call's", async () => {
    const { requests, say, compact, history, sessionId } = fixture([[usage(500), ...stop("answer")], [usage(40), ...stop(SUMMARY)]], { modelFor: () => ({ model: "script-1", effort: "high" }), compactAtTokens: 100_000 })
    await say("hello")
    const { outcome, events, cards } = await compact()
    expect(outcome).toMatchObject({ status: "ok", compacted: true })
    expectShared(requests[1]!, requests[0]!)
    expect(requests[1]!).toMatchObject({ model: "script-1", effort: "high" })
    expect(cards).toEqual([expect.objectContaining({ cachedPrefix: true })])
    expect(events.filter((event) => event.type === "usage")).toEqual([expect.not.objectContaining({ compactAt: expect.anything() })])
    expect(await summarized(history, sessionId)).toContain(SUMMARY)
  })

  test("`/compact <instructions>` and a `compact.prompt` hook are in the prompt the shared request ends with", async () => {
    const hooks = { has: (name: string) => name === "compact.prompt", compactPrompt: async ({ prompt }: { prompt: string }) => `${prompt}\nHOOKED PROMPT` }
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)], { hooks: hooks as never })
    await say("hello")
    await compact({ instructions: "Keep the failing test names." })
    expectShared(requests[1]!, requests[0]!)
    const prompt = (requests[1]!.messages.at(-1) as { content: string }).content
    expect(prompt.startsWith("Create a new anchored summary")).toBe(true)
    for (const part of ["Summarize", "Keep the failing test names.", "Latest Real User Request Evidence", "HOOKED PROMPT"]) expect(prompt).toContain(part)
  })

  test("a model picked for this `/compact` that is the main call's model: shared", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)])
    await say("hello")
    await compact({ selection: { model: { model: "script-1" } } })
    expectShared(requests[1]!, requests[0]!)
  })

  test("strategy auto on a transport without native compaction: the portable summary is shared", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)], { compaction: () => ({ strategy: "auto" }) })
    await say("hello")
    expect((await compact()).outcome).toMatchObject({ compacted: true })
    expectShared(requests[1]!, requests[0]!)
  })

  test("messages appended after the call (a `!command`) keep the request shared", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), stop(SUMMARY)])
    await say("hello")
    // What `runShell` leaves in the history after the turn.
    const ran: ModelMessage = { role: "user", content: "I ran a shell command myself:\n$ ls\n```\nsrc\n```" }
    await history.save(sessionId, [...(await history.load(sessionId))!, ran])
    const { cards } = await compact()
    expectShared(requests[1]!, requests[0]!)
    expect(requests[1]!.messages.slice(-2)[0]).toEqual(ran)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefix: true })])
  })

  test("an append-only store: the reasoning a new turn dropped in memory is dropped again, so the earlier messages match", async () => {
    const thought = (text: string): ModelEvent => ({ type: "reasoning_state", state: { provider: "scripted", model: "script-1", blocks: [{ type: "thinking", thinking: text, signature: "sig" }] } })
    const history = appendOnlyHistory()
    const { requests, say, compact, sessionId } = fixture([[thought("one"), ...stop("first")], [thought("two"), ...stop("second")], stop(SUMMARY)], { history })
    await say("hello")
    await say("again")
    // The stored first answer still carries its reasoning; the second turn's request did not send it.
    expect(((await history.load(sessionId))![1] as { reasoning?: unknown }).reasoning).toBeDefined()
    expect((requests[1]!.messages[1] as { reasoning?: unknown }).reasoning).toBeUndefined()
    const { cards } = await compact()
    expectShared(requests[2]!, requests[1]!)
    expect((requests[2]!.messages[3] as { reasoning?: unknown }).reasoning).toBeDefined()
    expect(cards).toEqual([expect.objectContaining({ cachedPrefix: true })])
  })

  test("an append-only store: the old tool outputs a turn pruned in memory are pruned again, so the earlier messages match", async () => {
    const history = appendOnlyHistory()
    // Six results of 12,800 tokens each (a tool result is cut at 51,200 bytes).
    const reads: ModelEvent[] = [...[1, 2, 3, 4, 5, 6].map((n): ModelEvent => ({ type: "tool_call", call: { callId: `call_${n}`, name: "read", args: { path: `src/${n}.ts` } } })), { type: "finish", reason: "tool_calls" }]
    const { requests, say, compact, sessionId } = fixture([[usage(1_000), ...reads], [usage(50_000), ...stop("read them")], [usage(90_000), ...stop("second")], [usage(90_000), ...stop("third")], stop(SUMMARY)], { history, tools: [fileTool("read", 60_000)], compactAtTokens: 100_000 })
    await say("read the six files")
    await say("and now")
    await say("and then")
    const PRUNED = "[Old tool output pruned; read the file or rerun the tool if needed.]"
    const outputs = (messages: readonly ModelMessage[]) => messages.flatMap((message) => message.role === "tool" ? [message.output === PRUNED ? "pruned" : "whole"] : [])
    // The third turn started at 90 % of the compaction point: it pruned the three oldest outputs in memory; the store still has them whole.
    expect(outputs(requests[3]!.messages)).toEqual(["pruned", "pruned", "pruned", "whole", "whole", "whole"])
    expect(outputs((await history.load(sessionId))!)).toEqual(["whole", "whole", "whole", "whole", "whole", "whole"])
    const { cards } = await compact()
    expectShared(requests[4]!, requests[3]!)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefix: true })])
  })
})

describe("when it keeps its own request", () => {
  test("no main call on record in this process (a restarted daemon)", async () => {
    const first = fixture([stop("answer")])
    await first.say("hello")
    const restarted = fixture([stop(SUMMARY)], { history: first.history })
    const events: EngineEvent[] = []
    expect(await restarted.engine.compact({ sessionId: first.sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event) })).toMatchObject({ compacted: true })
    expectOwn(restarted.requests[0]!)
    expect(events.find((event) => event.type === "item.started")).toMatchObject({ meta: expect.not.objectContaining({ cachedPrefix: true }) })
  })

  test("a second compaction right after the first: the request on record was for the history the first one replaced", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY), stop(SUMMARY)])
    await say("hello")
    await compact()
    expect((await compact()).outcome).toMatchObject({ compacted: true })
    expectShared(requests[1]!, requests[0]!)
    expectOwn(requests[2]!)
  })

  test("the user gave the compaction role another model: that model, its own request", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)], { modelFor: (_sessionId, role) => ({ model: role === "compaction" ? "script-small" : "script-1" }) })
    await say("hello")
    const { outcome, cards } = await compact()
    expect(outcome).toMatchObject({ compacted: true })
    expectOwn(requests[1]!)
    expect(requests[1]!.model).toBe("script-small")
    expect(cards).toEqual([expect.not.objectContaining({ cachedPrefix: true })])
  })

  test("the compaction role names the main model with an effort of its own: still the user's summariser, its own request", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)], { modelFor: (_sessionId, role) => ({ model: "script-1", effort: role === "compaction" ? "low" : "high" }) })
    await say("hello")
    await compact()
    expectOwn(requests[1]!)
    expect(requests[1]!).toMatchObject({ model: "script-1", effort: "low" })
  })

  test("a model picked for this `/compact` that is not the main call's", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)])
    await say("hello")
    await compact({ selection: { model: { model: "script-other" } } })
    expectOwn(requests[1]!)
    expect(requests[1]!.model).toBe("script-other")
  })

  test("strategy native (a `/compact <instructions>` writes a portable summary under it)", async () => {
    const { requests, say, compact } = fixture([stop("answer"), stop(SUMMARY)], { compaction: () => ({ strategy: "native" }) })
    await say("hello")
    expect((await compact({ instructions: "Keep the names." })).outcome).toMatchObject({ compacted: true })
    expectOwn(requests[1]!)
  })

  test("the stored history no longer starts with what the call sent (a message was edited)", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), stop(SUMMARY)])
    await say("hello")
    const stored = (await history.load(sessionId))!
    await history.replace(sessionId, [{ role: "user", content: "hello, edited" }, ...stored.slice(1)])
    const { outcome, cards } = await compact()
    expect(outcome).toMatchObject({ compacted: true })
    expectOwn(requests[1]!)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefixOff: "history-changed" })])
  })
})

describe("the shared request must fit the model's input", () => {
  /** One turn that leaves 5,010 tokens of context, then a manual compaction under `limits`. */
  const run = async (limits: { window?: number; inputLimit?: number }) => {
    const made = fixture([[usage(5_000), ...stop("answer")], stop(SUMMARY)], limits.window ? { contextWindowFor: () => limits.window } : {})
    if (limits.inputLimit) made.provider.compactionLimits = () => ({ inputLimit: limits.inputLimit! })
    await made.say("hello")
    return { ...made, ...await made.compact() }
  }
  const promptTokens = (request: ModelRequest) => Math.ceil((request.messages.at(-1) as { content: string }).content.length / 4)

  test("a context window holds the request and the summary: last call + prompt + 4,096 fits exactly, one token less does not", async () => {
    const free = await run({})
    expectShared(free.requests[1]!, free.requests[0]!)
    const needed = 5_010 + promptTokens(free.requests[1]!) + 4_096
    const fits = await run({ window: needed })
    expectShared(fits.requests[1]!, fits.requests[0]!)
    const over = await run({ window: needed - 1 })
    expect(over.outcome).toMatchObject({ compacted: true })
    expectOwn(over.requests[1]!)
    // The smaller request is sent to the model: not the local rescue summary.
    expect(over.cards).toEqual([expect.objectContaining({ cachedPrefixOff: "too-large" })])
    expect(over.cards[0]).not.toHaveProperty("summaryFallback")
    expect(await summarized(over.history, over.sessionId)).toContain(SUMMARY)
  })

  test("a stated input limit leaves the output aside: last call + prompt fits exactly", async () => {
    const free = await run({})
    const needed = 5_010 + promptTokens(free.requests[1]!)
    const fits = await run({ inputLimit: needed })
    expectShared(fits.requests[1]!, fits.requests[0]!)
    const over = await run({ inputLimit: needed - 1 })
    expectOwn(over.requests[1]!)
    expect(over.cards).toEqual([expect.objectContaining({ cachedPrefixOff: "too-large" })])
  })

  test("an automatic compaction whose turn ended at 98 % of a 200,000-token window (the default point is 95 %): 4,000 tokens are left, less than the summary's room", async () => {
    const { requests, say, compact, engine, sessionId } = fixture([[usage(195_990), ...stop("answer")], stop(SUMMARY)], { contextWindowFor: () => 200_000 })
    await say("hello")
    expect(engine.needsCompaction(sessionId)).toBe(true)
    const { outcome, cards } = await compact()
    expect(outcome).toMatchObject({ compacted: true })
    expectOwn(requests[1]!)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefixOff: "too-large" })])
  })

  test("the same at 95 % of a 1,000,000-token window: 50,000 tokens are left, it is shared", async () => {
    const { requests, say, compact, engine, sessionId } = fixture([[usage(950_490), ...stop("answer")], stop(SUMMARY)], { contextWindowFor: () => 1_000_000 })
    await say("hello")
    expect(engine.needsCompaction(sessionId)).toBe(true)
    await compact()
    expectShared(requests[1]!, requests[0]!)
  })

  test("a compaction while idle that would not fit is skipped: no model call", async () => {
    const { requests, say, compact } = fixture([[usage(5_000), ...stop("answer")], stop(SUMMARY)], { contextWindowFor: () => 6_000 })
    await say("hello")
    expect((await compact({ idle: true })).outcome).toEqual({ status: "ok" })
    expect(requests).toHaveLength(1)
  })
})

describe("a shared reply that is not a summary: the compaction's own request is sent once", () => {
  const items = (events: EngineEvent[]) => events.flatMap((event): Array<{ started?: unknown; completed?: string }> => event.type === "item.started" && event.kind === "compaction" ? [{ started: event.meta }] : event.type === "item.completed" ? [{ completed: event.status }] : [])

  test("the reply calls a tool: its card closes as an error, the retry has no tools and its summary is installed", async () => {
    const called: ModelEvent[] = [{ type: "text", delta: "Let me look first." }, { type: "tool_call", call: { callId: "call_1", name: "echo", args: { text: "x" } } }, { type: "finish", reason: "tool_calls" }]
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), called, stop(SUMMARY)], { hostedTools: () => ["web_search"] })
    await say("hello")
    const { outcome, events } = await compact()
    expect(outcome).toMatchObject({ status: "ok", compacted: true })
    expect(requests).toHaveLength(3)
    expectShared(requests[1]!, requests[0]!)
    expect(requests[1]!.hostedTools).toEqual(["web_search"])
    expectOwn(requests[2]!)
    expect(items(events)).toEqual([
      { started: expect.objectContaining({ cachedPrefix: true }) }, { completed: "error" },
      { started: expect.objectContaining({ cachedPrefixOff: "tool-call" }) }, { completed: "ok" },
    ])
    const installed = await summarized(history, sessionId)
    expect(installed).toContain(SUMMARY)
    expect(installed).not.toContain("Let me look first.")
  })

  test("an empty reply", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), [{ type: "finish", reason: "stop" }], stop(SUMMARY)])
    await say("hello")
    const { cards } = await compact()
    expect(requests).toHaveLength(3)
    expectOwn(requests[2]!)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefixOff: "empty" })])
    expect(await summarized(history, sessionId)).toContain(SUMMARY)
  })

  test("a reply that prints tool calls as text: retried before the local rescue summary is considered", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), stop("to=functions.read {\"path\":\"a\"}"), stop(SUMMARY)])
    await say("hello")
    const { cards } = await compact()
    expectOwn(requests[2]!)
    expect(cards.at(-1)).toMatchObject({ cachedPrefixOff: "tool-call-cosplay" })
    expect(await summarized(history, sessionId)).toContain(SUMMARY)
  })

  test("the provider refuses the shared request (it was larger than estimated)", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), new Error("[PROVIDER]: 400 context length exceeded"), stop(SUMMARY)])
    await say("hello")
    const { outcome, cards } = await compact()
    expect(outcome).toMatchObject({ compacted: true })
    expectOwn(requests[2]!)
    expect(cards).toEqual([expect.objectContaining({ cachedPrefixOff: "error" })])
    expect(await summarized(history, sessionId)).toContain(SUMMARY)
  })

  test("only once: a retry that also returns nothing installs nothing", async () => {
    const { requests, say, compact, history, sessionId } = fixture([stop("answer"), [{ type: "finish", reason: "stop" }], [{ type: "finish", reason: "stop" }], stop(SUMMARY)])
    await say("hello")
    expect((await compact()).outcome).toEqual({ status: "ok" })
    expect(requests).toHaveLength(3)
    expect((await history.load(sessionId))!.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  test("a compaction while idle is not retried at the full price: nothing is installed", async () => {
    const { requests, say, compact } = fixture([stop("answer"), [{ type: "finish", reason: "stop" }], stop(SUMMARY)])
    await say("hello")
    expect((await compact({ idle: true })).outcome).toEqual({ status: "ok" })
    expect(requests).toHaveLength(2)
  })
})
