import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { ProviderConfig, ProviderType, type ModelsReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "mistral-daemon-fixture-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-07-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const collect = async (stream: AsyncIterable<ModelEvent>) => {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
const fake: Fetch = async (url, init) => {
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  expect(init.redirect).toBe("error")
  return init.method === "GET"
    ? Response.json({ data: [{ id: "mistral-small-latest", max_context_length: 131_072, capabilities: { completion_chat: true, vision: true } }, { id: "mistral-embed", capabilities: { completion_chat: false } }] })
    : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
}

describe("B10.07 Mistral daemon and protocol", () => {
  test("wire and settings accept additive native Mistral without changing compatible providers", () => {
    expect(ProviderType.parse("mistral")).toBe("mistral")
    expect(ProviderConfig.parse({ type: "mistral", apiKeyEnv: "MISTRAL_API_KEY", parameters: { safePrompt: true } })).toMatchObject({ type: "mistral" })
    expect(ProviderType.parse("openai-compatible")).toBe("openai-compatible")
  })

  test("env credentials alone stay off; testing and refresh are opt-in and live disabling persists", async () => {
    let calls = 0
    const dir = temp()
    const providers = createProviderService({ dir, env: { MISTRAL_API_KEY: KEY }, fetch: async (url, init) => {
      calls++
      return fake(url, init)
    } })
    expect(providers.list().find((provider) => provider.id === "mistral")).toMatchObject({ type: "mistral", hasKey: true, enabled: false, source: "env" })
    expect(providers.models()).toEqual([])
    expect(await providers.test("mistral")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
    expect(await providers.refresh("mistral")).toMatchObject({ ok: false, message: expect.stringContaining("disabled") })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not use fallback") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "mistral:mistral-small-latest", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "mistral", apiKeyEnv: "MISTRAL_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "mistral", baseUrl: "http://127.0.0.1:1234/v1", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models().find((model) => model.id === "mistral:mistral-small-latest")).toMatchObject({ efforts: ["high"], variants: { high: { effort: "high", parameters: { reasoningEffort: "high" } } } })
    expect(providers.models().find((model) => model.id === "mistral:devstral-latest")?.efforts).toEqual([])
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    providers.set({ id: "mistral", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(createProviderService({ dir, env: { MISTRAL_API_KEY: KEY } }).list().find((provider) => provider.id === "mistral")?.enabled).toBe(false)
    expect(calls).toBe(1)
  })

  test("API-key auth is offline, public status is masked and logout keeps environment references", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("mistral")).toEqual({ mistral: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("mistral")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "mistral", apiKey: KEY, apiKeyEnv: "TEAM_MISTRAL_KEY", enabled: true })
    expect(auth.status("mistral")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(true), providers.inventory!({ readOnly: true }), auth.status("mistral")])).not.toContain(KEY)
    expect(providers.logout!("mistral")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.mistral).toEqual({ enabled: true, apiKeyEnv: "TEAM_MISTRAL_KEY" })
  })

  test("legacy SDK config resolves natively with options/files, no SDK install and clearable private key", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { mistral: { npm: "@ai-sdk/mistral", options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: KEY, safePrompt: true, documentPageLimit: 2 }, models: [{ id: "mistral-small-latest" }] } } }))
    let body: any
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => {
      body = JSON.parse(String(init.body))
      return fake(url, init)
    } })
    expect(providers.list()[0]).toMatchObject({ type: "mistral", enabled: false, hasKey: true })
    expect(providers.inventory!().find((provider) => provider.id === "mistral")).toMatchObject({ credentialStored: true })
    expect(providers.set({ id: "mistral", enabled: true })).toMatchObject({ ok: true })
    expect(await providers.test("mistral")).toMatchObject({ ok: true })
    expect(body).toMatchObject({ safe_prompt: true, document_page_limit: 2 })
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(JSON.stringify(providers.list())).not.toContain(KEY)
    expect(providers.logout!("mistral")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    expect(await providers.test("mistral")).toMatchObject({ ok: false, error: expect.stringContaining("no API key") })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { mistral: { npm: "@ai-sdk/mistral", options: { apiKey: KEY, safePrompt: true } } } }))
    const legacy = createProviderService({ dir, env: {} })
    expect(legacy.set({ id: "mistral", apiKey: "" })).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.mistral.options).toEqual({ safePrompt: true })
  })

  test("custom namespaces require credentials, secure endpoint and explicit enablement", async () => {
    let calls = 0
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => {
      calls++
      return fake(url, init)
    } })
    expect(providers.set({ id: "team", providerType: "mistral", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "mistral-small-latest" }] })).toMatchObject({ ok: true, provider: { enabled: false, hasKey: false } })
    providers.set({ id: "team", enabled: true })
    expect(await providers.test("team")).toMatchObject({ ok: false, error: expect.stringContaining("no API key") })
    expect(await providers.refresh("team")).toMatchObject({ ok: false })
    expect(providers.models()).toEqual([])
    expect(calls).toBe(0)
    for (const baseUrl of ["http://remote.example/v1", "https://user:key@example.test/v1", "https://api.mistral.ai/v1?key=secret", "https://api.mistral.ai/v1#secret"]) expect(providers.set({ id: "team", baseUrl })).toMatchObject({ ok: false })
    expect(providers.set({ id: "mistral", providerType: "openai-compatible" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { type: "mistral", baseUrl: "http://remote.example/v1", apiKey: KEY, enabled: true } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("must not call unsafe endpoint") } })
    expect(unsafe.list()[0]).toMatchObject({ enabled: false, baseUrl: "", error: expect.stringContaining("HTTPS") })
    expect(await unsafe.test("team")).toMatchObject({ ok: false })
    expect(await unsafe.refresh("team")).toMatchObject({ ok: false })
    const legacyDir = temp()
    writeFileSync(path.join(legacyDir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/mistral", models: [{ id: "devstral-latest" }] } } }))
    const legacy = createProviderService({ dir: legacyDir, env: { MISTRAL_API_KEY: KEY }, fetch: async () => { throw new Error("must remain off") } })
    expect(legacy.list().find((provider) => provider.id === "team")).toMatchObject({ type: "mistral", enabled: false, hasKey: true, baseUrl: "https://api.mistral.ai/v1" })
    expect(await legacy.test("team")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
  })

  test("refresh preserves configured metadata/options/variants and leaves the saved catalog intact on failure", async () => {
    const dir = temp()
    let failed = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => failed ? new Response(`rejected ${KEY}`, { status: 500 }) : fake(url, init) })
    providers.set({ id: "mistral", baseUrl: "http://127.0.0.1:1234/v1", apiKey: KEY, enabled: true, models: [{ id: "mistral-small-latest", options: { safePrompt: false }, cost: { input: 0.3, output: 0.5 }, outputLimit: 128, variants: { high: { effort: "high", parameters: { reasoningEffort: "high" } } } }] })
    expect(await providers.refresh("mistral")).toMatchObject({ ok: true, provider: { models: [{ context: 131_072, images: true, options: { safePrompt: false }, outputLimit: 128, cost: { input: 0.3, output: 0.5 }, variants: { high: { effort: "high" } } }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    failed = true
    const result = await providers.refresh("mistral")
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon/client configure, auth, test, refresh, namespacing and high variant selection", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "mistral:mistral-small-latest" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-07" })
    cleanup.push(() => client.close())
    await client.connect()
    const disabled = await client.configureMistral({ baseUrl: "http://127.0.0.1:1234/v1", apiKey: KEY })
    expect(disabled).toMatchObject({ ok: true, provider: { type: "mistral", enabled: false } })
    expect(await client.providerAuthMethods("mistral")).toMatchObject({ ok: true, methods: { mistral: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("mistral")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureMistral({ enabled: true, parameters: { safePrompt: true } })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "mistral" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "providers.refresh", provider: "mistral" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: "mistral-small-latest" }] } } })
    expect(await client.configureMistral({ provider: "team", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "TEAM_KEY" })).toMatchObject({ ok: true, provider: { id: "team", type: "mistral", enabled: false } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "mistral:mistral-small-latest", variant: "high" } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: "mistral:mistral-small-latest", variant: "high", effort: "high", parameters: { reasoningEffort: "high" } })
    expect(JSON.stringify([disabled, selected, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
