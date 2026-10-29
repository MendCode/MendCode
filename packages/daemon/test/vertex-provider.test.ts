import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { Command, ProviderConfig, ProviderInfo, VertexOptions, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const TOKEN = "vertex-daemon-fixture-never-print-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-vertex-daemon-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(url).toContain("/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
  expect(init.redirect).toBe("error")
  return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n')
}

describe("B10.04 Vertex daemon, protocol and client", () => {
  test("additive routing schema and config; credentials never enter public options or read-only commands", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "google-vertex", vertex: { project: "test-project", location: "global" } }).success).toBe(true)
    expect(ProviderConfig.parse({ type: "google-vertex", vertex: { tokenEnv: "TEAM_TOKEN" } }).type).toBe("google-vertex")
    for (const input of [{ project: "../escape" }, { location: "global/escape" }, { accessToken: TOKEN }, { credentials: TOKEN }, { endpoint: "http://public.example" }]) expect(VertexOptions.safeParse(input).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment preset stays off; explicit enable, namespaced routing, rotation and disable apply live", async () => {
    const dir = temp(), env = { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_VERTEX_LOCATION: "global", GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "google-vertex", type: "google-vertex", enabled: false, hasKey: false, authReady: true, source: "env", baseUrl: "https://aiplatform.googleapis.com/v1" })
    expect(providers.models()).toEqual([])
    expect((await providers.test("google-vertex"))?.error).toContain("disabled")
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "google-vertex:gemini-2.5-flash", signal: new AbortController().signal }
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must never reach subscription") } }, providers: providers.runtime })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "google-vertex", enabled: true }).ok).toBe(true)
    expect(providers.models()[0]).toMatchObject({ id: "google-vertex:gemini-2.5-flash", provider: "google-vertex" })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "google-vertex", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("offline inventory/auth plan, safe reports and catalog refresh preserve provider bytes", async () => {
    const dir = temp(), env = { TEAM_TOKEN: TOKEN }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    providers.set({ id: "google-vertex", enabled: true, vertex: { project: "test-project", location: "global", tokenEnv: "TEAM_TOKEN" }, models: [{ id: "gemini-2.5-flash", context: 128_000 }] })
    const auth = createProviderAuth({ dir, providers, env: {} }); cleanup.push(auth.stop)
    expect(auth.methods("google-vertex")["google-vertex"]!.map((entry) => entry.id)).toEqual(["adc"])
    expect(auth.plan("google-vertex")).toMatchObject({ callsProvider: false, writesSecrets: false, callback: "none", method: { id: "adc" } })
    expect(auth.status("google-vertex")[0]).toMatchObject({ state: "authorized", source: "none", accessTokenPresent: false })
    expect(providers.inventory!().find((entry) => entry.id === "google-vertex")).toMatchObject({ authMode: "google-adc", authReady: true, credentialStored: false })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(await providers.refresh("google-vertex")).toMatchObject({ ok: true, provider: { models: [{ id: "gemini-2.5-flash", context: 128_000 }] } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    expect(calls).toBe(0)
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(ProviderInfo.safeParse(providers.list()[0]).success).toBe(true)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status(), before])).not.toContain(TOKEN)
    expect((await providers.test("google-vertex"))?.ok).toBe(true)
    expect(providers.logout!("google-vertex")).toMatchObject({ ok: false, code: "target_mismatch" })
  })

  test("v1 project/location options and installed SDK alias resolve natively; endpoint can return to regional routing", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { "google-vertex": { npm: "@ai-sdk/google-vertex", options: { project: "test-project", location: "global" }, models: [{ id: "gemini-2.5-flash" }] } } }))
    const providers = createProviderService({ dir, env: { GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: "google-vertex", vertex: { project: "test-project", location: "global" } })
    providers.set({ id: "google-vertex", enabled: true, baseUrl: "http://127.0.0.1:9911/v1" })
    expect((await providers.test("google-vertex"))?.ok).toBe(true)
    providers.set({ id: "google-vertex", vertex: { endpoint: null, location: "europe-west4" } })
    expect(providers.list()[0]!.baseUrl).toBe("https://europe-west4-aiplatform.googleapis.com/v1")
  })

  test("missing project, unsafe routes and credentials reject safely; invalid legacy options remain isolated", () => {
    const providers = createProviderService({ dir: temp(), env: {} })
    providers.set({ id: "google-vertex", enabled: true })
    expect(providers.list()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("needs GOOGLE_CLOUD_PROJECT") })
    for (const input of [{ baseUrl: "http://remote.example" }, { baseUrl: "https://user:secret@example.com" }, { apiKey: TOKEN }, { apiKeyEnv: "TEAM_TOKEN" }, { vertex: { location: "global/escape" } }, { models: [{ id: "../escape" }] }]) expect(providers.set({ id: "google-vertex", ...input }).ok).toBe(false)
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { "google-vertex": { enabled: true, options: { project: "test-project", location: "invalid/location" } }, ollama: {} } }))
    const legacy = createProviderService({ dir, env: {} }).list()
    expect(legacy.find((entry) => entry.id === "google-vertex")).toMatchObject({ enabled: false, error: "invalid Vertex settings" })
    expect(legacy.find((entry) => entry.id === "ollama")).toMatchObject({ enabled: true })
  })

  test("daemon + typed client configure Vertex, test, select namespaced model and disable", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: { GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "google-vertex:gemini-2.5-flash" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-04" }); cleanup.push(() => client.close())
    await client.connect()
    const saved = await client.configureVertex({ vertex: { project: "test-project", location: "global" }, models: [{ id: "gemini-2.5-flash" }] })
    expect(saved).toMatchObject({ ok: true, provider: { enabled: false, type: "google-vertex" } })
    expect(await client.providerLoginPlan("google-vertex", "adc")).toMatchObject({ ok: true, plan: { callback: "none", callsProvider: false } })
    expect(await client.configureVertex({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "google-vertex" })).toMatchObject({ ok: true, result: { ok: true, model: "gemini-2.5-flash" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect((await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "google-vertex:gemini-2.5-flash" } })).ok).toBe(true)
    expect(await client.configureVertex({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(JSON.stringify([saved, await client.providersCatalog()])).not.toContain(TOKEN)
  }, 15_000)
})
