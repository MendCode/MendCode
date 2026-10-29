import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, ProviderConfig, ProviderInfo, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { CF_ID, CF_MODEL, CF_MODELS, CF_TOKEN, CF_URL, cfDone, cfRequest, collectCf } from "../../engine-native/test/cloudflare-workers-ai-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-21-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url).toBe(`${CF_URL}/chat/completions`)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${CF_TOKEN}`)
  return cfDone()
}

describe("B10.21 Workers AI daemon, protocol and client", () => {
  test("account metadata is additive and commands retain their original authority", () => {
    const ids = createIdFactory()
    const envelope = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: CF_ID }
    expect(Command.safeParse({ ...envelope, baseUrl: CF_URL, apiKeyEnv: "CLOUDFLARE_API_KEY", cloudflareWorkersAi: { accountId: "local-account" }, enabled: true }).success).toBe(true)
    expect(Command.safeParse({ ...envelope, cloudflareWorkersAi: { accountId: "../account" } }).success).toBe(false)
    expect(ProviderConfig.safeParse({ cloudflareWorkersAi: { accountId: null } }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment credentials stay off, enabling requires loopback and token, router disables live", async () => {
    const dir = temp()
    let calls = 0
    const env = { CLOUDFLARE_API_KEY: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: "environment" }
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: CF_ID, enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: CF_ID, enabled: true, baseUrl: "http://api.cloudflare.com/client/v4/accounts/environment/ai/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: CF_ID, baseUrl: CF_URL, cloudflareWorkersAi: { accountId: "stored" } })).toMatchObject({ ok: true, provider: { enabled: false, cloudflareWorkersAi: { accountId: "environment" } } })
    expect(await providers.test(CF_ID)).toMatchObject({ ok: false })
    expect(await providers.refresh(CF_ID)).toMatchObject({ ok: false })
    expect(calls).toBe(0)
    expect(providers.set({ id: CF_ID, enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, models: CF_MODELS } })
    expect(await providers.refresh(CF_ID)).toMatchObject({ ok: true, provider: { models: CF_MODELS } })
    expect(calls).toBe(0)
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = cfRequest({ model: `${CF_ID}:${CF_MODEL}` })
    expect((await collectCf(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env }).models()[0]).toMatchObject({ id: `${CF_ID}:${CF_MODEL}`, provider: CF_ID, contextWindow: 24_000 })
    providers.set({ id: CF_ID, enabled: false })
    await expect(collectCf(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
    expect(createProviderService({ dir: temp(), env: {} }).set({ id: CF_ID, baseUrl: CF_URL, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("Bearer token") })
  })

  test("legacy options use account metadata without SDK autoload; unsafe stored endpoints cannot make requests", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { [CF_ID]: { npm: "@ai-sdk/openai-compatible", apiKey: CF_TOKEN, options: { baseURL: CF_URL, accountId: "metadata" }, models: CF_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, cloudflareWorkersAi: { accountId: "metadata" } })
    expect(providers.set({ id: CF_ID, enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test(CF_ID)).toMatchObject({ ok: true, model: CF_MODEL })
    expect(providers.set({ id: CF_ID, baseUrl: "http://api.cloudflare.com/v1" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { [CF_ID]: { enabled: true, apiKey: CF_TOKEN, type: "openai", baseUrl: "http://public.example/v1", models: CF_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test(CF_ID)).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh(CF_ID)).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth, private persistence and logout keep public settings and never expose token fragments", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods(CF_ID)).toEqual({ [CF_ID]: [{ id: "api-key", type: "api", label: "Cloudflare Bearer token", available: true }] })
    expect(auth.plan(CF_ID)).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    expect(providers.set({ id: "openai", cloudflareWorkersAi: {} })).toMatchObject({ ok: false })
    expect(providers.set({ id: CF_ID, baseUrl: CF_URL, apiKey: CF_TOKEN, enabled: true, cloudflareWorkersAi: { accountId: "stored" }, models: CF_MODELS })).toMatchObject({ ok: true })
    expect(auth.status(CF_ID)[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(ProviderInfo.safeParse(providers.list()[0]).success).toBe(true)
    expect(providers.list()[0]!.keyTail).toBeUndefined()
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status(CF_ID)])).not.toContain(CF_TOKEN)
    expect(providers.logout!(CF_ID)).toMatchObject({ ok: true, provider: { hasKey: false, cloudflareWorkersAi: { accountId: "stored" } } })
    const saved = JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers[CF_ID]
    expect(saved).toMatchObject({ baseUrl: CF_URL, enabled: true, models: CF_MODELS, cloudflareWorkersAi: { accountId: "stored" } })
    expect(saved.apiKey).toBeUndefined()
    expect(providers.models()).toEqual([])
  })

  test("daemon and typed client save, retain catalog, test, select and disable without a real service", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `${CF_ID}:${CF_MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-21" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods(CF_ID)).toMatchObject({ ok: true, methods: { [CF_ID]: [{ id: "api-key" }] } })
    const replies = [await client.configureCloudflareWorkersAI({ baseUrl: CF_URL, apiKey: CF_TOKEN, cloudflareWorkersAi: { accountId: "stored" }, enabled: true }), await client.send({ type: "providers.refresh", provider: CF_ID }), await client.send({ type: "providers.test", provider: CF_ID })]
    expect(replies[0]).toMatchObject({ ok: true, provider: { id: CF_ID, enabled: true, cloudflareWorkersAi: { accountId: "stored" } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: CF_MODELS } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: CF_MODEL } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `${CF_ID}:${CF_MODEL}` } })).toMatchObject({ ok: true, result: { effective: { model: `${CF_ID}:${CF_MODEL}` } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === CF_ID)).toMatchObject({ configured: true, enabled: true, requiredEnv: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"] })
    expect(JSON.stringify(replies)).not.toContain(CF_TOKEN)
    expect(await client.configureCloudflareWorkersAI({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
