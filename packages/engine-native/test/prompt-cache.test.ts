import { afterEach, describe, expect, test } from "bun:test"
import type { PromptCacheMode } from "@mendcode/protocol"
import { createAnthropicProvider, createChatCompletionsProvider, createNativeEngine, createResponsesProvider, memoryHistory, type ModelRequest } from "../src"
import { collect, fakeServer, sse } from "./fake-server"
import { callTool, echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((fn) => fn()))

const compactInput = (sessionId: ReturnType<typeof ids<"session">>) => ({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })

describe("prompt cache: what the engine asks for", () => {
  function engineFor(steps: Parameters<typeof scriptedProvider>[0], mode: { current: PromptCacheMode | undefined }) {
    const { provider, requests } = scriptedProvider(steps)
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", subagents: true, promptCache: () => mode.current })
    return { engine, requests }
  }

  test("off sends no key and says so; legacy (and an unset setting) keep one key per session", async () => {
    const mode: { current: PromptCacheMode | undefined } = { current: "off" }
    const sessionId = ids("session")
    const { engine, requests } = engineFor([stop("a"), stop("b"), stop("c")], mode)
    await engine.runTurn(turn({ text: "1", sessionId }).input)
    mode.current = "legacy"
    await engine.runTurn(turn({ text: "2", sessionId }).input)
    // The setting is read at each call: unset means legacy.
    mode.current = undefined
    await engine.runTurn(turn({ text: "3", sessionId }).input)
    expect(requests.map((r) => [r.cacheKey, r.cacheMode])).toEqual([
      [undefined, "off"],
      [sessionId, "legacy"],
      [sessionId, "legacy"],
    ])
    expect("cacheKey" in requests[0]!).toBe(false)
  })

  test("a sub-agent has its own key in every mode that sends one, and none when off", async () => {
    const sessionId = ids("session")
    for (const [mode, expected] of [["legacy", `${sessionId}/subagent`], ["smart", `${sessionId}/subagent`], ["off", undefined]] as const) {
      const { engine, requests } = engineFor([callTool("task", { description: "d", prompt: "p" }), stop("sub answer"), stop("done")], { current: mode })
      await engine.runTurn(turn({ text: "go", sessionId }).input)
      expect([mode, requests[1]!.cacheKey]).toEqual([mode, expected])
    }
  })

  test("smart keeps the session's key until a compaction, then keys the new lineage; the key is stable within it", async () => {
    const sessionId = ids("session")
    const { engine, requests } = engineFor([stop("a"), stop("SUMMARY ONE"), stop("b"), stop("c"), stop("SUMMARY TWO"), stop("d")], { current: "smart" })
    await engine.runTurn(turn({ text: "1", sessionId }).input)
    await engine.compact(compactInput(sessionId))
    await engine.runTurn(turn({ text: "2", sessionId }).input)
    await engine.runTurn(turn({ text: "3", sessionId }).input)
    await engine.compact(compactInput(sessionId))
    await engine.runTurn(turn({ text: "4", sessionId }).input)
    const keys = requests.map((r) => r.cacheKey!)
    // 0: turn before any compaction · 1: the compaction call shares that prefix, so its key · 2,3: lineage one · 4: compacting lineage one · 5: lineage two.
    expect(keys[0]).toBe(sessionId)
    expect(keys[1]).toBe(sessionId)
    expect(keys[2]).toMatch(new RegExp(`^${sessionId}~[0-9a-f]{8}$`))
    expect(keys[3]).toBe(keys[2]!)
    expect(keys[4]).toBe(keys[2]!)
    expect(keys[5]).toMatch(new RegExp(`^${sessionId}~[0-9a-f]{8}$`))
    expect(keys[5]).not.toBe(keys[2]!)
  })

  test("smart's lineage survives a restart: the same summary gives the same key", async () => {
    const sessionId = ids("session")
    const history = memoryHistory()
    const first = scriptedProvider([stop("a"), stop("THE SUMMARY"), stop("b")])
    const engine = createNativeEngine({ provider: first.provider, tools: [echoTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", promptCache: () => "smart" })
    await engine.runTurn(turn({ text: "1", sessionId }).input)
    await engine.compact(compactInput(sessionId))
    await engine.runTurn(turn({ text: "2", sessionId }).input)
    const second = scriptedProvider([stop("c")])
    const restarted = createNativeEngine({ provider: second.provider, tools: [echoTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", promptCache: () => "smart" })
    await restarted.runTurn(turn({ text: "3", sessionId }).input)
    expect(second.requests[0]!.cacheKey).toBe(first.requests[2]!.cacheKey!)
  })

  test("legacy keeps the session key across a compaction (today's behaviour)", async () => {
    const sessionId = ids("session")
    const { engine, requests } = engineFor([stop("a"), stop("SUMMARY"), stop("b")], { current: "legacy" })
    await engine.runTurn(turn({ text: "1", sessionId }).input)
    await engine.compact(compactInput(sessionId))
    await engine.runTurn(turn({ text: "2", sessionId }).input)
    expect(new Set(requests.map((r) => r.cacheKey))).toEqual(new Set([sessionId]))
  })
})

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"
const TWO_TOOLS = [
  { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "grep", description: "search", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
]
const DONE = [{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]

describe("prompt cache: what the Anthropic adapter sends", () => {
  async function bodyFor(cacheMode: PromptCacheMode | undefined) {
    const server = fakeServer(() => sse(DONE, { named: true }))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1` })
    const request: ModelRequest = {
      system: "be brief",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok", toolCalls: [] },
        { role: "user", content: "second" },
      ],
      tools: TWO_TOOLS,
      ...(cacheMode ? { cacheMode } : {}),
      signal: new AbortController().signal,
    }
    await collect(provider.stream(request))
    return server.requests[0]!.body as { system: Array<{ cache_control?: unknown }>; tools: Array<{ name: string; cache_control?: unknown }>; messages: Array<{ role: string; content: Array<{ cache_control?: unknown }> }> }
  }

  test("off puts no breakpoint anywhere", async () => {
    const body = await bodyFor("off")
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  test("legacy (and no mode at all) marks the system prompt and the last user message, as before", async () => {
    for (const mode of ["legacy", undefined] as const) {
      const body = await bodyFor(mode)
      expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages.map((m) => m.content.map((block) => block.cache_control !== undefined))).toEqual([[false], [false], [true]])
      expect(body.tools.some((tool) => tool.cache_control)).toBe(false)
    }
  })

  test("smart adds a breakpoint on the last tool and one on the previous user message: tools, system, previous turn, last user message", async () => {
    const body = await bodyFor("smart")
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" })
    expect(body.tools.map((tool) => [tool.name, tool.cache_control !== undefined])).toEqual([["read", false], ["grep", true]])
    expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" })
    expect(body.messages.map((m) => m.content.map((block) => block.cache_control !== undefined))).toEqual([[true], [false], [true]])
    // Anthropic allows four breakpoints; smart uses all four.
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(4)
  })

  test("the previous-turn breakpoint follows the conversation: it sits where the previous request put its last one", async () => {
    const server = fakeServer(() => sse(DONE, { named: true }))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1` })
    const conversation: ModelRequest["messages"] = [{ role: "user", content: "go" }]
    const marked: number[][] = []
    for (let step = 1; step <= 3; step++) {
      await collect(provider.stream({ system: "s", messages: conversation, tools: TWO_TOOLS, cacheMode: "smart", signal: new AbortController().signal }))
      const body = server.requests.at(-1)!.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      marked.push(body.messages.flatMap((message, index) => message.content.some((block) => block.cache_control) ? [index] : []))
      conversation.push({ role: "assistant", content: "", toolCalls: [{ callId: `c${step}`, name: "read", args: {} }] }, { role: "tool", callId: `c${step}`, name: "read", output: "x", isError: false })
    }
    // Wire messages alternate user, assistant, user…: each request marks its last user message and the one it marked the step before.
    expect(marked).toEqual([[0], [0, 2], [2, 4]])
  })
})

describe("prompt cache: what the other adapters send", () => {
  async function responsesCall(mode: PromptCacheMode) {
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = []
    const provider = createResponsesProvider({
      id: "openai",
      model: "gpt-test",
      baseUrl: "https://api.example/v1/",
      headers: async () => ({ authorization: "Bearer t" }),
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
        return new Response(sse([{ type: "response.completed", response: {} }]).body, { status: 200 })
      },
    })
    const sessionId = ids("session")
    const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", promptCache: () => mode })
    await engine.runTurn(turn({ text: "hi", sessionId }).input)
    return { call: calls[0]!, sessionId }
  }

  test("the Responses adapter honours the key: prompt_cache_key and the session_id routing header, none when off", async () => {
    const off = await responsesCall("off")
    expect("prompt_cache_key" in off.call.body).toBe(false)
    expect(off.call.headers.session_id).toBeUndefined()
    for (const mode of ["legacy", "smart"] as const) {
      const { call, sessionId } = await responsesCall(mode)
      expect([call.body.prompt_cache_key, call.headers.session_id]).toEqual([sessionId, sessionId])
    }
  })

  test("the Chat Completions adapter sends no cache field in any mode (the host caches prefixes by itself)", async () => {
    for (const cacheMode of ["off", "legacy", "smart"] as const) {
      const server = fakeServer(() => sse([{ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }, "[DONE]"]))
      stops.push(server.stop)
      const provider = createChatCompletionsProvider({ id: "openrouter", model: "vendor/model", baseUrl: `${server.url}/api/v1/`, apiKey: () => KEY, requireKey: true })
      await collect(provider.stream({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], cacheKey: "ses_1", cacheMode, signal: new AbortController().signal }))
      expect(JSON.stringify(server.requests[0]!.body)).not.toMatch(/cache/)
    }
  })
})
