import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, type Fetch } from "../src"
import { cloudflareGatewayBaseUrl, cloudflareGatewayHeaders, createCloudflareGatewayProvider } from "../src/cloudflare-ai-gateway"
import { AIG_ID, AIG_MODEL, AIG_MODELS, AIG_TOKEN, AIG_URL, aigDone, aigRequest, aigResolved, aigSse, collectAig } from "./cloudflare-ai-gateway-fixtures"

describe("B10.22 Cloudflare AI Gateway transport", () => {
  test("streams text, reasoning, parallel fragmented tools and measured usage through Unified API", async () => {
    let body: any
    const fake: Fetch = async (url, init) => {
      expect(url).toBe(`${AIG_URL}/chat/completions`)
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${AIG_TOKEN}`)
      expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${AIG_TOKEN}`)
      expect(headers.get("cf-aig-metadata")).toBe('{"project":"local"}')
      expect(headers.get("cf-aig-cache-ttl")).toBe("120")
      expect(headers.get("cf-aig-cache-key")).toBe("local-cache-fixture")
      expect(headers.get("cf-aig-skip-cache")).toBe("false")
      expect(headers.get("cf-aig-collect-log")).toBe("false")
      for (const name of ["cookie", "proxy-authorization", "x-api-key", "x-auth-key"]) expect(headers.get(name)).toBeNull()
      body = JSON.parse(String(init.body))
      return aigSse([
        { choices: [{ delta: { reasoning_content: "Plan", content: "Reading" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "c2", function: { name: "read", arguments: '{"path":"b' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }, { index: 1, function: { arguments: '.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 } } },
      ])
    }
    const adapter = createApiProvider({ provider: aigResolved({ npm: "unavailable-sdk", headers: { Authorization: "stale-private-header", "cf-aig-authorization": "stale-token", "x-auth-key": "stale-key" }, cloudflareAiGateway: { metadata: { project: "local" }, cacheTtl: 120, cacheKey: "local-cache-fixture", skipCache: false, collectLog: false } }), fetch: fake })
    const events = await collectAig(adapter.stream(aigRequest({ headers: { authorization: "hook-token", cookie: "old-cookie", "x-api-key": "old-key", "cf-aig-metadata": "hook-metadata" }, parameters: { temperature: 0.2 }, transformBody: async (body) => ({ ...body, stream: false }) })))
    expect(events).toContainEqual({ type: "text", delta: "Reading" })
    expect(events).toContainEqual({ type: "reasoning", delta: "Plan" })
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } },
    ])
    expect(events).toContainEqual({ type: "usage", usage: { input: 50, output: 20, reasoning: 5, cacheRead: 40, cacheWrite: 10 } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    expect(body).toMatchObject({ model: AIG_MODEL, stream: true, stream_options: { include_usage: true }, temperature: 0.2, tools: [{ type: "function", function: { name: "read" } }] })
    expect(body).not.toHaveProperty("metadata")
  })

  test("replays tool results, applies vision metadata, output limits and token rotation", async () => {
    let key = AIG_TOKEN
    const bodies: any[] = []
    const adapter = createApiProvider({ provider: aigResolved({ apiKey: () => key, models: AIG_MODELS.map((model) => ({ ...model, outputLimit: 16 })) }), fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("cf-aig-authorization")).toBe(`Bearer ${key}`)
      bodies.push(JSON.parse(String(init.body)))
      return aigDone()
    } })
    await collectAig(adapter.stream(aigRequest({ maxOutputTokens: 100, messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(JSON.stringify(bodies[0].messages)).toContain("AAAA")
    expect(bodies[0].max_tokens).toBe(16)
    key += "-rotated"
    await collectAig(adapter.stream(aigRequest({ model: "openai/text-fixture", messages: [
      { role: "user", content: "read", images: [{ mime: "image/png", base64: "AAAA" }] },
      { role: "assistant", content: "Reading", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
      { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
    ] })))
    expect(JSON.stringify(bodies[1].messages)).not.toContain("AAAA")
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Reading", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
    ])
  })

  test("rejects plain-HTTP public endpoints, capabilities, missing auth and malformed models before transport", async () => {
    let calls = 0
    const fake: Fetch = async () => { calls++; return aigDone() }
    for (const baseUrl of ["http://gateway.ai.cloudflare.com/v1/a/g/compat","http://127.0.0.1.evil/v1", "http://u:p@localhost/compat", "http://localhost/compat?token=x", "http://localhost/compat#x", "file:///tmp/cf"]) {
      await expect(collectAig(createApiProvider({ provider: aigResolved({ baseUrl }), fetch: fake }).stream(aigRequest({ fetch: fake })))).rejects.toThrow("loopback")
      await expect(fetchProviderModels({ provider: aigResolved({ baseUrl }), fetch: fake })).rejects.toThrow("loopback")
      expect(await createCloudflareGatewayProvider({ id: AIG_ID, model: AIG_MODEL, baseUrl, apiKey: () => AIG_TOKEN, fetch: fake }).probe!()).toBe(false)
    }
    await expect(collectAig(createApiProvider({ provider: aigResolved({ apiKey: () => undefined, keyRequired: false }), fetch: fake }).stream(aigRequest({ headers: { authorization: "bypass" } })))).rejects.toThrow("requires")
    await expect(collectAig(createApiProvider({ provider: aigResolved(), fetch: fake }).stream(aigRequest({ model: "no-prefix" })))).rejects.toThrow("provider/model")
    expect(calls).toBe(0)
  })

  test("explicit endpoints bypass ID checks; catalog retention makes no request and null clears headers", async () => {
    expect(cloudflareGatewayBaseUrl(AIG_URL, {})).toBe(AIG_URL)
    expect(() => cloudflareGatewayBaseUrl("", {})).toThrow("CLOUDFLARE_ACCOUNT_ID")
    expect(cloudflareGatewayBaseUrl("", { accountId: "a", gatewayId: "g" })).toBe("https://gateway.ai.cloudflare.com/v1/a/g/compat")
    expect(await fetchProviderModels({ provider: aigResolved(), fetch: async () => { throw new Error("no network") } })).toEqual(AIG_MODELS)
    const headers = cloudflareGatewayHeaders({ "cf-aig-cache-key": "legacy", "cf-aig-cache-ttl": "15", "cf-aig-metadata": "legacy", "cf-aig-collect-log": "true" }, AIG_TOKEN, { metadata: null, cacheKey: null, cacheTtl: null, collectLog: false })
    for (const name of ["cf-aig-cache-key", "cf-aig-cache-ttl", "cf-aig-metadata"]) expect(headers.get(name)).toBeNull()
    expect(headers.get("cf-aig-collect-log")).toBe("false")
  })

  test("scrubs tokens and private metadata while retaining retry classification and abort", async () => {
    for (const status of [401, 429, 503]) {
      const privateValue = "private-project-fixture"
      const adapter = createApiProvider({ provider: aigResolved({ cloudflareAiGateway: { metadata: { project: privateValue } } }), fetch: async () => new Response(`${AIG_TOKEN} ${privateValue}`, { status, headers: { "retry-after": "1" } }) })
      try { await collectAig(adapter.stream(aigRequest())); throw new Error("expected rejection") } catch (error) {
        expect(error instanceof RetryableProviderError).toBe(status !== 401)
        expect(String(error)).not.toContain(AIG_TOKEN)
        expect(String(error)).not.toContain(privateValue)
      }
    }
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const events = await collectAig(createApiProvider({ provider: aigResolved(), fetch: async () => { calls++; return aigDone() } }).stream(aigRequest({ signal: controller.signal })))
    expect(events).toEqual([])
    expect(calls).toBe(0)
    const abort = new AbortController()
    const adapter = createApiProvider({ provider: aigResolved(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      abort.abort()
    }) })
    expect(await collectAig(adapter.stream(aigRequest({ signal: abort.signal })))).toEqual([])
  })
})
