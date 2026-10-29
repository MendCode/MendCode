import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PROVIDER_PRESETS } from "@mendcode/engine-native"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-endpoints-")); dirs.push(dir); return dir }
const KEY = "endpoint-fixture-key-0123456789"

/** Providers that reach one public HTTPS endpoint by default and authenticate with a plain API key. */
const PUBLIC_DEFAULTS: Array<[id: string, baseUrl: string, keyEnv: string]> = [
  ["google", "https://generativelanguage.googleapis.com/v1beta", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ["xai", "https://api.x.ai/v1", "XAI_API_KEY"],
  ["mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY"],
  ["deepinfra", "https://api.deepinfra.com/v1/openai", "DEEPINFRA_API_KEY"],
  ["perplexity", "https://api.perplexity.ai", "PERPLEXITY_API_KEY"],
  ["alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "DASHSCOPE_API_KEY"],
  ["opencode", "https://opencode.ai/zen/v1", "OPENCODE_API_KEY"],
  ["llmgateway", "https://api.llmgateway.io/v1", "LLMGATEWAY_API_KEY"],
  ["nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY"],
  ["zenmux", "https://zenmux.ai/api/v1", "ZENMUX_API_KEY"],
  ["cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"],
  ["cohere", "https://api.cohere.com/v2", "COHERE_API_KEY"],
  ["togetherai", "https://api.together.ai/v1", "TOGETHER_API_KEY"],
  ["kilo", "https://api.kilo.ai/api/gateway", "KILO_API_KEY"],
]

describe("provider default endpoints", () => {
  for (const [id, baseUrl, keyEnv] of PUBLIC_DEFAULTS) {
    test(`${id}: default ${baseUrl}, off until connected, and enabling needs a credential`, () => {
      expect(PROVIDER_PRESETS[id]).toMatchObject({ baseUrl, keyEnv, defaultEnabled: false })
      const keyless = createProviderService({ dir: temp(), env: {} })
      expect(keyless.catalog!().find((provider) => provider.id === id)).toMatchObject({ baseUrl, enabled: false, hasKey: false })
      expect(keyless.set({ id, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
      expect(keyless.set({ id, enabled: true, apiKey: "" })).toMatchObject({ ok: false })

      const dir = temp()
      const withEnv = createProviderService({ dir, env: { [keyEnv]: KEY } })
      const listed = withEnv.catalog!().find((provider) => provider.id === id)!
      expect(listed).toMatchObject({ baseUrl, enabled: false, hasKey: true, source: "env" })
      expect(listed.error).toBeUndefined()
      expect(withEnv.set({ id, enabled: true })).toMatchObject({ ok: true, provider: { baseUrl, enabled: true } })
    })

    test(`${id}: a stored plain-HTTP public override is refused, loopback HTTP is kept, and the key never reaches providers.json from the environment`, () => {
      const dir = temp()
      const providers = createProviderService({ dir, env: { [keyEnv]: KEY } })
      expect(providers.set({ id, baseUrl: `http://public.example/v1`, enabled: true })).toMatchObject({ ok: false })
      expect(providers.set({ id, baseUrl: "http://127.0.0.1:1234/v1", enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "http://127.0.0.1:1234/v1", enabled: true } })
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    })
  }
})

describe("providers whose endpoint needs a user-supplied value", () => {
  test("azure, sap-ai-core and gitlab ship no default URL and cannot be enabled without one", () => {
    for (const id of ["azure", "sap-ai-core", "gitlab"]) expect(PROVIDER_PRESETS[id]).toMatchObject({ baseUrl: "", defaultEnabled: false })
    const providers = createProviderService({ dir: temp(), env: { AZURE_API_KEY: KEY, GITLAB_TOKEN: KEY } })
    expect(providers.catalog!().find((provider) => provider.id === "azure")).toMatchObject({ baseUrl: "", enabled: false })
    expect(providers.catalog!().find((provider) => provider.id === "gitlab")).toMatchObject({ baseUrl: "", enabled: false })
    expect(providers.set({ id: "gitlab", enabled: true })).toMatchObject({ ok: false })
    expect(providers.set({ id: "gitlab", baseUrl: "http://gitlab.example.com", apiKey: KEY, enabled: true })).toMatchObject({ ok: false })
    expect(providers.set({ id: "gitlab", baseUrl: "https://gitlab.example.com", apiKey: KEY, enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "https://gitlab.example.com", enabled: true } })
    expect(providers.set({ id: "azure", baseUrl: "http://my-resource.openai.azure.com/openai", apiKey: KEY })).toMatchObject({ ok: false })
    expect(providers.set({ id: "azure", baseUrl: "https://my-resource.openai.azure.com/openai", apiKey: KEY, enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "https://my-resource.openai.azure.com/openai" } })
  })

  test("cloudflare routes are built from the user's IDs over HTTPS, need a token, and refuse plain-HTTP public overrides", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" }
    const keyless = createProviderService({ dir: temp(), env })
    for (const id of ["cloudflare-workers-ai", "cloudflare-ai-gateway"]) {
      expect(PROVIDER_PRESETS[id]).toMatchObject({ baseUrl: "", defaultEnabled: false })
      expect(keyless.set({ id, enabled: true })).toMatchObject({ ok: false, message: expect.stringMatching(/token/i) })
    }
    const workers = createProviderService({ dir: temp(), env: { ...env, CLOUDFLARE_API_KEY: KEY } })
    expect(workers.set({ id: "cloudflare-workers-ai", enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1", enabled: true } })
    expect(workers.set({ id: "cloudflare-workers-ai", baseUrl: "http://api.cloudflare.com/client/v4/accounts/acct/ai/v1" })).toMatchObject({ ok: false })
    const gateway = createProviderService({ dir: temp(), env: { ...env, CLOUDFLARE_API_TOKEN: KEY } })
    expect(gateway.set({ id: "cloudflare-ai-gateway", enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat", enabled: true } })
    expect(gateway.set({ id: "cloudflare-ai-gateway", baseUrl: "http://gateway.ai.cloudflare.com/v1/acct/gw/compat" })).toMatchObject({ ok: false })
  })

  test("SAP AI Core takes its API root from the service key and refuses plain-HTTP public service URLs", () => {
    const key = (url: string, api: string) => JSON.stringify({ clientid: "id", clientsecret: "secret", url, serviceurls: { AI_API_URL: api } })
    const providers = createProviderService({ dir: temp(), env: {} })
    expect(providers.set({ id: "sap-ai-core", apiKey: key("http://tenant.example.com", "https://api.ai.example.com"), enabled: true })).toMatchObject({ ok: false })
    expect(providers.set({ id: "sap-ai-core", apiKey: key("https://tenant.example.com", "http://api.ai.example.com"), enabled: true })).toMatchObject({ ok: false })
    expect(providers.set({ id: "sap-ai-core", apiKey: key("https://tenant.example.com", "https://api.ai.example.com"), enabled: true })).toMatchObject({ ok: true, provider: { baseUrl: "https://api.ai.example.com/v2", enabled: true } })
  })

  test("bedrock and vertex keep their regional HTTPS defaults, stay off, and refuse plain-HTTP public overrides", () => {
    expect(PROVIDER_PRESETS["amazon-bedrock"]!.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com")
    expect(PROVIDER_PRESETS["google-vertex"]!.baseUrl).toBe("https://us-central1-aiplatform.googleapis.com/v1")
    expect(PROVIDER_PRESETS["google-vertex-anthropic"]!.baseUrl).toBe("https://aiplatform.googleapis.com/v1")
    const providers = createProviderService({ dir: temp(), env: {} })
    for (const id of ["amazon-bedrock", "google-vertex", "google-vertex-anthropic"]) {
      expect(providers.catalog!().find((provider) => provider.id === id)).toMatchObject({ enabled: false })
      expect(providers.set({ id, baseUrl: "http://public.example/v1" })).toMatchObject({ ok: false })
    }
  })

  test("GitHub Copilot defaults to its HTTPS API, stays off, and needs a token", () => {
    expect(PROVIDER_PRESETS["github-copilot"]).toMatchObject({ baseUrl: "https://api.githubcopilot.com", defaultEnabled: false })
    const providers = createProviderService({ dir: temp(), env: {} })
    expect(providers.catalog!().find((provider) => provider.id === "github-copilot")).toMatchObject({ baseUrl: "https://api.githubcopilot.com", enabled: false, hasKey: false })
    expect(providers.set({ id: "github-copilot", baseUrl: "http://api.githubcopilot.com" })).toMatchObject({ ok: false })
  })
})
