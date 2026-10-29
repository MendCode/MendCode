import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, type Fetch } from "../src"
import { cloudflareWorkersAccount, cloudflareWorkersBaseUrl, createCloudflareWorkersProvider } from "../src/cloudflare-workers-ai"
import { CF_ID, CF_MODEL, CF_MODELS, CF_TOKEN, CF_URL, cfDone, cfRequest, cfResolved, cfSse, collectCf } from "./cloudflare-workers-ai-fixtures"

describe("B10.21 Workers AI transport", () => {
  test("streams text, fragmented tools and measured usage through the compatible protocol", async () => {
    let body: any
    const fake: Fetch = async (url, init) => {
      expect(url).toBe(`${CF_URL}/chat/completions`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${CF_TOKEN}`)
      for (const name of ["cookie", "x-api-key", "x-auth-key"]) expect(headers.get(name)).toBeNull()
      body = JSON.parse(String(init.body))
      return cfSse([
        { choices: [{ delta: { content: "Reading" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } } },
      ])
    }
    const adapter = createApiProvider({ provider: cfResolved({ npm: "unavailable-sdk", headers: { Authorization: "Bearer stale", "x-auth-key": "old-key" } }), fetch: fake })
    expect(await collectCf(adapter.stream(cfRequest({ headers: { authorization: "Bearer hook-stale", cookie: "old-cookie", "x-api-key": "old-key" }, parameters: { temperature: 0.2 }, transformBody: async (body) => ({ ...body, stream: false }) })))).toEqual([
      { type: "text", delta: "Reading" },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 60, output: 20, reasoning: 5, cacheRead: 40, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    expect(body).toMatchObject({ model: CF_MODEL, stream: true, stream_options: { include_usage: true }, temperature: 0.2, tool_choice: "auto", tools: [{ type: "function", function: { name: "read" } }] })
  })

  test("tool results replay correctly, unsupported images are omitted and token rotation applies immediately", async () => {
    let key = CF_TOKEN
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: cfResolved({ apiKey: () => key }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return cfDone()
    } })
    await collectCf(adapter.stream(cfRequest({ messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(JSON.stringify(bodies[0].messages)).not.toContain("AAAA")
    key += "-rotated"
    await collectCf(adapter.stream(cfRequest({ messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: "Reading", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
    ] })))
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
    ])
  })

  test("rejects plain-HTTP public endpoints, URL credentials and anonymous requests before transport or SDK loading", async () => {
    let calls = 0
    const fake: Fetch = async () => { calls++; return cfDone() }
    for (const baseUrl of ["http://api.cloudflare.com/client/v4/accounts/a/ai/v1","http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?token=x", "http://localhost/v1#x", "file:///tmp/cf"]) {
      await expect(collectCf(createApiProvider({ provider: cfResolved({ baseUrl }), fetch: fake }).stream(cfRequest({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: cfResolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
      expect(await createCloudflareWorkersProvider({ id: CF_ID, model: CF_MODEL, baseUrl, apiKey: () => CF_TOKEN, fetch: fake }).probe!()).toBe(false)
    }
    await expect(collectCf(createApiProvider({ provider: cfResolved({ apiKey: () => undefined, keyRequired: false }), fetch: fake }).stream(cfRequest({ headers: { authorization: "Bearer bypass" } })))).rejects.toThrow("no API key")
    expect(calls).toBe(0)
  })

  test("account environment wins over metadata, explicit endpoint bypasses account requirement and refresh stays offline", async () => {
    expect(cloudflareWorkersAccount({ accountId: "stored" }, { CLOUDFLARE_ACCOUNT_ID: "environment" })).toBe("environment")
    expect(cloudflareWorkersAccount({ accountId: "stored" })).toBe("stored")
    expect(cloudflareWorkersBaseUrl(CF_URL)).toBe(CF_URL)
    expect(() => cloudflareWorkersBaseUrl("")).toThrow("CLOUDFLARE_ACCOUNT_ID")
    expect(cloudflareWorkersBaseUrl("", "account")).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/v1")
    expect(await fetchProviderModels({ provider: cfResolved(), fetch: async () => { throw new Error("no network") } })).toEqual(CF_MODELS)
  })

  test("auth errors redact tokens and configured headers while retries retain classification and delay", async () => {
    for (const status of [401, 403, 302, 429, 503]) {
      const adapter = createApiProvider({ provider: cfResolved({ headers: { "x-fixture": "private-header-value" } }), fetch: async () => new Response(`rejected ${CF_TOKEN} private-header-value`, { status, headers: { "retry-after": "2" } }) })
      const error = await collectCf(adapter.stream(cfRequest())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(status >= 429 ? RetryableProviderError : Error)
      expect((error as Error).message).not.toContain(CF_TOKEN)
      expect((error as Error).message).not.toContain("private-header-value")
      if (status >= 429) expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
  })

  test("truncated streams fail and abort cancels the injected request", async () => {
    const incomplete = createApiProvider({ provider: cfResolved(), fetch: async () => cfSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    await expect(collectCf(incomplete.stream(cfRequest()))).rejects.toThrow("ended without completion")
    const abort = new AbortController()
    const adapter = createApiProvider({ provider: cfResolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      abort.abort()
    }) })
    expect(await collectCf(adapter.stream(cfRequest({ signal: abort.signal })))).toEqual([])
  })
})
