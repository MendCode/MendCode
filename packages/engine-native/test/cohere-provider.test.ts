import { describe, expect, test } from "bun:test"
import { cohereParameters, cohereUrl, createApiProvider, fetchProviderModels, RetryableProviderError, toCohereMessages, type ModelRequest, type ResolvedProvider } from "../src"
import { MAX_TOOL_ARGUMENT_CHARS } from "../src/openai-responses"
import { collect, sse } from "./fake-server"

const KEY = "cohere-private-fixture-0123456789"
const MODEL = "command-a-03-2025"
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "cohere", type: "cohere", baseUrl: "http://127.0.0.1:1234/v2", apiKey: () => KEY, keyRequired: true, models: [{ id: MODEL, images: false, outputLimit: 8000 }], ...over })
const request: ModelRequest = { system: "Be brief.", messages: [{ role: "user", content: "Inspect files" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal }
const end = (reason = "COMPLETE") => ({ type: "message-end", delta: { finish_reason: reason, usage: { tokens: { input_tokens: 100, output_tokens: 20 }, billed_units: { input_tokens: 37, output_tokens: 10 } } } })
const finished = () => sse([{ type: "content-delta", delta: { message: { content: { text: "ok" } } } }, end()])

describe("B10.10 Cohere native wire", () => {
  test("streams text/thinking, parallel fragmented tools and full usage behind forced Bearer auth", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "wrong", "x-team": "dev" } }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v2/chat")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(new Headers(init.headers).get("x-team")).toBe("dev")
      body = JSON.parse(String(init.body))
      return sse([
        { type: "content-delta", delta: { message: { content: { thinking: "Check files" } } } },
        { type: "content-delta", delta: { message: { content: { text: "Reading " } } } },
        { type: "tool-plan-delta", delta: { message: { tool_plan: "two files" } } },
        { type: "tool-call-start", index: 0, delta: { message: { tool_calls: { id: "r1", function: { name: "read", arguments: '{"path":' } } } } },
        { type: "tool-call-start", index: 1, delta: { message: { tool_calls: { id: "r2", function: { name: "read", arguments: '{"path":' } } } } },
        { type: "tool-call-delta", index: 1, delta: { message: { tool_calls: { function: { arguments: '"b.ts"}' } } } } },
        { type: "tool-call-delta", index: 0, delta: { message: { tool_calls: { function: { arguments: '"a.ts"}' } } } } },
        { type: "tool-call-end", index: 0 }, { type: "tool-call-end", index: 1 }, end("TOOL_CALL"),
      ])
    } })
    expect(await collect(provider.stream({ ...request, parameters: { topP: 0.8, topK: 4, safetyMode: "STRICT" }, headers: { authorization: "also-wrong" } }))).toEqual([
      { type: "reasoning", delta: "Check files" }, { type: "text", delta: "Reading " }, { type: "text", delta: "two files" },
      { type: "tool_call", call: { callId: "r1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "r2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: MODEL, p: 0.8, k: 4, safety_mode: "STRICT", stream: true, max_tokens: 8000, tools: [{ type: "function", function: { name: "read" } }] })
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(body.stream_options).toBeUndefined()
  })

  test("aliases cannot override native options or conversation; model and request caps survive hooks", async () => {
    expect(cohereParameters({ topP: 0.3, p: 0.5, stopSequences: ["end"], model: "wrong", apiKey: KEY, messages: [], stream: false })).toEqual({ p: 0.5, stop_sequences: ["end"] })
    const provider = createApiProvider({ provider: resolved({ models: [{ id: MODEL, outputLimit: 4, tool_call: false }] }), fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ max_tokens: 3, stream: true, model: MODEL })
      expect(body.tools).toBeUndefined()
      return sse([end("MAX_TOKENS")])
    } })
    expect(await collect(provider.stream({ ...request, maxOutputTokens: 3, parameters: { maxOutputTokens: 1000 }, transformBody: async (body) => ({ ...body, max_tokens: 5000, stream: false }) }))).toContainEqual({ type: "finish", reason: "length" })
  })

  test("history pairs tool results, omits unsupported images and does not mutate messages; keys rotate", async () => {
    let key = KEY, body: any
    const messages: ModelRequest["messages"] = [{ role: "user", content: "Inspect", images: [{ mime: "image/png", base64: "aW1hZ2U=" }] }, { role: "assistant", content: "", toolCalls: [{ callId: "r1", name: "read", args: { path: "a.ts" } }] }, { role: "tool", callId: "r1", name: "read", output: "File text", isError: false }, { role: "assistant", content: "", toolCalls: [{ callId: "r2", name: "read", args: {} }] }]
    const before = structuredClone(messages)
    const provider = createApiProvider({ provider: resolved({ id: "team", npm: "@ai-sdk/cohere", apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      body = JSON.parse(String(init.body))
      return finished()
    } })
    await collect(provider.stream({ ...request, messages }))
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "r2", content: "cancelled" })
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: "r1", function: { arguments: '{"path":"a.ts"}' } })
    expect(JSON.stringify(body)).not.toContain("aW1hZ2U=")
    expect(JSON.stringify(toCohereMessages(messages, "", true))).toContain("data:image/png;base64,aW1hZ2U=")
    key = "rotated-cohere-fixture"
    await collect(provider.stream({ ...request, messages }))
    expect(messages).toEqual(before)
  })

  test("rejects unsafe URLs and missing credentials before transport", async () => {
    for (const url of ["http://api.cohere.com/v2","http://localhost.evil.test/v2", "http://user:key@localhost/v2", "http://127.0.0.1/v2?key=x", "http://localhost/v2#x"]) expect(() => cohereUrl(url)).toThrow("loopback")
    expect(cohereUrl("http://[::1]:1234/v2/")).toBe("http://[::1]:1234/v2")
    let calls = 0
    const provider = createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { calls++; return finished() } })
    await expect(collect(provider.stream(request))).rejects.toThrow("no API key")
    expect(calls).toBe(0)
  })

  test("401 is final and redacted; 429 retains retry-after; cancellation before send is quiet", async () => {
    const rejected = createApiProvider({ provider: resolved(), fetch: async () => new Response(`rejected ${KEY}`, { status: 401 }) })
    const failure = await collect(rejected.stream(request)).catch((error) => error)
    expect(failure.message).toContain("[AUTH]")
    expect(failure.message).not.toContain(KEY)
    const limited = createApiProvider({ provider: resolved(), fetch: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }) })
    expect(await collect(limited.stream(request)).catch((error) => error)).toMatchObject({ name: "RetryableProviderError", retryAfterMs: 2000 })
    const controller = new AbortController()
    controller.abort()
    expect(await collect(rejected.stream({ ...request, signal: controller.signal }))).toEqual([])
  })

  test("truncated, malformed, unfinished and oversized tool streams never finish successfully", async () => {
    for (const chunks of [[], ["bad-json"], [{ type: "message-end", delta: { finish_reason: "ERROR" } }], [{ type: "tool-call-delta", index: 0 }], [{ type: "tool-call-start", index: 0, delta: { message: { tool_calls: { id: "r", function: { name: "read", arguments: "{" } } } } }, end("TOOL_CALL")]]) {
      const provider = createApiProvider({ provider: resolved(), fetch: async () => sse(chunks) })
      await expect(collect(provider.stream(request))).rejects.toBeInstanceOf(RetryableProviderError)
    }
    const oversized = createApiProvider({ provider: resolved(), fetch: async () => sse([{ type: "tool-call-start", index: 0, delta: { message: { tool_calls: { id: "r", function: { name: "read", arguments: "x".repeat(MAX_TOOL_ARGUMENT_CHARS + 1) } } } } }], { chunkSize: 65536 }) })
    await expect(collect(oversized.stream(request))).rejects.toThrow("oversized")
  })

  test("null tool arguments become an empty object, stop sequence and billed fallback work", async () => {
    const provider = createApiProvider({ provider: resolved(), fetch: async () => sse([{ type: "tool-call-start", index: 0, delta: { message: { tool_calls: { id: "r", function: { name: "read", arguments: "null" } } } } }, { type: "tool-call-end", index: 0 }, { type: "message-end", delta: { finish_reason: "STOP_SEQUENCE", usage: { billed_units: { input_tokens: 2, output_tokens: 1 } } } }]) })
    expect(await collect(provider.stream(request))).toEqual([{ type: "tool_call", call: { callId: "r", name: "read", args: {} } }, { type: "usage", usage: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "tool_calls" }])
  })

  test("refresh paginates chat models with Bearer auth, filters non-chat/deprecated models and deduplicates", async () => {
    let calls = 0
    const models = await fetchProviderModels({ provider: resolved(), fetch: async (url, init) => {
      expect(new URL(url).pathname).toBe("/v1/models")
      expect(new URL(url).searchParams.get("endpoint")).toBe("chat")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(init.redirect).toBe("error")
      calls++
      if (calls === 1) return Response.json({ models: [{ name: MODEL, endpoints: ["chat"], context_length: 256000 }, { name: "embed", endpoints: ["embed"] }, { name: "old", endpoints: ["chat"], is_deprecated: true }], next_page_token: "next" })
      expect(new URL(url).searchParams.get("page_token")).toBe("next")
      return Response.json({ models: [{ name: MODEL, endpoints: ["chat"], context_length: 256000 }, { name: "command-r", endpoints: ["chat"], context_length: 128000 }] })
    } })
    expect(models).toEqual([{ id: MODEL, context: 256000 }, { id: "command-r", context: 128000 }])
    expect(calls).toBe(2)
    await expect(fetchProviderModels({ provider: resolved(), fetch: async () => Response.json({ models: [], next_page_token: "same" }) })).rejects.toThrow("repeated")
  })

  test("bounds silent requests and user cancellation without a global timeout increase", async () => {
    const hanging = async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    const provider = createApiProvider({ provider: resolved(), idleTimeoutMs: 20, fetch: hanging })
    await expect(collect(provider.stream(request))).rejects.toThrow("stalled")
    const controller = new AbortController()
    const pending = collect(provider.stream({ ...request, signal: controller.signal }))
    controller.abort()
    expect(await pending).toEqual([])
  }, 2000)
})
