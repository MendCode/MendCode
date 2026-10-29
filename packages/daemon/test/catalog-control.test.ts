import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, isReadOnlyCommand, type ModelInfo } from "@mendcode/protocol"
import { createAuthStore, createMcpAuth, createMcpManager, loadMcpConfig } from "@mendcode/mcp"
import { startDaemon } from "../src"
import { createProviderService } from "../src/providers"
import { catalogChoice, catalogConfig } from "../src/catalog-control"
import { addMcpConfig } from "../src/mcp-config"
import type { ModelCatalog } from "../src/models"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "mendd-b17-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const MODELS: ModelInfo[] = [
  { id: "gpt-6-astra", name: "Astra", efforts: ["medium", "high"] },
  { id: "gpt-6-luna", name: "Luna", efforts: ["low", "medium"] },
  { id: "openai:gpt-6-astra", name: "Astra API", provider: "openai", efforts: ["medium"] },
  { id: "ollama:llama3:8b", name: "Llama", provider: "ollama", efforts: [] },
]
const catalog: ModelCatalog = { list: () => MODELS, selectable: true, defaults: { model: "gpt-6-luna" } }

async function boot() {
  const dir = temp(), project = path.join(dir, "project")
  mkdirSync(project)
  const providers = createProviderService({ dir, env: { OPENAI_API_KEY: "environment-key-do-not-print" }, fetch: async () => new Response(JSON.stringify({ data: [{ id: "gpt-fresh" }] }), { headers: { "content-type": "application/json" } }) })
  const mcp = createMcpManager({ configLoader: (directory) => loadMcpConfig({ directory, userDir: dir, env: {} }), auth: createMcpAuth({ dir }), fetch: async () => new Response(null, { status: 204 }) })
  cleanups.push(() => mcp.stop())
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), models: catalog, providers, mcp, info: { engine: "native", login: async () => ({ ok: true }) }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B17" })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, project, client, providers, mcp }
}

