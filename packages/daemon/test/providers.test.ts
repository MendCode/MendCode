import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createProviderRouter, type ModelEvent, type ModelProvider } from "@mendcode/engine-native"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, type ModelInfo, type ModelRoles, type ModelsReport, type ProviderInfo } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"
import { resolveModel, type ModelCatalog } from "../src/models"
import { createProviderService, PROVIDERS_FILE, type ProviderService } from "../src/providers"

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-3f2a"
const OTHER_KEY = "gsk_live_ZYXWVUTSRQPONMLKJIHG9876543210abcd"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-providers-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A provider stand-in on 127.0.0.1; it records each request and answers like `respond` says. */
function fakeServer(respond: (request: { path: string; headers: Record<string, string>; body: any }) => Response) {
  const requests: Array<{ path: string; headers: Record<string, string>; body: any }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text()
      const recorded = { path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: text ? JSON.parse(text) : undefined }
      requests.push(recorded)
      return respond(recorded)
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const chatAnswer = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"])

const service = (dir: string, env: Record<string, string | undefined> = {}) => createProviderService({ dir, env })
const fileMode = (dir: string) => statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777

describe("providers.json", () => {
  test("is written with mode 0600, atomically, and keeps the key out of every listing", () => {
    const dir = tempDir()
    const providers = service(dir)
    const done = providers.set({ id: "anthropic", apiKey: KEY })
    expect(done.ok).toBe(true)
    expect(fileMode(dir)).toBe(0o600)
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8"))).toEqual({ providers: { anthropic: { apiKey: KEY } } })
    const listed = providers.list()
    expect(listed).toEqual([
      expect.objectContaining({ id: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", enabled: true, hasKey: true, keyTail: "…3f2a", source: "config" }),
    ])
    expect(JSON.stringify(listed)).not.toContain(KEY)
    expect(JSON.stringify(done)).not.toContain(KEY)
    expect(JSON.stringify(listed)).not.toContain("apiKey")
    // The temporary file of the atomic write is gone.
    expect(Bun.spawnSync(["ls", dir]).stdout.toString().trim().split("\n")).toEqual([PROVIDERS_FILE])
  })

  test("a file that is readable by others is tightened when read", () => {
    const dir = tempDir()
    const file = path.join(dir, PROVIDERS_FILE)
    writeFileSync(file, JSON.stringify({ providers: { anthropic: { apiKey: KEY } } }))
    chmodSync(file, 0o644)
    expect(service(dir).list()[0]).toMatchObject({ id: "anthropic", hasKey: true })
    expect(fileMode(dir)).toBe(0o600)
  })

  test("a short key is not given a tail, an empty apiKey clears it, and a key with spaces is refused", () => {
    const dir = tempDir()
    const providers = service(dir)
    expect(providers.set({ id: "anthropic", apiKey: "short-key-1" })).toMatchObject({ ok: true, provider: { hasKey: true } })
    expect(providers.list()[0]!.keyTail).toBeUndefined()
    expect(providers.set({ id: "anthropic", apiKey: "" })).toMatchObject({ ok: true, provider: { hasKey: false, error: expect.stringContaining("no API key") } })
    expect(providers.set({ id: "anthropic", apiKey: "has a space" })).toMatchObject({ ok: false, code: "invalid_command" })
  })

  test("a corrupt file is reported on the providers, never crashes, and the environment still works", () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, PROVIDERS_FILE), "{ not json")
    const listed = service(dir, { GROQ_API_KEY: OTHER_KEY }).list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: "groq", hasKey: true, source: "env" })
    expect(listed[0]!.error).toContain("providers.json could not be read")
    expect(JSON.stringify(listed)).not.toContain(OTHER_KEY)
  })
})

