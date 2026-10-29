import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, type Fetch } from "../src"
import { createNvidiaProvider, nvidiaUrl, NVIDIA_HEADERS } from "../src/nvidia"
import { PROVIDER_PRESETS } from "../src/provider-presets"
import { collectNvidia, nvidiaDone, nvidiaFake, nvidiaRequest, nvidiaResolved, nvidiaSse, NVIDIA_MODELS, NVIDIA_TOKEN, NVIDIA_URL } from "./nvidia-fixtures"

describe("B10.17 NVIDIA native transport", () => {
  test("preset is opt-in with no guessed catalog; authenticated refresh preserves proxy capabilities", async () => {
    expect(PROVIDER_PRESETS.nvidia).toMatchObject({ defaultEnabled: false, models: [], keyEnv: "NVIDIA_API_KEY", type: "openai-compatible" })
    const models = await fetchProviderModels({ provider: nvidiaResolved({ headers: { authorization: "Bearer stale" } }), fetch: async (url, init) => {
      expect(url).toBe(`${NVIDIA_URL}/models`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${NVIDIA_TOKEN}`)
      for (const [name, value] of Object.entries(NVIDIA_HEADERS)) expect(headers.get(name)).toBe(value)
      expect(headers.has("x-source")).toBe(false)
      return nvidiaFake(url, init)
    } })
    expect(models).toEqual([NVIDIA_MODELS[1]!, NVIDIA_MODELS[0]!])
  })

  test("streams reasoning, text, fragmented parallel calls and final usage with model pricing and caps", async () => {
    let body: any
    const adapter = createApiProvider({ provider: nvidiaResolved({ npm: "@ai-sdk/openai-compatible", headers: { Authorization: "Bearer stale" }, models: [{ ...NVIDIA_MODELS[0]!, headers: { authorization: "Bearer model-stale" }, cost: { input: 2, output: 4, cache_read: 0.5 } }] }), fetch: async (url, init) => {
      expect(url).toBe(`${NVIDIA_URL}/chat/completions`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${NVIDIA_TOKEN}`)
      for (const [name, value] of Object.entries(NVIDIA_HEADERS)) expect(headers.get(name)).toBe(value)
      body = JSON.parse(String(init.body))
      return nvidiaSse([
        { choices: [{ delta: { reasoning_content: "Inspecting" } }] },
        { choices: [{ delta: { content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "c2", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
      ])
    } })
    expect(await collectNvidia(adapter.stream(nvidiaRequest({ maxOutputTokens: 8000, parameters: { max_tokens: 8000 }, effort: "high", headers: { authorization: "Bearer hook-stale" }, transformBody: async (body) => ({ ...body, stream: false, stream_options: { include_usage: false } }) })))).toEqual([
      { type: "reasoning", delta: "Inspecting" }, { type: "text", delta: "Reading " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0, costMicros: 190 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: "nvidia/tool-fixture", stream: true, stream_options: { include_usage: true }, max_tokens: 4096, reasoning_effort: "high", tool_choice: "auto", tools: [{ type: "function", function: { name: "read" } }] })
  })

  test("tool results replay and reused adapters read rotated tokens; capabilities follow the selected model", async () => {
    let key = NVIDIA_TOKEN
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: nvidiaResolved({ apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return nvidiaDone()
    } })
    await collectNvidia(adapter.stream(nvidiaRequest({ messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: "Reading", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
    ] })))
    expect(bodies[0].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
    ])
    key += "-rotated"
    await collectNvidia(adapter.stream(nvidiaRequest({ model: "nvidia/text-fixture", messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(bodies[1].tools).toBeUndefined()
    expect(JSON.stringify(bodies[1].messages)).not.toContain("AAAA")
    expect(JSON.stringify(bodies[1].messages)).toContain("1 image omitted")
  })

  test("plain-HTTP public hosts, URL capabilities and absent tokens fail before every injected transport", async () => {
    let calls = 0
    const fake: Fetch = async () => { calls++; return nvidiaDone() }
    for (const baseUrl of ["http://integrate.api.nvidia.com/v1","http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x", "file:///tmp/nvidia"]) {
      await expect(collectNvidia(createApiProvider({ provider: nvidiaResolved({ baseUrl }), fetch: fake }).stream(nvidiaRequest({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: nvidiaResolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
      expect(await createNvidiaProvider({ id: "nvidia", model: "fixture", baseUrl, apiKey: () => NVIDIA_TOKEN, fetch: fake }).probe!()).toBe(false)
    }
    const missing = nvidiaResolved({ apiKey: () => undefined, keyRequired: false })
    await expect(collectNvidia(createApiProvider({ provider: missing, fetch: fake }).stream(nvidiaRequest({ headers: { authorization: "Bearer override" } })))).rejects.toThrow("no API key")
    await expect(fetchProviderModels({ provider: missing, fetch: fake })).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(nvidiaUrl(`http://${host}:1234/v1`).hostname).toBe(host)
  })

  test("auth errors redact tokens; redirects, retries, truncation and cancellation retain stream semantics", async () => {
    for (const status of [401, 403, 302, 429, 503]) {
      const adapter = createApiProvider({ provider: nvidiaResolved(), fetch: async (_url, init) => {
        expect(init.redirect).toBe("error")
        return new Response(`rejected ${NVIDIA_TOKEN}`, { status, headers: { "retry-after": "2", location: "https://public.example/v1" } })
      } })
      const error = await collectNvidia(adapter.stream(nvidiaRequest())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(status >= 429 ? RetryableProviderError : Error)
      expect((error as Error).message).not.toContain(NVIDIA_TOKEN)
      if (status >= 429) expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
    const incomplete = createApiProvider({ provider: nvidiaResolved(), fetch: async () => nvidiaSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    await expect(collectNvidia(incomplete.stream(nvidiaRequest()))).rejects.toThrow("ended without completion")
    const abort = new AbortController()
    const adapter = createApiProvider({ provider: nvidiaResolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); abort.abort() }) })
    expect(await collectNvidia(adapter.stream(nvidiaRequest({ signal: abort.signal })))).toEqual([])
  })
})
