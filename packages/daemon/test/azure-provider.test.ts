import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { AzureOptions, Command, ProviderConfig, ProviderInfo, ProviderType, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const KEY = "azure-key-fixture-never-print-0123456789"
const TOKEN = "entra-token-fixture-never-print-0123456789"
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-02-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const fake: Fetch = async (url, init) => {
  expect(url).toContain("/openai/v1/responses?api-version=v1")
  expect(init.method).toBe("POST")
  const headers = new Headers(init.headers)
  expect(headers.get("api-key") ?? headers.get("authorization")).toBe(headers.has("api-key") ? KEY : `Bearer ${TOKEN}`)
  return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n')
}

describe("B10.02 Azure daemon and protocol", () => {
  test("additive Azure schema, config options and existing mutation boundaries", () => {
    const ids = createIdFactory()
    expect(ProviderType.parse("azure")).toBe("azure")
    for (const type of ["openai", "anthropic", "openai-compatible", "google", "github-copilot"]) expect(ProviderType.safeParse(type).success).toBe(true)
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "azure", azure: { resourceName: "team", auth: "entra" }, models: [{ id: "team-coder" }] }).success).toBe(true)
    expect(ProviderConfig.parse({ type: "azure", azure: { useCompletionUrls: true }, options: { resourceName: "team" } }).type).toBe("azure")
    expect(AzureOptions.safeParse({ resourceName: "team.evil.example" }).success).toBe(false)
    expect(AzureOptions.safeParse({ token: TOKEN }).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout", "providers.auth.authorize"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("environment preset stays off; explicit enable, routing and disable apply live", async () => {
    const dir = temp()
    const env = { AZURE_API_KEY: KEY, AZURE_RESOURCE_NAME: "team" }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "azure", type: "azure", hasKey: true, enabled: false, source: "env", baseUrl: "https://team.openai.azure.com/openai", models: [] })
    expect(providers.models()).toEqual([])
    expect((await providers.test("azure"))?.error).toContain("disabled")
    expect(calls).toBe(0)
    expect(providers.set({ id: "azure", models: [{ id: "team-coder", context: 100_000 }] })).toMatchObject({ ok: true, provider: { enabled: false } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must never reach subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "azure:team-coder", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    providers.set({ id: "azure", enabled: true })
    expect(providers.models()[0]).toMatchObject({ id: "azure:team-coder", provider: "azure", contextWindow: 100_000 })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "azure", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("Entra reports are offline, and refresh never substitutes global models for deployments", async () => {
    const dir = temp()
    const env = { TEAM_TOKEN: TOKEN }
    let calls = 0
    const providers = createProviderService({ dir, env, fetch: async (url, init) => { calls++; return fake(url, init) } })
    providers.set({ id: "azure", baseUrl: "https://team.openai.azure.com", azure: { auth: "entra", tokenEnv: "TEAM_TOKEN" }, enabled: true, models: [{ id: "my-deployment", context: 128_000, images: false }] })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("azure").azure!.map((method) => method.id)).toEqual(["api-key", "entra"])
    expect(auth.plan("azure", "entra")).toMatchObject({ callback: "none", callsProvider: false, writesSecrets: false })
    expect(auth.status("azure")[0]).toMatchObject({ state: "authorized", source: "none", accessTokenPresent: false })
    expect(providers.inventory!().find((entry) => entry.id === "azure")).toMatchObject({ authMode: "azure-entra", authReady: true })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    expect(await providers.refresh("azure")).toMatchObject({ ok: true, provider: { models: [{ id: "my-deployment", context: 128_000, images: false }] } })
    expect(calls).toBe(0)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
    expect((await providers.test("azure"))?.ok).toBe(true)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("azure"), before])).not.toContain(TOKEN)
    expect(ProviderInfo.safeParse(providers.list()[0]).success).toBe(true)
    expect(providers.models().map((model) => model.id)).toEqual(["azure:my-deployment"])
  })

  test("safe key storage, logout, aliases and unsafe endpoints leave no credential in reports", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    providers.set({ id: "azure", apiKey: KEY, azure: { resourceName: "team" }, models: [{ id: "team-coder" }] })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(providers.list())).not.toContain(KEY)
    expect(providers.logout!("azure")).toMatchObject({ ok: true, provider: { hasKey: false } })
    for (const baseUrl of ["http://remote.example", "https://user:secret@example.com", "https://example.com?secret=private", "https://example.com#private"]) expect(providers.set({ id: "azure", baseUrl }).ok).toBe(false)
    const alias = createProviderService({ dir: temp(), env: { AZURE_OPENAI_API_KEY: KEY, AZURE_OPENAI_ENDPOINT: "https://team.openai.azure.com" } })
    expect(alias.list()[0]).toMatchObject({ hasKey: true, enabled: false, baseUrl: "https://team.openai.azure.com" })
  })

  test("legacy Azure SDK config uses the native transport, offline metadata cannot invent deployments", () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { azure: { npm: "@ai-sdk/azure", options: { resourceName: "team", apiVersion: "2024-10-21", useCompletionUrls: true, useDeploymentBasedUrls: true }, models: [{ id: "team-coder" }] } } }))
    writeFileSync(path.join(dir, "models.dev.json"), JSON.stringify({ azure: { models: { "gpt-foreign": { name: "Foreign model" } } } }))
    const providers = createProviderService({ dir, env: { AZURE_API_KEY: KEY } })
    expect(providers.list()[0]).toMatchObject({ type: "azure", enabled: false, baseUrl: "https://team.openai.azure.com/openai", azure: { apiVersion: "2024-10-21", useCompletionUrls: true, useDeploymentBasedUrls: true }, models: [{ id: "team-coder" }] })
  })

  test("invalid legacy Azure options are isolated rather than breaking provider inventory", () => {
    const dir = temp()
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { azure: { enabled: true, options: { resourceName: "team.evil.example" } }, ollama: {} } }))
    const providers = createProviderService({ dir, env: {} })
    expect(providers.list().find((entry) => entry.id === "azure")).toMatchObject({ enabled: false, error: "invalid Azure settings" })
    expect(providers.list().find((entry) => entry.id === "ollama")).toMatchObject({ enabled: true })
  })

  test("daemon + typed client: configure, auth plan, test, namespaced selection and disable", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "azure:team-coder" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-02" })
    cleanup.push(() => client.close())
    await client.connect()
    const saved = await client.configureAzure({ apiKey: KEY, azure: { resourceName: "team" }, models: [{ id: "team-coder" }] })
    expect(saved).toMatchObject({ ok: true, provider: { enabled: false, type: "azure" } })
    expect(await client.providerLoginPlan("azure", "entra")).toMatchObject({ ok: true, plan: { callsProvider: false, callback: "none" } })
    const replies = [await client.configureAzure({ enabled: true }), await client.send({ type: "providers.refresh", provider: "azure" }), await client.send({ type: "providers.test", provider: "azure" })]
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "team-coder" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    expect((await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "azure:team-coder" } })).ok).toBe(true)
    expect(await client.configureAzure({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(JSON.stringify([saved, replies, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
