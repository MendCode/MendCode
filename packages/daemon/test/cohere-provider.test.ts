import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { ProviderType, ProviderInfo, type ModelsReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"
import { createProviderAuth } from "../src/provider-auth"

const KEY = "cohere-daemon-fixture-0123456789"
const MODEL = "command-a-03-2025"
const PROXY = "http://127.0.0.1:1234/v2"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-10-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  expect(init.redirect).toBe("error")
  return init.method === "GET" ? Response.json({ models: [{ name: MODEL, endpoints: ["chat"], context_length: 256000 }] }) : new Response(`data: ${JSON.stringify({ type: "content-delta", delta: { message: { content: { text: "ok" } } } })}\n\ndata: ${JSON.stringify({ type: "message-end", delta: { finish_reason: "COMPLETE", usage: { tokens: { input_tokens: 2, output_tokens: 1 } } } })}\n\n`)
}

describe("B10.10 Cohere daemon/protocol/client", () => {
  test("env-only remains disabled; endpoint + explicit enablement gate test, refresh and runtime routing", async () => {
    let calls = 0
    const providers = createProviderService({ dir: temp(), env: { COHERE_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "cohere", type: "cohere", enabled: false, hasKey: true, baseUrl: "https://api.cohere.com/v2" })
    expect(providers.list()[0]!.error).toBeUndefined()
    expect(providers.models()).toEqual([])
    expect(await providers.test("cohere")).toMatchObject({ ok: false })
    expect(await providers.refresh("cohere")).toMatchObject({ ok: false })
    expect(calls).toBe(0)
    expect(providers.set({ id: "cohere", baseUrl: PROXY })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(await providers.test("cohere")).toMatchObject({ error: expect.stringContaining("disabled") })
    expect(providers.set({ id: "cohere", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    const router = createProviderRouter({ fallback: { id: "never", model: "never", async *stream() { throw new Error("no fallback") } }, providers: providers.runtime })
    expect(await collect(router.stream({ system: "", messages: [{ role: "user", content: "ping" }], tools: [], model: `cohere:${MODEL}`, signal: new AbortController().signal }))).toContainEqual({ type: "usage", usage: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    providers.set({ id: "cohere", enabled: false })
    await expect(collect(router.stream({ system: "", messages: [], tools: [], model: `cohere:${MODEL}`, signal: new AbortController().signal }))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("private storage, safe auth/catalog, logout and env credential preservation reuse existing commands", () => {
    const dir = temp(), providers = createProviderService({ dir, env: { TEAM_KEY: KEY }, fetch: fake })
    expect(providers.inventory!({ readOnly: true }).find((entry) => entry.id === "cohere")).toMatchObject({ configured: false, enabled: false, requiredEnv: ["COHERE_API_KEY"] })
    expect(providers.set({ id: "cohere", baseUrl: PROXY, apiKey: KEY, apiKeyEnv: "TEAM_KEY", enabled: true })).toMatchObject({ ok: true })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(() => auth.stop())
    expect(auth.methods("cohere")).toMatchObject({ cohere: [{ id: "api-key", available: true }] })
    expect(auth.plan("cohere")).toMatchObject({ callsProvider: false, executesNow: false, method: { id: "api-key" } })
    expect(JSON.stringify([providers.list(true), providers.inventory!({ readOnly: true }), auth.status("cohere")])).not.toContain(KEY)
    expect(providers.logout!("cohere")).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.cohere).toEqual({ enabled: true, baseUrl: PROXY, apiKeyEnv: "TEAM_KEY" })
    expect(providers.logout!("cohere")).toMatchObject({ ok: false, message: expect.stringContaining("environment") })
  })

  test("legacy SDK namespaces use native wire, private options keys and explicit enablement without SDK import", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/cohere", options: { baseURL: PROXY, apiKey: KEY, topP: 0.7 }, models: [{ id: MODEL }] } } }))
    let body: any, calls = 0
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => { calls++; body = JSON.parse(String(init.body)); return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "team", type: "cohere", enabled: false, hasKey: true })
    expect(await providers.test("team")).toMatchObject({ ok: false })
    expect(calls).toBe(0)
    expect(providers.set({ id: "team", enabled: true })).toMatchObject({ ok: true })
    expect(await providers.test("team")).toMatchObject({ ok: true })
    expect(body).toMatchObject({ p: 0.7, max_tokens: 8, stream: true })
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(providers.inventory!().find((entry) => entry.id === "team")).toMatchObject({ credentialStored: true, requiredEnv: ["COHERE_API_KEY"] })
    expect(providers.logout!("team")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    expect(await providers.test("team")).toMatchObject({ error: expect.stringContaining("no API key") })
  })

  test("refuses unsafe endpoints/type/no-key before saving; imported remote config fails closed", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    expect(providers.set({ id: "cohere", enabled: true, baseUrl: "http://api.cohere.com/v2" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "cohere", baseUrl: PROXY, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
    providers.set({ id: "cohere", baseUrl: PROXY })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    for (const baseUrl of ["http://api.cohere.com/v2", "http://remote.test/v2", "http://user:key@localhost/v2", "http://localhost/v2?key=x", "http://localhost/v2#x"]) expect(providers.set({ id: "cohere", baseUrl })).toMatchObject({ ok: false })
    expect(providers.set({ id: "cohere", providerType: "openai-compatible" })).toMatchObject({ ok: false })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/cohere", enabled: true, options: { apiKey: KEY, baseURL: `https://user:${KEY}@remote.test/v2` } } } }))
    expect(providers.list()[0]).toMatchObject({ enabled: false, baseUrl: "", error: expect.stringContaining("loopback") })
    expect(JSON.stringify(providers.list())).not.toContain(KEY)
    expect(await providers.refresh("team")).toMatchObject({ ok: false })
  })

  test("refresh preserves starter and configured metadata; failures keep saved bytes and redact", async () => {
    const dir = temp()
    let fail = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => fail ? new Response(`rejected ${KEY}`, { status: 500 }) : fake(url, init) })
    providers.set({ id: "cohere", baseUrl: PROXY, apiKey: KEY, enabled: true })
    expect(await providers.refresh("cohere")).toMatchObject({ ok: true, provider: { models: [{ id: MODEL, context: 256000, outputLimit: 8000 }] } })
    providers.set({ id: "cohere", models: [{ id: MODEL, outputLimit: 64, options: { temperature: 0.1 }, variants: { precise: { parameters: { temperature: 0 } } } }] })
    expect(await providers.refresh("cohere")).toMatchObject({ ok: true, provider: { models: [{ outputLimit: 64, options: { temperature: 0.1 }, variants: { precise: { parameters: { temperature: 0 } } } }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    fail = true
    const result = await providers.refresh("cohere")
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("additive protocol/client path configures, authenticates, tests, refreshes and selects Cohere", async () => {
    expect(ProviderType.parse("cohere")).toBe("cohere")
    expect(ProviderType.parse("openai-compatible")).toBe("openai-compatible")
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `cohere:${MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-10" })
    cleanup.push(() => client.close())
    await client.connect()
    const configured = await client.configureCohere({ baseUrl: PROXY, apiKey: KEY })
    expect(configured).toMatchObject({ ok: true, provider: { enabled: false, type: "cohere" } })
    if (configured.ok) expect(ProviderInfo.safeParse(configured.provider).success).toBe(true)
    expect(await client.providerAuthMethods("cohere")).toMatchObject({ ok: true, methods: { cohere: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("cohere")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureCohere({ enabled: true })).toMatchObject({ ok: true })
    expect(await client.send({ type: "providers.test", provider: "cohere" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "providers.refresh", provider: "cohere" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: MODEL }] } } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `cohere:${MODEL}` } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: `cohere:${MODEL}` })
    expect(JSON.stringify([selected, await client.providersCatalog()])).not.toContain(KEY)
    expect(await client.send({ type: "providers.logout", provider: "cohere" })).toMatchObject({ ok: true })
  }, 15000)
})
