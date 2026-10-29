import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "togetherai-private-fixture-0123456789"
const MODEL = "openai/gpt-oss-120b"
const endpoint = "http://127.0.0.1:1234/v1"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-11-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(endpoint)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  return init.method === "GET" ? Response.json([{ id: MODEL, type: "chat", context_length: 131_072, supported_parameters: ["reasoning_effort", "tools"] }]) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
}

describe("B10.11 TogetherAI daemon boundaries", () => {
  test("additive compatible wire commands retain their write authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "togetherai", baseUrl: endpoint, apiKeyEnv: "TOGETHER_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment key is off by default; disabled test/refresh never call a service; enable and disable persist", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { TOGETHER_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "togetherai", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(await providers.test("togetherai")).toMatchObject({ ok: false })
    expect(await providers.refresh("togetherai")).toMatchObject({ ok: false })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: `togetherai:${MODEL}`, signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(providers.set({ id: "togetherai", enabled: true, baseUrl: "http://api.together.ai/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(calls).toBe(0)
    expect(providers.set({ id: "togetherai", baseUrl: endpoint, apiKeyEnv: "TOGETHER_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "togetherai", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models().find((model) => model.id === `togetherai:${MODEL}`)).toMatchObject({ efforts: ["low", "medium", "high"], variants: { high: { effort: "high" } } })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { TOGETHER_API_KEY: KEY } }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "togetherai", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("SDK aliases use native options and headers; stored legacy keys never reach generation and logout removes them", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/togetherai", options: { baseURL: endpoint, apiKey: KEY, topK: 5, headers: { "x-team": "dev" } }, models: [{ id: MODEL, reasoning: true }] } } }))
    let body: any
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => { body = init.body ? JSON.parse(String(init.body)) : undefined; expect(new Headers(init.headers).get("x-team")).toBe("dev"); return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "team", type: "openai-compatible", enabled: false, hasKey: true, baseUrl: endpoint })
    expect(providers.set({ id: "team", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("team")).toMatchObject({ ok: true, model: MODEL })
    expect(body.top_k).toBe(5)
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(providers.inventory!().find((entry) => entry.id === "team")).toMatchObject({ credentialStored: true })
    expect(providers.logout!("team")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    expect(await providers.test("team")).toMatchObject({ ok: false, error: expect.stringContaining("no API key") })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { togetherai: { npm: "@ai-sdk/togetherai", options: { baseURL: endpoint, apiKey: KEY, topK: 8 } } } }))
    expect(providers.set({ id: "togetherai", apiKey: "" })).toMatchObject({ ok: true, provider: { hasKey: false, enabled: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.togetherai.options).toEqual({ baseURL: endpoint, topK: 8 })
  })

  test("public/malformed URLs, missing tokens and wire-type overrides cannot bypass the conservative default", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("must not call") } })
    expect(providers.set({ id: "togetherai", baseUrl: endpoint, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
    expect(providers.set({ id: "togetherai", providerType: "openai" })).toMatchObject({ ok: false })
    for (const baseUrl of ["http://api.together.ai/v1", "http://remote.test/v1", "http://u:p@localhost/v1", "http://localhost/v1?key=x", "http://localhost/v1#x"]) expect(providers.set({ id: "togetherai", baseUrl, apiKey: KEY, enabled: true })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { togetherai: { enabled: true, apiKey: KEY, type: "openai", baseUrl: "http://api.together.ai/v1" } } }))
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible", error: expect.stringContaining("loopback") })
    expect(providers.models()).toEqual([])
    expect(await providers.test("togetherai")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await providers.refresh("togetherai")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { togetherai: { enabled: true, apiKey: KEY, baseUrl: endpoint, options: { headers: { "x-team": 13 } } } } }))
    expect(providers.list()[0]).toMatchObject({ enabled: false, error: "invalid TogetherAI headers" })
    expect(await providers.test("togetherai")).toMatchObject({ ok: false, error: "invalid TogetherAI headers" })
  })

  test("offline API-key auth and logout preserve environment references and never expose the token", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: { TEAM_KEY: KEY }, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("togetherai")).toEqual({ togetherai: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("togetherai")).toMatchObject({ callsProvider: false, executesNow: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "togetherai", baseUrl: endpoint, apiKey: KEY, apiKeyEnv: "TEAM_KEY", enabled: true })
    expect(auth.status("togetherai")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(true), providers.inventory!({ readOnly: true }), auth.status("togetherai")])).not.toContain(KEY)
    expect(providers.logout!("togetherai")).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.togetherai).toEqual({ baseUrl: endpoint, enabled: true, apiKeyEnv: "TEAM_KEY" })
  })

  test("refresh retains explicit metadata/variants and a redacted failure leaves saved state untouched", async () => {
    const dir = temp()
    let failed = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => failed ? new Response(`rejected ${KEY}`, { status: 401 }) : fake(url, init) })
    providers.set({ id: "togetherai", baseUrl: endpoint, apiKey: KEY, enabled: true, models: [{ id: MODEL, images: false, outputLimit: 64, variants: { precise: { effort: "high", parameters: { temperature: 0 } } } }] })
    expect(await providers.refresh("togetherai")).toMatchObject({ ok: true, provider: { models: [{ id: MODEL, context: 131_072, outputLimit: 64, variants: { precise: { effort: "high" } } }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    failed = true
    const result = await providers.refresh("togetherai")
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("401") })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon/client configure, catalog, auth, refresh, test and named variant selection use the existing protocol", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `togetherai:${MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-11" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.configureTogetherAI({ baseUrl: endpoint, apiKey: KEY })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(await client.providerAuthMethods("togetherai")).toMatchObject({ ok: true, methods: { togetherai: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("togetherai")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.configureTogetherAI({ enabled: true }), await client.send({ type: "providers.refresh", provider: "togetherai" }), await client.send({ type: "providers.test", provider: "togetherai" })]
    expect(replies[0]).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: [{ id: MODEL }] } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: MODEL } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `togetherai:${MODEL}`, variant: "high" } })).toMatchObject({ ok: true, result: { effective: { model: `togetherai:${MODEL}`, variant: "high", effort: "high", parameters: { reasoning_effort: "high" } } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "togetherai")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["TOGETHER_API_KEY"] })
    expect(JSON.stringify([replies, catalog])).not.toContain(KEY)
    expect(await client.send({ type: "providers.logout", provider: "togetherai" })).toMatchObject({ ok: true })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
