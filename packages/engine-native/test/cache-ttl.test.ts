import { afterEach, describe, expect, test } from "bun:test"
import type { PromptCacheMode } from "@mendcode/protocol"
import type { CacheTtl } from "@mendcode/protocol/wire"
import { createAnthropicProvider, createNativeEngine, memoryHistory, withoutCacheTtl, type ModelEvent, type ModelRequest } from "../src"
import { collect, fakeServer, sse } from "./fake-server"
import { callTool, echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

const TWO_TOOLS = [
  { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "grep", description: "search", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
]
const DONE = [{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
const answer = () => sse(DONE, { named: true })
const refusal = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "cache_control.ttl: Extra inputs are not permitted" } }), { status: 400, headers: { "content-type": "application/json" } })

type Body = { system: Array<{ cache_control?: unknown }>; tools: Array<{ name: string; cache_control?: unknown }>; messages: Array<{ role: string; content: Array<{ cache_control?: unknown }> }> }

function setup(handler: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(handler)
  stops.push(server.stop)
  const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1` })
  return { server, provider }
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok", toolCalls: [] },
    { role: "user", content: "second" },
  ],
  tools: TWO_TOOLS,
  conversationId: "ses_ttl",
  signal: new AbortController().signal,
  ...overrides,
})

/** Every `cache_control` of a body in the order Anthropic reads a request: tools, system, messages. */
const marks = (body: Body) => [...body.tools, ...body.system, ...body.messages.flatMap((message) => message.content)].map((block) => block.cache_control).filter((mark) => mark !== undefined) as Array<{ type: string; ttl?: string }>
/** The documented order: no breakpoint with a longer lifetime after one with a shorter lifetime. */
const longerFirst = (list: Array<{ ttl?: string }>) => list.every((mark, index) => mark.ttl !== "1h" || list.slice(0, index).every((before) => before.ttl === "1h"))
const usageOf = (events: ModelEvent[]) => events.find((event) => event.type === "usage")

describe("Anthropic cache lifetime: the wire shape", () => {
  test("5m and no lifetime at all send the mark without ttl, as before the setting existed", async () => {
    for (const cacheTtl of [undefined, "5m"] as const) {
      for (const cacheMode of ["legacy", "smart"] as PromptCacheMode[]) {
        const { server, provider } = setup(answer)
        const events = await collect(provider.stream(request({ cacheMode, ...(cacheTtl ? { cacheTtl } : {}) })))
        const sent = marks(server.requests[0]!.body as Body)
        expect(sent.length).toBe(cacheMode === "smart" ? 4 : 2)
        for (const mark of sent) expect(mark).toEqual({ type: "ephemeral" })
        expect(usageOf(events)).toEqual({ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
      }
    }
  })

  test("1h sends cache_control { type: ephemeral, ttl: 1h } on every breakpoint, with no beta header, and the usage says so", async () => {
    const { server, provider } = setup(answer)
    const events = await collect(provider.stream(request({ cacheMode: "smart", cacheTtl: "1h" })))
    const sent = server.requests[0]!
    const list = marks(sent.body as Body)
    expect(list).toHaveLength(4)
    for (const mark of list) expect(mark).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(sent.headers["anthropic-beta"]).toBeUndefined()
    expect(usageOf(events)).toEqual({ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheTtl: "1h" } })
  })

  test("legacy at 1h marks the system prompt and the last user message, both at 1h", async () => {
    const { server, provider } = setup(answer)
    await collect(provider.stream(request({ cacheTtl: "1h" })))
    const body = server.requests[0]!.body as Body
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(marks(body)).toHaveLength(2)
  })

  test("a request never has a 1h breakpoint after a 5m one: one lifetime for all of its breakpoints", async () => {
    for (const cacheTtl of [undefined, "5m", "1h"] as const) {
      for (const cacheMode of ["legacy", "smart"] as PromptCacheMode[]) {
        const { server, provider } = setup(answer)
        await collect(provider.stream(request({ cacheMode, ...(cacheTtl ? { cacheTtl } : {}) })))
        const list = marks(server.requests[0]!.body as Body)
        expect(longerFirst(list)).toBe(true)
        expect(new Set(list.map((mark) => mark.ttl)).size).toBe(1)
      }
    }
    // The check itself tells the two orders apart.
    expect(longerFirst([{ ttl: "1h" }, {}])).toBe(true)
    expect(longerFirst([{}, { ttl: "1h" }])).toBe(false)
  })

  test("off sends no breakpoint, whatever lifetime was asked for", async () => {
    const { server, provider } = setup(answer)
    const events = await collect(provider.stream(request({ cacheMode: "off", cacheTtl: "1h" })))
    expect(JSON.stringify(server.requests[0]!.body)).not.toContain("cache_control")
    expect(usageOf(events)).toEqual({ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
  })
})

describe("cache lifetime: what the engine asks for", () => {
  function engineFor(steps: Parameters<typeof scriptedProvider>[0], options: { mode?: PromptCacheMode; ttl?: CacheTtl | undefined }) {
    const { provider, requests } = scriptedProvider(steps)
    const asked: Array<{ sessionId: string; role: string; provider: string }> = []
    const engine = createNativeEngine({
      provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", subagents: true,
      promptCache: () => options.mode,
      cacheTtl: (input) => { asked.push(input); return options.ttl },
    })
    return { engine, requests, asked }
  }

  test("the lifetime is asked once per request, with the session, the role and the provider, and travels in the request", async () => {
    const sessionId = ids("session")
    const { engine, requests, asked } = engineFor([callTool("task", { description: "d", prompt: "p" }), stop("sub answer"), stop("done")], { ttl: "1h" })
    await engine.runTurn(turn({ text: "go", sessionId }).input)
    expect(requests.map((request) => request.cacheTtl)).toEqual(["1h", "1h", "1h"])
    expect(asked.map((input) => input.role)).toEqual(["main", "subagent", "main"])
    expect(asked.every((input) => input.provider === "scripted")).toBe(true)
    expect(asked[0]!.sessionId).toBe(sessionId)
  })

  test("no lifetime from the policy leaves the request without the field", async () => {
    const { engine, requests } = engineFor([stop("a")], { ttl: undefined })
    await engine.runTurn(turn({ text: "1", sessionId: ids("session") }).input)
    expect("cacheTtl" in requests[0]!).toBe(false)
  })

  test("promptCache off never asks: a call that caches nothing is not a call the lifetime rule counts", async () => {
    const { engine, requests, asked } = engineFor([stop("a")], { mode: "off", ttl: "1h" })
    await engine.runTurn(turn({ text: "1", sessionId: ids("session") }).input)
    expect(asked).toEqual([])
    expect("cacheTtl" in requests[0]!).toBe(false)
  })
})

describe("Anthropic cache lifetime: a host that refuses ttl", () => {
  test("a 400 is answered by the same call without ttl, once; the conversation then sends none", async () => {
    const { server, provider } = setup((sent) => (JSON.stringify(sent.body).includes('"ttl"') ? refusal() : answer()))
    const first = await collect(provider.stream(request({ cacheMode: "smart", cacheTtl: "1h" })))
    expect(server.requests).toHaveLength(2)
    expect(marks(server.requests[0]!.body as Body).every((mark) => mark.ttl === "1h")).toBe(true)
    const retried = marks(server.requests[1]!.body as Body)
    expect(retried).toHaveLength(4)
    for (const mark of retried) expect(mark).toEqual({ type: "ephemeral" })
    // Everything else of the request is what was refused.
    expect(withoutCacheTtl(server.requests[0]!.body)).toEqual(server.requests[1]!.body)
    expect(first.at(-1)).toEqual({ type: "finish", reason: "stop" })
    // Written at the provider's default lifetime, so the usage does not claim an hour.
    expect(usageOf(first)).toEqual({ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })

    await collect(provider.stream(request({ cacheMode: "smart", cacheTtl: "1h" })))
    expect(server.requests).toHaveLength(3)
    expect(JSON.stringify(server.requests[2]!.body)).not.toContain('"ttl"')
  })

  test("another conversation of the same provider still asks for 1h", async () => {
    const { server, provider } = setup((sent) => (sent.body.messages[0].content[0].text === "refused one" && JSON.stringify(sent.body).includes('"ttl"') ? refusal() : answer()))
    await collect(provider.stream(request({ cacheTtl: "1h", conversationId: "ses_a", messages: [{ role: "user", content: "refused one" }] })))
    await collect(provider.stream(request({ cacheTtl: "1h", conversationId: "ses_b" })))
    expect(server.requests).toHaveLength(3)
    expect(JSON.stringify(server.requests[2]!.body)).toContain('"ttl":"1h"')
  })

  test("a request refused for another reason fails with its own error after one more try, and nothing is remembered", async () => {
    let fail = true
    const { server, provider } = setup(() => (fail ? new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long" } }), { status: 400 }) : answer()))
    await expect(collect(provider.stream(request({ cacheTtl: "1h" })))).rejects.toThrow(/400.*prompt is too long/)
    // The first try and the one without ttl: no loop.
    expect(server.requests).toHaveLength(2)
    fail = false
    await collect(provider.stream(request({ cacheTtl: "1h" })))
    expect(server.requests).toHaveLength(3)
    expect(JSON.stringify(server.requests[2]!.body)).toContain('"ttl":"1h"')
  })

  test("a 400 without ttl in the request is not tried again", async () => {
    const { server, provider } = setup(() => new Response("bad request", { status: 400 }))
    await expect(collect(provider.stream(request()))).rejects.toThrow(/400/)
    expect(server.requests).toHaveLength(1)
  })

  test("a retryable failure (529) is not treated as a refusal", async () => {
    const { server, provider } = setup(() => new Response("overloaded", { status: 529 }))
    await expect(collect(provider.stream(request({ cacheTtl: "1h" })))).rejects.toThrow(/529/)
    expect(server.requests).toHaveLength(1)
  })
})
