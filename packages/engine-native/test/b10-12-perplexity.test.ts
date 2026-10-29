import { describe, expect, test } from "bun:test"
import { createApiProvider, createChatCompletionsProvider, RetryableProviderError, type Fetch, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"
import { fetchProviderModels } from "../src/provider-remote"

const KEY = "perplexity-local-fixture-0123456789"
const sse = (...chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) if (event.type !== "tool_input") events.push(event); return events }
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Explain TCP" }], tools: [{ name: "read", description: "Read file", parameters: { type: "object" } }], signal: new AbortController().signal, ...over })
const config = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "perplexity", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234", apiKey: () => KEY, keyRequired: true, models: [{ id: "sonar", images: false, tool_call: false }], ...over })
const adapter = (fetch: Fetch, over: Partial<ResolvedProvider> = {}) => createApiProvider({ provider: config(over), fetch })

describe("B10.12 Perplexity Sonar compatibility", () => {
  test("authenticated local Chat Completions, search options and token cap; unsupported tools and images stay out", async () => {
    const provider = adapter(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/chat/completions")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ model: "sonar", stream: true, max_tokens: 8, search_domain_filter: ["example.com"] })
      for (const field of ["tools", "tool_choice", "stream_options", "reasoning_effort", "prompt_cache_key"]) expect(body[field]).toBeUndefined()
      expect(JSON.stringify(body.messages)).not.toContain("AAAA")
      expect(JSON.stringify(body.messages)).toContain("1 image omitted")
      return sse({ choices: [{ delta: { content: "TCP is reliable. [1]" } }] }, { citations: ["https://example.com/tcp"] }, stop)
    })
    const events = await collect(provider.stream(request({ effort: "high", maxOutputTokens: 8, parameters: { search_domain_filter: ["example.com"] }, messages: [{ role: "user", content: "Look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(events).toEqual([{ type: "text", delta: "TCP is reliable. [1]" }, { type: "text", delta: "\n\n[1]: https://example.com/tcp" }, { type: "finish", reason: "stop" }])
  })

  test("cumulative sources arrive once, keep citation numbers and omit unsafe URLs and tokens", async () => {
    const citations = ["javascript:alert(1)", "https://example.com/source", `https://example.com/${KEY}`, "https://user:pass@example.com", "https://example.com/\u001b[2J"]
    const events = await collect(adapter(async () => sse({ citations }, { citations, search_results: [{ url: "https://ignored.example" }] }, { choices: [{ delta: { content: "Answer [2]" } }] }, stop)).stream(request()))
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "Answer [2]" }, { type: "text", delta: "\n\n[2]: https://example.com/source" }])
    expect(JSON.stringify(events)).not.toContain(KEY)
  })

  test("search-result fallback and final usage follow stop, including reasoning and provider USD cost", async () => {
    const events = await collect(adapter(async () => sse({ search_results: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }] }, stop, { usage: { prompt_tokens: 100, completion_tokens: 30, reasoning_tokens: 12, prompt_tokens_details: { cached_tokens: 20 }, cost: { total_cost: 0.006 } } })).stream(request()))
    expect(events).toEqual([{ type: "text", delta: "\n\n[1]: https://example.com/a\n[2]: https://example.com/b" }, { type: "usage", usage: { input: 80, output: 30, reasoning: 12, cacheRead: 20, cacheWrite: 0, costMicros: 6000 } }, { type: "finish", reason: "stop" }])
  })

  test("tool history is readable text and an unexpected function call never reaches the engine", async () => {
    const provider = adapter(async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body.messages).toEqual([{ role: "system", content: "Be brief" }, { role: "user", content: "read it" }, { role: "assistant", content: "(tool call)" }, { role: "user", content: "Tool result: hello" }])
      return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
    })
    await expect(collect(provider.stream(request({ messages: [{ role: "user", content: "read it" }, { role: "assistant", content: "", toolCalls: [{ callId: "x", name: "read", args: {} }] }, { role: "tool", callId: "x", name: "read", output: "hello", isError: false }] })))).rejects.toThrow("does not support client tool calls")
  })

  test("keys are read per request; missing token and non-loopback endpoints make no request", async () => {
    let key: string | undefined = KEY
    let calls = 0
    const provider = adapter(async (_url, init) => { calls++; expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`); return sse(stop) }, { apiKey: () => key })
    await collect(provider.stream(request()))
    key = "rotated-local-token"
    await collect(provider.stream(request()))
    key = undefined
    await expect(collect(provider.stream(request()))).rejects.toThrow("no API key")
    for (const baseUrl of ["http://api.perplexity.ai","http://127.0.0.1.evil.example", "http://user:pass@127.0.0.1", "http://127.0.0.1?token=x"]) {
      const blocked = adapter(async () => { calls++; return sse(stop) }, { baseUrl, type: "openai", npm: "@ai-sdk/perplexity" })
      await expect(collect(blocked.stream(request()))).rejects.toThrow("loopback")
      const direct = createChatCompletionsProvider({ id: "perplexity", model: "sonar", baseUrl, sonar: true, fetch: async () => { calls++; return sse(stop) } })
      expect(await direct.probe!()).toBe(false)
      await expect(fetchProviderModels({ provider: config({ baseUrl }), fetch: async () => { calls++; return Response.json({ data: [] }) } })).rejects.toThrow("loopback")
    }
    expect(calls).toBe(2)
  })

  test("auth failure is final and scrubbed; rate limits retain retry-after", async () => {
    const error = await collect(adapter(async () => new Response(`rejected ${KEY}`, { status: 401 })).stream(request())).catch((error: Error) => error)
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect((error as Error).message).toStartWith("[AUTH]: perplexity 401")
    expect((error as Error).message).not.toContain(KEY)
    const retry = await collect(adapter(async () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } })).stream(request())).catch((error: Error) => error)
    expect(retry).toBeInstanceOf(RetryableProviderError)
    expect((retry as RetryableProviderError).retryAfterMs).toBe(2000)
  })

  test("truncated streams never publish references or a successful finish; EOF after length is accepted", async () => {
    const events: ModelEvent[] = []
    const truncated = adapter(async () => new Response(`data: ${JSON.stringify({ citations: ["https://example.com"] })}\n\n`))
    await expect((async () => { for await (const event of truncated.stream(request())) events.push(event) })()).rejects.toBeInstanceOf(RetryableProviderError)
    expect(events).toEqual([])
    const complete = adapter(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "short" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_cost: 0.001 } })}\n\n`))
    expect((await collect(complete.stream(request()))).at(-1)).toEqual({ type: "finish", reason: "length" })
  })

  test("abort ends quietly and general compatible providers keep tool streaming and stream_options", async () => {
    const controller = new AbortController()
    const events: ModelEvent[] = []
    for await (const event of adapter(async () => sse({ choices: [{ delta: { content: "partial" } }] })).stream(request({ signal: controller.signal }))) { events.push(event); controller.abort() }
    expect(events).toEqual([{ type: "text", delta: "partial" }])
    const ordinary = adapter(async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body.stream_options).toEqual({ include_usage: true })
      expect(body.tools).toHaveLength(1)
      return sse({ citations: ["https://ignored.example"], choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
    }, { id: "corp", models: [{ id: "local" }] })
    expect(await collect(ordinary.stream(request()))).toEqual([{ type: "tool_call", call: { callId: "x", name: "read", args: {} } }, { type: "finish", reason: "tool_calls" }])
  })
})
