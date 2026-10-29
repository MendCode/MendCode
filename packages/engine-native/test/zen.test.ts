import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, testProvider, type Fetch, type ResolvedProvider } from "../src"
import { zenUrl, zenWire } from "../src/opencode-zen"
import { collectZen, ZEN_MODELS, ZEN_TOKEN, ZEN_URL, zenFake, zenRequest } from "./zen-fixtures"

const resolved = (overrides: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "opencode", type: "openai-compatible", baseUrl: ZEN_URL, apiKey: () => ZEN_TOKEN, keyRequired: true, models: ZEN_MODELS, ...overrides })

describe("B10.15 OpenCode Zen native adapter", () => {
  test("routes all four formats through the proxy and preserves text, tools, reasoning and usage", async () => {
    const sent: Array<{ url: string; init: RequestInit; body: Record<string, any> }> = []
    const provider = createApiProvider({ provider: resolved({ headers: { authorization: "wrong", "x-api-key": "wrong", "x-goog-api-key": "wrong" }, npm: "missing-sdk-must-not-load" }), fetch: async (url, init) => { sent.push({ url, init, body: JSON.parse(String(init.body)) }); return zenFake(url, init) } })
    for (const [index, model] of ZEN_MODELS.entries()) {
      const events = await collectZen(provider.stream(zenRequest(model.id)))
      expect(events).toContainEqual({ type: "text", delta: "hello" })
      expect(events).toContainEqual({ type: "reasoning", delta: "look" })
      expect(events).toContainEqual({ type: "tool_call", call: { callId: "call_1", name: "read", args: { path: "a.ts" } } })
      expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
      expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { input: 40, cacheRead: 60, output: index === 2 ? 25 : 20 } })
      const call = sent[index]!
      const headers = new Headers(call.init.headers)
      expect(call.init.redirect).toBe("error")
      expect(headers.get(index === 1 ? "x-api-key" : index === 2 ? "x-goog-api-key" : "authorization")).toBe(index === 1 || index === 2 ? ZEN_TOKEN : `Bearer ${ZEN_TOKEN}`)
      expect(JSON.stringify([...headers])).not.toContain("wrong")
      expect(call.body.tools).toHaveLength(1)
    }
    expect(sent[0]!.url).toBe(`${ZEN_URL}/responses`)
    expect(sent[1]!.url).toBe(`${ZEN_URL}/messages`)
    expect(sent[2]!.url).toBe(`${ZEN_URL}/models/gemini-fixture:streamGenerateContent?alt=sse`)
    expect(sent[3]!.url).toBe(`${ZEN_URL}/chat/completions`)
    expect((await collectZen(provider.stream(zenRequest("gpt-fixture")))).find((event) => event.type === "usage")).toMatchObject({ usage: { reasoning: 5, costMicros: 300 } })
  })

  test("model SDK metadata wins over names, remote URLs are not followed, and tool results round-trip", async () => {
    expect(zenWire({ id: "claude-custom", provider: { npm: "@ai-sdk/openai-compatible" } })).toBe("openai-compatible")
    expect(zenWire({ id: "claude-sonnet" })).toBe("anthropic")
    expect(zenWire({ id: "gemini-2.5-pro" })).toBe("google")
    expect(zenWire({ id: "gpt-5" })).toBe("openai")
    expect(() => zenWire({ id: "unknown", provider: { npm: "uninstalled" } })).toThrow("unsupported")
    let body: Record<string, any> = {}
    const provider = createApiProvider({ provider: resolved({ models: [{ id: "local-fixture", provider: { npm: "@ai-sdk/openai-compatible", api: "https://do-not-contact.example" } }] }), fetch: async (url, init) => { expect(url.startsWith(ZEN_URL)).toBe(true); body = JSON.parse(String(init.body)); return zenFake(url, init) } })
    const events = await collectZen(provider.stream({ ...zenRequest("local-fixture"), tools: [], messages: [{ role: "assistant", content: "", toolCalls: [{ callId: "call_1", name: "read", args: { path: "a.ts" } }] }, { role: "tool", callId: "call_1", name: "read", output: "file text", isError: false }] }))
    expect(body.messages).toContainEqual({ role: "tool", tool_call_id: "call_1", content: "file text" })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
  })

  test("rejects plain-HTTP remote endpoints, missing tokens and anonymous fallback before any injected transport", async () => {
    let calls = 0
    const transport: Fetch = async () => { calls++; throw new Error("must not run") }
    for (const baseUrl of ["http://opencode.ai/zen/v1","http://127.0.0.1.evil/v1", "http://user:secret@localhost/v1", "http://localhost/v1?token=secret", "http://localhost/v1#fragment"]) {
      expect(() => zenUrl(baseUrl)).toThrow("loopback")
      const provider = resolved({ baseUrl })
      await expect(collectZen(createApiProvider({ provider, fetch: transport }).stream({ ...zenRequest("local-fixture"), fetch: transport }))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider, fetch: transport })).rejects.toThrow("loopback")
    }
    for (const key of [undefined, "public"]) {
      const provider = resolved({ apiKey: () => key })
      await expect(collectZen(createApiProvider({ provider, fetch: transport }).stream(zenRequest("gpt-fixture")))).rejects.toThrow("proxy token")
      await expect(fetchProviderModels({ provider, fetch: transport })).rejects.toThrow("API key")
    }
    expect(calls).toBe(0)
  })

  test("refresh keeps native metadata, authenticates with the live token, rejects redirects and bounds the catalog", async () => {
    let key = ZEN_TOKEN
    const provider = resolved({ apiKey: () => key, headers: { authorization: "wrong" } })
    const fake: Fetch = async (url, init) => { expect(url).toBe(`${ZEN_URL}/models`); expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`); expect(init.redirect).toBe("error"); return Response.json({ data: [...ZEN_MODELS, { id: "broken", cost: { input: -1, output: 0 } }, ...Array.from({ length: 410 }, (_, index) => ({ id: `model-${index}` }))] }) }
    const models = await fetchProviderModels({ provider, fetch: fake })
    expect(models).toHaveLength(400)
    expect(models.find((entry) => entry.id === "gpt-fixture")).toEqual(ZEN_MODELS[0])
    expect(models.some((entry) => entry.id === "broken")).toBe(false)
    key = "rotated-zen-local-token-0123456789"
    await fetchProviderModels({ provider, fetch: fake })
    await expect(fetchProviderModels({ provider, fetch: async () => new Response(null, { status: 302, headers: { location: "https://do-not-contact.example" } }) })).rejects.toThrow()
  })

  test("bounded tests, cancellation and scrubbed retry errors use the same native transport", async () => {
    expect(await testProvider({ provider: resolved(), fetch: zenFake })).toMatchObject({ ok: true, model: "gpt-fixture" })
    const provider = createApiProvider({ provider: resolved(), fetch: async () => { throw new RetryableProviderError(`rejected ${ZEN_TOKEN}`, 100, "transient") } })
    try { await collectZen(provider.stream(zenRequest("gpt-fixture"))); throw new Error("expected error") } catch (error) { expect(error).toBeInstanceOf(RetryableProviderError); expect(String(error)).not.toContain(ZEN_TOKEN) }
    const controller = new AbortController()
    const aborted = createApiProvider({ provider: resolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { const stop = () => reject(new DOMException("aborted", "AbortError")); if (init.signal?.aborted) stop(); else init.signal?.addEventListener("abort", stop, { once: true }) }) })
    const running = collectZen(aborted.stream({ ...zenRequest("gpt-fixture"), signal: controller.signal }))
    controller.abort()
    expect(await running).toEqual([])
    expect(await testProvider({ provider: resolved(), timeoutMs: 20, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }) }) })).toMatchObject({ ok: false, error: "timed out" })
  })

  test("a free model refused to a non-OpenCode client reads as the free-tier rule, not as a rejected key", async () => {
    // Zen's live answer (2026-10-17) to any client other than OpenCode's own, with or without a key.
    const refusal: Fetch = async () => Response.json({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building." } }, { status: 403 })
    const provider = createApiProvider({ provider: resolved({ models: [{ id: "deepseek-free-fixture", provider: { npm: "@ai-sdk/openai-compatible" } }] }), fetch: refusal })
    const failure = await collectZen(provider.stream(zenRequest("deepseek-free-fixture"))).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("only to OpenCode's own client")
    expect(String(failure)).toContain("opencode ACP agent")
    expect(String(failure)).not.toContain("rejected the API key")
    expect(String(failure)).not.toContain(ZEN_TOKEN)
    // Any other 403 still reads as a key problem.
    const denied = createApiProvider({ provider: resolved(), fetch: async () => new Response("bad key", { status: 403 }) })
    await expect(collectZen(denied.stream(zenRequest("gpt-fixture")))).rejects.toThrow("rejected")
  })
})
