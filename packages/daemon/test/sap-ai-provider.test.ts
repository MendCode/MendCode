import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, ProviderInfo, type SessionId } from "@mendcode/protocol"
import { collectSap, sapFake, sapRequest, SAP_KEY, SAP_MODELS, SAP_SECRET, SAP_SERVICE, SAP_TOKEN, SAP_URL } from "../../engine-native/test/sap-ai-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-18-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe("B10.18 SAP daemon, protocol and client", () => {
  test("adds compatible SAP settings without expanding read-only authority", () => {
    const ids = createIdFactory()
    const command = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "sap-ai-core", apiKey: SAP_KEY, sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" }, enabled: true }
    expect(Command.safeParse(command).success).toBe(true)
    expect(Command.safeParse({ ...command, sapAi: { deploymentId: "../escape" } }).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("env-only service keys stay off; explicit enablement, env defaults, live rotation and disablement apply", async () => {
    const dir = temp()
    const env = { AICORE_SERVICE_KEY: SAP_KEY, AICORE_DEPLOYMENT_ID: "deployment-fixture", AICORE_RESOURCE_GROUP: "test" }
    let exchanges = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) { exchanges++; expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from(`sap-fixture-client:${JSON.parse(env.AICORE_SERVICE_KEY).clientsecret}`).toString("base64")}`) }
      else expect(new Headers(init.headers).get("AI-Resource-Group")).toBe(env.AICORE_RESOURCE_GROUP)
      return sapFake(url, init)
    } })
    expect(providers.list()).toMatchObject([{ id: "sap-ai-core", enabled: false, baseUrl: SAP_URL, source: "env", sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" } }])
    expect(providers.models()).toEqual([])
    expect(exchanges).toBe(0)
    expect(providers.set({ id: "sap-ai-core", enabled: true, models: SAP_MODELS })).toMatchObject({ ok: true, provider: { enabled: true } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    await collectSap(router.stream(sapRequest({ model: "sap-ai-core:chat-fixture" })))
    env.AICORE_SERVICE_KEY = JSON.stringify({ ...SAP_SERVICE, clientsecret: `${SAP_SECRET}-rotated` })
    await collectSap(router.stream(sapRequest({ model: "sap-ai-core:chat-fixture" })))
    env.AICORE_RESOURCE_GROUP = "rotated"
    await collectSap(router.stream(sapRequest({ model: "sap-ai-core:chat-fixture" })))
    expect(exchanges).toBe(3)
    expect(createProviderService({ dir, env }).models()[0]).toMatchObject({ id: "sap-ai-core:chat-fixture", provider: "sap-ai-core", contextWindow: 128_000 })
    providers.set({ id: "sap-ai-core", enabled: false })
    await expect(collectSap(router.stream(sapRequest({ model: "sap-ai-core:chat-fixture" })))).rejects.toThrow("disabled")
  })

  test("private service-key storage, offline auth reports and logout never expose JSON tails or components", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("sap-ai-core")).toEqual({ "sap-ai-core": [{ id: "api-key", type: "api", label: "Service key (JSON)", available: true }] })
    expect(auth.plan("sap-ai-core")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    expect(providers.set({ id: "sap-ai-core", apiKey: SAP_KEY, enabled: true, models: SAP_MODELS, sapAi: { deploymentId: "deployment-fixture" } })).toMatchObject({ ok: true })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    const info = providers.list()[0]!
    expect(ProviderInfo.safeParse(info).success).toBe(true)
    expect(info.keyTail).toBeUndefined()
    expect(auth.status("sap-ai-core")[0]).toMatchObject({ state: "authorized", source: "v2" })
    for (const secret of [SAP_KEY, SAP_SERVICE.clientid, SAP_SECRET, SAP_TOKEN]) expect(JSON.stringify([info, providers.inventory!(), auth.status("sap-ai-core")])).not.toContain(secret)
    expect(providers.logout!("sap-ai-core")).toMatchObject({ ok: true, provider: { hasKey: false, enabled: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers["sap-ai-core"]).toEqual({ enabled: true, sapAi: { deploymentId: "deployment-fixture" }, models: SAP_MODELS })
    expect(providers.models()).toEqual([])
  })

  test("v1 SDK entries stay opt-in and use the native adapter; file edits cannot bypass loopback", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { "sap-ai-core": { npm: "@jerome-benoit/sap-ai-provider-v2", apiKey: SAP_KEY, models: SAP_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: sapFake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible" })
    expect(providers.set({ id: "sap-ai-core", providerType: "openai" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "sap-ai-core", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("sap-ai-core")).toMatchObject({ ok: true })
    expect(providers.set({ id: "sap-ai-core", baseUrl: "http://public.example/v2" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "sap-ai-core", apiKey: "bad JSON" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "openai", sapAi: {} })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { "sap-ai-core": { enabled: true, apiKey: SAP_KEY, baseUrl: "http://public.example/v2", models: SAP_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("must not run transport") } })
    expect(unsafe.list()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("sap-ai-core")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
  })

  test("refresh preserves saved tools, limits and prices; empty/failed refresh never overwrites the catalog", async () => {
    const dir = temp()
    let fail: "empty" | "auth" | undefined
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => url.endsWith("/models") && fail ? fail === "empty" ? Response.json({ resources: [] }) : new Response(SAP_SECRET, { status: 401 }) : sapFake(url, init) })
    providers.set({ id: "sap-ai-core", apiKey: SAP_KEY, enabled: true, models: SAP_MODELS })
    expect(await providers.refresh("sap-ai-core")).toMatchObject({ ok: true, provider: { models: SAP_MODELS } })
    for (const mode of ["empty", "auth"] as const) {
      fail = mode
      const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
      const result = await providers.refresh("sap-ai-core")
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(SAP_SECRET)
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    }
  })

  test("Unix daemon and typed client integrate SAP save, auth, refresh, test, model choice and logout", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: sapFake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "sap-ai-core:chat-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-18" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("sap-ai-core")).toMatchObject({ ok: true, methods: { "sap-ai-core": [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("sap-ai-core")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "sap-ai-core", apiKey: SAP_KEY, sapAi: { resourceGroup: "test" }, enabled: true }), await client.send({ type: "providers.refresh", provider: "sap-ai-core" }), await client.send({ type: "providers.test", provider: "sap-ai-core" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "sap-ai-core", enabled: true, sapAi: { resourceGroup: "test" } } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: [{ id: "chat-fixture" }, { id: "text-fixture" }] } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "chat-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "sap-ai-core:chat-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "sap-ai-core:chat-fixture" } } })
    expect(JSON.stringify(replies)).not.toContain(SAP_SECRET)
    expect(await client.send({ type: "providers.logout", provider: "sap-ai-core" })).toMatchObject({ ok: true })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
