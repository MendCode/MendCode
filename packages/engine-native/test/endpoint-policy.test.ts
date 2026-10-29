import { afterEach, describe, expect, test } from "bun:test"
import {
  PROVIDER_PRESETS,
  alibabaUrl, awsEndpoint, azureBaseUrl, cerebrasUrl, cloudflareGatewayBaseUrl, cloudflareGatewayUrl, cloudflareWorkersBaseUrl, cloudflareWorkersUrl,
  cohereUrl, copilotUrl, createApiProvider, deepinfraBaseUrl, geminiUrl, gitlabUrl, isLoopbackHostname, kiloUrl, llmgatewayUrl, mistralBaseUrl, nvidiaUrl,
  outboundEndpoint, perplexityUrl, sapAiUrl, togetheraiUrl, vertexEndpoint, xaiBaseUrl, zenUrl, zenmuxUrl,
  type Fetch, type ModelEvent, type ResolvedProvider,
} from "../src"

/** The one outbound policy every provider validator applies: HTTPS anywhere, HTTP only on literal loopback, no URL credentials, query or fragment. */
const VALIDATORS: Record<string, (value: string) => unknown> = {
  outbound: (value) => outboundEndpoint(value, "Fixture"),
  alibaba: alibabaUrl, aws: awsEndpoint, azure: azureBaseUrl, cerebras: cerebrasUrl, cloudflareGateway: cloudflareGatewayUrl, cloudflareWorkers: cloudflareWorkersUrl,
  cohere: cohereUrl, copilot: copilotUrl, deepinfra: (value) => deepinfraBaseUrl(value), gemini: geminiUrl, gitlab: gitlabUrl, kilo: kiloUrl, llmgateway: llmgatewayUrl,
  mistral: mistralBaseUrl, nvidia: nvidiaUrl, perplexity: perplexityUrl, sapAi: sapAiUrl, togetherai: togetheraiUrl, vertex: vertexEndpoint, xai: xaiBaseUrl,
  zen: zenUrl, zenmux: zenmuxUrl,
}

describe("outbound endpoint policy", () => {
  for (const [name, validate] of Object.entries(VALIDATORS)) {
    test(`${name}: HTTPS to a public host is allowed`, () => {
      expect(() => validate("https://api.example.com/v1")).not.toThrow()
    })
    test(`${name}: plain HTTP to a public host is rejected`, () => {
      for (const url of ["http://api.example.com/v1", "http://192.168.1.10/v1", "http://127.0.0.1.evil.test/v1", "http://localhost.evil.test/v1", "http://10.0.0.1/v1"]) expect(() => validate(url)).toThrow()
    })
    test(`${name}: plain HTTP to a literal loopback host is allowed`, () => {
      for (const url of ["http://127.0.0.1:1234/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1"]) expect(() => validate(url)).not.toThrow()
    })
    test(`${name}: credentials, query, fragment and other schemes are rejected even over HTTPS`, () => {
      for (const url of ["https://user:key@api.example.com/v1", "https://api.example.com/v1?key=x", "https://api.example.com/v1#x", "ftp://api.example.com/v1", "file:///tmp/proxy", "not a url"]) expect(() => validate(url)).toThrow()
    })
  }

  test("loopback means the three literal hosts only", () => {
    for (const host of ["127.0.0.1", "[::1]", "localhost"]) expect(isLoopbackHostname(host)).toBe(true)
    for (const host of ["127.0.0.2", "0.0.0.0", "example.com", "localhost.example.com", "::1"]) expect(isLoopbackHostname(host)).toBe(false)
  })

  test("account-specific Cloudflare routes are built over HTTPS from the user's IDs and never invented", () => {
    expect(() => cloudflareWorkersBaseUrl("")).toThrow("CLOUDFLARE_ACCOUNT_ID")
    expect(cloudflareWorkersBaseUrl("", "acct")).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1")
    expect(() => cloudflareGatewayBaseUrl("", {})).toThrow("CLOUDFLARE_ACCOUNT_ID")
    expect(cloudflareGatewayBaseUrl("", { accountId: "acct", gatewayId: "gw" })).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/compat")
  })
})

const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "m", signal: new AbortController().signal }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const resolved = (id: string, over: Partial<ResolvedProvider> = {}): ResolvedProvider => {
  const preset = PROVIDER_PRESETS[id]!
  return {
    id, type: preset.type, baseUrl: preset.baseUrl, apiKey: () => "fixture-key-0123456789", keyRequired: true, models: [{ id: "m", images: false }],
    ...(id === "deepinfra" ? { deepinfra: true } : id === "cerebras" ? { cerebras: true } : id === "togetherai" ? { togetherai: true } : {}),
    ...over,
  }
}
/** Chat-Completions presets that reach a public HTTPS host by default (no account-specific URL part). */
const CHAT_PRESETS = ["deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "zenmux", "cerebras", "togetherai", "kilo"] as const

describe("public default endpoints", () => {
  for (const id of CHAT_PRESETS) {
    test(`${id}: requests go to the preset's HTTPS endpoint with a Bearer key, redirects refused, and no key means no request`, async () => {
      const base = PROVIDER_PRESETS[id]!.baseUrl
      expect(base.startsWith("https://")).toBe(true)
      const calls: Array<{ url: string; init: RequestInit }> = []
      const fake: Fetch = async (url, init) => { calls.push({ url, init }); return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }) }
      await collect(createApiProvider({ provider: resolved(id), fetch: fake }).stream({ ...request, fetch: fake } as typeof request)).catch(() => undefined)
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]!.url.startsWith(`${base}/`)).toBe(true)
      expect(calls[0]!.init.redirect).toBe("error")
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer fixture-key-0123456789")
      const before = calls.length
      await expect(collect(createApiProvider({ provider: resolved(id, { apiKey: () => undefined }), fetch: fake }).stream(request))).rejects.toThrow()
      expect(calls.length).toBe(before)
    })
  }
})

describe("credentials stay out of errors on public hosts", () => {
  for (const id of CHAT_PRESETS) {
    test(`${id}: a provider error that echoes the key is redacted`, async () => {
      const fake: Fetch = async () => new Response(`rejected fixture-key-0123456789 for ${PROVIDER_PRESETS[id]!.baseUrl}`, { status: 401 })
      const error = await collect(createApiProvider({ provider: resolved(id), fetch: fake }).stream(request)).catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain("fixture-key-0123456789")
    })
  }
})

describe("redirects are refused against a local fake server", () => {
  const servers: Array<{ stop(force?: boolean): void }> = []
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
  for (const id of CHAT_PRESETS) {
    test(`${id}: a 302 to a public HTTPS host is not followed`, async () => {
      const seen: string[] = []
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { seen.push(new URL(req.url).pathname); return new Response(null, { status: 302, headers: { location: "https://redirect-target.invalid/steal" } }) } })
      servers.push(server)
      const provider = resolved(id, { baseUrl: `http://127.0.0.1:${server.port}/v1` })
      await expect(collect(createApiProvider({ provider }).stream(request))).rejects.toThrow()
      expect(seen.length).toBe(1)
      expect(seen.every((path) => path.startsWith("/v1"))).toBe(true)
    })
  }
})
