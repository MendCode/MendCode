import { describe, expect, test } from "bun:test"
import { connectFields, createConnectState, validateConnect } from "../src/view/connect-page"
import { isOutboundEndpoint, presetOf } from "../src/view/provider-presets"

const KEY = "cli-endpoint-fixture-key-0123456789"
const form = (id: string, values: Record<string, string>, viaEnv = false) => {
  const state = createConnectState(id)
  return { ...state, viaEnv, values: { ...state.values, ...values } }
}

/** [id, default endpoint, key variable]: presets whose form takes an optional endpoint override and a Bearer key. */
const PUBLIC_DEFAULTS: Array<[string, string, string]> = [
  ["deepinfra", "https://api.deepinfra.com/v1/openai", "DEEPINFRA_API_KEY"],
  ["cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"],
  ["cohere", "https://api.cohere.com/v2", "COHERE_API_KEY"],
  ["togetherai", "https://api.together.ai/v1", "TOGETHER_API_KEY"],
  ["perplexity", "https://api.perplexity.ai", "PERPLEXITY_API_KEY"],
  ["alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "DASHSCOPE_API_KEY"],
  ["opencode", "https://opencode.ai/zen/v1", "OPENCODE_API_KEY"],
  ["llmgateway", "https://api.llmgateway.io/v1", "LLMGATEWAY_API_KEY"],
  ["nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"],
  ["zenmux", "https://zenmux.ai/api/v1", "ZENMUX_API_KEY"],
  ["kilo", "https://api.kilo.ai/api/gateway", "KILO_API_KEY"],
]

describe("connect form endpoint policy", () => {
  test("isOutboundEndpoint: HTTPS anywhere, HTTP only on literal loopback, no credentials, query or fragment", () => {
    for (const url of ["https://api.example.com/v1", "http://127.0.0.1:1234/v1", "http://localhost:1/v1", "http://[::1]:1/v1"]) expect(isOutboundEndpoint(url)).toBe(true)
    for (const url of ["http://api.example.com/v1", "http://127.0.0.1.evil.test/v1", "http://192.168.0.2/v1", "https://u:p@api.example.com", "https://api.example.com/v1?k=x", "https://api.example.com/v1#x", "ftp://api.example.com", "nope", ""]) expect(isOutboundEndpoint(url)).toBe(false)
  })

  for (const [id, baseUrl, keyEnv] of PUBLIC_DEFAULTS) {
    test(`${id}: endpoint is an optional override of ${baseUrl}; a credential is required`, () => {
      expect(presetOf(id)!.baseUrl).toBe(baseUrl)
      expect(connectFields(id, false)[0]).toMatchObject({ id: "baseUrl", label: "Endpoint", placeholder: baseUrl })
      // Blank endpoint uses the daemon's preset: nothing is sent for baseUrl.
      expect(validateConnect(form(id, { key: KEY }))).toEqual({ ok: true, submit: { provider: id, apiKey: KEY, enabled: true } })
      expect(validateConnect(form(id, {}, true))).toEqual({ ok: true, submit: { provider: id, apiKeyEnv: keyEnv, enabled: true } })
      expect(validateConnect(form(id, {}))).toMatchObject({ ok: false, error: expect.stringContaining("API key") })
      // Overrides follow the shared policy.
      expect(validateConnect(form(id, { baseUrl: "https://gateway.example.com/v1", key: KEY }))).toMatchObject({ ok: true, submit: { baseUrl: "https://gateway.example.com/v1" } })
      expect(validateConnect(form(id, { baseUrl: "http://127.0.0.1:9/v1", key: KEY }))).toMatchObject({ ok: true })
      for (const bad of ["http://gateway.example.com/v1", "https://u:p@gateway.example.com/v1", "https://gateway.example.com/v1?k=x"]) expect(validateConnect(form(id, { baseUrl: bad, key: KEY }))).toMatchObject({ ok: false, focus: 0 })
    })
  }

  test("GitLab requires the user's instance URL over HTTPS (no default) and a token", () => {
    expect(presetOf("gitlab")!.baseUrl).toBe("")
    expect(validateConnect(form("gitlab", { key: KEY }))).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect(form("gitlab", { baseUrl: "http://gitlab.example.com", key: KEY }))).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect(form("gitlab", { baseUrl: "https://gitlab.example.com" }))).toMatchObject({ ok: false, error: expect.stringContaining("token") })
    expect(validateConnect(form("gitlab", { baseUrl: "https://gitlab.example.com", key: KEY }))).toMatchObject({ ok: true, submit: { provider: "gitlab", baseUrl: "https://gitlab.example.com", apiKey: KEY } })
  })

  test("Cloudflare Workers AI and AI Gateway route through the user's IDs, or a full HTTPS endpoint, and need a token", () => {
    expect(validateConnect(form("cloudflare-workers-ai", { key: KEY }))).toMatchObject({ ok: false, error: expect.stringContaining("account ID") })
    expect(validateConnect(form("cloudflare-workers-ai", { cloudflareAccountId: "acct" }))).toMatchObject({ ok: false, error: expect.stringContaining("Bearer token") })
    expect(validateConnect(form("cloudflare-workers-ai", { cloudflareAccountId: "acct", key: KEY }))).toMatchObject({ ok: true, submit: { provider: "cloudflare-workers-ai", apiKey: KEY } })
    expect(validateConnect(form("cloudflare-workers-ai", { baseUrl: "http://api.cloudflare.com/x", key: KEY }))).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect(form("cloudflare-workers-ai", { baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1", key: KEY }))).toMatchObject({ ok: true })
    const models = "openai/gpt-fixture"
    expect(validateConnect(form("cloudflare-ai-gateway", { key: KEY, models }))).toMatchObject({ ok: false, error: expect.stringContaining("account") })
    expect(validateConnect(form("cloudflare-ai-gateway", { cloudflareAccountId: "acct", key: KEY, models }))).toMatchObject({ ok: false, error: expect.stringContaining("gateway") })
    expect(validateConnect(form("cloudflare-ai-gateway", { cloudflareAccountId: "acct", cloudflareGatewayId: "gw", models }))).toMatchObject({ ok: false, error: expect.stringContaining("gateway token") })
    expect(validateConnect(form("cloudflare-ai-gateway", { cloudflareAccountId: "acct", cloudflareGatewayId: "gw", key: KEY, models }))).toMatchObject({ ok: true, submit: { provider: "cloudflare-ai-gateway", apiKey: KEY } })
    expect(validateConnect(form("cloudflare-ai-gateway", { baseUrl: "http://gateway.ai.cloudflare.com/v1/a/g/compat", key: KEY, models }))).toMatchObject({ ok: false, focus: 0 })
  })

  test("SAP AI Core takes its API root from the service key; every URL must be HTTPS or loopback HTTP", () => {
    const key = (url: string, api: string) => JSON.stringify({ clientid: "id", clientsecret: "secret", url, serviceurls: { AI_API_URL: api } })
    expect(validateConnect(form("sap-ai-core", { key: key("https://tenant.example.com", "https://api.ai.example.com") }))).toMatchObject({ ok: true, submit: { provider: "sap-ai-core" } })
    expect(validateConnect(form("sap-ai-core", { key: key("http://tenant.example.com", "https://api.ai.example.com") }))).toMatchObject({ ok: false, focus: 1 })
    expect(validateConnect(form("sap-ai-core", { key: key("https://tenant.example.com", "http://api.ai.example.com") }))).toMatchObject({ ok: false, focus: 1 })
    expect(validateConnect(form("sap-ai-core", { baseUrl: "http://api.ai.example.com/v2", key: key("https://tenant.example.com", "https://api.ai.example.com") }))).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect(form("sap-ai-core", { key: "" }))).toMatchObject({ ok: false, focus: 1 })
  })

  test("Azure, Bedrock and Vertex refuse plain-HTTP public endpoints; Azure still takes a bare resource name", () => {
    expect(validateConnect(form("azure", { baseUrl: "my-resource", models: "dep", key: KEY }))).toMatchObject({ ok: true, submit: { baseUrl: "https://my-resource.openai.azure.com/openai" } })
    expect(validateConnect(form("azure", { baseUrl: "http://my-resource.openai.azure.com/openai", models: "dep", key: KEY }))).toMatchObject({ ok: false })
    expect(validateConnect(form("amazon-bedrock", { baseUrl: "http://bedrock-runtime.us-east-1.amazonaws.com" }))).toMatchObject({ ok: false })
    expect(validateConnect(form("amazon-bedrock", { baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" }))).toMatchObject({ ok: true })
    expect(validateConnect(form("google-vertex", { baseUrl: "http://us-central1-aiplatform.googleapis.com/v1" }))).toMatchObject({ ok: false })
    expect(validateConnect(form("google-vertex", { baseUrl: "https://us-central1-aiplatform.googleapis.com/v1" }))).toMatchObject({ ok: true })
  })
})
