import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { ProviderId, type ModelsReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "deepinfra-daemon-private-fixture-0123456789"
const MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-08-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  expect(init.redirect).toBe("error")
  return init.method === "GET"
    ? Response.json({ data: [{ id: MODEL, context_length: 131_072 }] })
    : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, estimated_cost: 0.000002 } })}\n\ndata: [DONE]\n\n`)
}

describe("B10.08 DeepInfra daemon and existing protocol", () => {
  test("env keys alone stay off; requests and refresh are opt-in; disabling persists and never falls back", async () => {
    expect(ProviderId.parse("deepinfra")).toBe("deepinfra")
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { DEEPINFRA_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "deepinfra", type: "openai-compatible", enabled: false, hasKey: true, source: "env" })
    expect(providers.models()).toEqual([])
    expect(await providers.test("deepinfra")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
    expect(await providers.refresh("deepinfra")).toMatchObject({ ok: false })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not use fallback") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: `deepinfra:${MODEL}`, signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "deepinfra", apiKeyEnv: "DEEPINFRA_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai", enabled: true })
    expect(providers.models()[0]).toMatchObject({ id: `deepinfra:${MODEL}`, efforts: ["low", "medium", "high"], variants: { max: { parameters: { reasoning_effort: "max" } } } })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    providers.set({ id: "deepinfra", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(createProviderService({ dir, env: { DEEPINFRA_API_KEY: KEY } }).list()[0]?.enabled).toBe(false)
    expect(calls).toBe(1)
  })

  test("API-key methods/status/catalog are offline and private; logout keeps config and environment references", () => {
    const dir = temp(), env = { TEAM_KEY: KEY }
    const providers = createProviderService({ dir, env, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("deepinfra")).toEqual({ deepinfra: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("deepinfra")).toMatchObject({ callsProvider: false, executesNow: false, callback: "none", writesSecrets: false })
    providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai", apiKey: KEY, apiKeyEnv: "TEAM_KEY", enabled: true })
    expect(auth.status("deepinfra")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(true), providers.inventory!({ readOnly: true }), auth.status("deepinfra")])).not.toContain(KEY)
    expect(providers.logout!("deepinfra")).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.deepinfra).toEqual({ enabled: true, baseUrl: "http://127.0.0.1:1234/v1/openai", apiKeyEnv: "TEAM_KEY" })
  })

  test("legacy SDK settings resolve natively without importing the SDK or leaking its key into generation", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/deepinfra", options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: KEY, minP: 0.1 }, models: [{ id: MODEL, reasoning: true }] } } }))
    let body: any
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => { body = JSON.parse(String(init.body)); return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "team", type: "openai-compatible", enabled: false, hasKey: true, baseUrl: "http://127.0.0.1:1234/v1/openai" })
    providers.set({ id: "team", enabled: true })
    expect(await providers.test("team")).toMatchObject({ ok: true })
    expect(body.min_p).toBe(0.1)
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(providers.inventory!().find((entry) => entry.id === "team")).toMatchObject({ credentialStored: true })
    expect(providers.logout!("team")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    expect(await providers.test("team")).toMatchObject({ ok: false, error: expect.stringContaining("no API key") })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { deepinfra: { npm: "@ai-sdk/deepinfra", options: { apiKey: KEY, topK: 5 } } } }))
    expect(providers.set({ id: "deepinfra", apiKey: "" })).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.deepinfra.options).toEqual({ topK: 5 })
  })

  test("secure endpoints and preset type are enforced before saving or calling", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    expect(providers.set({ id: "deepinfra", enabled: true, baseUrl: "http://api.deepinfra.com/v1/openai" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai", enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
    providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai" })
    expect(await providers.test("deepinfra")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
    expect(providers.models()).toEqual([])
    for (const baseUrl of ["http://remote.test/v1", "http://api.deepinfra.com/v1/openai", "https://user:key@localhost/v1", "https://localhost/v1?key=x", "https://localhost/v1#x"]) expect(providers.set({ id: "deepinfra", baseUrl })).toMatchObject({ ok: false })
    expect(providers.set({ id: "deepinfra", providerType: "openai" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { deepinfra: { enabled: true, apiKey: KEY, baseUrl: "http://remote.test/v1" } } }))
    expect(providers.list()[0]).toMatchObject({ enabled: false, baseUrl: "", error: expect.stringContaining("loopback") })
    expect(await providers.refresh("deepinfra")).toMatchObject({ ok: false })
  })

  test("disabled local providers and legacy namespaces cannot test or refresh, and variants extend defaults", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai", apiKey: KEY, models: [{ id: MODEL, reasoning: true, variants: { high: { disabled: true }, precise: { parameters: { top_k: 4 } } } }] })).toMatchObject({ ok: true, provider: { enabled: false } })
    const saved = JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8"))
    saved.providers.team = { npm: "@ai-sdk/deepinfra", options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: KEY }, enabled: false, models: [{ id: MODEL }] }
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify(saved))
    for (const id of ["deepinfra", "team"]) {
      expect(await providers.test(id)).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
      expect(await providers.refresh(id)).toMatchObject({ ok: false, message: expect.stringContaining("disabled") })
    }
    expect(calls).toBe(0)
    expect(providers.set({ id: "deepinfra", enabled: true })).toMatchObject({ ok: true })
    expect(Object.keys(providers.models()[0]!.variants!)).toEqual(["low", "medium", "max", "precise"])
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(providers.set({ id: "deepinfra", baseUrl: "http://api.deepinfra.com/v1/openai" })).toMatchObject({ ok: false })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("refresh retains preset/config metadata and leaves persisted state unchanged after a redacted failure", async () => {
    const dir = temp()
    let failed = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => failed ? new Response(`rejected ${KEY}`, { status: 500 }) : fake(url, init) })
    providers.set({ id: "deepinfra", baseUrl: "http://127.0.0.1:1234/v1/openai", apiKey: KEY, enabled: true })
    expect(await providers.refresh("deepinfra")).toMatchObject({ ok: true, provider: { models: [{ id: MODEL, effort: true, context: 131_072, variants: { max: { parameters: { reasoning_effort: "max" } } } }] } })
    providers.set({ id: "deepinfra", models: [{ id: MODEL, images: false, effort: true, options: { top_k: 4 }, outputLimit: 64, variants: { precise: { effort: "high" } } }] })
    expect(await providers.refresh("deepinfra")).toMatchObject({ ok: true, provider: { models: [{ options: { top_k: 4 }, outputLimit: 64, variants: { precise: { effort: "high" } } }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    failed = true
    const result = await providers.refresh("deepinfra")
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon/client configure, auth, catalog, test, refresh and named variant selection through existing wire commands", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `deepinfra:${MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-08" })
    cleanup.push(() => client.close())
    await client.connect()
    const disabled = await client.configureDeepInfra({ baseUrl: "http://127.0.0.1:1234/v1/openai", apiKey: KEY })
    expect(disabled).toMatchObject({ ok: true, provider: { type: "openai-compatible", enabled: false } })
    expect(await client.providerAuthMethods("deepinfra")).toMatchObject({ ok: true, methods: { deepinfra: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("deepinfra")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureDeepInfra({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "deepinfra" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "providers.refresh", provider: "deepinfra" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: MODEL }] } } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `deepinfra:${MODEL}`, variant: "max" } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: `deepinfra:${MODEL}`, variant: "max", parameters: { reasoning_effort: "max" } })
    expect(JSON.stringify([disabled, selected, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
