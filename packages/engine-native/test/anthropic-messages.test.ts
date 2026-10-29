import { afterEach, describe, expect, test } from "bun:test"
import { createAnthropicProvider, RetryableProviderError, toAnthropicMessages, type ModelEvent, type ModelMessage, type ModelRequest } from "../src"
import { collect, collectAll, fakeServer, hangingSse, sse } from "./fake-server"

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

function setup(handler: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(handler)
  stops.push(server.stop)
  const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1` })
  return { server, provider }
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  signal: new AbortController().signal,
  ...overrides,
})

const answer = (events: unknown[]) => sse(events, { named: true })

const TOOL_TURN = [
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, output_tokens: 1 } } },
  { type: "ping" },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Leyendo ñ " } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
]

const FINAL_TURN = [
  { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

describe("Anthropic Messages adapter", () => {
  test("a tool_use block's input streams as tool_input under its id before the call is whole", async () => {
    const { provider } = setup(() => answer(TOOL_TURN))
    const events = (await collectAll(provider.stream(request({ model: "claude-x" })))).filter((event) => event.type === "tool_input" || event.type === "tool_call")
    expect(events).toEqual([
      { type: "tool_input", callId: "toolu_1", name: "read", delta: '{"path":' },
      { type: "tool_input", callId: "toolu_1", name: "read", delta: '"a.ts"}' },
      { type: "tool_call", call: { callId: "toolu_1", name: "read", args: { path: "a.ts" } } },
    ])
  })

  test("streams thinking, text, a tool call and usage, and sends the documented request", async () => {
    const { server, provider } = setup(() => answer(TOOL_TURN))
    const events = await collect(provider.stream(request({ model: "claude-x", effort: "medium" })))
    expect(events).toEqual([
      { type: "reasoning", delta: "hmm " },
      { type: "reasoning_state", state: { provider: "anthropic", model: "claude-x", blocks: [{ type: "thinking", thinking: "hmm ", signature: "sig123" }] } },
      { type: "text", delta: "Leyendo ñ " },
      { type: "tool_call", call: { callId: "toolu_1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 100, output: 42, reasoning: 0, cacheRead: 60, cacheWrite: 10 } },
      { type: "finish", reason: "tool_calls" },
    ])
    const sent = server.requests[0]!
    expect(sent.path).toBe("/v1/messages")
    expect(sent.headers["x-api-key"]).toBe(KEY)
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01")
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.body).toMatchObject({
      model: "claude-x",
      stream: true,
      thinking: { type: "enabled", budget_tokens: 8_000 },
      system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    })
    expect(sent.body.max_tokens).toBeGreaterThan(sent.body.thinking.budget_tokens)
  })

  test("effort maps to the thinking budget: none off, low 2k, medium 8k, high 24k", async () => {
    const { server, provider } = setup(() => answer(FINAL_TURN))
    for (const effort of [undefined, "low", "medium", "high"] as const) await collect(provider.stream(request({ effort })))
    expect(server.requests.map((r) => r.body.thinking?.budget_tokens)).toEqual([undefined, 2_000, 8_000, 24_000])
  })

  test("a tool round trip: the result and the signed thinking go back, and the last turn is the cache breakpoint", async () => {
    const { server, provider } = setup((_, index) => answer(index === 0 ? TOOL_TURN : FINAL_TURN))
    const first = await collect(provider.stream(request({ model: "claude-x", effort: "low" })))
    const call = first.find((e) => e.type === "tool_call")
    const state = first.find((e) => e.type === "reasoning_state")
    if (call?.type !== "tool_call" || state?.type !== "reasoning_state") throw new Error("missing events")
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Leyendo ñ ", toolCalls: [call.call], reasoning: state.state },
      { role: "tool", callId: call.call.callId, name: "read", output: "file text", isError: false },
    ]
    const second = await collect(provider.stream(request({ model: "claude-x", effort: "low", messages: history })))
    expect(second.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "done" }])
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" })
    const body = server.requests[1]!.body
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2_000 })
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm ", signature: "sig123" },
          { type: "text", text: "Leyendo ñ " },
          { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file text", cache_control: { type: "ephemeral" } }] },
    ])
  })

  test("thinking stays off for a tool loop whose steps lack this model's signed reasoning", async () => {
    const { server, provider } = setup(() => answer(FINAL_TURN))
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: {} }] },
      { role: "tool", callId: "c1", name: "read", output: "x", isError: false },
    ]
    const dropped = await collect(provider.stream(request({ effort: "high", messages: history })))
    // The usage event says the call asked for reasoning and went without it; a call that never asked does not.
    expect(dropped.find((event) => event.type === "usage")).toMatchObject({ usage: { thinkingDropped: true } })
    const quiet = await collect(provider.stream(request({ messages: history })))
    expect(quiet.find((event) => event.type === "usage")).not.toHaveProperty("usage.thinkingDropped")
    // Same loop, reasoning made by another model: its blocks are not replayed either.
    const other = history.map((m) => (m.role === "assistant" ? { ...m, reasoning: { provider: "anthropic", model: "someone-else", blocks: [{ type: "thinking", thinking: "x", signature: "s" }] } } : m))
    await collect(provider.stream(request({ effort: "high", messages: other })))
    expect(server.requests.map((r) => r.body.thinking)).toEqual([undefined, undefined, undefined])
    expect(JSON.stringify(server.requests[2]!.body.messages)).not.toContain("signature")
  })

  test("usage of a call with no reasoning and no cache", async () => {
    const { provider } = setup(() => answer(FINAL_TURN))
    const events = await collect(provider.stream(request()))
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 5, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
  })

  test("max_tokens stop reason finishes as length", async () => {
    const { provider } = setup(() => answer([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } }, { type: "message_stop" }]))
    expect((await collect(provider.stream(request()))).at(-1)).toEqual({ type: "finish", reason: "length" })
  })

  test("429 with retry-after is retryable and carries the wait; the key never appears in the error", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: `slow down, key ${KEY}` } }), { status: 429, headers: { "retry-after": "7" } }))
    const error = await collect(provider.stream(request())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect((error as RetryableProviderError).retryAfterMs).toBe(7_000)
    expect((error as Error).message).not.toContain(KEY)
  })

  test("529 overloaded and a mid-stream overloaded_error are retryable", async () => {
    const overloaded = setup(() => new Response("overloaded", { status: 529 }))
    expect(await collect(overloaded.provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
    const midStream = setup(() => answer([{ type: "message_start", message: { usage: {} } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]))
    expect(await collect(midStream.provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
  })

  test("401 is a clear, final auth error without the key", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }), { status: 401 }))
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect(error.message).toStartWith("[AUTH]: anthropic 401")
    expect(error.message).toContain("rejected the API key")
    expect(error.message).not.toContain(KEY)
  })

  test("an invalid request (400) is final and shows the provider's reason", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens too large" } }), { status: 400 }))
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect(error.message).toContain("max_tokens too large")
  })

  test("a missing key stops before any request", async () => {
    const server = fakeServer(() => answer(FINAL_TURN))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "m", apiKey: () => undefined, baseUrl: `${server.url}/v1` })
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error.message).toStartWith("[AUTH]: no API key for anthropic")
    expect(server.requests).toHaveLength(0)
  })

  test("aborting mid-stream ends the iteration quietly", async () => {
    const { provider } = setup(() => hangingSse([{ type: "message_start", message: { usage: {} } }, { type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }], { named: true }))
    const controller = new AbortController()
    const seen: ModelEvent[] = []
    for await (const event of provider.stream(request({ signal: controller.signal }))) {
      seen.push(event)
      if (event.type === "text") controller.abort()
    }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
  })

  test("a stream cut before message_stop is a retryable failure", async () => {
    const { provider } = setup(() => answer([{ type: "message_start", message: { usage: {} } }]))
    expect(await collect(provider.stream(request())).catch((e: unknown) => e)).toBeInstanceOf(RetryableProviderError)
  })

  test("maxOutputTokens caps the answer and skips thinking's headroom", async () => {
    const { server, provider } = setup(() => answer(FINAL_TURN))
    await collect(provider.stream(request({ maxOutputTokens: 8 })))
    expect(server.requests[0]!.body.max_tokens).toBe(8)
  })

  test("images are dropped with a note for a model that takes none", async () => {
    const server = fakeServer(() => answer(FINAL_TURN))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "m", apiKey: () => KEY, baseUrl: `${server.url}/v1`, takesImages: () => false })
    await collect(provider.stream(request({ messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(JSON.stringify(server.requests[0]!.body.messages)).toContain("1 image omitted")
    expect(JSON.stringify(server.requests[0]!.body.messages)).not.toContain("AAAA")
  })
})

describe("toAnthropicMessages", () => {
  test("tool results lead the user message that also carries the image of the step; same-role neighbours merge", () => {
    const wire = toAnthropicMessages(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ callId: "a", name: "shot", args: {} }, { callId: "b", name: "read", args: {} }] },
        { role: "tool", callId: "a", name: "shot", output: "ok", isError: false },
        { role: "tool", callId: "b", name: "read", output: "", isError: true },
        { role: "user", content: "[image from shot call]", images: [{ mime: "image/png", base64: "QUJD" }] },
      ],
      "m",
    )
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(wire[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "ok" },
      { type: "tool_result", tool_use_id: "b", content: "(no output)", is_error: true },
      { type: "text", text: "[image from shot call]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ])
  })

  test("a call without a result gets a cancelled one, a result without a call is dropped, odd ids are made valid", () => {
    const wire = toAnthropicMessages(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "x", toolCalls: [{ callId: "fc.1|odd", name: "read", args: "not an object" }] },
        { role: "user", content: "next" },
        { role: "tool", callId: "ghost", name: "read", output: "orphan", isError: false },
      ],
      "m",
    )
    expect(JSON.stringify(wire)).not.toContain("orphan")
    expect(wire[1]!.content[1]).toEqual({ type: "tool_use", id: "fc_1_odd", name: "read", input: {} })
    expect(wire[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "fc_1_odd", content: "cancelled", is_error: true })
  })
})
