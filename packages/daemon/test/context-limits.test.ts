import { afterEach, expect, test } from "bun:test"
import { compactionThreshold } from "@mendcode/engine-native"
import { ContextLimits, RecentContextReport, type ModelInfo, type ProviderInfo, type SessionEvent } from "@mendcode/protocol"
import { compactPoint, contextLimits, globalTrigger, modelCompactAt, modelLimits, turnSamples } from "../src/context-limits"
import { answer, boot, openSession, until } from "./native-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const sol: ModelInfo = { id: "gpt-6.1-sol", name: "Sol", efforts: [], contextWindow: 500_000 }
const noTrigger = { tokens: undefined, environment: false }
const usage = (extra: Partial<Extract<SessionEvent, { type: "usage.recorded" }>> = {}) => ({ type: "usage.recorded", provider: "chatgpt", model: "gpt-6.1-sol", input: 1000, output: 200, reasoning: 0, cacheRead: 200_000, cacheWrite: 0, ...extra }) as Extract<SessionEvent, { type: "usage.recorded" }>

test("a 500k model with nothing set packs at 90 percent of its window, and the label says so", () => {
  expect(compactPoint({}, { contextWindow: 500_000 }, noTrigger)).toEqual({ tokens: 450_000, compactAtSource: "threshold", thresholdPercent: 90, thresholdSource: "default" })
})

test("the compactAtTokens setting is an absolute trigger, lowered to a smaller window", () => {
  expect(compactPoint({}, { contextWindow: 500_000 }, { tokens: 450_000, environment: false })).toEqual({ tokens: 450_000, compactAtSource: "compactAtTokens" })
  expect(compactPoint({ threshold: 50 }, { contextWindow: 200_000 }, { tokens: 450_000, environment: false })).toEqual({ tokens: 200_000, compactAtSource: "compactAtTokens", capped: true })
})

test("the daemon's environment variable wins over the setting and is named", () => {
  expect(globalTrigger({ compactAtTokens: 450_000 }, { MENDCODE_COMPACT_AT_TOKENS: "300000" })).toEqual({ tokens: 300_000, environment: true })
  expect(globalTrigger({ compactAtTokens: 450_000 }, { MENDCODE_COMPACT_AT_TOKENS: "nope" })).toEqual({ tokens: 450_000, environment: false })
  expect(compactPoint({}, { contextWindow: 500_000 }, { tokens: 300_000, environment: true }).compactAtSource).toBe("environment")
})

test("precedence of the labels is the engine's: model, provider, global trigger, compaction.token_limit, then a percentage", () => {
  const limits = { contextWindow: 500_000, provider: { token_limit: 120_000, threshold: 60 }, model: { token_limit: 90_000, threshold: 40 } }
  expect(compactPoint({ token_limit: 100_000 }, limits, { tokens: 450_000, environment: false })).toEqual({ tokens: 90_000, compactAtSource: "model-override" })
  expect(compactPoint({ token_limit: 100_000 }, { ...limits, model: { threshold: 40 } }, { tokens: 450_000, environment: false })).toEqual({ tokens: 120_000, compactAtSource: "provider-override" })
  expect(compactPoint({ token_limit: 100_000 }, { contextWindow: 500_000 }, noTrigger)).toEqual({ tokens: 100_000, compactAtSource: "compaction.token_limit" })
  expect(compactPoint({ threshold: 90 }, { contextWindow: 500_000, model: { threshold: 40 } }, noTrigger)).toEqual({ tokens: 200_000, compactAtSource: "threshold", thresholdPercent: 40, thresholdSource: "model-override" })
  expect(compactPoint({ threshold: 90 }, { contextWindow: 500_000, provider: { threshold: 60 } }, noTrigger)).toEqual({ tokens: 300_000, compactAtSource: "threshold", thresholdPercent: 60, thresholdSource: "provider-override" })
  expect(compactPoint({ threshold: 90 }, { contextWindow: 500_000 }, noTrigger)).toEqual({ tokens: 450_000, compactAtSource: "threshold", thresholdPercent: 90, thresholdSource: "compaction.threshold" })
  expect(compactPoint({ threshold: 250 }, { contextWindow: 500_000 }, noTrigger)).toMatchObject({ tokens: 500_000, thresholdPercent: 100 })
})

