import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { ProviderInfo, type SessionId } from "@mendcode/protocol"
import { AIG_ID, AIG_MODEL, AIG_MODELS, AIG_TOKEN, AIG_URL, aigDone, aigRequest, collectAig } from "../../engine-native/test/cloudflare-ai-gateway-fixtures"
import { startDaemon } from "../src"
import { gatewayConfig } from "../src/cloudflare-ai-gateway"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-22-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url).toBe(`${AIG_URL}/chat/completions`)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("cf-aig-authorization")).toBe(`Bearer ${AIG_TOKEN}`)
  return aigDone()
}

describe("B10.22 gateway daemon and client", () => {
  test("environment token aliases stay off, IDs route only without endpoint, enabling requires token/loopback", async () => {
    for (const variable of ["CLOUDFLARE_API_TOKEN", "CF_AIG_TOKEN"]) {
      const env = { [variable]: AIG_TOKEN, CLOUDFLARE_ACCOUNT_ID: "env-account", CLOUDFLARE_GATEWAY_ID: "env-gateway" }
      const providers = createProviderService({ dir: temp(), env, fetch: async () => { throw new Error("no network") } })
      expect(providers.list()).toMatchObject([{ id: AIG_ID, enabled: false, hasKey: true, source: "env", cloudflareAiGateway: { accountId: "env-account", gatewayId: "env-gateway" } }])
      expect(providers.models()).toEqual([])
      expect(providers.set({ id: AIG_ID, enabled: true, baseUrl: "http://gateway.ai.cloudflare.com/v1/env-account/env-gateway/compat" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
      expect(await providers.test(AIG_ID)).toMatchObject({ ok: false })
      expect(await providers.refresh(AIG_ID)).toMatchObject({ ok: false })
      expect(providers.set({ id: AIG_ID, baseUrl: AIG_URL, models: AIG_MODELS })).toMatchObject({ ok: true, provider: { enabled: false } })
      expect(providers.set({ id: AIG_ID, enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
      expect(await providers.refresh(AIG_ID)).toMatchObject({ ok: true, provider: { models: AIG_MODELS } })
    }
    const providers = createProviderService({ dir: temp(), env: {} })
    expect(providers.set({ id: AIG_ID, baseUrl: AIG_URL, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("token") })
    expect(providers.set({ id: AIG_ID, baseUrl: AIG_URL, apiKey: AIG_TOKEN, models: [{ id: "no-prefix" }] })).toMatchObject({ ok: false, message: expect.stringContaining("provider/model") })
    expect(providers.set({ id: "openai", cloudflareAiGateway: {} })).toMatchObject({ ok: false })
  })

  test("legacy metadata/cache options normalize without SDK loading; explicit URL bypasses stale env IDs", async () => {
    const dir = temp()
    const legacy = { npm: "ai-gateway-provider", apiKey: AIG_TOKEN, options: { baseURL: AIG_URL, accountId: "stored", gateway: "stored-gateway", cacheTtl: 0, skipCache: false, collectLog: false, headers: { "cf-aig-metadata": '{"project":"legacy-project"}' } }, models: AIG_MODELS }
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { [AIG_ID]: legacy } }))
    const providers = createProviderService({ dir, env: { CLOUDFLARE_ACCOUNT_ID: "invalid env", CLOUDFLARE_GATEWAY_ID: "invalid env" }, fetch: async (url, init) => {
      expect(new Headers(init.headers).get("cf-aig-metadata")).toBe('{"project":"legacy-project"}')
      return fake(url, init)
    } })
    expect(providers.list()[0]).toMatchObject({ enabled: false, cloudflareAiGateway: { accountId: "stored", gatewayId: "stored-gateway", hasMetadata: true, cacheTtl: 0, skipCache: false, collectLog: false } })
    expect(providers.set({ id: AIG_ID, enabled: true })).toMatchObject({ ok: true })
    expect(await providers.test(AIG_ID)).toMatchObject({ ok: true, model: AIG_MODEL })
    expect(gatewayConfig({ options: { metadata: { project: "option" }, headers: { "cf-aig-metadata": '{"project":"header"}' } } }).metadata).toEqual({ project: "option" })
    expect(gatewayConfig({ options: { headers: { "cf-aig-metadata": "bad JSON" } } })).toEqual({})
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { [AIG_ID]: { ...legacy, enabled: true, type: "openai", baseUrl: "http://public.example/compat" } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("must not request") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.test(AIG_ID)).toMatchObject({ ok: false })
    expect(await unsafe.refresh(AIG_ID)).toMatchObject({ ok: false })
  })

  test("private options persist atomically, edits merge/clear, auth stays offline and logout preserves routing", async () => {
    const dir = temp()
    const env = { CLOUDFLARE_API_TOKEN: AIG_TOKEN, CF_AIG_TOKEN: "alias-private-fixture" }
    const providers = createProviderService({ dir, env, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env })
    cleanup.push(auth.stop)
    expect(auth.methods(AIG_ID)).toEqual({ [AIG_ID]: [{ id: "api-key", type: "api", label: "Cloudflare Gateway token", available: true }] })
    expect(auth.plan(AIG_ID)).toMatchObject({ callsProvider: false, writesSecrets: false, callback: "none" })
    const privateValue = "private-project-fixture"
    const saved = providers.set({ id: AIG_ID, baseUrl: AIG_URL, apiKey: "stored-private-fixture", enabled: true, models: AIG_MODELS, cloudflareAiGateway: { accountId: "team", gatewayId: "coding", metadata: { project: privateValue }, cacheKey: "private-cache-fixture", cacheTtl: 60, collectLog: false } })
    expect(saved).toMatchObject({ ok: true, provider: { hasKey: true, cloudflareAiGateway: { hasMetadata: true, hasCacheKey: true } } })
    if (!saved.ok) throw new Error("save failed")
    expect(ProviderInfo.safeParse(saved.provider).success).toBe(true)
    expect(saved.provider.keyTail).toBeUndefined()
    for (const secret of [AIG_TOKEN, "stored-private-fixture", privateValue, "private-cache-fixture"]) expect(JSON.stringify([saved, providers.list(), providers.inventory!(), auth.status(AIG_ID)])).not.toContain(secret)
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(await providers.refresh(AIG_ID)).toMatchObject({ ok: true })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    expect(providers.set({ id: AIG_ID, cloudflareAiGateway: { cacheTtl: 0, metadata: null, cacheKey: null } })).toMatchObject({ ok: true, provider: { cloudflareAiGateway: { gatewayId: "coding", cacheTtl: 0, collectLog: false, hasMetadata: false, hasCacheKey: false } } })
    expect(providers.logout!(AIG_ID)).toMatchObject({ ok: true, provider: { hasKey: true } })
    delete (env as Partial<typeof env>).CLOUDFLARE_API_TOKEN
    delete (env as Partial<typeof env>).CF_AIG_TOKEN
    expect(auth.status(AIG_ID)[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers[AIG_ID]).toMatchObject({ baseUrl: AIG_URL, models: AIG_MODELS, cloudflareAiGateway: { gatewayId: "coding" } })
  })

  test("router reflects token priority and live disablement; empty retained catalogs are actionable", async () => {
    const env = { CLOUDFLARE_API_TOKEN: AIG_TOKEN, CF_AIG_TOKEN: "alias-private-fixture" }
    const providers = createProviderService({ dir: temp(), env, fetch: fake })
    expect(providers.set({ id: AIG_ID, baseUrl: AIG_URL, apiKey: "stored-private-fixture", models: AIG_MODELS, enabled: true }).ok).toBe(true)
    const router = createProviderRouter({ fallback: { id: "fallback", model: "default", async *stream() { throw new Error("no fallback") } }, providers: providers.runtime })
    expect((await collectAig(router.stream(aigRequest({ model: `${AIG_ID}:${AIG_MODEL}` })))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(providers.set({ id: AIG_ID, enabled: false }).ok).toBe(true)
    await expect(collectAig(router.stream(aigRequest({ model: `${AIG_ID}:${AIG_MODEL}` })))).rejects.toThrow("disabled")
    const empty = createProviderService({ dir: temp(), env: {} })
    empty.set({ id: AIG_ID, baseUrl: AIG_URL, apiKey: AIG_TOKEN, enabled: true })
    expect(await empty.refresh(AIG_ID)).toMatchObject({ ok: false, message: expect.stringContaining("provider/model") })
  })

  test("socket protocol and typed client save, authenticate, retain, test, select and disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `${AIG_ID}:${AIG_MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-22" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods(AIG_ID)).toMatchObject({ ok: true, methods: { [AIG_ID]: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan(AIG_ID)).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const saved = await client.configureCloudflareAIGateway({ baseUrl: AIG_URL, apiKey: AIG_TOKEN, enabled: true, models: AIG_MODELS, cloudflareAiGateway: { gatewayId: "coding", metadata: { project: "private-project-fixture" } } })
    expect(saved).toMatchObject({ ok: true, provider: { cloudflareAiGateway: { gatewayId: "coding", hasMetadata: true } } })
    expect(await client.send({ type: "providers.refresh", provider: AIG_ID })).toMatchObject({ ok: true, result: { provider: { models: AIG_MODELS } } })
    expect(await client.send({ type: "providers.test", provider: AIG_ID })).toMatchObject({ ok: true, result: { ok: true, model: AIG_MODEL } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `${AIG_ID}:${AIG_MODEL}` } })).toMatchObject({ ok: true, result: { effective: { model: `${AIG_ID}:${AIG_MODEL}` } } })
    expect(JSON.stringify(saved)).not.toContain("private-project-fixture")
    expect(await client.configureCloudflareAIGateway({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
