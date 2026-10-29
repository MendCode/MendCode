import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectKilo, kiloFake, kiloRequest, KILO_MODELS, KILO_TOKEN, KILO_URL } from "../../engine-native/test/kilo-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-23-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(`${KILO_URL}/`)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KILO_TOKEN}`)
  return kiloFake(url, init)
}

describe("B10.23 Kilo daemon and protocol", () => {
  test("reuses additive compatible commands without extending read-only authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "kilo", baseUrl: KILO_URL, apiKeyEnv: "KILO_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment credentials stay off until explicit local enablement; router disablement applies live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { KILO_API_KEY: KILO_TOKEN }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "kilo", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "kilo", enabled: true, baseUrl: "http://api.kilo.ai/api/gateway" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "kilo", baseUrl: KILO_URL, apiKeyEnv: "KILO_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "kilo", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, models: [] } })
    expect(calls).toBe(0)
    expect(await providers.refresh("kilo")).toMatchObject({ ok: true, provider: { models: KILO_MODELS } })
    expect(providers.models()[0]!.name).toBe("Reasoning fixture")
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = kiloRequest({ model: "kilo:reasoning-fixture" })
    expect((await collectKilo(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { KILO_API_KEY: KILO_TOKEN } }).models()[0]).toMatchObject({ id: "kilo:reasoning-fixture", provider: "kilo", contextWindow: 128_000, efforts: ["low", "medium", "high"] })
    providers.set({ id: "kilo", enabled: false })
    await expect(collectKilo(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(2)
  })

  test("disabled providers and missing proxy tokens never reach a transport", async () => {
    let calls = 0
    const providers = createProviderService({ dir: temp(), env: { KILO_API_KEY: KILO_TOKEN }, fetch: async () => { calls++; throw new Error("must not call transport") } })
    expect(await providers.test("kilo")).toMatchObject({ ok: false })
    expect(await providers.refresh("kilo")).toMatchObject({ ok: false })
    providers.set({ id: "kilo", baseUrl: KILO_URL, models: KILO_MODELS })
    expect(await providers.test("kilo")).toMatchObject({ ok: false, error: expect.stringContaining("disabled") })
    expect(await providers.refresh("kilo")).toMatchObject({ ok: false, message: expect.stringContaining("disabled") })
    const missing = createProviderService({ dir: temp(), env: {} })
    expect(missing.set({ id: "kilo", baseUrl: KILO_URL, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
    expect(missing.list()).toEqual([])
    expect(calls).toBe(0)
  })

  test("v1 options resolve without SDK loading or credential fields in generation, and model overrides survive refresh", async () => {
    const dir = temp()
    const model = { ...KILO_MODELS[0]!, outputLimit: 64, variants: { careful: { effort: "high" as const } }, cost: { input: 1, output: 2 } }
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { kilo: { npm: "@openrouter/ai-sdk-provider", options: { baseURL: KILO_URL, apiKey: KILO_TOKEN, headers: { "X-Title": "custom-client", authorization: "Bearer stale" } }, models: [model] } } }))
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${KILO_TOKEN}`)
      expect(headers.get("x-title")).toBe("custom-client")
      if (init.body) {
        const body = JSON.parse(String(init.body))
        expect(body.apiKey).toBeUndefined()
        expect(body.headers).toBeUndefined()
        expect(String(init.body)).not.toContain(KILO_TOKEN)
      }
      return kiloFake(url, init)
    } })
    expect(providers.list()[0]).toMatchObject({ enabled: false, hasKey: true, type: "openai-compatible" })
    expect(providers.set({ id: "kilo", enabled: true })).toMatchObject({ ok: true })
    expect(await providers.test("kilo")).toMatchObject({ ok: true })
    expect(await providers.refresh("kilo")).toMatchObject({ ok: true, provider: { models: [model, KILO_MODELS[1]] } })
    expect(JSON.stringify(providers.list())).not.toContain(KILO_TOKEN)
    expect(providers.inventory!().find((entry) => entry.id === "kilo")).toMatchObject({ credentialStored: true })
    expect(providers.logout!("kilo")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.kilo.options).toEqual({ baseURL: KILO_URL, headers: { "X-Title": "custom-client", authorization: "Bearer stale" } })
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "kilo", apiKey: KILO_TOKEN, enabled: true })).toMatchObject({ ok: true })
    expect(providers.set({ id: "kilo", apiKeyEnv: "LOCAL_KILO_TOKEN" })).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(KILO_TOKEN)
  })

  test("legacy SDK entries cannot autoload or bypass the loopback guard", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { kilo: { npm: "@ai-sdk/openai-compatible", apiKey: KILO_TOKEN, options: { baseURL: KILO_URL }, models: KILO_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible" })
    expect(providers.set({ id: "kilo", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("kilo")).toMatchObject({ ok: true, model: "reasoning-fixture" })
    expect(providers.set({ id: "kilo", baseUrl: "http://api.kilo.ai/api/gateway" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { kilo: { enabled: true, apiKey: KILO_TOKEN, type: "openai", baseUrl: "http://public.example/v1", models: KILO_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("kilo")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh("kilo")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth, private persistence and logout never expose the token or discard settings", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("kilo")).toEqual({ kilo: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("kilo")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "kilo", baseUrl: KILO_URL, apiKey: KILO_TOKEN, enabled: true, models: KILO_MODELS })
    expect(auth.status("kilo")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("kilo")])).not.toContain(KILO_TOKEN)
    expect(providers.logout!("kilo")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.kilo).toEqual({ baseUrl: KILO_URL, enabled: true, models: KILO_MODELS })
    expect(auth.status("kilo")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
  })

  test("empty and failed refreshes preserve the catalog and redact echoed tokens", async () => {
    for (const empty of [true, false]) {
      const dir = temp()
      const providers = createProviderService({ dir, env: {}, fetch: async () => empty ? Response.json({ data: [] }) : new Response(`rejected ${KILO_TOKEN}`, { status: 401 }) })
      providers.set({ id: "kilo", baseUrl: KILO_URL, apiKey: KILO_TOKEN, enabled: true, models: KILO_MODELS })
      const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
      const reply = await providers.refresh("kilo")
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(empty ? "no models" : "401") })
      expect(JSON.stringify(reply)).not.toContain(KILO_TOKEN)
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    }
  })

  test("daemon and typed client cover catalog, auth, save, refresh, test, selection and live disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "kilo:reasoning-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-23" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("kilo")).toMatchObject({ ok: true, methods: { kilo: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("kilo")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "kilo", baseUrl: KILO_URL, apiKey: KILO_TOKEN, enabled: true }), await client.send({ type: "providers.refresh", provider: "kilo" }), await client.send({ type: "providers.test", provider: "kilo" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "kilo", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: KILO_MODELS } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "reasoning-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "kilo:text-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "kilo:text-fixture" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "kilo")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["KILO_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(KILO_TOKEN)
    expect(await client.send({ type: "providers.set", provider: "kilo", enabled: false })).toMatchObject({ ok: true, result: { provider: { enabled: false } } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
