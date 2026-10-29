import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, togetheraiUrl, togetheraiVariants, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, hangingSse, sse } from "./fake-server"

const KEY = "togetherai-private-fixture-0123456789"
const MODEL = "openai/gpt-oss-120b"
const endpoint = "http://127.0.0.1:1234/v1"
const request: ModelRequest = { system: "Be brief.", messages: [{ role: "user", content: "Inspect files" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], signal: new AbortController().signal }
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "togetherai", type: "openai-compatible", baseUrl: endpoint, apiKey: () => KEY, keyRequired: true, models: [{ id: MODEL, effort: true, images: false }], ...over })
const finished = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"])

describe("B10.11 TogetherAI native transport", () => {
  test("streams reasoning/text, fragmented parallel tools and trailing flat usage; maps v1 options", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "wrong-token", "x-team": "dev" } }), fetch: async (url, init) => {
      expect(url).toBe(`${endpoint}/chat/completions`)
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(new Headers(init.headers).get("x-team")).toBe("dev")
      body = JSON.parse(String(init.body))
      return sse([
        { choices: [{ delta: { content: "Reading ", reasoning_content: "Check " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "r2", function: { name: "read", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b.ts"}' } }, { index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 60, reasoning_tokens: 5, total_cost: 0.000027 } },
        "[DONE]",
      ], { chunkSize: 3 })
    } })
    expect(await collect(provider.stream({ ...request, effort: "low", parameters: { reasoningEffort: "high", topK: 20, minP: 0.1, repetitionPenalty: 1.1, parallelToolCalls: true, responseFormat: { type: "json_object" } } }))).toEqual([
      { type: "text", delta: "Reading " }, { type: "reasoning", delta: "Check " },
      { type: "tool_call", call: { callId: "r1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "r2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0, costMicros: 27 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: MODEL, stream: true, stream_options: { include_usage: true }, reasoning_effort: "high", top_k: 20, min_p: 0.1, repetition_penalty: 1.1, parallel_tool_calls: true, response_format: { type: "json_object" }, tool_choice: "auto" })
    expect(body.tools[0].function.name).toBe("read")
    expect(body.reasoningEffort).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(KEY)
  })

  test("SDK aliases stay native, replay tool results/images, follow model caps and read rotated keys", async () => {
    let body: any, key = KEY, keyReads = 0
    const provider = createApiProvider({ provider: resolved({ id: "team", npm: "@ai-sdk/togetherai", apiKey: () => { keyReads++; return key }, models: [{ id: "vision", images: true, outputLimit: 40 }, { id: "text:v2", images: false, tool_call: false }] }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      body = JSON.parse(String(init.body))
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, cached_tokens: 9, reasoning_tokens: 2, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 }, cost: 0 } }, "[DONE]"])
    } })
    const messages: ModelRequest["messages"] = [
      { role: "user", content: "Inspect", images: [{ mime: "image/png", base64: "aW1hZ2U=" }] },
      { role: "assistant", content: "", toolCalls: [{ callId: "r1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "r1", name: "read", output: "File text", isError: false },
    ]
    const before = structuredClone(messages)
    const events = await collect(provider.stream({ ...request, model: "vision", messages, parameters: { max_tokens: 100 } }))
    expect(body.max_tokens).toBe(40)
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } })
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "r1", content: "File text" })
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { input: 6, cacheRead: 4, reasoning: 1, costMicros: 0 } })
    key = "rotated-togetherai-fixture"
    await collect(provider.stream({ ...request, model: "text:v2", messages, parameters: { reasoningEffort: "low", reasoning_effort: "high" } }))
    expect(body.model).toBe("text:v2")
    expect(body.reasoning_effort).toBe("high")
    expect(body.tools).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("aW1hZ2U=")
    expect(messages).toEqual(before)
    expect(keyReads).toBe(2)
  })

  test("requires a real token and an HTTPS-or-loopback URL even with request headers or fetch hooks", async () => {
    for (const baseUrl of ["http://api.together.ai/v1","http://127.0.0.1.example/v1", "http://user:key@localhost/v1", "http://localhost/v1?key=x", "http://localhost/v1#x"]) {
      expect(() => togetheraiUrl(baseUrl)).toThrow("loopback")
      const provider = createApiProvider({ provider: resolved({ baseUrl }), fetch: async () => { throw new Error("must not call") } })
      await expect(collect(provider.stream(request))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: resolved({ baseUrl }), fetch: async () => { throw new Error("must not call") } })).rejects.toThrow("loopback")
    }
    expect(togetheraiUrl("http://[::1]:1234/v1").hostname).toBe("[::1]")
    const missing = createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { throw new Error("must not call") } })
    await expect(collect(missing.stream({ ...request, headers: { authorization: "Bearer bypass" } }))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { throw new Error("must not call") } })).rejects.toThrow("no API key")
  })

  test("redacts auth/rate-limit failures and keeps user abort distinct from an incomplete stream", async () => {
    for (const status of [401, 429]) {
      const provider = createApiProvider({ provider: resolved(), fetch: async () => new Response(`rejected ${KEY}`, { status, headers: { "retry-after": "2" } }) })
      const error = await collect(provider.stream(request)).catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(KEY)
      expect(error instanceof RetryableProviderError).toBe(status === 429)
      if (error instanceof RetryableProviderError) expect(error.retryAfterMs).toBe(2_000)
    }
    const controller = new AbortController()
    const provider = createApiProvider({ provider: resolved(), fetch: async () => hangingSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    const events = []
    for await (const event of provider.stream({ ...request, signal: controller.signal })) { events.push(event); controller.abort() }
    expect(events).toEqual([{ type: "text", delta: "partial" }])
    const incomplete = createApiProvider({ provider: resolved(), fetch: async () => sse([{ choices: [{ delta: { content: "partial" } }] }, "[DONE]"]) })
    await expect(collect(incomplete.stream(request))).rejects.toBeInstanceOf(RetryableProviderError)
  })

  test("refresh handles native arrays/envelopes, filters, deduplicates and bounds catalogs", async () => {
    const raw = [{ id: "z:v2", type: "chat" }, { id: "a", type: "chat", context_length: 131_072, supported_parameters: ["reasoning_effort", "tools"], input_modalities: ["text", "image"], max_output: 4096 }, { id: "embed", type: "embedding" }, { id: "image", type: "image" }, { id: "z:v2", type: "chat" }, { id: "x".repeat(67) }, null]
    for (const payload of [raw, { data: raw }, { models: raw }]) {
      const models = await fetchProviderModels({ provider: resolved({ headers: { Authorization: "wrong-token" } }), fetch: async (url, init) => {
        expect(url).toBe(`${endpoint}/models`)
        expect(init.redirect).toBe("error")
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
        return Response.json(payload)
      } })
      expect(models).toMatchObject([{ id: "a", context: 131_072, images: true, effort: true, tool_call: true, outputLimit: 4096, variants: { high: { effort: "high" } } }, { id: "z:v2" }])
      expect(models).toHaveLength(2)
    }
    expect(await fetchProviderModels({ provider: resolved(), fetch: async () => Response.json(Array.from({ length: 450 }, (_, i) => ({ id: `m${i}` }))) })).toHaveLength(400)
    await expect(fetchProviderModels({ provider: resolved(), fetch: async () => Response.json({ unexpected: [] }) })).rejects.toThrow("without a model list")
    expect(Object.keys(togetheraiVariants({ id: "DeepSeek-V4-test", reasoning: true }))).toEqual(["low", "medium", "high", "max"])
    expect(togetheraiVariants({ id: MODEL, effort: true, reasoning: false })).toEqual({})
  })
})