test("no known window packs at the 160k default; an input limit below the window is what the percentage applies to", () => {
  expect(compactPoint({ threshold: 50 }, {}, noTrigger)).toEqual({ tokens: 160_000, compactAtSource: "no-window-default" })
  expect(compactPoint({}, { contextWindow: 500_000, inputLimit: 400_000 }, noTrigger)).toMatchObject({ tokens: 360_000, compactAtSource: "threshold" })
})

test("every labelled point is the engine's own number", () => {
  const configs = [{}, { threshold: 80 }, { token_limit: 70_000 }, { threshold: 0 }]
  const limits = [{}, { contextWindow: 500_000 }, { contextWindow: 200_000, inputLimit: 150_000 }, { contextWindow: 500_000, provider: { threshold: 50 } }, { contextWindow: 64_000, model: { token_limit: 900_000 } }]
  for (const config of configs) for (const limit of limits) for (const tokens of [undefined, 450_000]) expect(compactPoint(config, limit, { tokens, environment: false }).tokens).toBe(compactionThreshold(config, limit, tokens))
})

test("a model's limits come from the model list and, for an API provider, from its providers.json entry; a session window replaces both", () => {
  const provider = { id: "acme", compaction: { threshold: 80 }, models: [{ id: "big", context: 300_000, inputLimit: 250_000, outputLimit: 30_000, compaction: { token_limit: 100_000 } }, { id: "plain", limit: { context: 128_000, output: 8000 } }] } as unknown as ProviderInfo
  const big: ModelInfo = { id: "acme:big", name: "Big", efforts: [], contextWindow: 300_000, provider: "acme" }
  expect(modelLimits({ model: big, providers: [provider] })).toEqual({ contextWindow: 300_000, inputLimit: 250_000, outputLimit: 30_000, provider: { threshold: 80 }, model: { token_limit: 100_000 } })
  expect(modelLimits({ model: big, providers: [provider], override: 1_000_000 })).toEqual({ contextWindow: 1_000_000, outputLimit: 30_000, provider: { threshold: 80 }, model: { token_limit: 100_000 } })
  expect(modelLimits({ model: sol, providers: [provider] })).toEqual({ contextWindow: 500_000 })
  expect(modelLimits({ model: undefined, providers: [] })).toEqual({})
  expect(modelCompactAt({ model: big, providers: [provider], settings: {}, environment: {} })).toBe(100_000)
  expect(modelCompactAt({ model: { id: "acme:plain", name: "Plain", efforts: [], provider: "acme" }, providers: [provider], settings: {}, environment: {} })).toBe(102_400)
})

test("the models list states where each native model packs, and nothing for a model another engine or an ACP agent runs", () => {
  expect(modelCompactAt({ model: sol, providers: [], settings: {}, environment: {} })).toBe(450_000)
  expect(modelCompactAt({ model: sol, providers: [], settings: { compactAtTokens: 450_000 }, environment: {} })).toBe(450_000)
  expect(modelCompactAt({ model: sol, providers: [], settings: { compaction: { threshold: 90 } }, environment: {} })).toBe(450_000)
  expect(modelCompactAt({ model: { id: "unlisted", name: "?", efforts: [] }, providers: [], settings: {}, environment: {} })).toBe(160_000)
  expect(modelCompactAt({ model: { ...sol, id: "claude-opus", engine: "claude" }, providers: [], settings: {}, environment: {} })).toBeUndefined()
  expect(modelCompactAt({ model: { ...sol, id: "acp:gemini" }, providers: [], settings: {}, environment: {} })).toBeUndefined()
})

test("a session's limits: the engine's point explained by the settings, tokens from the last call", () => {
  const report = { model: "gpt-6.1-sol", compactAtTokens: 450_000, estimatedTokens: 190_000 }
  const limits = contextLimits({ report, catalog: [sol], providers: [], settings: {}, lastUsage: usage(), environment: {} })
  expect(limits).toEqual({ model: "gpt-6.1-sol", contextWindow: 500_000, contextWindowSource: "catalog", compactAtTokens: 450_000, compactAtSource: "threshold", thresholdPercent: 90, thresholdSource: "default", autoCompact: true, contextTokens: 201_200, contextTokensSource: "last-call", forecast: { limit: "compaction", auto: true, tokensLeft: 248_800, noticeDue: false } })
  expect(ContextLimits.safeParse(limits).success).toBe(true)
})

