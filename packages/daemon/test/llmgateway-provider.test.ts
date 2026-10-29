import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectGateway, gatewayFake, gatewayRequest, GATEWAY_MODELS, GATEWAY_TOKEN, GATEWAY_URL } from "../../engine-native/test/llmgateway-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-16-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(`${GATEWAY_URL}/`)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`)
  return gatewayFake(url, init)
}

describe("B10.16 LLMGateway daemon and protocol", () => {
  test("reuses additive compatible commands without extending read-only authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "llmgateway", baseUrl: GATEWAY_URL, apiKeyEnv: "LLMGATEWAY_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment credentials stay off until explicit local enablement; router disablement applies live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { LLMGATEWAY_API_KEY: GATEWAY_TOKEN }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "llmgateway", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "llmgateway", enabled: true, baseUrl: "http://api.llmgateway.io/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "llmgateway", baseUrl: GATEWAY_URL, apiKeyEnv: "LLMGATEWAY_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "llmgateway", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, models: [] } })
    expect(calls).toBe(0)
    expect(await providers.refresh("llmgateway")).toMatchObject({ ok: true, provider: { models: GATEWAY_MODELS } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = gatewayRequest({ model: "llmgateway:reasoning-fixture" })
    expect((await collectGateway(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { LLMGATEWAY_API_KEY: GATEWAY_TOKEN } }).models()[0]).toMatchObject({ id: "llmgateway:reasoning-fixture", provider: "llmgateway", contextWindow: 128_000, efforts: ["low", "medium", "high"] })
    providers.set({ id: "llmgateway", enabled: false })
    await expect(collectGateway(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(2)
  })

  test("legacy SDK entries cannot autoload or bypass the loopback guard", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { llmgateway: { npm: "@ai-sdk/openai-compatible", apiKey: GATEWAY_TOKEN, options: { baseURL: GATEWAY_URL }, models: GATEWAY_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible" })
    expect(providers.set({ id: "llmgateway", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("llmgateway")).toMatchObject({ ok: true, model: "reasoning-fixture" })
    expect(providers.set({ id: "llmgateway", baseUrl: "http://api.llmgateway.io/v1" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { llmgateway: { enabled: true, apiKey: GATEWAY_TOKEN, type: "openai", baseUrl: "http://public.example/v1", models: GATEWAY_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("llmgateway")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh("llmgateway")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth, private persistence and logout never expose the token or discard settings", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("llmgateway")).toEqual({ llmgateway: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("llmgateway")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "llmgateway", baseUrl: GATEWAY_URL, apiKey: GATEWAY_TOKEN, enabled: true, models: GATEWAY_MODELS })
    expect(auth.status("llmgateway")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("llmgateway")])).not.toContain(GATEWAY_TOKEN)
    expect(providers.logout!("llmgateway")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.llmgateway).toEqual({ baseUrl: GATEWAY_URL, enabled: true, models: GATEWAY_MODELS })
    expect(auth.status("llmgateway")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
  })

  test("empty and failed refreshes preserve the catalog and redact echoed tokens", async () => {
    for (const empty of [true, false]) {
      const dir = temp()
      const providers = createProviderService({ dir, env: {}, fetch: async () => empty ? Response.json({ data: [] }) : new Response(`rejected ${GATEWAY_TOKEN}`, { status: 401 }) })
      providers.set({ id: "llmgateway", baseUrl: GATEWAY_URL, apiKey: GATEWAY_TOKEN, enabled: true, models: GATEWAY_MODELS })
      const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
      const reply = await providers.refresh("llmgateway")
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(empty ? "no models" : "401") })
      expect(JSON.stringify(reply)).not.toContain(GATEWAY_TOKEN)
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    }
  })

  test("daemon and typed client cover catalog, auth, save, refresh, test, selection and live disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "llmgateway:reasoning-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-16" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("llmgateway")).toMatchObject({ ok: true, methods: { llmgateway: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("llmgateway")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "llmgateway", baseUrl: GATEWAY_URL, apiKey: GATEWAY_TOKEN, enabled: true }), await client.send({ type: "providers.refresh", provider: "llmgateway" }), await client.send({ type: "providers.test", provider: "llmgateway" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "llmgateway", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: GATEWAY_MODELS } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "reasoning-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "llmgateway:text-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "llmgateway:text-fixture" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "llmgateway")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["LLMGATEWAY_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(GATEWAY_TOKEN)
    expect(await client.send({ type: "providers.set", provider: "llmgateway", enabled: false })).toMatchObject({ ok: true, result: { provider: { enabled: false } } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
