import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, type Fetch, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"
import { alibabaBody, alibabaUrl } from "../src/alibaba"
import { PROVIDER_PRESETS } from "../src/provider-presets"

const KEY = "alibaba-local-fixture-0123456789"
const endpoint = "http://127.0.0.1:1234/compatible-mode/v1"
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "alibaba", type: "openai-compatible", baseUrl: endpoint, apiKey: () => KEY, keyRequired: true, models: PROVIDER_PRESETS.alibaba!.models, ...over })
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) if (event.type !== "tool_input") events.push(event); return events }
const sse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const done = () => sse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }])

describe("B10.13 Alibaba native transport", () => {
  test("streams reasoning, text, fragmented parallel tools and usage through the factory without an SDK", async () => {
    let body: any
    const fake: Fetch = async (url, init) => {
      expect(url).toBe(`${endpoint}/chat/completions`)
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      body = JSON.parse(String(init.body))
      return sse([
        { choices: [{ delta: { reasoning_content: "Inspecting" } }] },
        { choices: [{ delta: { content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "c2", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
      ])
    }
    const adapter = createApiProvider({ provider: resolved({ npm: "@ai-sdk/alibaba", parameters: { enableThinking: true, thinkingBudget: 4096 } }), fetch: fake })
    expect(await collect(adapter.stream(request({ effort: "high" })))).toEqual([
      { type: "reasoning", delta: "Inspecting" }, { type: "text", delta: "Reading " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: "qwen-plus", stream: true, stream_options: { include_usage: true }, temperature: 0.55, top_p: 1, enable_thinking: true, thinking_budget: 4096, tool_choice: "auto", tools: [{ type: "function", function: { name: "read" } }] })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.enableThinking).toBeUndefined()
  })

  test("tool results replay in order and each call reads the current token", async () => {
    let key = KEY
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: resolved({ apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return done()
    } })
    await collect(adapter.stream(request()))
    key = `${KEY}-rotated`
    await collect(adapter.stream(request({ messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: "Reading", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
    ] })))
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
    ])
  })

  test("plain-HTTP public URLs, credentials and absent tokens fail before transport, including injected transports", async () => {
    let calls = 0
    const fake: Fetch = async () => { calls++; return done() }
    for (const baseUrl of ["http://dashscope-intl.aliyuncs.com/compatible-mode/v1","http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x", "file:///tmp/proxy"]) {
      await expect(collect(createApiProvider({ provider: resolved({ baseUrl }), fetch: fake }).stream(request({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: resolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
    }
    const missing = resolved({ apiKey: () => undefined, keyRequired: false })
    await expect(collect(createApiProvider({ provider: missing, fetch: fake }).stream(request({ headers: { authorization: "Bearer override" } })))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: missing, fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(alibabaUrl(`http://${host}:1234/v1`).hostname).toBe(host)
  })

  test("auth errors scrub secrets; retries, truncation and cancellation keep existing transport semantics", async () => {
    for (const status of [401, 429]) {
      const adapter = createApiProvider({ provider: resolved(), fetch: async () => new Response(`rejected ${KEY}`, { status, headers: { "retry-after": "2" } }) })
      const error = await collect(adapter.stream(request())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(status === 429 ? RetryableProviderError : Error)
      expect((error as Error).message).not.toContain(KEY)
      if (status === 429) expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
    const incomplete = createApiProvider({ provider: resolved(), fetch: async () => sse([{ choices: [{ delta: { content: "partial" } }] }]) })
    await expect(collect(incomplete.stream(request()))).rejects.toThrow("ended without completion")
    const abort = new AbortController()
    const cancelled = createApiProvider({ provider: resolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); abort.abort() }) })
    expect(await collect(cancelled.stream(request({ signal: abort.signal })))).toEqual([])
  })

  test("usage remains requested after hooks; snake-case options win over SDK aliases", () => {
    expect(alibabaBody({ model: "qwen-plus", enableThinking: true, enable_thinking: false, thinkingBudget: 100, thinking_budget: 200, reasoning_effort: "high", stream_options: { include_usage: false } })).toEqual({ model: "qwen-plus", enable_thinking: false, thinking_budget: 200, stream: true, stream_options: { include_usage: true } })
  })
})