describe("B17 protocol contracts", () => {
  test("additive commands validate before mutation and readonly never grants logout/debug/add", () => {
    const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
    const parse = (type: string, input: Record<string, unknown>) => Command.safeParse({ ...base, type, ...input }).success
    expect(parse("mcp.add", { directory: "/tmp/x", name: "docs", scope: "project", config: { url: "https://docs.test", oauth: false } })).toBe(true)
    expect(parse("mcp.add", { directory: "/tmp/x", name: "../bad", scope: "project", config: { command: "bun" } })).toBe(false)
    expect(parse("mcp.add", { directory: "/tmp/x", name: "bad", scope: "project", config: { command: "bun", url: "https://x" } })).toBe(false)
    expect(parse("mcp.add", { directory: "/tmp/x", name: "bad", scope: "project", config: { command: "bun", oauth: {} } })).toBe(false)
    expect(parse("models.default.set", { directory: "/tmp/x", preset: "p", provider: "openai", model: "m" })).toBe(false)
    expect(isReadOnlyCommand("models.config.get")).toBe(false)
    expect(isReadOnlyCommand("providers.catalog")).toBe(false)
    for (const type of ["models.default.set", "providers.logout", "mcp.add", "mcp.debug"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })
})

describe("B17 model control", () => {
  test("routing distinguishes subscription from API and refuses ambiguous billing or missing models", () => {
    expect(catalogChoice({ provider: "openai", model: "gpt-6-astra", authMode: "api-key" }, catalog)).toEqual({ model: "openai:gpt-6-astra" })
    expect(catalogChoice({ provider: "openai", model: "gpt-6-astra", authMode: "chatgpt-subscription-oauth" }, catalog)).toEqual({ model: "gpt-6-astra" })
    expect(catalogChoice({ provider: "chatgpt", model: "gpt-6-astra" }, catalog)).toEqual({ model: "gpt-6-astra" })
    expect(catalogChoice({ provider: "ollama", model: "llama3:8b" }, catalog)).toEqual({ model: "ollama:llama3:8b" })
    expect(() => catalogChoice({ provider: "openai", model: "gpt-6-astra" }, catalog)).toThrow("ambiguous")
    expect(() => catalogChoice({ provider: "openai", model: "missing" }, catalog)).toThrow("unavailable")
    expect(() => catalogChoice({ provider: "ollama", model: "llama3:8b", authMode: "chatgpt-subscription-oauth" }, catalog)).toThrow("applies to")
    expect(() => catalogChoice({ provider: "chatgpt", model: "gpt-6-astra", authMode: "api-key" }, catalog)).toThrow("API key")
  })
  test("plan reports invalid roles, inherited choices and all fourteen v1 presets without invented prices", () => {
    const report = catalogConfig("native", catalog, { main: { model: "missing" } })
    expect(report.failures).toEqual(["main: unknown model missing"])
    expect(report.effective.main).toEqual({ model: "missing" })
    expect(report.presets).toHaveLength(14)
    expect(report.presets.find((preset) => preset.name === "openai-api-gpt-6-astra")?.available).toBe(true)
    expect(report.presets.find((preset) => preset.name === "openai-api-gpt-5-nano")?.available).toBe(false)
  })
  test("client helpers, dry-run, real write and use-preset persist in the active folder profile", async () => {
    const { client, project } = await boot()
    await client.send({ type: "settings.set", patch: { profiles: [{ name: "team", directories: [project], models: { small: { model: "gpt-6-luna" } } }] } })
    expect(await client.modelsConfig(project)).toMatchObject({ ok: true, report: { roles: { small: { model: "gpt-6-luna" } } } })
    expect(await client.send({ type: "models.default.set", directory: project, provider: "openai", model: "gpt-6-astra", authMode: "api-key", dryRun: true })).toMatchObject({ ok: true, result: { writesConfig: false, roles: { main: { model: "openai:gpt-6-astra" } } } })
    expect(await client.modelsConfig(project)).toMatchObject({ ok: true, report: { roles: { small: { model: "gpt-6-luna" } } } })
    expect(await client.send({ type: "models.default.set", directory: project, preset: "openai-codex-subscription-gpt-6-astra" })).toMatchObject({ ok: true, result: { writesConfig: true } })
    expect(await client.modelsConfig(project)).toMatchObject({ ok: true, report: { roles: { main: { model: "gpt-6-astra" }, small: { model: "gpt-6-luna" } } } })
    const settings = await client.send({ type: "settings.get" })
    expect(settings.ok && (settings.result?.settings as { models?: unknown }).models).toBeUndefined()
    expect(await client.send({ type: "models.default.set", directory: project, preset: "openai-api-gpt-5-nano" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})

describe("B17 provider credentials", () => {
  test("logout removes only stored keys, retains unknown fields/models/env reference, and environment auth stays", () => {
    const dir = temp(), file = path.join(dir, "providers.json")
    writeFileSync(file, JSON.stringify({ providers: { openai: { apiKey: "stored-key-do-not-print", apiKeyEnv: "TEAM_KEY", models: [{ id: "m" }], enabled: true, custom: { value: 42 } } } }))
    const providers = createProviderService({ dir, env: { TEAM_KEY: "environment-key-do-not-print" } })
    expect(providers.inventory?.().find((provider) => provider.id === "openai")).toMatchObject({ credentialStored: true, presentEnv: ["TEAM_KEY"] })
    expect(providers.logout?.("openai")).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(JSON.parse(readFileSync(file, "utf8")).providers.openai).toEqual({ apiKeyEnv: "TEAM_KEY", models: [{ id: "m" }], enabled: true, custom: { value: 42 } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(providers.logout?.("openai")).toMatchObject({ ok: false, code: "target_mismatch" })
    expect(JSON.stringify(providers.inventory?.())).not.toContain("environment-key-do-not-print")
  })
  test("daemon inventory includes implemented adapters and subscription presence without any secret or key tail", async () => {
    const { client, providers } = await boot()
    providers.set({ id: "openai", apiKey: "stored-key-do-not-print" })
    const report = await client.providersCatalog()
    expect(report).toMatchObject({ ok: true, report: { callsProviders: false, secretsPrinted: false, providers: expect.arrayContaining([expect.objectContaining({ id: "chatgpt", authReady: true }), expect.objectContaining({ id: "openai", credentialStored: true })]) } })
    expect(JSON.stringify(report)).not.toContain("key-do-not-print")
    expect(JSON.stringify(report)).not.toContain("keyTail")
    expect(await client.send({ type: "providers.logout", provider: "openai" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "providers.logout", provider: "openai" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await client.send({ type: "providers.refresh", provider: "openai" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: "gpt-fresh" }] } } })
  })
})

describe("B17 MCP config and diagnostics", () => {
  test("daemon add loads immediately, scopes correctly and refuses duplicate entries without replace", async () => {
    const { client, project, dir } = await boot()
    expect(await client.send({ type: "mcp.add", directory: project, name: "docs", scope: "project", config: { url: "https://docs.test/mcp", oauth: {} } })).toMatchObject({ ok: true, result: { writesConfig: true, path: path.join(project, ".mendcode/mcp.json") } })
    expect(await client.send({ type: "mcp.status", directory: project })).toMatchObject({ ok: true, result: { servers: [expect.objectContaining({ name: "docs", transport: "remote", auth: "none" })] } })
    expect(await client.send({ type: "mcp.add", directory: project, name: "docs", scope: "project", config: { command: "bun" } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.send({ type: "mcp.add", directory: project, name: "docs", scope: "user", config: { url: "https://global.test" } })).toMatchObject({ ok: true, result: { path: path.join(dir, "mcp.json") } })
    expect(await client.send({ type: "mcp.debug", directory: project, server: "docs" })).toMatchObject({ ok: true, result: { url: "https://docs.test/mcp", httpStatus: 204, credentials: { accessToken: false } } })
  })
  test("config dry-run makes no file; writes preserve unknown fields and unresolved variables; corrupt input is not overwritten", () => {
    const dir = temp(), directory = temp(), config = { url: "https://docs.test/mcp", oauth: { clientId: "${CLIENT}", clientSecret: "${SECRET}" } }
    const input = { dir, directory, name: "docs", scope: "user" as const, config }
    const result = addMcpConfig({ ...input, dryRun: true })
    expect(result.writesConfig).toBe(false)
    expect(Bun.file(result.path).size).toBe(0)
    writeFileSync(result.path, JSON.stringify({ servers: { other: { command: "unchanged", future: 42 } }, future: { value: true } }))
    addMcpConfig(input)
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({ servers: { other: { command: "unchanged", future: 42 }, docs: config }, future: { value: true } })
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    writeFileSync(result.path, "invalid-json")
    expect(() => addMcpConfig({ ...input, replace: true })).toThrow("invalid JSON")
    expect(readFileSync(result.path, "utf8")).toBe("invalid-json")
  })
  test("OAuth debug discovers metadata without registering/refreshing, and exposes expired credential presence only", async () => {
    const dir = temp(), store = createAuthStore({ dir }), url = "https://docs.test/mcp?key=secret-query"
    await store.set(url, { issuer: "https://auth.test", clientId: "client", clientSecret: "do-not-print-client-secret", tokenEndpoint: "https://auth.test/token", authMethod: "basic", tokens: { accessToken: "do-not-print-access-token", refreshToken: "do-not-print-refresh-token", expiresAt: 1, tokenType: "Bearer" } })
    const requests: { url: string; method: string }[] = []
    const fake = async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? "GET" })
      if (url.startsWith("https://docs.test/mcp")) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://docs.test/resource"' } })
      if (url === "https://docs.test/resource") return Response.json({ authorization_servers: ["https://auth.test"] })
      return Response.json({ issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize?secret=hidden", token_endpoint: "https://auth.test/token", registration_endpoint: "https://auth.test/register", code_challenge_methods_supported: ["S256"] })
    }
    const auth = createMcpAuth({ dir, store, fetch: fake })
    const manager = createMcpManager({ configLoader: () => ({ servers: { docs: { url } }, errors: [] }), auth, fetch: fake })
    cleanups.push(() => manager.stop())
    const before = readFileSync(store.file, "utf8")
    const report = await manager.debug({ directory: dir, server: "docs" })
    expect(report).toMatchObject({ auth: "expired", httpStatus: 401, credentials: { accessToken: true, refreshToken: true, client: true, expiresAt: 1 }, oauth: { registrationAvailable: true, clientRegistrationRequired: false } })
    expect(report.oauth?.authorizationEndpoint).toBe("https://auth.test/authorize")
    expect(JSON.stringify(report)).not.toContain("do-not-print")
    expect(JSON.stringify(report)).not.toContain("secret-query")
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
    expect(readFileSync(store.file, "utf8")).toBe(before)
    expect((await manager.status(dir)).servers[0]).toMatchObject({ authStored: true, authExpiresAt: 1 })
  })
  test("debug rejects local, disabled OAuth and unknown targets and redacts connection failures", async () => {
    const manager = createMcpManager({ configLoader: () => ({ servers: { local: { command: "never-run" }, off: { url: "https://x.test", oauth: false }, docs: { url: "https://x.test?secret=hidden" } }, errors: [] }), fetch: async () => { throw new Error("do-not-print-secret") } })
    cleanups.push(() => manager.stop())
    for (const server of ["local", "off", "unknown"]) expect(manager.debug({ directory: "/tmp", server })).rejects.toThrow()
    const report = await manager.debug({ directory: "/tmp", server: "docs" })
    expect(report.error).toBe("connection or OAuth discovery failed")
    expect(JSON.stringify(report)).not.toContain("do-not-print-secret")
  })
})
