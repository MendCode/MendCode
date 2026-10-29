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

const KEY = "xai-private-fixture-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-06-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  return init.method === "GET" ? Response.json({ data: [{ id: "grok-3-mini", context_length: 131_072 }] }) : new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`)
}

describe("B10.06 xAI daemon", () => {
  test("key alone stays off; disabled admin calls never contact HTTP; enable/disable applies live", async () => {
    let calls = 0
    const dir = temp(), env = { XAI_API_KEY: KEY }
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "xai", type: "xai", enabled: false, hasKey: true, source: "env" })
    expect(providers.models()).toEqual([])
    expect(await providers.test("xai")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
    expect(await providers.refresh("xai")).toMatchObject({ ok: false, message: expect.stringContaining("disabled") })
    expect(providers.set({ id: "xai", apiKeyEnv: "XAI_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not reach subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "xai:grok-3-mini", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "xai", enabled: true, baseUrl: "http://127.0.0.1:1234/v1" })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models().find((entry) => entry.id === "xai:grok-3-mini")).toMatchObject({ efforts: ["low", "high"], variants: { low: { effort: "low" }, high: { effort: "high" } } })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "xai", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("API-key auth reports stay offline; private storage and logout preserve environment references", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} }); cleanup.push(auth.stop)
    expect(auth.methods("xai")).toEqual({ xai: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("xai")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "xai", apiKey: KEY, apiKeyEnv: "TEAM_XAI_KEY", enabled: true })
    expect(auth.status("xai")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("xai")])).not.toContain(KEY)
    expect(providers.logout!("xai")).toMatchObject({ ok: true, provider: { enabled: true, hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.xai).toEqual({ enabled: true, apiKeyEnv: "TEAM_XAI_KEY" })
  })

  test("custom native providers and legacy SDK options stay opt-in, use no SDK and require a key", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { xai: { npm: "@ai-sdk/xai", apiKeyEnv: "XAI_API_KEY", options: { baseURL: "http://127.0.0.1:1234/v1", topLogprobs: 2 } } } }))
    const providers = createProviderService({ dir, env: { XAI_API_KEY: KEY }, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ type: "xai", enabled: false })
    providers.set({ id: "xai", enabled: true })
    expect(await providers.test("xai")).toMatchObject({ ok: true })
    expect(providers.set({ id: "proxy", providerType: "xai", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "grok-3-mini" }] })).toMatchObject({ ok: true, provider: { enabled: false, hasKey: false } })
    providers.set({ id: "proxy", enabled: true })
    expect(await providers.test("proxy")).toMatchObject({ ok: false, error: expect.stringContaining("no API key") })
    expect(providers.models().some((entry) => entry.provider === "proxy")).toBe(false)
    expect(providers.set({ id: "xai", baseUrl: "http://remote.example/v1" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "xai", providerType: "openai-compatible" })).toMatchObject({ ok: false })
  })

  test("refresh preserves explicit metadata/options; failed refresh preserves saved catalog", async () => {
    const dir = temp()
    let fail = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => fail ? new Response(`bad ${KEY}`, { status: 500 }) : fake(url, init) })
    providers.set({ id: "xai", baseUrl: "http://127.0.0.1:1234/v1", apiKey: KEY, enabled: true, models: [{ id: "grok-3-mini", options: { topLogprobs: 3 }, cost: { input: 0.3, output: 0.5 }, variants: { low: { parameters: { reasoningEffort: "low" } } } }] })
    expect(await providers.refresh("xai")).toMatchObject({ ok: true, provider: { models: [{ context: 131_072, options: { topLogprobs: 3 }, variants: { low: { parameters: { reasoningEffort: "low" } } } }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    fail = true
    const result = await providers.refresh("xai")
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon + client: configure, catalog, auth, Responses test, refresh and named variant selection", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "xai:grok-3-mini" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-06" }); cleanup.push(() => client.close())
    await client.connect()
    const disabled = await client.configureXai({ apiKey: KEY, baseUrl: "http://127.0.0.1:1234/v1" })
    expect(disabled).toMatchObject({ ok: true, provider: { type: "xai", enabled: false } })
    expect(await client.providerAuthMethods("xai")).toMatchObject({ ok: true, methods: { xai: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("xai")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureXai({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "xai" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.send({ type: "providers.refresh", provider: "xai" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: "grok-3-mini" }] } } })
    expect(await client.configureXai({ provider: "proxy", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "TEAM_KEY" })).toMatchObject({ ok: true, provider: { id: "proxy", type: "xai", enabled: false } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "xai:grok-3-mini", variant: "high" } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: "xai:grok-3-mini", variant: "high", effort: "high" })
    expect(JSON.stringify([disabled, selected, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
