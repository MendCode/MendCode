import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { Command, ProviderConfig, ProviderInfo, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const ID = "google-vertex-anthropic", MODEL = "claude-haiku-4-5@20251001", TOKEN = "vertex-claude-daemon-fixture-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-vertex-claude-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const answer = () => new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n')
const fake: Fetch = async (url, init) => {
  expect(url).toContain(`/v1/projects/test-project/locations/global/publishers/anthropic/models/${MODEL}:streamRawPredict`)
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
  expect(init.redirect).toBe("error")
  expect(JSON.parse(String(init.body))).toMatchObject({ anthropic_version: "vertex-2023-10-16", stream: true })
  return answer()
}

describe("B10.05 Vertex Anthropic daemon/protocol/client", () => {
  test("additive schema, secret-free ADC options and existing command authority", () => {
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: ID, providerType: ID, vertex: { project: "test-project", location: "global" }, models: [{ id: MODEL }] }).success).toBe(true)
    expect(ProviderConfig.parse({ type: ID, vertex: { tokenEnv: "TEAM_TOKEN" } }).type).toBe(ID)
    expect(ProviderConfig.safeParse({ type: ID, vertex: { accessToken: TOKEN } }).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment discovery stays disabled, live enable/disable and namespaced routing have no subscription fallback", async () => {
    const dir = temp(), env = { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_VERTEX_LOCATION: "us-central1", GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list().find((entry) => entry.id === ID)).toMatchObject({ type: ID, enabled: false, hasKey: false, authReady: true, source: "env", vertex: { location: "global" }, baseUrl: "https://aiplatform.googleapis.com/v1" })
    expect(providers.models()).toEqual([])
    expect((await providers.test(ID))?.error).toContain("disabled")
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must never reach subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: `${ID}:${MODEL}`, signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: ID, enabled: true, models: [{ id: MODEL, context: 200_000 }] }).ok).toBe(true)
    expect(providers.models()[0]).toMatchObject({ id: `${ID}:${MODEL}`, provider: ID })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env }).list().find((entry) => entry.id === ID)!.enabled).toBe(true)
    providers.set({ id: ID, enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("offline inventory/auth/refresh preserve config bytes and never expose or remove Google credentials", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { TEAM_TOKEN: TOKEN }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.set({ id: ID, enabled: true, vertex: { project: "test-project", tokenEnv: "TEAM_TOKEN" }, models: [{ id: MODEL, context: 200_000 }] }).ok).toBe(true)
    const auth = createProviderAuth({ dir, providers, env: {} }); cleanup.push(auth.stop)
    expect(auth.methods(ID)[ID]!.map((entry) => entry.id)).toEqual(["adc"])
    expect(auth.plan(ID)).toMatchObject({ callsProvider: false, writesSecrets: false, callback: "none", method: { id: "adc" } })
    expect(auth.status(ID)[0]).toMatchObject({ state: "authorized", source: "none", accessTokenPresent: false })
    expect(providers.inventory!().find((entry) => entry.id === ID)).toMatchObject({ authMode: "google-adc", authReady: true, credentialStored: false })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(await providers.refresh(ID)).toMatchObject({ ok: true, provider: { models: [{ id: MODEL, context: 200_000 }] } })
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    expect(calls).toBe(0)
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(ProviderInfo.safeParse(providers.list()[0]).success).toBe(true)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status(), before])).not.toContain(TOKEN)
    expect((await providers.test(ID))?.ok).toBe(true)
    expect(providers.logout!(ID)).toMatchObject({ ok: false, code: "target_mismatch" })
  })

  test("legacy Vertex Anthropic SDK/options map natively and endpoint null restores routing", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { [ID]: { npm: "@ai-sdk/google-vertex/anthropic", options: { project: "test-project", location: "global" }, models: [{ id: MODEL }] } } }))
    const providers = createProviderService({ dir, env: { GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, fetch: fake })
    expect(providers.list()[0]).toMatchObject({ enabled: false, type: ID, vertex: { project: "test-project", location: "global" } })
    expect(providers.set({ id: ID, enabled: true, baseUrl: "http://127.0.0.1:9911/v1" }).ok).toBe(true)
    expect((await providers.test(ID))?.ok).toBe(true)
    providers.set({ id: ID, vertex: { endpoint: null, location: "us-east5" } })
    expect(providers.list()[0]!.baseUrl).toBe("https://us-east5-aiplatform.googleapis.com/v1")
  })

  test("custom namespace, model variants/metadata and scoped ADC validation", () => {
    const providers = createProviderService({ dir: temp(), env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN } })
    expect(providers.set({ id: "team-claude", providerType: ID, enabled: true, baseUrl: "https://aiplatform.googleapis.com/v1", models: [{ id: MODEL, variants: { short: { parameters: { max_tokens: 256 } } }, limit: { context: 200_000, output: 8192 }, images: true }] })).toMatchObject({ ok: true, provider: { type: ID, hasKey: false } })
    expect(providers.models().find((entry) => entry.provider === "team-claude")).toMatchObject({ id: `team-claude:${MODEL}`, variants: { short: { parameters: { max_tokens: 256 } } } })
    for (const input of [{ baseUrl: "http://remote.example" }, { apiKey: TOKEN }, { apiKeyEnv: "TEAM_TOKEN" }, { vertex: { location: "global/escape" } }, { models: [{ id: "../escape" }] }]) expect(providers.set({ id: ID, ...input }).ok).toBe(false)
    const missing = createProviderService({ dir: temp(), env: {} })
    missing.set({ id: ID, enabled: true })
    expect(missing.list()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("needs GOOGLE_CLOUD_PROJECT") })
  })

  test("ADC authorized-user refresh is cached across calls; only temporary credentials and local fakes", async () => {
    const dir = temp(), credential = path.join(dir, "adc.json")
    writeFileSync(credential, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-client-secret", refresh_token: "fixture-refresh-token", token_uri: "http://127.0.0.1:9911/token", quota_project_id: "billing-project" }))
    let exchanges = 0, requests = 0
    const providers = createProviderService({ dir, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_APPLICATION_CREDENTIALS: credential }, fetch: async (url, init) => {
      if (url.endsWith("/token")) { exchanges++; expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("refresh_token"); return Response.json({ access_token: TOKEN, expires_in: 3600 }) }
      requests++; expect(new Headers(init.headers).get("x-goog-user-project")).toBe("billing-project"); return fake(url, init)
    } })
    providers.set({ id: ID, enabled: true, models: [{ id: MODEL }] })
    expect((await providers.test(ID))?.ok).toBe(true)
    expect((await providers.test(ID))?.ok).toBe(true)
    expect(exchanges).toBe(1); expect(requests).toBe(2)
    expect(JSON.stringify(providers.list())).not.toContain(TOKEN)
  })

  test("daemon and typed client configure, select, test, refresh and disable Vertex Anthropic", async () => {
    const dir = temp(), providers = createProviderService({ dir, env: { GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN }, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: `${ID}:${MODEL}` } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-05" }); cleanup.push(() => client.close())
    await client.connect()
    expect(await client.configureVertexAnthropic({ vertex: { project: "test-project" }, models: [{ id: MODEL }] })).toMatchObject({ ok: true, provider: { enabled: false, type: ID } })
    expect(await client.providerLoginPlan(ID, "adc")).toMatchObject({ ok: true, plan: { callback: "none", callsProvider: false } })
    expect(await client.configureVertexAnthropic({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: ID })).toMatchObject({ ok: true, result: { ok: true, model: MODEL } })
    expect(await client.send({ type: "providers.refresh", provider: ID })).toMatchObject({ ok: true, result: { provider: { type: ID } } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect((await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: `${ID}:${MODEL}` } })).ok).toBe(true)
    expect(await client.configureVertexAnthropic({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(JSON.stringify(await client.providersCatalog())).not.toContain(TOKEN)
  }, 15_000)
})
