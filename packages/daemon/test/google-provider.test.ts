import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { Command, ProviderType, createIdFactory, isReadOnlyCommand, type ModelsReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "gemini-private-fixture-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-03-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (_url, init) => {
  expect(new Headers(init.headers).get("x-goog-api-key")).toBe(KEY)
  return init.method === "GET" ? Response.json({ models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] }] }) : new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } })}\n\n`)
}

describe("B10.03 Gemini provider service", () => {
  test("additive protocol type and existing mutation boundaries", () => {
    const ids = createIdFactory()
    expect(ProviderType.parse("google")).toBe("google")
    for (const type of ["openai", "anthropic", "openai-compatible"]) expect(ProviderType.safeParse(type).success).toBe(true)
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "google", providerType: "google", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("key alone never enables Gemini; explicit enable persists, routing and disable apply live", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { GOOGLE_GENERATIVE_AI_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "google", type: "google", hasKey: true, enabled: false, source: "env" })
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "google", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must never reach subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "google:gemini-2.5-flash", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "google", enabled: true, baseUrl: "http://127.0.0.1:1234/v1beta" })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models()[0]).toMatchObject({ id: "google:gemini-2.5-flash", provider: "google", variants: { high: {}, max: {} } })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { GOOGLE_GENERATIVE_AI_API_KEY: KEY } }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "google", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("auth reports stay offline and logout removes only v2's stored key", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("google")).toEqual({ google: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("google")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "none" })
    expect(auth.status("google")[0]!.state).toBe("none")
    providers.set({ id: "google", apiKey: KEY, enabled: true })
    expect(auth.status("google")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("google")])).not.toContain(KEY)
    expect(providers.logout!("google")).toMatchObject({ ok: true, provider: { hasKey: false, enabled: true } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.google).toEqual({ enabled: true })
    expect(auth.status("google")[0]!.state).toBe("none")
  })

  test("failed refresh preserves the catalog; a custom native endpoint requires a token", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => Response.json({ models: [], nextPageToken: "repeat" }) })
    providers.set({ id: "google", apiKey: KEY, enabled: true })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(await providers.refresh("google")).toMatchObject({ ok: false, message: expect.stringContaining("invalid model pagination") })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    expect(providers.set({ id: "custom-gemini", providerType: "google", baseUrl: "http://127.0.0.1:1234/v1beta", apiKey: KEY })).toMatchObject({ ok: true, provider: { enabled: false, hasKey: true } })
    expect(providers.set({ id: "local-gemini", providerType: "google", baseUrl: "http://127.0.0.1:1234/v1beta", enabled: true, models: [{ id: "gemini-2.5-flash" }] })).toMatchObject({ ok: true, provider: { hasKey: false, error: expect.stringContaining("no API key") } })
    expect(providers.models().some((model) => model.provider === "local-gemini")).toBe(false)
  })

  test("daemon + typed client: auth, enable, refresh, native test and model selection", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "google:gemini-2.5-flash" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-03" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("google")).toMatchObject({ ok: true, methods: { google: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("google")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "google", apiKey: KEY, enabled: true, baseUrl: "http://127.0.0.1:1234/v1beta" }), await client.send({ type: "providers.refresh", provider: "google" }), await client.send({ type: "providers.test", provider: "google" })]
    expect(replies[0]).toMatchObject({ ok: true, result: { provider: { id: "google", type: "google", enabled: true } } })
    expect(replies[1]).toMatchObject({ ok: true, result: { provider: { models: [{ id: "gemini-2.5-flash" }] } } })
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "gemini-2.5-flash" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const selected = await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "google:gemini-2.5-flash", variant: "max" } })
    expect(selected.ok && (selected.result as ModelsReport).effective).toMatchObject({ model: "google:gemini-2.5-flash", variant: "max", parameters: { thinkingConfig: { thinkingBudget: 24_576 } } })
    expect(JSON.stringify([...replies, selected, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
