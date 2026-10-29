import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, xaiBaseUrl, type Fetch, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, hangingSse, sse } from "./fake-server"

const KEY = "xai-private-fixture-0123456789"
const model = "grok-3-mini"
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "xai", type: "xai", baseUrl: "http://127.0.0.1:1234/v1", apiKey: () => KEY, keyRequired: true, models: [{ id: model, images: false }], ...over })
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief.", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], model, effort: "high", signal: new AbortController().signal, ...over })
const turn = [
  { type: "response.reasoning_text.delta", delta: "Check the file" },
  { type: "response.output_text.delta", delta: "Reading café" },
  { type: "response.output_item.done", item: { type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [] } },
  { type: "response.function_call_arguments.delta", item_id: "f1", delta: '{"path":"a.ts"}' },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
  { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
]

describe("B10.06 xAI Responses", () => {
  test("SSE streaming, tool calls, encrypted reasoning and cache usage use the Responses transport", async () => {
    let body: any, headers: Headers | undefined
    const fetch: Fetch = async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/responses")
      expect(init.redirect).toBe("error")
      body = JSON.parse(String(init.body)); headers = new Headers(init.headers)
      return sse(turn, { named: true, chunkSize: 1 })
    }
    const events = await collect(createApiProvider({ provider: resolved(), fetch }).stream(request({ cacheKey: "session-key", cacheKeyForBody: () => "hook-cache", hostedTools: ["web_search", "image_generation"], parameters: { reasoningEffort: "low", topLogprobs: 2, temperature: 0.1 } })))
    expect(events).toEqual([
      { type: "reasoning", delta: "Check the file" },
      { type: "text", delta: "Reading café" },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } },
      { type: "reasoning_state", state: { provider: "xai", model, blocks: [{ type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [] }] } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(headers!.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(headers!.has("session_id")).toBe(false)
    expect(body).toMatchObject({ input: [{ role: "system", content: "Be brief." }, { role: "user" }], reasoning: { effort: "low" }, top_logprobs: 2, logprobs: true, temperature: 0.1, stream: true, store: false, include: ["reasoning.encrypted_content"] })
    expect(body.tools.map((entry: any) => entry.type)).toEqual(["function"])
    for (const field of ["instructions", "prompt_cache_key", "reasoningEffort", "topLogprobs", "parallel_tool_calls"]) expect(body[field]).toBeUndefined()
    expect(body.reasoning.summary).toBeUndefined()
  })

  test("tool results and private reasoning replay only to the same provider/model; image filtering survives replay", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved(), fetch: async (_url, init) => { body = JSON.parse(String(init.body)); return sse([{ type: "response.completed", response: {} }]) } })
    const messages: ModelRequest["messages"] = [
      { role: "user", content: "Read", images: [{ mime: "image/png", base64: "AAAA" }] },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: {} }], reasoning: { provider: "xai", model, blocks: [{ type: "reasoning", encrypted_content: "private-reasoning" }] } },
      { role: "tool", callId: "c1", name: "read", output: "hello", isError: false },
    ]
    await collect(provider.stream(request({ messages })))
    expect(body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "c1", output: "hello" })
    expect(body.input[2]).toEqual({ type: "reasoning", encrypted_content: "private-reasoning" })
    expect(JSON.stringify(body.input)).toContain("1 image omitted")
    expect(JSON.stringify(body.input)).not.toContain("AAAA")
    await collect(provider.stream(request({ model: "grok-other", messages })))
    expect(JSON.stringify(body)).not.toContain("private-reasoning")
  })

  test("xAI's uncached-input usage convention, metadata pricing and output caps are preserved", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ models: [{ id: model, limit: { context: 131_072, output: 30 }, cost: { input: 0.3, output: 0.5, cache_read: 0.075 } }] }), fetch: async (_url, init) => {
      body = JSON.parse(String(init.body))
      return sse([{ type: "response.incomplete", response: { usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } } }])
    } })
    const events = await collect(provider.stream(request({ parameters: { max_output_tokens: 100 } })))
    expect(body.max_output_tokens).toBe(30)
    expect(events).toEqual([{ type: "usage", usage: { input: 10, output: 20, reasoning: 0, cacheRead: 60, cacheWrite: 0, costMicros: 18 } }, { type: "finish", reason: "length" }])
    expect(provider.compactionLimits!(model)).toEqual({ contextWindow: 131_072, outputLimit: 30 })
  })

  test("tests without tools use no tool policy; images, hooks and native option aliases work", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ models: [{ id: "grok-4", images: true }] }), fetch: async (_url, init) => { body = JSON.parse(String(init.body)); return sse([{ type: "response.completed", response: {} }]) } })
    await collect(provider.stream(request({ model: "grok-4", effort: undefined, tools: [], maxOutputTokens: 8, parameters: { previousResponseId: "previous", include: ["other"] }, messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }], transformBody: async (value) => ({ ...value, temperature: 0.2 }) })))
    expect(body).toMatchObject({ max_output_tokens: 16, previous_response_id: "previous", temperature: 0.2, include: ["other", "reasoning.encrypted_content"] })
    expect(JSON.stringify(body.input)).toContain("data:image/png;base64,AAAA")
    for (const field of ["tool_choice", "previousResponseId", "reasoning"]) expect(body[field]).toBeUndefined()
  })

  test("missing keys and unsupported Grok 3 Mini effort fail before HTTP; endpoints fail closed", async () => {
    const fetch: Fetch = async () => { throw new Error("HTTP must not run") }
    await expect(collect(createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch }).stream(request()))).rejects.toThrow("[AUTH]")
    await expect(collect(createApiProvider({ provider: resolved(), fetch }).stream(request({ effort: "medium" })))).rejects.toThrow("low or high")
    for (const url of ["http://remote.example/v1", "https://key:secret@example.com/v1", "https://example.com/v1?q=secret", "file:///tmp/xai"]) expect(() => xaiBaseUrl(url)).toThrow()
    expect(xaiBaseUrl("http://[::1]:1234/v1/")).toBe("http://[::1]:1234/v1")
  })

  test("HTTP and stream failures redact the literal token and retain retry classification", async () => {
    for (const status of [401, 403, 429, 500]) {
      const provider = createApiProvider({ provider: resolved(), fetch: async () => new Response(`rejected ${KEY}`, { status, headers: { "retry-after": "2" } }) })
      const error = await collect(provider.stream(request())).catch((error) => error)
      expect(error.message).not.toContain(KEY)
      expect(error.message).toContain("xai")
      if (status >= 429) { expect(error).toBeInstanceOf(RetryableProviderError); expect(error.retryAfterMs).toBe(2000) }
      else { expect(error).not.toBeInstanceOf(RetryableProviderError); expect(error.message).toContain("[AUTH]") }
    }
    const provider = createApiProvider({ provider: resolved(), fetch: async () => sse([{ type: "error", message: `failed ${KEY}` }]) })
    await expect(collect(provider.stream(request()))).rejects.toThrow("[redacted:api-key]")
  })

  test("abort cancels quietly; a truncated stream remains a retryable failure", async () => {
    const controller = new AbortController()
    const provider = createApiProvider({ provider: resolved(), fetch: async () => hangingSse([{ type: "response.output_text.delta", delta: "partial" }]) })
    const seen = []
    for await (const event of provider.stream(request({ signal: controller.signal }))) { seen.push(event); controller.abort() }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
    await expect(collect(createApiProvider({ provider: resolved(), fetch: async () => sse([{ type: "response.output_text.delta", delta: "partial" }]) }).stream(request()))).rejects.toBeInstanceOf(RetryableProviderError)
  })

  test("refresh lists chat models with v1 variants and ignores non-chat modalities", async () => {
    const models = await fetchProviderModels({ provider: resolved(), fetch: async (url, init) => {
      expect(url).toEndWith("/models"); expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      return Response.json({ data: [{ id: "grok-3-mini", context_length: 131_072 }, { id: "grok-4", architecture: { input_modalities: ["text", "image"] } }, { id: "grok-imagine-image" }, { id: "text-embedding" }] })
    } })
    expect(models).toEqual([{ id: "grok-3-mini", context: 131_072, variants: { low: { effort: "low" }, high: { effort: "high" } } }, { id: "grok-4", images: true, variants: {} }])
  })
})
