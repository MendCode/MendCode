import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, createProviderRouter, memoryHistory, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { isReadOnlyCommand, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"
import { createProviderAuth } from "../src/provider-auth"

const KEY = "perplexity-local-private-fixture-0123456789"
const URL = "http://127.0.0.1:1234"
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-12-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const request = { system: "", messages: [{ role: "user" as const, content: "What is TCP?" }], tools: [], model: "perplexity:sonar", signal: new AbortController().signal }
const fake: Fetch = async (url, init) => {
  expect(url.startsWith(URL)).toBe(true)
  expect(init.redirect).toBe("error")
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
  return init.method === "GET" ? Response.json({ data: [{ id: "sonar", context_length: 128000, supported_parameters: ["tools"] }] }) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Reliable transport. [1]" }, finish_reason: "stop" }], citations: ["https://example.com/tcp"], usage: { prompt_tokens: 10, completion_tokens: 4, cost: { total_cost: 0.001 } } })}\n\ndata: [DONE]\n\n`)
}

describe("B10.12 Perplexity daemon", () => {
  test("environment key and saved SDK do not enable; explicit local enable persists and routes without subscription", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { PERPLEXITY_API_KEY: KEY }, fetch: async (url, init) => { calls++; return fake(url, init) } })
    expect(providers.list()[0]).toMatchObject({ id: "perplexity", enabled: false, hasKey: true })
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "perplexity", npm: "@ai-sdk/perplexity", baseUrl: URL, apiKeyEnv: "PERPLEXITY_API_KEY" })).toMatchObject({ ok: true, provider: { enabled: false } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("subscription must not run") } }, providers: providers.runtime })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(providers.set({ id: "perplexity", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(providers.models()[0]).toMatchObject({ id: "perplexity:sonar", provider: "perplexity", tool_call: false })
    expect(providers.list()[0]!.models[0]).toMatchObject({ images: false, tool_call: false })
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(createProviderService({ dir, env: { PERPLEXITY_API_KEY: KEY } }).list()[0]!.enabled).toBe(true)
    providers.set({ id: "perplexity", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
  })

  test("plain-HTTP public endpoints cannot be enabled, imported unsafe config is inert and smoke refuses before HTTP", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: {}, fetch: async () => { calls++; throw new Error("no HTTP") } })
    expect(providers.set({ id: "perplexity", enabled: true, apiKey: KEY, baseUrl: "http://api.perplexity.ai" })).toMatchObject({ ok: false, code: "invalid_command", message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "perplexity", baseUrl: "http://public.example", enabled: false })).toMatchObject({ ok: false })
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { perplexity: { enabled: true, apiKey: KEY, type: "openai", npm: "@ai-sdk/perplexity", baseUrl: "http://api.perplexity.ai" } } }))
    expect(providers.list()[0]).toMatchObject({ type: "openai-compatible", enabled: false, error: expect.stringContaining("loopback") })
    expect(providers.models()).toEqual([])
    expect(await providers.test("perplexity")).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
    expect(await providers.refresh("perplexity")).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(calls).toBe(0)
    for (const command of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(command)).toBe(false)
  })

  test("auth methods and plans are offline; credentials are private and logout preserves config", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no HTTP") } })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanups.push(auth.stop)
    expect(auth.methods("perplexity")).toEqual({ perplexity: [{ id: "api-key", type: "api", label: "API key", available: true }] })
    expect(auth.plan("perplexity")).toMatchObject({ callsProvider: false, writesSecrets: false, executesNow: false })
    expect(auth.status("perplexity")[0]!.state).toBe("none")
    providers.set({ id: "perplexity", apiKey: KEY, enabled: true, baseUrl: URL })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(auth.status("perplexity")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("perplexity")])).not.toContain(KEY)
    expect(providers.logout!("perplexity")).toMatchObject({ ok: true, provider: { hasKey: false } })
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.perplexity).toEqual({ enabled: true, baseUrl: URL })
    expect(providers.models()).toEqual([])
  })

  test("refresh carries Sonar limits and no-tools metadata; failed refresh preserves saved models", async () => {
    const dir = temp()
    let failed = false
    const providers = createProviderService({ dir, env: {}, fetch: (url, init) => failed ? Promise.resolve(new Response(`rejected ${KEY}`, { status: 401 })) : fake(url, init) })
    providers.set({ id: "perplexity", apiKey: KEY, baseUrl: URL, enabled: true })
    expect(await providers.refresh("perplexity")).toMatchObject({ ok: true, provider: { models: [{ id: "sonar", context: 128000, images: false, tool_call: false }] } })
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    failed = true
    const reply = await providers.refresh("perplexity")
    expect(reply).toMatchObject({ ok: false })
    expect(JSON.stringify(reply)).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("daemon + typed client: opt-in, smoke, model selection, streamed citations and persisted replay", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: fake })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("no subscription") } }, providers: providers.runtime })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), log: () => {}, info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "perplexity:sonar" } }, engine: () => createNativeEngine({ provider: router, tools: [], history: memoryHistory(), cwdFor: () => dir, system: () => "Be brief", compactionPrompt: "Summarize", modelFor: () => ({ model: "perplexity:sonar" }) }) })
    cleanups.push(() => daemon.stop())
    const events: SessionEvent[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-12", onEvent: (event) => void events.push(event) })
    cleanups.push(() => client.close())
    await client.connect()
    expect(await client.providerAuthMethods("perplexity")).toMatchObject({ ok: true, methods: { perplexity: [{ id: "api-key" }] } })
    expect(await client.providerLoginPlan("perplexity")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const replies = [await client.send({ type: "providers.set", provider: "perplexity", apiKey: KEY, enabled: true, baseUrl: URL }), await client.send({ type: "providers.refresh", provider: "perplexity" }), await client.send({ type: "providers.test", provider: "perplexity" })]
    expect(replies.every((reply) => reply.ok)).toBe(true)
    expect(replies[2]).toMatchObject({ ok: true, result: { ok: true, model: "sonar" } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("session creation failed")
    const sessionId = session.result?.sessionId as SessionId
    expect(await client.send({ type: "session.model.set", sessionId, choice: { model: "perplexity:sonar" } })).toMatchObject({ ok: true, result: { effective: { model: "perplexity:sonar" } } })
    await client.subscribe(sessionId, 0)
    expect(await client.send({ type: "user.submit", sessionId, text: "What is TCP?", attachments: [] })).toMatchObject({ ok: true })
    const deadline = Date.now() + 4000
    while (!events.some((event) => event.type === "turn.completed")) {
      if (Date.now() > deadline) throw new Error("turn did not complete")
      await Bun.sleep(10)
    }
    expect(events.filter((event) => event.type === "item.completed")).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Reliable transport. [1]\n\n[1]: https://example.com/tcp" })]))
    expect(events.find((event) => event.type === "usage.recorded")).toMatchObject({ provider: "perplexity", model: "perplexity:sonar", input: 10, output: 4, costMicros: 1000 })
    const replay: SessionEvent[] = []
    const reader = createClient({ socketPath: daemon.socketPath, name: "b10-12-replay", onEvent: (event) => void replay.push(event) })
    cleanups.push(() => reader.close())
    await reader.connect()
    await reader.subscribe(sessionId, 0)
    expect(JSON.stringify(replay)).toContain("https://example.com/tcp")
    expect(JSON.stringify([...events, ...replay, ...replies, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
