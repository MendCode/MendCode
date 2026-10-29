import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, type Fetch, type ModelEvent, type ResolvedProvider } from "../src"
import { GATEWAY_PRESETS, gatewayUrl } from "../src/gateway-presets"
import { PROVIDER_PRESETS } from "../src/provider-presets"

const KEY = "gateway-fixture-key-0123456789"
const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "m", signal: new AbortController().signal }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const done = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
const resolved = (id: string, over: Partial<ResolvedProvider> = {}): ResolvedProvider => {
  const preset = PROVIDER_PRESETS[id]!
  return { id, type: preset.type, baseUrl: preset.baseUrl || "https://resource.example.com/openai/v1", apiKey: () => (preset.keyless ? undefined : KEY), keyRequired: !preset.keyless, models: [{ id: "m", images: false }], ...over }
}
const hosted = Object.keys(GATEWAY_PRESETS).filter((id) => !GATEWAY_PRESETS[id]!.keyless)

describe("gateway presets", () => {
  test("every gateway id is an opt-in preset and the two tables agree", () => {
    for (const [id, gateway] of Object.entries(GATEWAY_PRESETS)) {
      const preset = PROVIDER_PRESETS[id]!
      expect(preset.name).toBe(gateway.label)
      expect(preset).toMatchObject({ type: "openai-compatible", defaultEnabled: false, models: [] })
      expect(preset.keyEnv).toBe(gateway.keyEnv)
      expect(Boolean(preset.keyless)).toBe(Boolean(gateway.keyless))
      if (preset.baseUrl) expect(preset.baseUrl.startsWith(gateway.keyless ? "http://127.0.0.1" : "https://")).toBe(true)
    }
    // A shared variable would enable two providers from one key.
    const envs = Object.values(PROVIDER_PRESETS).map((preset) => preset.keyEnv).filter(Boolean)
    expect(new Set(envs).size).toBe(envs.length)
  })

  for (const id of hosted) {
    test(`${id}: Bearer key to its endpoint, redirects refused, stale Authorization replaced, no key means no request`, async () => {
      const calls: Array<{ url: string; init: RequestInit }> = []
      const fake: Fetch = async (url, init) => { calls.push({ url, init }); return done() }
      const provider = resolved(id, { headers: { Authorization: "Bearer stale" } })
      const events = await collect(createApiProvider({ provider, fetch: fake }).stream({ ...request, fetch: fake } as typeof request))
      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
      expect(calls[0]!.url.startsWith(`${provider.baseUrl}/`)).toBe(true)
      expect(calls[0]!.init.redirect).toBe("error")
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      const before = calls.length
      await expect(collect(createApiProvider({ provider: resolved(id, { apiKey: () => undefined }), fetch: fake }).stream(request))).rejects.toThrow("no API key")
      expect(calls.length).toBe(before)
    })

    test(`${id}: plain-HTTP public hosts and URL capabilities fail before any request; errors never echo the key`, async () => {
      let calls = 0
      const fake: Fetch = async () => { calls++; return done() }
      for (const baseUrl of ["http://api.example.com/v1", "http://127.0.0.1.evil.test/v1", "http://u:p@localhost/v1", "https://host.example/v1?token=x", "https://host.example/v1#x", ""]) {
        await expect(collect(createApiProvider({ provider: resolved(id, { baseUrl }), fetch: fake }).stream(request))).rejects.toThrow("endpoint")
        await expect(fetchProviderModels({ provider: resolved(id, { baseUrl }), fetch: fake })).rejects.toThrow("endpoint")
      }
      expect(calls).toBe(0)
      const leaky: Fetch = async () => new Response(`rejected ${KEY}`, { status: 401 })
      const error = await collect(createApiProvider({ provider: resolved(id), fetch: leaky }).stream(request)).catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(KEY)
    })

    test(`${id}: model refresh authenticates and keeps provider-owned ids`, async () => {
      const provider = resolved(id)
      const models = await fetchProviderModels({ provider, fetch: async (url, init) => {
        expect(url).toBe(`${provider.baseUrl}/models`)
        expect(init.redirect).toBe("error")
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
        return Response.json({ data: [{ id: "vendor/model-b" }, { id: "vendor/model-a" }] })
      } })
      expect(models.map((model) => model.id)).toEqual(["vendor/model-a", "vendor/model-b"])
      await expect(fetchProviderModels({ provider: resolved(id, { apiKey: () => undefined }), fetch: async () => { throw new Error("must not be called") } })).rejects.toThrow("no API key")
    })
  }

  test("atomic-chat: a local server works without a key, sends none, and still refuses public plain HTTP", async () => {
    const seen: Array<string | null> = []
    const fake: Fetch = async (_url, init) => { seen.push(new Headers(init.headers).get("authorization")); return done() }
    expect((await collect(createApiProvider({ provider: resolved("atomic-chat"), fetch: fake }).stream({ ...request, fetch: fake } as typeof request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(seen).toEqual([null])
    const keyed = resolved("atomic-chat", { apiKey: () => KEY })
    await collect(createApiProvider({ provider: keyed, fetch: fake }).stream({ ...request, fetch: fake } as typeof request))
    expect(seen.at(-1)).toBe(`Bearer ${KEY}`)
    await expect(collect(createApiProvider({ provider: resolved("atomic-chat", { baseUrl: "http://example.com/v1" }), fetch: fake }).stream(request))).rejects.toThrow("endpoint")
    expect(gatewayUrl("atomic-chat", "http://localhost:1337/v1").hostname).toBe("localhost")
  })

  test("foundry has no default endpoint: it must come from the user", () => {
    expect(PROVIDER_PRESETS.foundry!.baseUrl).toBe("")
    expect(() => gatewayUrl("foundry", "")).toThrow("Microsoft Foundry endpoint")
  })
})