describe("environment keys", () => {
  test("enable their preset when there is no config for it", () => {
    const env = { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-0123456789abcdef", OPENROUTER_API_KEY: "or-0123456789abcdefgh", AI_GATEWAY_API_KEY: "vg-0123456789abcdefgh", GROQ_API_KEY: OTHER_KEY, DEEPSEEK_API_KEY: "ds-0123456789abcdefgh" }
    const listed = service(tempDir(), env).list()
    expect(listed.map((p) => `${p.id}:${p.type}`).sort()).toEqual(["anthropic:anthropic", "deepseek:openai-compatible", "groq:openai-compatible", "openai:openai", "openrouter:openai-compatible", "vercel:openai-compatible"])
    for (const provider of listed) expect(provider).toMatchObject({ enabled: true, hasKey: true, source: "env" })
    expect(listed.find((p) => p.id === "openrouter")!.baseUrl).toBe("https://openrouter.ai/api/v1")
    expect(listed.find((p) => p.id === "vercel")!.baseUrl).toBe("https://ai-gateway.vercel.sh/v1")
    const serialized = JSON.stringify(listed)
    for (const secret of Object.values(env)) expect(serialized).not.toContain(secret)
  })

  test("nothing is enabled without a key, and local servers need an explicit entry", () => {
    expect(service(tempDir(), {}).list()).toEqual([])
    expect(service(tempDir(), { ANTHROPIC_API_KEY: "   " }).list()).toEqual([])
  })

  test("a config entry can switch an env provider off, and a key from apiKeyEnv is read live", () => {
    const dir = tempDir()
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: KEY }
    const providers = createProviderService({ dir, env })
    expect(providers.models().length).toBeGreaterThan(0)
    providers.set({ id: "anthropic", enabled: false })
    expect(providers.list()[0]).toMatchObject({ id: "anthropic", enabled: false, source: "config", hasKey: true })
    expect(providers.models()).toEqual([])
    providers.set({ id: "mine", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "MINE_KEY", models: [{ id: "m" }] })
    expect(providers.list().find((p) => p.id === "mine")).toMatchObject({ hasKey: false })
    env.MINE_KEY = "mine-key-0123456789abcdef"
    expect(providers.list().find((p) => p.id === "mine")).toMatchObject({ hasKey: true, keyTail: "…cdef" })
  })
})

