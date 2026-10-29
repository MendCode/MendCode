import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectZen, ZEN_MODELS, ZEN_TOKEN, ZEN_URL, zenFake, zenRequest } from "../../engine-native/test/zen-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-15-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe("B10.15 OpenCode Zen provider service", () => {
  test("reuses additive commands without granting read-only authority to secrets, writes or HTTP", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "opencode", baseUrl: ZEN_URL, apiKeyEnv: "OPENCODE_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment token is opt-in; enabled state persists and disable applies live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { OPENCODE_API_KEY: ZEN_TOKEN }, fetch: async (url, init) => { calls++; return zenFake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "opencode", type: "openai-compatible", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = { ...zenRequest("opencode:gpt-fixture"), tools: [] }
    await expect(collectZen(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "opencode", enabled: true, baseUrl: "http://opencode.ai/zen/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "opencode", baseUrl: ZEN_URL, apiKeyEnv: "OPENCODE_API_KEY", models: ZEN_MODELS })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "opencode", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models()[0]).toMatchObject({ id: "opencode:gpt-fixture", provider: "opencode", contextWindow: 200_000, cost: { input: 2, output: 8 } })
    expect((await collectZen(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { OPENCODE_API_KEY: ZEN_TOKEN } }).list()[0]!.enabled).toBe(true)
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    providers.set({ id: "opencode", enabled: false })
    await expect(collectZen(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("offline model metadata dispatches native formats even with an unavailable provider SDK", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "models.dev.json"), JSON.stringify({ opencode: { models: Object.fromEntries(ZEN_MODELS.map((model) => [model.id, model])) } }))
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { opencode: { npm: "@fixture/zen-never-install", apiKey: ZEN_TOKEN, options: { baseURL: ZEN_URL } } } }))
    const providers = createProviderService({ dir, env: {}, fetch: zenFake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, models: ZEN_MODELS })
    expect(providers.set({ id: "opencode", enabled: true })).toMatchObject({ ok: true })
    for (const model of ZEN_MODELS) expect(await providers.test("opencode", model.id)).toMatchObject({ ok: true, model: model.id })
    expect(providers.set({ id: "opencode", baseUrl: "http://opencode.ai/zen/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { opencode: { enabled: true, apiKey: ZEN_TOKEN, baseUrl: "http://opencode.ai/zen/v1", models: ZEN_MODELS } } }))
    const remote = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("must not contact public Zen") } })
    expect(remote.list()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("loopback") })
    expect(await remote.refresh("opencode")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(await remote.test("opencode")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(providers.set({ id: "opencode", apiKey: "public" })).toMatchObject({ ok: false, message: expect.stringContaining("anonymous") })
  })

  test("auth plans remain local, reports hide tokens and logout deletes only stored credentials", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {} })
    const auth = createProviderAuth({ dir, providers, env: {}, openBrowser: async () => { throw new Error("must not open console") } })
    cleanup.push(auth.stop)
    expect(auth.methods("opencode").opencode).toMatchObject([{ id: "api-key", type: "api", available: true }])
    expect(auth.plan("opencode")).toMatchObject({ callsProvider: false, writesSecrets: false, executesNow: false, callback: "none" })
    expect(auth.status("opencode")[0]!.state).toBe("none")
    providers.set({ id: "opencode", baseUrl: ZEN_URL, apiKey: ZEN_TOKEN, enabled: true, models: ZEN_MODELS })
    expect(auth.status("opencode")[0]!.state).toBe("authorized")
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("opencode")])).not.toContain(ZEN_TOKEN)
    expect(providers.logout!("opencode")).toMatchObject({ ok: true })
    const stored = JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.opencode
    expect(stored).not.toHaveProperty("apiKey")
    expect(stored).toMatchObject({ baseUrl: ZEN_URL, enabled: true, models: ZEN_MODELS })
    expect(auth.status("opencode")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
    const anonymous = createProviderService({ dir: temp(), env: { OPENCODE_API_KEY: "public" } })
    expect(anonymous.inventory!().find((entry) => entry.id === "opencode")).toMatchObject({ enabled: false, authReady: false })
  })

  test("refresh retains per-model formats and configured budgets when listing returns only IDs", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => Response.json({ data: ZEN_MODELS.map(({ id }) => ({ id })) }) })
    providers.set({ id: "opencode", baseUrl: ZEN_URL, apiKey: ZEN_TOKEN, enabled: true, models: ZEN_MODELS.map((model) => ({ ...model, inputLimit: 8000, outputLimit: 64, compaction: { threshold: 0.75 } })) })
    expect(await providers.refresh("opencode")).toMatchObject({ ok: true })
    for (const model of providers.list()[0]!.models) expect(model).toMatchObject({ ...ZEN_MODELS.find((entry) => entry.id === model.id), inputLimit: 8000, outputLimit: 64, compaction: { threshold: 0.75 } })
  })

  test("failed refresh preserves the catalog and redacts an echoed token", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => new Response(`rejected ${ZEN_TOKEN}`, { status: 401 }) })
    providers.set({ id: "opencode", baseUrl: ZEN_URL, apiKey: ZEN_TOKEN, enabled: true, models: ZEN_MODELS })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    const result = await providers.refresh("opencode")
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("401") })
    expect(JSON.stringify(result)).not.toContain(ZEN_TOKEN)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon and typed client: auth, catalog, refresh, test, model selection, disable and logout", async () => {
    const dir = temp()
    const fake: Fetch = async (url, init) => { expect(url.startsWith(ZEN_URL)).toBe(true); expect(init.redirect).toBe("error"); expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ZEN_TOKEN}`); return zenFake(url, init) }
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "opencode:gpt-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-15" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("opencode")).toMatchObject({ ok: true, methods: { opencode: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("opencode")).toMatchObject({ ok: true, plan: { callsProvider: false, callback: "none" } })
    const replies = [await client.send({ type: "providers.set", provider: "opencode", baseUrl: ZEN_URL, apiKey: ZEN_TOKEN, enabled: true }), await client.send({ type: "providers.refresh", provider: "opencode" }), await client.send({ type: "providers.test", provider: "opencode", model: "gpt-fixture" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "opencode", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: expect.arrayContaining(ZEN_MODELS) } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "gpt-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "opencode:gpt-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "opencode:gpt-fixture" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "opencode")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["OPENCODE_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(ZEN_TOKEN)
    expect(await client.send({ type: "providers.set", provider: "opencode", enabled: false })).toMatchObject({ ok: true, result: { provider: { enabled: false } } })
    expect(providers.models()).toEqual([])
    expect(await client.send({ type: "providers.logout", provider: "opencode" })).toMatchObject({ ok: true })
  }, 15_000)
})
