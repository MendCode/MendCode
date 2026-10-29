import { afterEach, describe, expect, test } from "bun:test"
import { createChatCompletionsProvider, RetryableProviderError, toChatMessages, type ModelEvent, type ModelMessage, type ModelRequest } from "../src"
import { collect, collectAll, fakeServer, hangingSse, sse } from "./fake-server"

const KEY = "sk-or-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

function setup(handler: Parameters<typeof fakeServer>[0], options: Partial<Parameters<typeof createChatCompletionsProvider>[0]> = {}) {
  const server = fakeServer(handler)
  stops.push(server.stop)
  const provider = createChatCompletionsProvider({ id: "openrouter", model: "vendor/model", baseUrl: `${server.url}/api/v1/`, apiKey: () => KEY, requireKey: true, ...options })
  return { server, provider }
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  signal: new AbortController().signal,
  ...overrides,
})

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] })

const TOOL_TURN = [
  chunk({ role: "assistant", reasoning_content: "thinking " }),
  chunk({ content: "Leyendo ñ " }),
  chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"b.ts"}' } }] }),
  chunk({}, "tool_calls"),
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.0123 } },
  "[DONE]",
]

const FINAL_TURN = [chunk({ content: "done" }), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }, "[DONE]"]

describe("Chat Completions adapter", () => {
  test("split arguments stream as tool_input under the call's id before the calls are whole", async () => {
    const { provider } = setup(() => sse(TOOL_TURN))
    const events = (await collectAll(provider.stream(request()))).filter((event) => event.type === "tool_input" || event.type === "tool_call")
    expect(events).toEqual([
      { type: "tool_input", callId: "call_1", name: "read", delta: '{"path":' },
      { type: "tool_input", callId: "call_1", name: "read", delta: '"a.ts"}' },
      { type: "tool_input", callId: "call_2", name: "read", delta: '{"path":"b.ts"}' },
      { type: "tool_call", call: { callId: "call_1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "call_2", name: "read", args: { path: "b.ts" } } },
    ])
  })

  test("streams reasoning, text, tool calls (split arguments, two calls) and usage, and sends the documented request", async () => {
    const { server, provider } = setup(() => sse(TOOL_TURN))
    const events = await collect(provider.stream(request({ model: "other/model" })))
    expect(events).toEqual([
      { type: "reasoning", delta: "thinking " },
      { type: "text", delta: "Leyendo ñ " },
      { type: "tool_call", call: { callId: "call_1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "call_2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0, costMicros: 12_300 } },
      { type: "finish", reason: "tool_calls" },
    ])
    const sent = server.requests[0]!
    expect(sent.path).toBe("/api/v1/chat/completions")
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent.body).toMatchObject({
      model: "other/model",
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }],
    })
  })

  test("reasoning_content, OpenRouter's reasoning field and DeepSeek's cache counters are understood", async () => {
    const { provider } = setup(() => sse([chunk({ reasoning: "via openrouter" }), chunk({ content: "x" }), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 30 } }, "[DONE]"]))
    const events = await collect(provider.stream(request()))
    expect(events[0]).toEqual({ type: "reasoning", delta: "via openrouter" })
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 20, output: 1, reasoning: 0, cacheRead: 30, cacheWrite: 0 } })
  })

  test("a tool round trip: assistant tool_calls and a tool message go back, then the final text", async () => {
    const { server, provider } = setup((_, index) => sse(index === 0 ? TOOL_TURN.slice(0, 5).concat([chunk({}, "tool_calls"), "[DONE]"]) : FINAL_TURN))
    const first = await collect(provider.stream(request()))
    const call = first.find((e) => e.type === "tool_call")
    if (call?.type !== "tool_call") throw new Error("no call")
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [call.call] },
      { role: "tool", callId: call.call.callId, name: "read", output: "file text", isError: false },
    ]
    const second = await collect(provider.stream(request({ messages: history })))
    expect(second.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "done" }])
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(server.requests[1]!.body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "file text" },
    ])
  })

  test("effort becomes reasoning_effort, or OpenRouter's reasoning object; minimal sends nothing", async () => {
    const plain = setup(() => sse(FINAL_TURN))
    await collect(plain.provider.stream(request({ effort: "high" })))
    await collect(plain.provider.stream(request({ effort: "xhigh" })))
    await collect(plain.provider.stream(request({ effort: "minimal" })))
    expect(plain.server.requests.map((r) => r.body.reasoning_effort)).toEqual(["high", "high", undefined])
    const router = setup(() => sse(FINAL_TURN), { reasoningStyle: "reasoning-object" })
    await collect(router.provider.stream(request({ effort: "medium" })))
    expect(router.server.requests[0]!.body.reasoning).toEqual({ effort: "medium" })
    expect(router.server.requests[0]!.body.reasoning_effort).toBeUndefined()
  })

  test("a local server without auth gets no Authorization header and no tool policy without tools", async () => {
    const { server, provider } = setup(() => sse(FINAL_TURN), { id: "ollama", apiKey: () => undefined, requireKey: false })
    await collect(provider.stream(request({ tools: [], maxOutputTokens: 8 })))
    const sent = server.requests[0]!
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.body.tools).toBeUndefined()
    expect(sent.body.tool_choice).toBeUndefined()
    expect(sent.body.max_tokens).toBe(8)
  })

  test("a server that ends the stream after the finish reason without [DONE] still completes", async () => {
    const { provider } = setup(() => sse([chunk({ content: "ok" }), chunk({}, "length")]))
    expect((await collect(provider.stream(request()))).at(-1)).toEqual({ type: "finish", reason: "length" })
  })

  test("429 with retry-after is retryable with the wait; 503 too; the key never shows", async () => {
    const limited = setup(() => new Response(JSON.stringify({ error: { message: `rate limited for ${KEY}` } }), { status: 429, headers: { "retry-after": "3" } }))
    const error = await collect(limited.provider.stream(request())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect((error as RetryableProviderError).retryAfterMs).toBe(3_000)
    expect((error as Error).message).not.toContain(KEY)
    const down = setup(() => new Response("bad gateway", { status: 503 }))
    expect(await collect(down.provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
  })

  test("an insufficient-quota 429 is final (waiting does not help)", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }), { status: 429 }))
    expect(await collect(provider.stream(request())).catch((e: unknown) => e)).not.toBeInstanceOf(RetryableProviderError)
  })

  test("401 is a clear final auth error without the key", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { message: `No auth credentials found for ${KEY}` } }), { status: 401 }))
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect(error.message).toStartWith("[AUTH]: openrouter 401")
    expect(error.message).not.toContain(KEY)
  })

  test("an error chunk inside the stream: 5xx retries, others are final", async () => {
    const retry = setup(() => sse([{ error: { code: 502, message: "upstream down" } }]))
    expect(await collect(retry.provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
    const final = setup(() => sse([{ error: { code: 400, message: "bad" } }]))
    expect(await collect(final.provider.stream(request())).catch((e: unknown) => e)).not.toBeInstanceOf(RetryableProviderError)
  })

  test("a required key that is missing stops before any request", async () => {
    const { server, provider } = setup(() => sse(FINAL_TURN), { apiKey: () => undefined })
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error.message).toStartWith("[AUTH]: no API key for openrouter")
    expect(server.requests).toHaveLength(0)
  })

  test("aborting mid-stream ends the iteration quietly", async () => {
    const { provider } = setup(() => hangingSse([chunk({ content: "partial" })]))
    const controller = new AbortController()
    const seen: ModelEvent[] = []
    for await (const event of provider.stream(request({ signal: controller.signal }))) {
      seen.push(event)
      controller.abort()
    }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
  })

  test("a stream cut before any finish reason is retryable", async () => {
    const { provider } = setup(() => sse([chunk({ content: "partial" })]))
    expect(await collect(provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
  })
})

describe("toChatMessages", () => {
  test("images become image_url parts; empty assistant steps are skipped; missing results are filled", () => {
    const wire = toChatMessages("sys", [
      { role: "user", content: "look", images: [{ mime: "image/png", base64: "QUJD" }] },
      { role: "assistant", content: "", toolCalls: [] },
      { role: "assistant", content: "calling", toolCalls: [{ callId: "c1", name: "read", args: null }] },
      { role: "user", content: "next" },
    ])
    expect(wire).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
      { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "cancelled" },
      { role: "user", content: "next" },
    ])
  })
})
