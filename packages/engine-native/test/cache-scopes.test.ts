import { describe, expect, test } from "bun:test"
import type { CacheConfig } from "@mendcode/protocol"
import { cacheConfigFor, passiveCache, selectCache, updateCache, type CacheBinding } from "../src/cache-policy"
import { createNativeEngine, createProviderRouter, createResponsesProvider, createChatCompletionsProvider, memoryHistory } from "../src"
import { callTool, echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const binding: CacheBinding = { provider: "openai", model: "test", endpoint: "https://api.openai.com/v1", auth: "api", transport: "responses", account: "opaque-account" }
const compact = (sessionId: ReturnType<typeof ids<"session">>) => ({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })

describe("B49 cache selection", () => {
  test("negative gates take priority over global smart and exact-model selectors do not use globs", () => {
    const select = (config: CacheConfig, session = "s", model = "openrouter:vendor/exact") => selectCache({ config, directory: "/work/repo/", session, provider: "openrouter", model })
    expect(select({ mode: "off", projects: { "/work/repo": { mode: "smart" } } }).mode).toBe("off")
    expect(select({ mode: "smart", projects: { "/work/repo/": { mode: "off" } } }).source).toBe("project")
    expect(select({ mode: "smart", sessions: { mode: "none" } }).mode).toBe("off")
    expect(select({ mode: "smart", sessions: { mode: "selected", include: ["other"] } }).mode).toBe("off")
    expect(select({ mode: "smart", sessions: { include: ["s"], exclude: ["s"] } }).mode).toBe("off")
    expect(select({ mode: "smart", providers: { openrouter: { mode: "off" } } }).source).toBe("provider")
    expect(select({ mode: "smart", providers: { openrouter: { models: ["exact"], exclude_models: ["vendor/exact"] } } }).mode).toBe("off")
    expect(select({ providers: { openrouter: { models: ["exact"], scope: "project" } } })).toMatchObject({ mode: "smart", scope: "project", source: "model" })
    expect(select({ providers: { openrouter: { models: ["vendor/*"] } } }).mode).toBe("off")
    expect(select({ providers: { openrouter: { models: ["exact"] } } }, "s", "exact-v2").mode).toBe("off")
    expect(select({ sessions: { include: ["s"] } })).toMatchObject({ mode: "smart", scope: "session" })
    expect(select({ projects: { "/work/repo": { mode: "smart" } } }).scope).toBe("project")
    expect(select({})).toMatchObject({ mode: "legacy", scope: "session" })
  })
  test("targeted mutations preserve neighbours, lists deduplicate, project configs layer over global", () => {
    const initial: CacheConfig = { sessions: { include: ["s"], exclude: ["x"] }, providers: { openai: { models: ["m"], exclude_models: ["m"] } } }
    const input = { directory: "/work", action: "enable" as const }
    const next = updateCache(initial, { ...input, provider: "openai", model: "m" })
    expect(initial.providers!.openai!.exclude_models).toEqual(["m"])
    expect(next.providers!.openai).toMatchObject({ models: ["m"], exclude_models: [], mode: "smart" })
    expect(next.sessions).toEqual(initial.sessions)
    const disabled = updateCache(next, { ...input, action: "disable", session: "s" })
    expect(disabled.sessions).toMatchObject({ include: [], exclude: ["x", "s"] })
    expect(updateCache(disabled, { ...input, session: "s" }).sessions).toEqual({ mode: "selected", include: ["s"], exclude: ["x"] })
    expect(updateCache(undefined, { ...input, global: true, projectPath: "/work/repo/../repo/" }).projects).toEqual({ "/work/repo": { mode: "smart", scope: "project" } })
    expect(updateCache({ projects: { "/work/repo/": { mode: "off" } } }, { ...input, global: true, projectPath: "/work/repo" }).projects).toEqual({ "/work/repo": { mode: "smart", scope: "project" } })
    expect(() => updateCache(next, { ...input, model: "m" })).toThrow("requires --provider")
    expect(() => updateCache(next, { ...input, projectPath: "/work" })).toThrow("requires --global")
    expect(() => updateCache(next, { ...input, session: "s", provider: "openai" })).toThrow("cannot combine")
    expect(cacheConfigFor({ cache: next, cacheProjects: { "/work/repo/": { providers: { openai: { scope: "project" } } } } }, "/work/repo")).toMatchObject({ providers: { openai: { mode: "smart", models: ["m"], scope: "project" } }, sessions: initial.sessions })
  })
  test("only exact supported endpoint/auth/transport bindings permit managed keys", () => {
    expect(passiveCache(binding)).toBe("managed")
    expect(passiveCache({ ...binding, provider: "openrouter", transport: "chat", endpoint: "https://openrouter.ai/api/v1" })).toBe("managed")
    expect(passiveCache({ ...binding, auth: "oauth", endpoint: "https://chatgpt.com/backend-api/codex" })).toBe("session")
    for (const change of [{ endpoint: "https://api.openai.com.evil/v1" }, { endpoint: "http://api.openai.com/v1" }, { endpoint: "https://user:pass@api.openai.com/v1" }, { endpoint: "https://api.openai.com/unverified" }, { account: "" }, { auth: "unknown" as const }, { transport: "other" as const }]) expect(passiveCache({ ...binding, ...change })).toBe("none")
  })
})

describe("B49 native requests", () => {
  function harness(config: { current: CacheConfig }, options: { history?: ReturnType<typeof memoryHistory>; steps?: Parameters<typeof scriptedProvider>[0] } = {}) {
    const p = scriptedProvider(options.steps ?? Array.from({ length: 15 }, () => stop("ok")))
    let currentBinding = binding, cwd = "/work/repo", system = "SYS"
    const provider = { ...p.provider, id: "openai", model: "test", cacheBinding: async () => currentBinding }
    const engine = createNativeEngine({ provider, tools: [echoTool], history: options.history ?? memoryHistory(), cwdFor: () => cwd, system: () => system, compactionPrompt: "SUM", subagents: true, cacheConfig: () => config.current })
    return { ...p, engine, setBinding: (value: CacheBinding) => { currentBinding = value }, setCwd: (value: string) => { cwd = value }, setSystem: (value: string) => { system = value } }
  }
  test("project scope shares only a reproducible bound prefix; session/account/model/project/prompt partitions", async () => {
    const config = { current: { mode: "smart", scope: "project" } as CacheConfig }, h = harness(config)
    const a = ids("session"), b = ids("session")
    await h.engine.runTurn(turn({ sessionId: a, text: "one" }).input)
    await h.engine.runTurn(turn({ sessionId: b, text: "two" }).input)
    const key = h.requests[0]!.cacheKey
    expect(key).toMatch(/^mc:[0-9a-f]{64}$/)
    expect(h.requests[1]!.cacheKey).toBe(key)
    h.setBinding({ ...binding, account: "other" })
    await h.engine.runTurn(turn({ sessionId: a, text: "three" }).input)
    expect(h.requests[2]!.cacheKey).not.toBe(key)
    h.setBinding({ ...binding, model: "other" })
    await h.engine.runTurn(turn({ sessionId: a, text: "four" }).input)
    expect(h.requests[3]!.cacheKey).not.toBe(key)
    h.setBinding(binding); h.setCwd("/work/other")
    await h.engine.runTurn(turn({ sessionId: a, text: "five" }).input)
    expect(h.requests[4]!.cacheKey).not.toBe(key)
    h.setCwd("/work/repo"); h.setSystem("new system")
    await h.engine.runTurn(turn({ sessionId: a, text: "six" }).input)
    expect(h.requests[5]!.cacheKey).not.toBe(key)
    h.setSystem("SYS"); config.current.scope = "session"
    await h.engine.runTurn(turn({ sessionId: a, text: "seven" }).input)
    await h.engine.runTurn(turn({ sessionId: b, text: "eight" }).input)
    expect(h.requests[6]!.cacheKey).not.toBe(h.requests[7]!.cacheKey)
  })
  test("lineage changes at compaction and survives restart", async () => {
    const config = { current: { mode: "smart" } as CacheConfig }, history = memoryHistory(), sessionId = ids("session")
    const h = harness(config, { history, steps: [stop("ok"), stop("summary"), stop("ok"), stop("ok")] })
    await h.engine.runTurn(turn({ sessionId, text: "one" }).input)
    await h.engine.compact(compact(sessionId))
    await h.engine.runTurn(turn({ sessionId, text: "two" }).input)
    const before = h.requests[0]!.cacheKey, after = h.requests.at(-1)!.cacheKey
    expect(after).not.toBe(before)
    const restarted = harness(config, { history })
    await restarted.engine.runTurn(turn({ sessionId, text: "three" }).input)
    expect(restarted.requests[0]!.cacheKey).toBe(after)
  })
  test("off is read again in a tool loop; subagents stay separate; unknown hosts cannot share", async () => {
    const config = { current: { mode: "smart" } as CacheConfig }, sessionId = ids("session")
    const h = harness(config, { steps: [async function* () { config.current = { mode: "off" }; yield* callTool("echo", { text: "x" }) }, stop("done")] })
    await h.engine.runTurn(turn({ sessionId, text: "one" }).input)
    expect(h.requests[0]!.cacheKey).toBeDefined()
    expect(h.requests[1]!.cacheMode).toBe("off")
    expect(h.requests[1]!.cacheKey).toBeUndefined()
    config.current = { mode: "smart", scope: "project" }
    const sub = harness(config, { steps: [callTool("task", { description: "d", prompt: "p" }), stop("sub"), stop("done")] })
    await sub.engine.runTurn(turn({ sessionId, text: "two" }).input)
    expect(sub.requests[1]!.cacheKey).not.toBe(sub.requests[0]!.cacheKey)
    const unknown = harness(config)
    unknown.setBinding({ ...binding, endpoint: "https://unverified.test/v1" })
    await unknown.engine.runTurn(turn({ sessionId, text: "three" }).input)
    expect(unknown.requests[0]).toMatchObject({ cacheMode: "legacy" })
    expect(unknown.requests[0]!.cacheKey).toBeUndefined()
    const oauth = harness(config)
    oauth.setBinding({ ...binding, auth: "oauth", endpoint: "https://chatgpt.com/backend-api/codex" })
    await oauth.engine.runTurn(turn({ sessionId, text: "four" }).input)
    expect(oauth.requests[0]!.cacheKey).toBe(sessionId)
  })
  test("router binding uses the selected provider and strips only its namespace", async () => {
    const p = scriptedProvider([stop("ok")])
    const openrouter = { ...p.provider, id: "openrouter", cacheBinding: async (model: string | undefined) => ({ ...binding, provider: "openrouter", model: model!, transport: "chat" as const }) }
    const router = createProviderRouter({ fallback: p.provider, providers: { openrouter } })
    expect(await router.cacheBinding?.("openrouter:vendor/exact")).toMatchObject({ provider: "openrouter", model: "vendor/exact" })
    expect(await router.cacheBinding?.("unregistered:m")).toBeUndefined()
  })
  test("adapter wire controls are passive, account opaque and off wins over a request hook", async () => {
    const calls: { body: Record<string, unknown>; headers: Headers }[] = []
    const fakeFetch = async (_: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) })
      return new Response('data: {"type":"response.completed","response":{}}\n\n', { headers: { "content-type": "text/event-stream" } })
    }
    const provider = createResponsesProvider({ id: "openai", model: "m", baseUrl: "https://api.openai.com/v1", headers: async () => ({ authorization: "Bearer private-key" }), authHint: "api", fetch: fakeFetch })
    const b = await provider.cacheBinding?.(undefined)
    expect(b?.account).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(b)).not.toContain("private-key")
    const request = { system: "s", messages: [] as [], tools: [], cacheKey: "opaque", signal: new AbortController().signal }
    for await (const _ of provider.stream({ ...request, cacheMode: "off", transformBody: async (body) => ({ ...body, prompt_cache_key: "bad" }) })) {}
    expect(calls[0]!.body.prompt_cache_key).toBeUndefined()
    expect(calls[0]!.headers.get("session_id")).toBeNull()
    const chat = createChatCompletionsProvider({ id: "openrouter", model: "m", baseUrl: "https://openrouter.ai/api/v1", apiKey: () => "private-key", fetch: async (url, init) => { calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) } })
    for (const cacheMode of ["smart", "off", "legacy"] as const) for await (const _ of chat.stream({ ...request, cacheMode })) {}
    expect(calls.slice(1).map((call) => call.body.prompt_cache_key)).toEqual(["opaque", undefined, undefined])
  })
})
