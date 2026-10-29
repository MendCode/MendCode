import { describe, expect, test } from "bun:test"
import { createApiProvider, deepinfraBaseUrl, deepinfraVariants, fetchProviderModels, RetryableProviderError, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, hangingSse, sse } from "./fake-server"

const KEY = "deepinfra-private-fixture-0123456789"
const MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
const request: ModelRequest = { system: "Be brief.", messages: [{ role: "user", content: "Inspect files" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], signal: new AbortController().signal }
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "deepinfra", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1/openai", apiKey: () => KEY, keyRequired: true, models: [{ id: MODEL, effort: true, images: false }], ...over })
const finished = (cost?: number) => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, ...(cost !== undefined ? { estimated_cost: cost } : {}) } }, "[DONE]"])

describe("B10.08 DeepInfra compatible transport", () => {
  test("streams reasoning/text, parallel fragmented tools and trailing usage/cost; translates v1 options", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "do-not-use", "x-team": "dev" } }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/openai/chat/completions")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(new Headers(init.headers).get("x-team")).toBe("dev")
      body = JSON.parse(String(init.body))
      return sse([
        { choices: [{ delta: { reasoning_content: "Check ", content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "r2", function: { name: "read", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b.ts"}' } }, { index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 }, estimated_cost: 0.0000268 } },
        "[DONE]",
      ])
    } })
    expect(await collect(provider.stream({ ...request, model: MODEL, effort: "high", parameters: { reasoningEffort: "max", minP: 0.1, topK: 20, repetitionPenalty: 1.1, parallelToolCalls: true, responseFormat: { type: "json_object" } } }))).toEqual([
      { type: "text", delta: "Reading " }, { type: "reasoning", delta: "Check " },
      { type: "tool_call", call: { callId: "r1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "r2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0, costMicros: 27 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: MODEL, stream: true, stream_options: { include_usage: true }, reasoning_effort: "max", min_p: 0.1, top_k: 20, repetition_penalty: 1.1, parallel_tool_calls: true, response_format: { type: "json_object" }, tool_choice: "auto" })
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read" } })
    expect(body.reasoningEffort).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(KEY)
  })

  test("replays tool results and versioned ids, honors per-model images and reads a rotated key", async () => {
    let body: any, key = KEY
    const provider = createApiProvider({ provider: resolved({ apiKey: () => key, models: [{ id: "vision", images: true }, { id: "text:v2", images: false }] }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      body = JSON.parse(String(init.body))
      return finished(0)
    } })
    const messages: ModelRequest["messages"] = [
      { role: "user", content: "Inspect", images: [{ mime: "image/png", base64: "aW1hZ2U=" }] },
      { role: "assistant", content: "", toolCalls: [{ callId: "r1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "r1", name: "read", output: "File text", isError: false },
    ]
    const original = structuredClone(messages)
    const events = await collect(provider.stream({ ...request, model: "vision", messages }))
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } })
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "r1", content: "File text" })
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { costMicros: 0 } })
    key = "rotated-deepinfra-fixture"
    await collect(provider.stream({ ...request, model: "text:v2", messages, parameters: { reasoningEffort: "low", reasoning_effort: "high" } }))
    expect(body.model).toBe("text:v2")
    expect(body.reasoning_effort).toBe("high")
    expect(JSON.stringify(body)).not.toContain("aW1hZ2U=")
    expect(messages).toEqual(original)
  })

  test("requires a token, redacts 401/429 errors, and aborts without finishing a partial stream", async () => {
    const missing = createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { throw new Error("must not call") } })
    await expect(collect(missing.stream(request))).rejects.toThrow("no API key for deepinfra")
    for (const status of [401, 429]) {
      const provider = createApiProvider({ provider: resolved(), fetch: async () => new Response(JSON.stringify({ error: { message: `rejected ${KEY}` } }), { status, headers: { "retry-after": "2" } }) })
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
  })

  test("secure roots and SDK suffixes; reasoning variants follow capability metadata", () => {
    expect(deepinfraBaseUrl("https://localhost:1234/v1/", true)).toBe("https://localhost:1234/v1/openai")
    expect(deepinfraBaseUrl("http://[::1]:1234/v1/openai", true)).toBe("http://[::1]:1234/v1/openai")
    for (const url of ["", "http://remote.test/v1", "http://api.deepinfra.com/v1/openai", "https://user:key@localhost/v1", "https://localhost/v1?key=x", "https://localhost/v1#x", "http://localhost.evil.test/v1"]) expect(() => deepinfraBaseUrl(url)).toThrow("loopback")
    expect(Object.keys(deepinfraVariants({ id: MODEL, reasoning: true }))).toEqual(["low", "medium", "high", "max"])
    expect(Object.keys(deepinfraVariants({ id: "reasoner", effort: true }))).toEqual(["low", "medium", "high"])
    expect(deepinfraVariants({ id: MODEL, reasoning: false, effort: true })).toEqual({})
  })

  test("reasoning variants match v1 families without advertising unsupported efforts", () => {
    const variants = (id: string) => Object.keys(deepinfraVariants({ id, reasoning: true }))
    for (const id of ["deepseek-ai/DeepSeek-R1", "Qwen/Qwen3", "minimax-m3", "glm-5", "kimi-k2", "grok-4"]) expect(variants(id)).toEqual([])
    expect(variants("grok-3-mini")).toEqual(["low", "high"])
    expect(variants("glm-5.2")).toEqual(["low", "medium", "high"])
    expect(variants("openai/gpt-5.1")).toEqual(["none", "low", "medium", "high"])
    expect(variants("gpt-5.6")).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
    expect(variants("gpt-5.3-codex")).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(variants("gpt-5-chat-latest")).toEqual([])
  })

  test("token and streaming usage are authoritative; all error headers are redacted and output caps apply", async () => {
    const headerSecret = "deepinfra-header-private-fixture"
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "wrong", "x-proxy-token": headerSecret }, models: [{ id: MODEL, outputLimit: 4, tool_call: false }] }), fetch: async (_url, init) => {
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`)
      expect(headers.get("x-proxy-token")).toBe(headerSecret)
      expect(init.redirect).toBe("error")
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 4 })
      expect(body.tools).toBeUndefined()
      return new Response(`rejected ${KEY} ${headerSecret}`, { status: 401 })
    } })
    const error = await collect(provider.stream({ ...request, headers: { AUTHORIZATION: "overridden" }, parameters: { max_tokens: 1000, stream_options: { include_usage: false } }, transformBody: async (body) => ({ ...body, stream: false, max_tokens: 2000 }) })).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(KEY)
    expect((error as Error).message).not.toContain(headerSecret)
    const missing = createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { throw new Error("must not call") } })
    await expect(collect(missing.stream({ ...request, headers: { authorization: "injected" } }))).rejects.toThrow("no API key")
  })

  test("refresh uses the compatible models endpoint/token, sorting and bounds without a socket", async () => {
    const models = await fetchProviderModels({ provider: resolved({ headers: { Authorization: "wrong" } }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/openai/models")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      return Response.json({ data: [{ id: "z:v2" }, { id: "a", context_length: 131_072, supported_parameters: ["reasoning_effort"], architecture: { input_modalities: ["text", "image"] } }, { id: "x".repeat(67) }, { id: "" }] })
    } })
    expect(models).toEqual([{ id: "a", context: 131_072, effort: true, images: true }, { id: "z:v2" }])
    const many = await fetchProviderModels({ provider: resolved(), fetch: async () => Response.json({ data: Array.from({ length: 450 }, (_, index) => ({ id: `m${index}` })) }) })
    expect(many).toHaveLength(400)
  })

  test("plain-HTTP public endpoints and header-only auth cannot trigger generation or model discovery", async () => {
    let calls = 0
    const fake = async () => { calls++; return finished() }
    const publicEndpoint = resolved({ baseUrl: "http://api.deepinfra.com/v1/openai" })
    await expect(collect(createApiProvider({ provider: publicEndpoint, fetch: fake }).stream(request))).rejects.toThrow("loopback")
    await expect(fetchProviderModels({ provider: publicEndpoint, fetch: fake })).rejects.toThrow("loopback")
    await expect(fetchProviderModels({ provider: resolved({ apiKey: () => undefined, keyRequired: false, headers: { Authorization: `Bearer ${KEY}` } }), fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
  })
})