describe("providers.set validation", () => {
  test("custom endpoints need a type and a base URL; presets keep their type; reserved and malformed ids are refused", () => {
    const providers = service(tempDir())
    expect(providers.set({ id: "mine" })).toMatchObject({ ok: false, message: expect.stringContaining("providerType") })
    expect(providers.set({ id: "mine", providerType: "openai-compatible" })).toMatchObject({ ok: false, message: expect.stringContaining("baseUrl") })
    expect(providers.set({ id: "openrouter", providerType: "anthropic" })).toMatchObject({ ok: false, message: expect.stringContaining("cannot change") })
    expect(providers.set({ id: "chatgpt", providerType: "openai", baseUrl: "https://x.test/v1" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "Bad Id", providerType: "openai", baseUrl: "https://x.test/v1" })).toMatchObject({ ok: false })
    expect(providers.set({ id: "anthropic", models: [{ id: "a" }, { id: "a" }] })).toMatchObject({ ok: false, message: expect.stringContaining("duplicate model") })
    expect(providers.set({ id: "mine", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1/" })).toMatchObject({ ok: true, provider: { baseUrl: "http://127.0.0.1:1234/v1", type: "openai-compatible", source: "config" } })
  })

  test("the wire schema keeps the command id apart from the provider and rejects bad input", () => {
    const ids = createIdFactory()
    const parse = (body: Record<string, unknown>) => Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", ...body }).success
    expect(parse({ provider: "anthropic", apiKey: "k" })).toBe(true)
    expect(parse({ provider: "custom", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "m", effort: true, images: false, context: 8000 }] })).toBe(true)
    expect(parse({ provider: "anthropic", baseUrl: "ftp://x" })).toBe(false)
    expect(parse({ provider: "Bad Id" })).toBe(false)
    expect(parse({ provider: "chatgpt" })).toBe(false)
    expect(parse({ provider: "anthropic", providerType: "gemini" })).toBe(false)
    expect(parse({ provider: "anthropic", models: [{ id: "x".repeat(67) }] })).toBe(false)
    expect(parse({ provider: "anthropic", apiKeyEnv: "not valid" })).toBe(false)
    expect(parse({ provider: "anthropic", surprise: 1 })).toBe(false)
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.test", provider: "gw", model: "m" }).success).toBe(true)
  })

  test("models: [] clears the list (back to the preset's), other fields survive a rewrite", () => {
    const dir = tempDir()
    const providers = service(dir, { ANTHROPIC_API_KEY: KEY })
    providers.set({ id: "anthropic", models: [{ id: "claude-custom", name: "Custom", context: 123_000, effort: true }] })
    expect(providers.list()[0]!.models).toEqual([{ id: "claude-custom", name: "Custom", context: 123_000, effort: true }])
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-custom" }], note: "kept" } } }))
    providers.set({ id: "anthropic", headers: { "x-team": "a" } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.anthropic).toMatchObject({ note: "kept", headers: { "x-team": "a" } })
    providers.set({ id: "anthropic", models: [] })
    expect(providers.list()[0]!.models.map((m) => m.id)).toContain("claude-sonnet-5-5")
  })

  test("remove deletes the entry; an env-only provider can only be switched off", () => {
    const providers = service(tempDir(), { GROQ_API_KEY: OTHER_KEY })
    expect(providers.remove("groq")).toMatchObject({ ok: false, message: expect.stringContaining("GROQ_API_KEY") })
    expect(providers.remove("nothing")).toMatchObject({ ok: false, code: "target_mismatch" })
    providers.set({ id: "groq", enabled: false })
    expect(providers.remove("groq")).toMatchObject({ ok: true, providers: [expect.objectContaining({ id: "groq", source: "env", enabled: true })] })
  })
})

describe("the model catalog", () => {
  const catalogOf = (providers: ProviderService): ModelCatalog => ({
    selectable: true,
    list: () => [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, ...providers.models(), { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low"], engine: "claude" }],
    defaults: { model: "gpt-6-luna", effort: "low" },
  })

  test("provider models are namespaced, carry efforts and context, and come only from usable providers", () => {
    const providers = service(tempDir(), { ANTHROPIC_API_KEY: KEY })
    providers.set({ id: "openrouter", models: [{ id: "google/gemini-3-pro", name: "Gemini 3 Pro", context: 1_000_000, effort: true }] })
    providers.set({ id: "local", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "llama3:8b" }] })
    const models = providers.models()
    const byId = new Map(models.map((m) => [m.id, m]))
    // openrouter has no key: its models stay out; the keyless custom endpoint and the env-keyed Anthropic are in.
    expect([...byId.keys()].filter((id) => id.startsWith("openrouter:"))).toEqual([])
    expect(byId.get("anthropic:claude-sonnet-5-5")).toEqual({ id: "anthropic:claude-sonnet-5-5", name: "Claude Sonnet 5.5 · Anthropic", efforts: ["low", "medium", "high"], contextWindow: 200_000, provider: "anthropic" })
    expect(byId.get("local:llama3:8b")).toEqual({ id: "local:llama3:8b", name: "llama3:8b · local", efforts: [], provider: "local" })
    providers.set({ id: "openrouter", apiKey: "or-0123456789abcdefghijkl" })
    expect(providers.models().find((m) => m.id === "openrouter:google/gemini-3-pro")).toEqual({ id: "openrouter:google/gemini-3-pro", name: "Gemini 3 Pro · OpenRouter", efforts: ["low", "medium", "high"], contextWindow: 1_000_000, provider: "openrouter" })
  })

  test("resolveModel accepts namespaced ids and checks their efforts like any model", () => {
    const providers = service(tempDir(), { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-0123456789abcdef" })
    const catalog = catalogOf(providers)
    expect(resolveModel({ role: "main", session: { model: "anthropic:claude-sonnet-5-5", effort: "high" }, roles: {}, catalog })).toEqual({ model: "anthropic:claude-sonnet-5-5", effort: "high" })
    // Anthropic models start with thinking off: no default effort.
    expect(resolveModel({ role: "main", session: { model: "anthropic:claude-sonnet-5-5" }, roles: {}, catalog })).toEqual({ model: "anthropic:claude-sonnet-5-5" })
    expect(resolveModel({ role: "main", session: { model: "anthropic:claude-sonnet-5-5", effort: "xhigh" }, roles: {}, catalog })).toEqual({ model: "anthropic:claude-sonnet-5-5" })
    // OpenAI reasoning models start at medium.
    expect(resolveModel({ role: "main", session: { model: "openai:gpt-6-luna" }, roles: {}, catalog })).toEqual({ model: "openai:gpt-6-luna", effort: "medium" })
    // Un-namespaced ids are unchanged.
    expect(resolveModel({ role: "main", roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    // Another role follows main onto a provider model.
    expect(resolveModel({ role: "subagent", session: { model: "anthropic:claude-sonnet-5-5", effort: "low" }, roles: {}, catalog })).toEqual({ model: "anthropic:claude-sonnet-5-5", effort: "low" })
  })
})

describe("roles", () => {
  const MODELS: ModelInfo[] = [
    { id: "gpt-6-luna", name: "luna", efforts: ["low"], defaultEffort: "low" },
    { id: "gpt-6-sol", name: "sol", efforts: ["low", "high"] },
    { id: "groq:llama", name: "llama", efforts: [], provider: "groq" },
    { id: "claude-opus", name: "opus", efforts: [], engine: "claude" },
  ]
  const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-luna", effort: "low" } }

  test("aside falls back to small, then the session's model, then main; every other role ignores small and aside", () => {
    const session = { model: "gpt-6-sol", effort: "high" as const }
    const roles: ModelRoles = { main: { model: "gpt-6-luna" }, small: { model: "groq:llama" }, aside: { model: "gpt-6-sol", effort: "low" } }
    expect(resolveModel({ role: "aside", session, roles, catalog })).toEqual({ model: "gpt-6-sol", effort: "low" })
    expect(resolveModel({ role: "aside", session, roles: { small: roles.small! }, catalog })).toEqual({ model: "groq:llama" })
    expect(resolveModel({ role: "aside", session, roles: { main: roles.main! }, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(resolveModel({ role: "aside", roles: { main: roles.main! }, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "aside", roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "compaction", session, roles: { small: roles.small! }, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(resolveModel({ role: "dream", roles: { small: roles.small! }, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
  })

  test("roles saved before aside and small existed keep resolving exactly as before", () => {
    const old: ModelRoles = { main: { model: "gpt-6-sol", effort: "high" }, plan: { model: "gpt-6-luna" }, dream: { model: "gpt-6-luna", effort: "low" } }
    expect(resolveModel({ role: "main", roles: old, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(resolveModel({ role: "plan", roles: old, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "subagent", roles: old, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(resolveModel({ role: "aside", roles: old, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
  })

  test("a role never lands on a Claude Code model", () => {
    expect(resolveModel({ role: "aside", session: { model: "claude-opus" }, roles: { small: { model: "claude-opus" } }, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
  })
})

describe("refresh and test against a fake provider", () => {
  test("refresh caches the provider's model list in providers.json; a failed refresh leaves it alone", async () => {
    const dir = tempDir()
    let fail = false
    const server = fakeServer(() => (fail ? json({ error: { message: `denied ${KEY}` } }, 401) : json({ data: [{ id: "b-model", context_length: 64_000 }, { id: "a-model", name: "A" }] })))
    const providers = service(dir)
    providers.set({ id: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: KEY, models: [{ id: "old" }] })
    const refreshed = await providers.refresh("gw")
    expect(refreshed).toMatchObject({ ok: true, provider: { models: [{ id: "a-model", name: "A" }, { id: "b-model", context: 64_000 }] } })
    expect(JSON.stringify(refreshed)).not.toContain(KEY)
    const saved = JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.gw
    expect(saved.models.map((m: { id: string }) => m.id)).toEqual(["a-model", "b-model"])
    expect(typeof saved.refreshedAt).toBe("number")
    expect(fileMode(dir)).toBe(0o600)
    expect(providers.models().map((m) => m.id)).toEqual(["gw:a-model", "gw:b-model"])
    expect(server.requests[0]).toMatchObject({ path: "/v1/models", headers: { authorization: `Bearer ${KEY}` } })
    fail = true
    const failed = await providers.refresh("gw")
    expect(failed).toMatchObject({ ok: false })
    expect(JSON.stringify(failed)).not.toContain(KEY)
    expect(providers.list()[0]!.models.map((m) => m.id)).toEqual(["a-model", "b-model"])
    expect(await providers.refresh("ghost")).toMatchObject({ ok: false, code: "target_mismatch" })
  })

  test("refresh of an env-keyed preset creates its config entry and keeps using the env key", async () => {
    const dir = tempDir()
    const server = fakeServer(() => json({ data: [{ id: "llama-x" }] }))
    const providers = createProviderService({ dir, env: { GROQ_API_KEY: OTHER_KEY } })
    providers.set({ id: "groq", baseUrl: `${server.url}/openai/v1` })
    expect(await providers.refresh("groq")).toMatchObject({ ok: true, provider: { source: "config", hasKey: true, models: [{ id: "llama-x" }] } })
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${OTHER_KEY}`)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(OTHER_KEY)
  })

  test("test sends one tiny streaming request and reports ok with the latency; unknown ids are undefined", async () => {
    const server = fakeServer(() => chatAnswer())
    const providers = service(tempDir())
    providers.set({ id: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: KEY, models: [{ id: "m1" }] })
    const result = await providers.test("gw")
    expect(result).toMatchObject({ ok: true, model: "m1" })
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.body).toMatchObject({ model: "m1", stream: true, max_tokens: 8 })
    expect(await providers.test("ghost")).toBeUndefined()
  })

  test("test reports a rejected key clearly and never echoes it", async () => {
    const server = fakeServer(() => json({ error: { message: `Invalid key ${KEY}` } }, 401))
    const providers = service(tempDir())
    providers.set({ id: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: KEY, models: [{ id: "m1" }] })
    const result = await providers.test("gw")
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("[AUTH]: gw 401") })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe("routing through the provider service", () => {
  const fallback: ModelProvider = {
    id: "chatgpt",
    model: "gpt-6-luna",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text", delta: "subscription" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const run = async (stream: AsyncIterable<ModelEvent>) => {
    let text = ""
    for await (const event of stream) if (event.type === "text") text += event.delta
    return text
  }
  const request = (model?: string) => ({ system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], ...(model ? { model } : {}), signal: new AbortController().signal })

  test("namespaced models reach their provider's endpoint with the namespace removed; plain ids use the subscription", async () => {
    const server = fakeServer(() => chatAnswer())
    const providers = service(tempDir())
    const router = createProviderRouter({ fallback, providers: () => providers.runtime() })
    await expect(run(router.stream(request("gw:llama3:8b")))).rejects.toThrow('no provider "gw"')
    providers.set({ id: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: KEY, models: [{ id: "llama3:8b" }] })
    expect(await run(router.stream(request("gw:llama3:8b")))).toBe("ok")
    expect(server.requests[0]).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}` }, body: { model: "llama3:8b" } })
    expect(await run(router.stream(request("gpt-6-luna")))).toBe("subscription")
    expect(await run(router.stream(request()))).toBe("subscription")
  })

  test("a disabled provider says so; a key changed in the file applies to the next call", async () => {
    const server = fakeServer(() => chatAnswer())
    const providers = service(tempDir())
    const router = createProviderRouter({ fallback, providers: () => providers.runtime() })
    providers.set({ id: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: KEY, models: [{ id: "m" }], enabled: false })
    await expect(run(router.stream(request("gw:m")))).rejects.toThrow("gw is disabled")
    providers.set({ id: "gw", enabled: true })
    await run(router.stream(request("gw:m")))
    providers.set({ id: "gw", apiKey: OTHER_KEY })
    await run(router.stream(request("gw:m")))
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${OTHER_KEY}`])
  })
})

describe("daemon commands", () => {
  async function boot(options: Pick<DaemonOptions, "providers" | "models" | "complete"> = {}) {
    const dir = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, ...options })
    const client = createClient({ socketPath: daemon.socketPath, name: "providers" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const created = await client.send({ type: "session.create", directory: dir })
    const sessionId = (created.ok ? created.result : undefined) as { sessionId: string }
    return { client, dir, sessionId: sessionId.sessionId as never }
  }
  const infos = (reply: { ok: boolean; result?: unknown }) => ((reply.result as { providers?: ProviderInfo[] } | undefined)?.providers ?? []) as ProviderInfo[]

  test("list, set, test, refresh and remove work over the wire and no reply ever contains a key", async () => {
    const server = fakeServer((request) => (request.path.endsWith("/models") ? json({ data: [{ id: "m-one" }] }) : chatAnswer()))
    const dir = tempDir()
    const providers = createProviderService({ dir, env: { ANTHROPIC_API_KEY: KEY } })
    const { client } = await boot({ providers })
    const replies: unknown[] = []
    const send = async (command: Parameters<typeof client.send>[0]) => {
      const reply = await client.send(command)
      replies.push(reply)
      return reply
    }
    expect(infos(await send({ type: "providers.list" }))).toEqual([expect.objectContaining({ id: "anthropic", hasKey: true, keyTail: "…3f2a", source: "env" })])
    const set = await send({ type: "providers.set", provider: "gw", providerType: "openai-compatible", baseUrl: `${server.url}/v1`, apiKey: OTHER_KEY, models: [{ id: "m1" }] })
    expect(set).toMatchObject({ ok: true, result: { provider: { id: "gw", hasKey: true, keyTail: "…abcd", models: [{ id: "m1" }] } } })
    expect(fileMode(dir)).toBe(0o600)
    expect(await send({ type: "providers.test", provider: "gw" })).toMatchObject({ ok: true, result: { ok: true, model: "m1" } })
    expect(await send({ type: "providers.refresh", provider: "gw" })).toMatchObject({ ok: true, result: { provider: { models: [{ id: "m-one" }] } } })
    expect(await send({ type: "providers.set", provider: "gw", providerType: "openai-compatible", baseUrl: "not a url" })).toMatchObject({ ok: false })
    expect(await send({ type: "providers.set", provider: "custom" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await send({ type: "providers.test", provider: "ghost" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(infos(await send({ type: "providers.remove", provider: "gw" })).map((p) => p.id)).toEqual(["anthropic"])
    const everything = JSON.stringify(replies)
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(OTHER_KEY)
    expect(everything).not.toContain("apiKey\":")
  })

  test("a daemon without providers refuses the commands", async () => {
    const { client } = await boot()
    expect(await client.send({ type: "providers.list" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })

  test("/model lists provider models and accepts namespaced choices; an unknown namespace is refused", async () => {
    const providers = createProviderService({ dir: tempDir(), env: { ANTHROPIC_API_KEY: KEY } })
    const catalog: ModelCatalog = { selectable: true, list: () => [{ id: "gpt-6-luna", name: "luna", efforts: ["low"] }, ...providers.models()], defaults: { model: "gpt-6-luna", effort: "low" } }
    const { client, sessionId } = await boot({ providers, models: catalog })
    const listed = (await client.send({ type: "models.list", sessionId })) as { ok: true; result: ModelsReport }
    expect(listed.result.models.map((m) => m.id)).toContain("anthropic:claude-sonnet-5-5")
    const set = (await client.send({ type: "session.model.set", sessionId, choice: { model: "anthropic:claude-sonnet-5-5", effort: "medium" } })) as { ok: true; result: ModelsReport }
    expect(set.result.effective).toEqual({ model: "anthropic:claude-sonnet-5-5", effort: "medium" })
    expect(await client.send({ type: "session.model.set", sessionId, choice: { model: "ghost:model" } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.send({ type: "session.model.set", sessionId, choice: { model: "anthropic:claude-sonnet-5-5", effort: "xhigh" } })).toMatchObject({ ok: false })
  })

  test("/btw uses the aside role, then small, then the session's model", async () => {
    const catalog: ModelCatalog = {
      selectable: true,
      list: () => [{ id: "gpt-6-luna", name: "luna", efforts: [] }, { id: "gpt-6-sol", name: "sol", efforts: [] }, { id: "groq:llama", name: "llama", efforts: [], provider: "groq" }],
      defaults: { model: "gpt-6-luna" },
    }
    const { client, sessionId } = await boot({ models: catalog, complete: async () => "" })
    const model = async () => {
      const reply = await client.send({ type: "session.aside", sessionId, text: "why?" })
      return reply.ok ? (reply.result?.thread as { model?: string }).model : reply.error.message
    }
    await client.send({ type: "session.model.set", sessionId, choice: { model: "gpt-6-sol" } })
    expect(await model()).toBe("sol")
    await client.send({ type: "settings.set", patch: { models: { small: { model: "groq:llama" } } } })
    expect(await model()).toBe("llama")
    await client.send({ type: "settings.set", patch: { models: { small: { model: "groq:llama" }, aside: { model: "gpt-6-luna" } } } })
    expect(await model()).toBe("luna")
  })
})
