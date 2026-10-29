import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, type Fetch } from "../src"
import { createKiloProvider, kiloUrl, KILO_HEADERS } from "../src/kilo"
import { PROVIDER_PRESETS } from "../src/provider-presets"
import { collectKilo, kiloDone, kiloFake, kiloRequest, kiloResolved, kiloSse, KILO_MODELS, KILO_TOKEN, KILO_URL } from "./kilo-fixtures"

describe("B10.23 Kilo native transport", () => {
  test("streams reasoning, text, fragmented parallel tools, cache usage and reported USD cost without an SDK", async () => {
    let body: any
    const fake: Fetch = async (url, init) => {
      expect(url).toBe(`${KILO_URL}/chat/completions`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${KILO_TOKEN}`)
      for (const [name, value] of Object.entries(KILO_HEADERS)) expect(headers.get(name)).toBe(value)
      body = JSON.parse(String(init.body))
      return kiloSse([
        { choices: [{ delta: { reasoning: "Inspecting" } }] },
        { choices: [{ delta: { content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "c2", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, reasoning_tokens: 5, cost: 0.000125 } },
      ])
    }
    const adapter = createApiProvider({ provider: kiloResolved({ npm: "@ai-sdk/openai-compatible", headers: { Authorization: "Bearer stale" }, models: [{ ...KILO_MODELS[0]!, headers: { authorization: "Bearer model-stale" } }] }), fetch: fake })
    expect(await collectKilo(adapter.stream(kiloRequest({ effort: "high", headers: { authorization: "Bearer hook-stale" }, transformBody: async (body) => ({ ...body, stream: false, stream_options: { include_usage: false } }) })))).toEqual([
      { type: "reasoning", delta: "Inspecting" }, { type: "text", delta: "Reading " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 30, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 10, costMicros: 125 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: "reasoning-fixture", stream: true, stream_options: { include_usage: true }, max_tokens: 4096, reasoning_effort: "high", tool_choice: "auto", tools: [{ type: "function", function: { name: "read" } }] })
  })

  test("tool results replay in order and a reused adapter reads rotated tokens", async () => {
    let key = KILO_TOKEN
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: kiloResolved({ apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return kiloDone()
    } })
    await collectKilo(adapter.stream(kiloRequest()))
    key += "-rotated"
    await collectKilo(adapter.stream(kiloRequest({ messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: "Reading", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
    ] })))
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
    ])
  })

  test("plain-HTTP public hosts, URL capabilities and missing tokens fail before any injected transport", async () => {
    let calls = 0
    const fake: Fetch = async () => { calls++; return kiloDone() }
    for (const baseUrl of ["http://api.kilo.ai/api/gateway","http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x", "file:///tmp/gateway"]) {
      await expect(collectKilo(createApiProvider({ provider: kiloResolved({ baseUrl }), fetch: fake }).stream(kiloRequest({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: kiloResolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
      expect(await createKiloProvider({ id: "kilo", model: "fixture", baseUrl, apiKey: () => KILO_TOKEN, fetch: fake }).probe!()).toBe(false)
    }
    const missing = kiloResolved({ apiKey: () => undefined, keyRequired: false })
    await expect(collectKilo(createApiProvider({ provider: missing, fetch: fake }).stream(kiloRequest({ headers: { authorization: "Bearer override" } })))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: missing, fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(kiloUrl(`http://${host}:1234/v1`).hostname).toBe(host)
  })

  test("model refresh authenticates, keeps capability metadata and never invents starter models", async () => {
    expect(PROVIDER_PRESETS.kilo).toMatchObject({ defaultEnabled: false, models: [], keyEnv: "KILO_API_KEY" })
    const models = await fetchProviderModels({ provider: kiloResolved({ headers: { authorization: "Bearer stale" } }), fetch: async (url, init) => {
      expect(url).toBe(`${KILO_URL}/models`)
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KILO_TOKEN}`)
      for (const [name, value] of Object.entries(KILO_HEADERS)) expect(new Headers(init.headers).get(name)).toBe(value)
      return kiloFake(url, init)
    } })
    expect(models).toEqual(KILO_MODELS)
  })

  test("free usage stays zero and cache-creation aliases are counted once", async () => {
    const adapter = createApiProvider({ provider: kiloResolved({ models: [{ id: "fixture", cost: { input: 5, output: 20 } }] }), fetch: async () => kiloSse([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cache_creation_tokens: 10 }, cost: 0 } }]) })
    expect((await collectKilo(adapter.stream(kiloRequest()))).find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 30, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 10, costMicros: 0 } })
  })

  test("selected-model capabilities omit unsupported tools/images and cap generation", async () => {
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: kiloResolved(), fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return kiloDone() } })
    await collectKilo(adapter.stream(kiloRequest({ model: "text-fixture", messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(bodies[0].tools).toBeUndefined()
    expect(JSON.stringify(bodies[0].messages)).not.toContain("AAAA")
    expect(JSON.stringify(bodies[0].messages)).toContain("1 image omitted")
    await collectKilo(adapter.stream(kiloRequest({ maxOutputTokens: 8000, parameters: { max_tokens: 8000 } })))
    expect(bodies[1].max_tokens).toBe(4096)
  })

  test("auth errors scrub tokens; redirects, retries, truncation and cancellation retain transport semantics", async () => {
    for (const status of [401, 403, 302, 429, 503]) {
      const adapter = createApiProvider({ provider: kiloResolved(), fetch: async (_url, init) => {
        expect(init.redirect).toBe("error")
        return new Response(`rejected ${KILO_TOKEN}`, { status, headers: { "retry-after": "2", location: "https://public.example/v1" } })
      } })
      const error = await collectKilo(adapter.stream(kiloRequest())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(status >= 429 ? RetryableProviderError : Error)
      expect((error as Error).message).not.toContain(KILO_TOKEN)
      if (status >= 429) expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
    const incomplete = createApiProvider({ provider: kiloResolved(), fetch: async () => kiloSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    const truncated = collectKilo(incomplete.stream(kiloRequest()))
    await expect(truncated).rejects.toThrow("ended without completion")
    const abort = new AbortController()
    const adapter = createApiProvider({ provider: kiloResolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); abort.abort() }) })
    expect(await collectKilo(adapter.stream(kiloRequest({ signal: abort.signal })))).toEqual([])
  })
})
