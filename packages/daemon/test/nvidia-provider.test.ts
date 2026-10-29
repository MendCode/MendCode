import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectNvidia, nvidiaFake, nvidiaRequest, NVIDIA_MODELS, NVIDIA_TOKEN, NVIDIA_URL } from "../../engine-native/test/nvidia-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-17-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(`${NVIDIA_URL}/`)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${NVIDIA_TOKEN}`)
  return nvidiaFake(url, init)
}

describe("B10.17 NVIDIA daemon, protocol and client", () => {
  test("compatible provider commands need no new wire variant or read-only authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "nvidia", baseUrl: NVIDIA_URL, apiKeyEnv: "NVIDIA_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("env-only credentials stay off; explicit local enablement, rotation and disablement apply live", async () => {
    const dir = temp()
    const env = { NVIDIA_API_KEY: NVIDIA_TOKEN }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => {
      calls++
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${env.NVIDIA_API_KEY}`)
      return nvidiaFake(url, init)
    } })
    expect(providers.list()).toMatchObject([{ id: "nvidia", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "nvidia", enabled: true, baseUrl: "http://integrate.api.nvidia.com/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "nvidia", baseUrl: NVIDIA_URL, apiKeyEnv: "NVIDIA_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "nvidia", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, models: [] } })
    expect(calls).toBe(0)
    expect(await providers.refresh("nvidia")).toMatchObject({ ok: true, provider: { models: [NVIDIA_MODELS[1], NVIDIA_MODELS[0]] } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = nvidiaRequest({ model: "nvidia:nvidia/tool-fixture" })
    expect((await collectNvidia(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    env.NVIDIA_API_KEY += "-rotated"
    await collectNvidia(router.stream(request))
    expect(createProviderService({ dir, env }).models().find((model) => model.id === request.model)).toMatchObject({ provider: "nvidia", contextWindow: 128_000, efforts: ["low", "medium", "high"] })
    providers.set({ id: "nvidia", enabled: false })
    await expect(collectNvidia(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(3)
  })

  test("v1 SDK entries cannot autoload, switch wire type or escape loopback", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { nvidia: { npm: "@ai-sdk/openai-compatible", apiKey: NVIDIA_TOKEN, options: { baseURL: NVIDIA_URL }, models: NVIDIA_MODELS } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible" })
    expect(providers.set({ id: "nvidia", providerType: "openai" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "nvidia", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("nvidia")).toMatchObject({ ok: true, model: "nvidia/tool-fixture" })
    expect(providers.set({ id: "nvidia", baseUrl: "http://integrate.api.nvidia.com/v1" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { nvidia: { enabled: true, apiKey: NVIDIA_TOKEN, type: "google", baseUrl: "http://public.example/v1", models: NVIDIA_MODELS } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("nvidia")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh("nvidia")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth and private persistence redact credentials; logout keeps provider settings", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("nvidia")).toEqual({ nvidia: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("nvidia")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    providers.set({ id: "nvidia", baseUrl: NVIDIA_URL, apiKey: NVIDIA_TOKEN, enabled: true, models: NVIDIA_MODELS })
    expect(auth.status("nvidia")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("nvidia")])).not.toContain(NVIDIA_TOKEN)
    expect(providers.logout!("nvidia")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.nvidia).toEqual({ baseUrl: NVIDIA_URL, enabled: true, models: NVIDIA_MODELS })
    expect(auth.status("nvidia")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
  })

  test("minimal refresh retains saved capabilities; empty and failed refreshes preserve the catalog", async () => {
    const dir = temp()
    let response = () => Response.json({ data: NVIDIA_MODELS.map(({ id }) => ({ id })) })
    const providers = createProviderService({ dir, env: {}, fetch: async () => response() })
    providers.set({ id: "nvidia", baseUrl: NVIDIA_URL, apiKey: NVIDIA_TOKEN, enabled: true, models: NVIDIA_MODELS })
    expect(await providers.refresh("nvidia")).toMatchObject({ ok: true, provider: { models: [NVIDIA_MODELS[1], NVIDIA_MODELS[0]] } })
    for (const empty of [true, false]) {
      response = () => empty ? Response.json({ data: [] }) : new Response(`rejected ${NVIDIA_TOKEN}`, { status: 401 })
      const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
      const reply = await providers.refresh("nvidia")
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(empty ? "no models" : "401") })
      expect(JSON.stringify(reply)).not.toContain(NVIDIA_TOKEN)
      expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    }
  })

  test("Unix daemon and typed client integrate auth, save, refresh, test, catalog, model selection and logout", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "nvidia:nvidia/tool-fixture" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-17" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("nvidia")).toMatchObject({ ok: true, methods: { nvidia: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("nvidia")).toMatchObject({ ok: true, plan: { callsProvider: false, writesSecrets: false } })
    const replies = [await client.send({ type: "providers.set", provider: "nvidia", baseUrl: NVIDIA_URL, apiKey: NVIDIA_TOKEN, enabled: true }), await client.send({ type: "providers.refresh", provider: "nvidia" }), await client.send({ type: "providers.test", provider: "nvidia" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "nvidia", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: [NVIDIA_MODELS[1], NVIDIA_MODELS[0]] } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "nvidia/text-fixture" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "nvidia:nvidia/tool-fixture" } })).toMatchObject({ ok: true, result: { effective: { model: "nvidia:nvidia/tool-fixture" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "nvidia")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["NVIDIA_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(NVIDIA_TOKEN)
    expect(await client.send({ type: "providers.logout", provider: "nvidia" })).toMatchObject({ ok: true })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
