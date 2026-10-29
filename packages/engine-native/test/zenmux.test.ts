import { describe, expect, test } from "bun:test"
import { createApiProvider, createNativeEngine, fetchProviderModels, memoryHistory, RetryableProviderError, toChatMessages, type Fetch } from "../src"
import { createIdFactory } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { z } from "zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createZenmuxProvider, zenmuxUrl, ZENMUX_HEADERS } from "../src/zenmux"
import { PROVIDER_PRESETS } from "../src/provider-presets"
import { collectZenmux, zenmuxDone, zenmuxFake, zenmuxRequest, zenmuxResolved, zenmuxSse, ZENMUX_MODELS, ZENMUX_TOKEN, ZENMUX_URL } from "./zenmux-fixtures"

describe("B10.19 Zenmux native transport", () => {
  test("streams reasoning, text, fragmented parallel tools, cache usage and reported USD cost without an SDK", async () => {
    let body: any
    const fake: Fetch = async (url, init) => {
      expect(url).toBe(`${ZENMUX_URL}/chat/completions`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${ZENMUX_TOKEN}`)
      for (const [name, value] of Object.entries(ZENMUX_HEADERS)) expect(headers.get(name)).toBe(value)
      body = JSON.parse(String(init.body))
      return zenmuxSse([
        { choices: [{ delta: { reasoning: "Inspecting" } }] },
        { choices: [{ delta: { content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "c2", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, reasoning_tokens: 5, cost: 0.000125 } },
      ])
    }
    const adapter = createApiProvider({ provider: zenmuxResolved({ npm: "@ai-sdk/openai-compatible", headers: { Authorization: "Bearer stale" }, models: [{ ...ZENMUX_MODELS[0]!, headers: { authorization: "Bearer model-stale" } }] }), fetch: fake })
    expect(await collectZenmux(adapter.stream(zenmuxRequest({ effort: "high", headers: { authorization: "Bearer hook-stale" }, transformBody: async (body) => ({ ...body, stream: false, stream_options: { include_usage: false } }) })))).toEqual([
      { type: "reasoning", delta: "Inspecting" }, { type: "text", delta: "Reading " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 30, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 10, costMicros: 125 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: "vendor/reasoning-fixture", stream: true, stream_options: { include_usage: true }, max_tokens: 4096, reasoning_effort: "high", tool_choice: "auto", tools: [{ type: "function", function: { name: "read" } }] })
  })

  test("tool results replay in order and a reused adapter reads rotated tokens", async () => {
    let key = ZENMUX_TOKEN
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: zenmuxResolved({ apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return zenmuxDone()
    } })
    await collectZenmux(adapter.stream(zenmuxRequest()))
    key += "-rotated"
    await collectZenmux(adapter.stream(zenmuxRequest({ messages: [
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
    const fake: Fetch = async () => { calls++; return zenmuxDone() }
    for (const baseUrl of ["http://zenmux.ai/api/v1","http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x", "file:///tmp/zenmux"]) {
      await expect(collectZenmux(createApiProvider({ provider: zenmuxResolved({ baseUrl }), fetch: fake }).stream(zenmuxRequest({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: zenmuxResolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
      expect(await createZenmuxProvider({ id: "zenmux", model: "fixture", baseUrl, apiKey: () => ZENMUX_TOKEN, fetch: fake }).probe!()).toBe(false)
    }
    const missing = zenmuxResolved({ apiKey: () => undefined, keyRequired: false })
    await expect(collectZenmux(createApiProvider({ provider: missing, fetch: fake }).stream(zenmuxRequest({ headers: { authorization: "Bearer override" } })))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: missing, fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(zenmuxUrl(`http://${host}:1234/v1`).hostname).toBe(host)
  })

  test("model refresh authenticates, keeps capability metadata and never invents starter models", async () => {
    expect(PROVIDER_PRESETS.zenmux).toMatchObject({ defaultEnabled: false, models: [], keyEnv: "ZENMUX_API_KEY" })
    const models = await fetchProviderModels({ provider: zenmuxResolved({ headers: { authorization: "Bearer stale" } }), fetch: async (url, init) => {
      expect(url).toBe(`${ZENMUX_URL}/models`)
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ZENMUX_TOKEN}`)
      for (const [name, value] of Object.entries(ZENMUX_HEADERS)) expect(new Headers(init.headers).get(name)).toBe(value)
      return zenmuxFake(url, init)
    } })
    expect(models).toEqual(ZENMUX_MODELS)
  })

  test("native catalog shape keeps reasoning, vision and context and excludes non-text outputs", async () => {
    const models = await fetchProviderModels({ provider: zenmuxResolved(), fetch: async () => Response.json({ data: [
      { id: "vendor/signed", display_name: "Signed", context_length: 200_000, input_modalities: ["text", "image", "file"], output_modalities: ["text"], capabilities: { reasoning: true } },
      { id: "vendor/plain", input_modalities: ["text"], output_modalities: ["text"], capabilities: { reasoning: false } },
      { id: "vendor/image", output_modalities: ["image"] }, null, { id: "x".repeat(67) },
    ] }) })
    expect(models).toEqual([
      { id: "vendor/plain", images: false, effort: false },
      { id: "vendor/signed", name: "Signed", context: 200_000, images: true, effort: true },
    ])
  })

  test("signed reasoning fragments replay only to the same provider/model, without changing other chat adapters", async () => {
    const adapter = createApiProvider({ provider: zenmuxResolved(), fetch: async () => zenmuxSse([
      { choices: [{ delta: { reasoning: "Inspect ", reasoning_details: [{ index: 0, type: "reasoning.text", text: "Inspect ", format: "anthropic-claude-v1" }] } }] },
      { choices: [{ delta: { reasoning: "file", reasoning_details: [{ index: 0, text: "file", signature: "signed-" }] } }] },
      { choices: [{ delta: { reasoning_details: [{ index: 0, signature: "fixture" }], tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
    ]) })
    const events = await collectZenmux(adapter.stream(zenmuxRequest()))
    const signed = events.find((event) => event.type === "reasoning_state")
    if (signed?.type !== "reasoning_state") throw new Error("missing signed reasoning")
    const block = { reasoning: "Inspect file", reasoning_details: [{ index: 0, type: "reasoning.text", text: "Inspect file", format: "anthropic-claude-v1", signature: "signed-fixture" }] }
    expect(signed.state).toEqual({ provider: "zenmux", model: "vendor/reasoning-fixture", blocks: [block] })
    const messages = [{ role: "assistant" as const, content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }], reasoning: signed.state }]
    expect(toChatMessages("", messages, "vendor/reasoning-fixture")[0]).toMatchObject(block)
    for (const state of [signed.state, { ...signed.state, provider: "other" }]) {
      expect(toChatMessages("", [{ ...messages[0]!, reasoning: state }], "vendor/other")[0]).not.toHaveProperty("reasoning_details")
    }
    expect(toChatMessages("", [{ ...messages[0]!, reasoning: { ...signed.state, provider: "other" } }], signed.state.model)[0]).not.toHaveProperty("reasoning_details")
    expect(toChatMessages("", messages)[0]).not.toHaveProperty("reasoning_details")
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
  })

  test("native engine executes a signed tool loop, records provider usage and drops private reasoning next turn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendcode-zenmux-engine-"))
    try {
      const bodies: any[] = []
      const provider = createApiProvider({ provider: zenmuxResolved(), fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return bodies.length === 1 ? zenmuxSse([
          { choices: [{ delta: { reasoning: "Echo", reasoning_details: [{ index: 0, type: "reasoning.text", text: "Echo", signature: "private-signature" }], tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"text":"fixture"}' } }] }, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
        ]) : zenmuxDone()
      } })
      const echo = defineTool({ name: "echo", description: "Echo", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: `echoed ${text}`, truncated: false, title: "Echo", isError: false }) })
      const engine = createNativeEngine({ provider, tools: [echo], history: memoryHistory(), cwdFor: () => dir, system: () => "Be brief", compactionPrompt: "summarize" })
      const ids = createIdFactory()
      const events: EngineEvent[] = []
      const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "Echo fixture", attachments: [], signal: new AbortController().signal, permissionMode: () => "ask", setPermissionMode: () => {}, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }) }
      await engine.runTurn(input)
      expect(bodies).toHaveLength(2)
      expect(bodies[1].messages.slice(-2)).toEqual([
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"fixture"}' } }], reasoning: "Echo", reasoning_details: [{ index: 0, type: "reasoning.text", text: "Echo", signature: "private-signature" }] },
        { role: "tool", tool_call_id: "c1", content: "echoed fixture" },
      ])
      expect(events.find((event) => event.type === "usage")).toMatchObject({ provider: "zenmux", model: "vendor/reasoning-fixture", input: 40, output: 20, reasoning: 5, cacheRead: 60 })
      expect(JSON.stringify(events)).not.toContain("private-signature")
      await engine.runTurn({ ...input, turnId: ids("turn"), text: "Again" })
      expect(JSON.stringify(bodies[2])).not.toContain("private-signature")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("free usage stays zero and cache-creation aliases are counted once", async () => {
    const adapter = createApiProvider({ provider: zenmuxResolved({ models: [{ id: "fixture", cost: { input: 5, output: 20 } }] }), fetch: async () => zenmuxSse([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cache_creation_tokens: 10 }, cost: 0 } }]) })
    expect((await collectZenmux(adapter.stream(zenmuxRequest()))).find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 30, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 10, costMicros: 0 } })
  })

  test("selected-model capabilities omit unsupported tools/images and cap generation", async () => {
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: zenmuxResolved(), fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return zenmuxDone() } })
    await collectZenmux(adapter.stream(zenmuxRequest({ model: "vendor/text-fixture", messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(bodies[0].tools).toBeUndefined()
    expect(JSON.stringify(bodies[0].messages)).not.toContain("AAAA")
    expect(JSON.stringify(bodies[0].messages)).toContain("1 image omitted")
    await collectZenmux(adapter.stream(zenmuxRequest({ maxOutputTokens: 8000, parameters: { max_tokens: 8000 } })))
    expect(bodies[1].max_tokens).toBe(4096)
  })

  test("auth errors scrub tokens; redirects, retries, truncation and cancellation retain transport semantics", async () => {
    for (const status of [401, 403, 302, 429, 503]) {
      const adapter = createApiProvider({ provider: zenmuxResolved(), fetch: async (_url, init) => {
        expect(init.redirect).toBe("error")
        return new Response(`rejected ${ZENMUX_TOKEN}`, { status, headers: { "retry-after": "2", location: "https://public.example/v1" } })
      } })
      const error = await collectZenmux(adapter.stream(zenmuxRequest())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(status >= 429 ? RetryableProviderError : Error)
      expect((error as Error).message).not.toContain(ZENMUX_TOKEN)
      if (status >= 429) expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
    const incomplete = createApiProvider({ provider: zenmuxResolved(), fetch: async () => zenmuxSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    const truncated = collectZenmux(incomplete.stream(zenmuxRequest()))
    await expect(truncated).rejects.toThrow("ended without completion")
    const abort = new AbortController()
    const adapter = createApiProvider({ provider: zenmuxResolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); abort.abort() }) })
    expect(await collectZenmux(adapter.stream(zenmuxRequest({ signal: abort.signal })))).toEqual([])
  })
})
