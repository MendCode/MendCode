import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import type { ModelsReport, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "cerebras-daemon-private-fixture-0123456789"
const MODEL = "gpt-oss-120b"
const PROXY = "http://127.0.0.1:1234/v1"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-09-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  expect(new Headers(init.headers).get("x-cerebras-3rd-party-integration")).toBe("opencode")
  expect(init.redirect).toBe("error")
  return init.method === "GET" ? Response.json({ data: [{ id: MODEL, context_window: 131_072 }] }) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
}

describe("B10.09 Cerebras daemon and existing protocol", () => {
  test("env-only stays disabled and cannot test, refresh or route to a fallback", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { CEREBRAS_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "cerebras", type: "openai-compatible", enabled: false, hasKey: true, baseUrl: "https://api.cerebras.ai/v1" })
    expect(providers.list()[0]!.error).toBeUndefined()
    expect(providers.models()).toEqual([])
    expect(await providers.test("cerebras")).toMatchObject({ ok: false })
    expect(await providers.refresh("cerebras")).toMatchObject({ ok: false })
    providers.set({ id: "cerebras", baseUrl: PROXY })
    expect(await providers.test("cerebras")).toMatchObject({ error: expect.stringContaining("disabled") })
    expect(providers.set({ id: "cerebras", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    const router = createProviderRouter({ fallback: { id: "never", model: "never", async *stream() { throw new Error("no fallback") } }, providers: providers.runtime })
    expect(await collect(router.stream({ system: "", messages: [{ role: "user", content: "ping" }], tools: [], model: `cerebras:${MODEL}`, signal: new AbortController().signal }))).toContainEqual({ type: "usage", usage: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(calls).toBe(1)
    providers.set({ id: "cerebras", enabled: false })
    await expect(collect(router.stream({ system: "", messages: [], tools: [], model: `cerebras:${MODEL}`, signal: new AbortController().signal }))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("private storage/auth reports are safe and logout preserves public settings and env credentials", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: { TEAM_KEY: KEY }, fetch: fake })
    expect(providers.inventory!({ readOnly: true }).find((entry) => entry.id === "cerebras")).toMatchObject({ configured: false, enabled: false, requiredEnv: ["CEREBRAS_API_KEY"] })
    providers.set({ id: "cerebras", baseUrl: PROXY, apiKey: KEY, apiKeyEnv: "TEAM_KEY", enabled: true })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(() => auth.stop())
    expect(auth.methods("cerebras")).toMatchObject({ cerebras: [{ id: "api-key", available: true }] })
    expect(auth.plan("cerebras")).toMatchObject({ callsProvider: false, executesNow: false, method: { id: "api-key" } })
    expect(JSON.stringify([providers.list(true), providers.inventory!({ readOnly: true }), auth.status("cerebras")])).not.toContain(KEY)
    expect(providers.logout!("cerebras")).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.cerebras).toEqual({ enabled: true, baseUrl: PROXY, apiKeyEnv: "TEAM_KEY" })
    expect(providers.logout!("cerebras")).toMatchObject({ ok: false, message: expect.stringContaining("environment") })
  })

  test("legacy Cerebras SDK namespace uses native wire, private options key and explicit enablement", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/cerebras", options: { baseURL: PROXY, apiKey: KEY, parallelToolCalls: false }, models: [{ id: MODEL, reasoning: true }] } } }))
    let body: any, calls = 0
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => { calls++; body = JSON.parse(String(init.body)); return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "team", type: "openai-compatible", enabled: false, hasKey: true, baseUrl: PROXY })
    expect(await providers.test("team")).toMatchObject({ error: expect.stringContaining("disabled") })
    expect(await providers.refresh("team")).toMatchObject({ ok: false })
    expect(calls).toBe(0)
    expect(providers.set({ id: "team", enabled: true })).toMatchObject({ ok: true })
    expect(await providers.test("team")).toMatchObject({ ok: true })
    expect(body.parallel_tool_calls).toBe(false)
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(providers.inventory!().find((entry) => entry.id === "team")).toMatchObject({ credentialStored: true, requiredEnv: ["CEREBRAS_API_KEY"] })
    expect(providers.logout!("team")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KEY)
    expect(await providers.test("team")).toMatchObject({ error: expect.stringContaining("no API key") })
  })

  test("refuses unsafe endpoints/type without saving and fails closed for imported configuration", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    expect(providers.set({ id: "cerebras", enabled: true, baseUrl: "http://api.cerebras.ai/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    providers.set({ id: "cerebras", baseUrl: PROXY })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    for (const baseUrl of ["http://api.cerebras.ai/v1", "http://remote.test/v1", "http://user:key@localhost/v1", "http://localhost/v1?key=x", "http://localhost/v1#x"]) expect(providers.set({ id: "cerebras", baseUrl })).toMatchObject({ ok: false })
    expect(providers.set({ id: "cerebras", providerType: "openai" })).toMatchObject({ ok: false })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { team: { npm: "@ai-sdk/cerebras", enabled: true, options: { apiKey: KEY, baseURL: `https://user:${KEY}@remote.test/v1` } } } }))
    expect(providers.list()[0]).toMatchObject({ enabled: false, baseUrl: "", error: expect.stringContaining("loopback") })
    expect(JSON.stringify(providers.list())).not.toContain(KEY)
    expect(await providers.refresh("team")).toMatchObject({ ok: false })
  })

  test("refresh keeps starter/config metadata and variants; failure preserves saved bytes", async () => {
    const dir = temp()
    let fail = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => fail ? new Response(`rejected ${KEY}`, { status: 500 }) : fake(url, init) })
    providers.set({ id: "cerebras", baseUrl: PROXY, apiKey: KEY, enabled: true })
    expect(await providers.refresh("cerebras")).toMatchObject({ ok: true, provider: { models: [{ id: MODEL, effort: true, outputLimit: 32768 }] } })
    providers.set({ id: "cerebras", models: [{ id: MODEL, reasoning: true, outputLimit: 64, options: { temperature: 0.1 }, variants: { high: { disabled: true }, precise: { effort: "high" } } }] })
    expect(await providers.refresh("cerebras")).toMatchObject({ ok: true, provider: { models: [{ outputLimit: 64, options: { temperature: 0.1 }, variants: { precise: { effort: "high" } } }] } })
    expect(providers.models()[0]!.variants).toHaveProperty("precise")
    expect(providers.models()[0]!.variants).not.toHaveProperty("high")
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    fail = true
    const result = await providers.refresh("cerebras")
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon/client configure, auth, catalog, test, refresh and variant selection use additive wire", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `cerebras:${MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-09" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.configureCerebras({ baseUrl: PROXY, apiKey: KEY })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(await client.providerAuthMethods("cerebras")).toMatchObject({ ok: true, methods: { cerebras: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("cerebras")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureCerebras({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "cerebras" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "providers.refresh", provider: "cerebras" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: MODEL }] } } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `cerebras:${MODEL}`, variant: "high" } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: `cerebras:${MODEL}`, variant: "high", parameters: { reasoning_effort: "high" } })
    const noReasoning = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `cerebras:${MODEL}`, variant: "none" } })
    expect(noReasoning.ok && (noReasoning.result as ModelsReport).effective).toMatchObject({ variant: "none", parameters: { reasoning_effort: "none" } })
    expect(JSON.stringify([selected, await client.providersCatalog()])).not.toContain(KEY)
    expect(await client.send({ type: "providers.logout", provider: "cerebras" })).toMatchObject({ ok: true })
  }, 15_000)
})
