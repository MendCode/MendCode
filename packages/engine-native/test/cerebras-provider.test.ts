import { describe, expect, test } from "bun:test"
import { cerebrasBody, cerebrasUrl, cerebrasVariants, createApiProvider, fetchProviderModels, RetryableProviderError, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, hangingSse, sse } from "./fake-server"

const KEY = "cerebras-private-fixture-0123456789"
const MODEL = "gpt-oss-120b"
const request: ModelRequest = { system: "Be brief.", messages: [{ role: "user", content: "Inspect files" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], signal: new AbortController().signal }
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "cerebras", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: () => KEY, keyRequired: true, models: [{ id: MODEL, effort: true, images: false }], ...over })
const finished = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }, "[DONE]"])

describe("B10.09 Cerebras native compatible transport", () => {
  test("streams text/reasoning, fragmented parallel tools and trailing usage; maps SDK options", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "wrong", "x-team": "dev" } }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(new Headers(init.headers).get("x-cerebras-3rd-party-integration")).toBe("opencode")
      expect(new Headers(init.headers).get("x-team")).toBe("dev")
      body = JSON.parse(String(init.body))
      return sse([
        { choices: [{ delta: { reasoning: "Check ", content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "r2", function: { name: "read", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b.ts"}' } }, { index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } }, time_info: { total_time: 0.2 } },
        "[DONE]",
      ])
    } })
    expect(await collect(provider.stream({ ...request, model: MODEL, effort: "high", parameters: { reasoningEffort: "low", parallelToolCalls: true, topLogprobs: 3, logitBias: { "10": 1 }, serviceTier: "auto", reasoningFormat: "parsed" } }))).toEqual([
      { type: "text", delta: "Reading " }, { type: "reasoning", delta: "Check " },
      { type: "tool_call", call: { callId: "r1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "r2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: MODEL, stream: true, reasoning_effort: "low", parallel_tool_calls: true, top_logprobs: 3, logit_bias: { "10": 1 }, service_tier: "auto", reasoning_format: "parsed", tool_choice: "auto" })
    expect(body.stream_options).toBeUndefined()
    expect(body.reasoningEffort).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(KEY)
  })

  test("native fields win aliases; one output cap survives hooks and model limits; tools can be disabled", async () => {
    const provider = createApiProvider({ provider: resolved({ models: [{ id: MODEL, outputLimit: 4, tool_call: false }] }), fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ max_completion_tokens: 4, stream: true, reasoning_effort: "high" })
      for (const field of ["max_tokens", "max_output_tokens", "stream_options", "tools"]) expect(body[field]).toBeUndefined()
      return finished()
    } })
    await collect(provider.stream({ ...request, parameters: { reasoningEffort: "low", reasoning_effort: "high", max_tokens: 1000 }, transformBody: async (body) => ({ ...body, max_completion_tokens: 2000, max_output_tokens: 3000, stream: false }) }))
    const original = { max_tokens: 3, max_completion_tokens: 5, parallelToolCalls: false, responseFormat: { type: "json_schema" } }
    expect(cerebrasBody(original, 8)).toEqual({ max_completion_tokens: 3, parallel_tool_calls: false, response_format: { type: "json_schema" }, stream: true })
    expect(original.max_tokens).toBe(3)
  })

  test("SDK namespaces stay native, read rotated keys and replay tool history without mutating it", async () => {
    let key = KEY, body: any
    const provider = createApiProvider({ provider: resolved({ id: "team", npm: "@ai-sdk/cerebras", apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      body = JSON.parse(String(init.body))
      return finished()
    } })
    const messages: ModelRequest["messages"] = [{ role: "user", content: "Inspect", images: [{ mime: "image/png", base64: "aW1hZ2U=" }] }, { role: "assistant", content: "", toolCalls: [{ callId: "r1", name: "read", args: { path: "a.ts" } }] }, { role: "tool", callId: "r1", name: "read", output: "File text", isError: false }]
    const before = structuredClone(messages)
    await collect(provider.stream({ ...request, messages, model: "deploy:v2" }))
    expect(body.model).toBe("deploy:v2")
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "r1", content: "File text" })
    expect(JSON.stringify(body)).not.toContain("aW1hZ2U=")
    key = "rotated-cerebras-fixture"
    await collect(provider.stream({ ...request, messages }))
    expect(messages).toEqual(before)
  })

  test("native effort levels survive the shared compatible transport", async () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      const provider = createApiProvider({ provider: resolved(), fetch: async (_url, init) => {
        expect(JSON.parse(String(init.body)).reasoning_effort).toBe(effort)
        return finished()
      } })
      await collect(provider.stream({ ...request, effort }))
    }
    await collect(createApiProvider({ provider: resolved(), fetch: async (_url, init) => {
      expect(JSON.parse(String(init.body)).reasoning_effort).toBe("none")
      return finished()
    } }).stream({ ...request, parameters: { reasoning_effort: "none" } }))
  })

  test("plain-HTTP public/unsafe URLs and header-only auth cannot trigger inference or refresh", async () => {
    let calls = 0
    const fake = async () => { calls++; return finished() }
    for (const baseUrl of ["", "http://api.cerebras.ai/v1","http://localhost.evil.test/v1", "https://user:key@localhost/v1", "http://localhost/v1?key=x", "http://localhost/v1#x"]) {
      expect(() => cerebrasUrl(baseUrl)).toThrow("loopback")
      await expect(collect(createApiProvider({ provider: resolved({ baseUrl }), fetch: fake }).stream(request))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: resolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
    }
    const missing = resolved({ apiKey: () => undefined, keyRequired: false, headers: { authorization: `Bearer ${KEY}` } })
    await expect(collect(createApiProvider({ provider: missing, fetch: fake }).stream(request))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: missing, fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    expect(cerebrasUrl("http://[::1]:1234/v1/")).toBe("http://[::1]:1234/v1")
  })

  test("refresh has authoritative auth/integration headers, bounds and capability metadata", async () => {
    const models = await fetchProviderModels({ provider: resolved({ headers: { Authorization: "wrong" } }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/models")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(new Headers(init.headers).get("x-cerebras-3rd-party-integration")).toBe("opencode")
      return Response.json({ data: [{ id: "z:v2" }, { id: "a", context_window: 131_072, max_output: 32_768, capabilities: { reasoning: true } }, { id: "x".repeat(67) }, null] })
    } })
    expect(models).toEqual([{ id: "a", context: 131_072, effort: true, outputLimit: 32_768 }, { id: "z:v2" }])
    expect(await fetchProviderModels({ provider: resolved(), fetch: async () => Response.json({ data: Array.from({ length: 450 }, (_, i) => ({ id: `m${i}` })) }) })).toHaveLength(400)
  })

  test("auth/rate-limit failures redact all headers; aborted and truncated streams never finish", async () => {
    const secret = "cerebras-proxy-private-fixture"
    for (const status of [401, 429]) {
      const provider = createApiProvider({ provider: resolved({ headers: { "x-proxy-token": secret } }), fetch: async () => new Response(`rejected ${KEY} ${secret}`, { status, headers: { "retry-after": "2" } }) })
      const error = await collect(provider.stream(request)).catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(KEY)
      expect((error as Error).message).not.toContain(secret)
      expect(error instanceof RetryableProviderError).toBe(status === 429)
      if (error instanceof RetryableProviderError) expect(error.retryAfterMs).toBe(2000)
    }
    const controller = new AbortController()
    const provider = createApiProvider({ provider: resolved(), fetch: async () => hangingSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    const events = []
    for await (const event of provider.stream({ ...request, signal: controller.signal })) { events.push(event); controller.abort() }
    expect(events).toEqual([{ type: "text", delta: "partial" }])
    await expect(collect(createApiProvider({ provider: resolved(), fetch: async () => sse([{ choices: [{ delta: { content: "partial" } }] }]) }).stream(request))).rejects.toThrow("without completion")
  })

  test("v1 reasoning families retain named variants without enabling non-reasoning models", () => {
    expect(Object.keys(cerebrasVariants({ id: MODEL, effort: true }))).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    expect(cerebrasVariants({ id: MODEL, effort: true }).none).toEqual({ parameters: { reasoning_effort: "none" } })
    expect(cerebrasVariants({ id: MODEL, reasoning: false, effort: true })).toEqual({})
    for (const id of ["llama3.1-8b", "qwen-3-235b", "zai-glm-4.7"]) expect(cerebrasVariants({ id, reasoning: false })).toEqual({})
    expect(Object.keys(cerebrasVariants({ id: "deepseek-v4", reasoning: true }))).toContain("max")
  })
})
