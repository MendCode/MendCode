import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "alibaba-private-fixture-0123456789"
const endpoint = "http://127.0.0.1:1234/compatible-mode/v1"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-13-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(endpoint)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  return init.method === "GET" ? Response.json({ data: [{ id: "qwen-plus", name: "Qwen Plus" }, { id: "qwen3-coder-plus" }] }) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
}

describe("B10.13 Alibaba provider service", () => {
  test("uses additive compatible commands without broadening read-only authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "alibaba", baseUrl: endpoint, apiKeyEnv: "DASHSCOPE_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment key is off by default; enable persists and disable applies to the router live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { DASHSCOPE_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()).toMatchObject([{ id: "alibaba", type: "openai-compatible", enabled: false, hasKey: true, source: "env" }])
    expect(providers.models()).toEqual([])
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "alibaba:qwen-plus", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "alibaba", enabled: true, baseUrl: "http://dashscope-intl.aliyuncs.com/compatible-mode/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "alibaba", baseUrl: endpoint, apiKeyEnv: "DASHSCOPE_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.set({ id: "alibaba", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models()[0]).toMatchObject({ id: "alibaba:qwen-plus", provider: "alibaba", efforts: [] })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { DASHSCOPE_API_KEY: KEY } }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "alibaba", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("legacy Alibaba SDK configs stay off, use the native transport and cannot bypass endpoint policy", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { alibaba: { npm: "@ai-sdk/alibaba", apiKey: KEY, options: { baseURL: endpoint } } } }))
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "openai-compatible", hasKey: true })
    expect(providers.set({ id: "alibaba", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await providers.test("alibaba")).toMatchObject({ ok: true, model: "qwen-plus" })
    expect(providers.set({ id: "alibaba", baseUrl: "http://dashscope.aliyuncs.com/compatible-mode/v1" })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { alibaba: { enabled: true, apiKey: KEY, type: "openai", baseUrl: "http://public.example/v1" } } }))
    const unsafe = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("transport must not run") } })
    expect(unsafe.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(unsafe.models()).toEqual([])
    expect(await unsafe.test("alibaba")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await unsafe.refresh("alibaba")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
  })

  test("offline auth reports and logout preserve configuration without exposing the token", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("alibaba")).toEqual({ alibaba: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("alibaba")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    expect(providers.set({ id: "alibaba", baseUrl: endpoint, apiKey: KEY, enabled: true })).toMatchObject({ ok: true })
    expect(auth.status("alibaba")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("alibaba")])).not.toContain(KEY)
    expect(providers.logout!("alibaba")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.alibaba).toEqual({ baseUrl: endpoint, enabled: true })
    expect(auth.status("alibaba")[0]!.state).toBe("none")
    expect(providers.models()).toEqual([])
  })

  test("failed model refresh preserves the catalog and scrubs the token", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => new Response(`rejected ${KEY}`, { status: 401 }) })
    providers.set({ id: "alibaba", baseUrl: endpoint, apiKey: KEY, enabled: true, models: [{ id: "qwen-plus" }] })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    const reply = await providers.refresh("alibaba")
    expect(reply).toMatchObject({ ok: false, message: expect.stringContaining("401") })
    expect(JSON.stringify(reply)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon and typed client: catalog, login, refresh, test, model choice and disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "alibaba:qwen-plus" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-13" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("alibaba")).toMatchObject({ ok: true, methods: { alibaba: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("alibaba")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "alibaba", baseUrl: endpoint, apiKey: KEY, enabled: true }), await client.send({ type: "providers.refresh", provider: "alibaba" }), await client.send({ type: "providers.test", provider: "alibaba" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "alibaba", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: [{ id: "qwen-plus" }, { id: "qwen3-coder-plus" }] } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "qwen-plus" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "alibaba:qwen3-coder-plus" } })).toMatchObject({ ok: true, result: { effective: { model: "alibaba:qwen3-coder-plus" } } })
    const catalog = await client.providersCatalog()
    expect(catalog.ok && catalog.report.providers.find((provider) => provider.id === "alibaba")).toMatchObject({ configured: true, enabled: true, requiredEnv: ["DASHSCOPE_API_KEY"] })
    expect(JSON.stringify(replies)).not.toContain(KEY)
    expect(await client.send({ type: "providers.set", provider: "alibaba", enabled: false })).toMatchObject({ ok: true, result: { provider: { enabled: false } } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