test("the estimate: tokens left, turns from three main turns of growth, and whether the terminal's notice is due", () => {
  const report = { model: "gpt-6.1-sol", compactAtTokens: 450_000, estimatedTokens: 0 }
  const at = (turnId: string, context: number, extra: Record<string, unknown> = {}) => usage({ turnId: turnId as never, input: context, output: 0, cacheRead: 0, compactAt: 450_000, ...extra })
  const recentUsage = [at("t1", 300_000), at("t2", 320_000), at("t2", 340_000), at("sub", 5_000, { compactAt: undefined }), at("t3", 400_000)]
  const base = { report, catalog: [sol], providers: [], lastUsage: recentUsage.at(-1), recentUsage, environment: {} }
  expect(turnSamples(recentUsage)).toEqual([{ turnId: "t1", tokens: 300_000 }, { turnId: "t2", tokens: 340_000 }, { turnId: "t3", tokens: 400_000 }])
  const balanced = contextLimits({ ...base, settings: {}, notice: { tier: "balanced" } })
  expect(balanced.forecast).toEqual({ limit: "compaction", auto: true, tokensLeft: 50_000, turns: 1, perTurn: 50_000, noticePercent: 80, noticeDue: true })
  expect(ContextLimits.safeParse(balanced).success).toBe(true)
  // Two turns of data: tokens only. No tier, or the setting off: the estimate stays, the notice is not due.
  expect(contextLimits({ ...base, recentUsage: recentUsage.slice(3), settings: {}, notice: { tier: "balanced" } }).forecast).toEqual({ limit: "compaction", auto: true, tokensLeft: 50_000, noticePercent: 80, noticeDue: true })
  expect(contextLimits({ ...base, settings: {}, notice: {} }).forecast).toMatchObject({ tokensLeft: 50_000, noticeDue: false })
  expect(contextLimits({ ...base, settings: {}, notice: { tier: "full", compactNoticePercent: "off" } }).forecast?.noticePercent).toBeUndefined()
  expect(contextLimits({ ...base, settings: {}, notice: { tier: "full", compactNoticePercent: 90 } }).forecast).toMatchObject({ noticePercent: 90, noticeDue: false })
  // After a compaction the earlier turns say nothing about the new history.
  expect(contextLimits({ ...base, packedSince: true, settings: {}, notice: { tier: "balanced" } }).forecast).toEqual({ limit: "compaction", auto: true, tokensLeft: 450_000, noticePercent: 80, noticeDue: false })
})

test("no estimate when there is nothing to predict: automatic compaction off with no known window, or no measured context", () => {
  const unknown = { report: { model: "unlisted", compactAtTokens: 160_000, estimatedTokens: 150_000 }, catalog: [], providers: [], environment: {} }
  expect(contextLimits({ ...unknown, settings: { compaction: { auto: false } }, notice: { tier: "balanced" } }).forecast).toBeUndefined()
  expect(contextLimits({ ...unknown, settings: {}, notice: { tier: "balanced" } }).forecast).toMatchObject({ limit: "compaction", tokensLeft: 10_000, noticeDue: true })
  const known = contextLimits({ report: { model: "gpt-6.1-sol", compactAtTokens: 450_000, estimatedTokens: 400_000 }, catalog: [sol], providers: [], settings: { compaction: { auto: false } }, notice: { tier: "balanced" }, environment: {} })
  expect(known.forecast).toMatchObject({ limit: "compaction", auto: false, tokensLeft: 50_000 })
  expect(contextLimits({ catalog: [], providers: [], settings: {}, fallbackModel: "gpt-6-luna", notice: { tier: "balanced" }, environment: {} }).forecast).toBeUndefined()
})

test("after a compaction packed the history, or before any call, the tokens are the engine's estimate", () => {
  const report = { model: "gpt-6.1-sol", compactAtTokens: 450_000, estimatedTokens: 30_000 }
  expect(contextLimits({ report, catalog: [sol], providers: [], settings: {}, lastUsage: usage(), packedSince: true, environment: {} })).toMatchObject({ contextTokens: 30_000, contextTokensSource: "estimate" })
  expect(contextLimits({ report, catalog: [sol], providers: [], settings: {}, environment: {} })).toMatchObject({ contextTokens: 30_000, contextTokensSource: "estimate" })
})

