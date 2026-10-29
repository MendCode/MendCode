import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectZenmux, zenmuxFake, zenmuxRequest, ZENMUX_MODELS, ZENMUX_TOKEN, ZENMUX_URL } from "../../engine-native/test/zenmux-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-19-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(`${ZENMUX_URL}/`)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ZENMUX_TOKEN}`)
  return zenmuxFake(url, init)
}

describe("B10.19 Zenmux daemon and protocol", () => {
  test("reuses additive compatible commands without extending read-only authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "zenmux", baseUrl: ZENMUX_URL, apiKeyEnv: "ZENMUX_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment credentials stay off until explicit local enablement; router disablement applies live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { ZENMUX_API_KEY: ZENMUX_TOKEN }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "zenmux", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "zenmux", enabled: true, baseUrl: "http://zenmux.ai/api/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "zenmux", baseUrl: ZENMUX_URL, apiKeyEnv: "ZENMUX_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "zenmux", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, models: [] } })
    expect(calls).toBe(0)
    expect(await providers.refresh("zenmux")).toMatchObject({ ok: true, provider: { models: ZENMUX_MODELS } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = zenmuxRequest({ model: "zenmux:vendor/reasoning-fixture" })
    expect((await collectZenmux(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { ZENMUX_API_KEY: ZENMUX_TOKEN } }).models()[0]).toMatchObject({ id: "zenmux:vendor/reasoning-fixture", provider: "zenmux", contextWindow: 128_000, efforts: ["low", "medium", "high"] })
    providers.set({ id: "zenmux", enabled: false })
    await expect(collectZenmux(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(2)
  })

  test("legacy SDK entries cannot autoload or bypass the loopback guard", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { zenmux: { npm: "@ai-sdk/openai-compatible", apiKey: ZENMUX_TOKEN, options: { baseURL: ZENMUX_URL }, models: ZENMUX_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible" })
    expect(providers.set({ id: "zenmux", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("zenmux")).toMatchObject({ ok: true, model: "vendor/reasoning-fixture" })
    expect(providers.set({ id: "zenmux", baseUrl: "http://zenmux.ai/api/v1" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { zenmux: { enabled: true, apiKey: ZENMUX_TOKEN, type: "openai", baseUrl: "http://public.example/v1", models: ZENMUX_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("zenmux")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh("zenmux")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth, private persistence and logout never expose the token or discard settings", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("zenmux")).toEqual({ zenmux: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("zenmux")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "zenmux", baseUrl: ZENMUX_URL, apiKey: ZENMUX_TOKEN, enabled: true, models: ZENMUX_MODELS })
    expect(auth.status("zenmux")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("zenmux")])).not.toContain(ZENMUX_TOKEN)
    expect(providers.logout!("zenmux")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.zenmux).toEqual({ baseUrl: ZENMUX_URL, enabled: true, models: ZENMUX_MODELS })
    expect(auth.status("zenmux")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
  })

  test("empty and failed refreshes preserve the catalog and redact echoed tokens", async () => {
    for (const empty of [true, false]) {
      const dir = temp()
      const providers = createProviderService({ dir, env: {}, fetch: async () => empty ? Response.json({ data: [] }) : new Response(`rejected ${ZENMUX_TOKEN}`, { status: 401 }) })
      providers.set({ id: "zenmux", baseUrl: ZENMUX_URL, apiKey: ZENMUX_TOKEN, enabled: true, models: ZENMUX_MODELS })
      const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
      const reply = await providers.refresh("zenmux")
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(empty ? "no models" : "401") })
      expect(JSON.stringify(reply)).not.toContain(ZENMUX_TOKEN)
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    }
  })

  test("daemon and typed client cover catalog, auth, save, refresh, test, selection and live disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "zenmux:vendor/reasoning-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-19" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("zenmux")).toMatchObject({ ok: true, methods: { zenmux: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("zenmux")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "zenmux", baseUrl: ZENMUX_URL, apiKey: ZENMUX_TOKEN, enabled: true }), await client.send({ type: "providers.refresh", provider: "zenmux" }), await client.send({ type: "providers.test", provider: "zenmux" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "zenmux", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: ZENMUX_MODELS } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "vendor/reasoning-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "zenmux:vendor/text-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "zenmux:vendor/text-fixture" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "zenmux")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["ZENMUX_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(ZENMUX_TOKEN)
    expect(await client.send({ type: "providers.set", provider: "zenmux", enabled: false })).toMatchObject({ ok: true, result: { provider: { enabled: false } } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