test("a session window is named as the source, and a point the settings do not reproduce is labelled as the engine's", () => {
  const overridden = contextLimits({ report: { model: "gpt-6.1-sol", compactAtTokens: 180_000, estimatedTokens: 0 }, override: 200_000, catalog: [sol], providers: [], settings: { compaction: { auto: false } }, environment: {} })
  expect(overridden).toMatchObject({ contextWindow: 200_000, contextWindowSource: "session", compactAtTokens: 180_000, compactAtSource: "threshold", autoCompact: false })
  const odd = contextLimits({ report: { model: "faux fixture", contextWindow: 32_000, compactAtTokens: 24_000, estimatedTokens: 0 }, catalog: [], providers: [], settings: {}, environment: {} })
  expect(odd).toMatchObject({ contextWindow: 32_000, contextWindowSource: "engine", compactAtTokens: 24_000, compactAtSource: "engine" })
  expect(odd.thresholdPercent).toBeUndefined()
  const unknown = contextLimits({ report: { model: "unlisted", compactAtTokens: 160_000, estimatedTokens: 0 }, catalog: [], providers: [], settings: {}, environment: {} })
  expect(unknown).toMatchObject({ contextWindowSource: "unknown", compactAtTokens: 160_000, compactAtSource: "no-window-default" })
  expect(unknown.contextWindow).toBeUndefined()
})

test("an engine without a report: its own window from the last call, or where MendCode said it would pack", () => {
  const own = contextLimits({ catalog: [], providers: [], settings: {}, lastUsage: usage({ provider: "claude", model: "claude-opus", context: 80_000, contextWindow: 200_000 }), environment: {} })
  expect(own).toEqual({ model: "claude-opus", contextWindow: 200_000, contextWindowSource: "engine", compactAtSource: "engine-managed", autoCompact: true, contextTokens: 80_000, contextTokensSource: "last-call", forecast: { limit: "window", auto: true, tokensLeft: 120_000, noticeDue: false } })
  const said = contextLimits({ catalog: [sol], providers: [], settings: {}, lastUsage: usage({ compactAt: 450_000 }), environment: {} })
  expect(said).toMatchObject({ contextWindow: 500_000, contextWindowSource: "catalog", compactAtTokens: 450_000, compactAtSource: "last-call" })
  expect(contextLimits({ catalog: [], providers: [], settings: {}, fallbackModel: "gpt-6-luna", environment: {} })).toEqual({ model: "gpt-6-luna", contextWindowSource: "unknown", compactAtSource: "engine-managed", autoCompact: true })
})

test("context.recent states the limits of a real session and follows the setting and the session window", async () => {
  const h = await boot({ steps: [answer("First", { input: 100, output: 10 })] })
  cleanups.push(h.cleanup)
  const sessionId = await openSession(h)
  const fresh = await h.client.recentContext(sessionId)
  expect(fresh.ok && fresh.report.limits).toMatchObject({ model: "script-1", contextWindowSource: "unknown", compactAtTokens: 160_000, compactAtSource: "no-window-default", autoCompact: true, contextTokensSource: "estimate" })
  expect((await h.client.send({ type: "user.submit", sessionId, text: "one", attachments: [] })).ok).toBe(true)
  await until(() => h.store.turns.list(sessionId).filter((turn) => turn.status === "completed").length === 1)
  const called = await h.client.recentContext(sessionId)
  expect(called.ok && RecentContextReport.safeParse(called.report).success).toBe(true)
  expect(called.ok && called.report.limits).toMatchObject({ contextTokens: 110, contextTokensSource: "last-call" })
  expect((await h.client.send({ type: "settings.set", patch: { compactAtTokens: 450_000 } })).ok).toBe(true)
  const set = await h.client.recentContext(sessionId)
  expect(set.ok && set.report.limits).toMatchObject({ compactAtTokens: 450_000, compactAtSource: "compactAtTokens" })
  expect((await h.client.send({ type: "session.context-window", sessionId, tokens: 200_000 })).ok).toBe(true)
  const capped = await h.client.recentContext(sessionId)
  expect(capped.ok && capped.report.limits).toMatchObject({ contextWindow: 200_000, contextWindowSource: "session", compactAtTokens: 200_000, compactAtSource: "compactAtTokens", capped: true })
  expect((await h.client.send({ type: "settings.set", patch: { compactAtTokens: null, compaction: { threshold: 90 } } })).ok).toBe(true)
  const percent = await h.client.recentContext(sessionId)
  expect(percent.ok && percent.report.limits).toMatchObject({ compactAtTokens: 180_000, compactAtSource: "threshold", thresholdPercent: 90, thresholdSource: "compaction.threshold" })
  const models = await h.client.send({ type: "models.list" })
  expect(models.ok && (models.result!.models as ModelInfo[]).map((model) => model.compactAtTokens)).toEqual([160_000, 160_000, 160_000])
})
