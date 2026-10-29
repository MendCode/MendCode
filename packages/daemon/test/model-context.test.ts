import { afterEach, describe, expect, test } from "bun:test"
import { clampWindow, ContextLimits, ContextReport, modelRef, Settings, type ModelInfo, type ModelsReport } from "@mendcode/protocol"
import { contextLimits, globalTrigger, compactPoint, modelCompactAt } from "../src/context-limits"
import { windowOverride } from "../src/session-context-window"
import { boot, openSession, say, stop, type NativeHarness } from "./native-harness"

const astra: ModelInfo = { id: "gpt-6-astra", name: "Astra", efforts: [], contextWindow: 272_000, maxContextWindow: 872_000 }
const luna: ModelInfo = { id: "gpt-6-luna", name: "Luna", efforts: [], contextWindow: 272_000 }
const facts = (entries: Record<string, string> = {}) => ({ get: (key: string) => entries[key] })
const sessionId = "ses_model_context" as never

describe("the modelContext setting", () => {
  test("is keyed by the reference mendcode models prints, 1,000 to 10,000,000 tokens, with a window or a compaction point", () => {
    expect(modelRef(astra)).toBe("chatgpt/gpt-6-astra")
    expect(modelRef({ id: "openai:gpt-6-astra", provider: "openai" })).toBe("openai/gpt-6-astra")
    expect(modelRef({ id: "claude-opus", engine: "claude" })).toBe("claude/claude-opus")
    const valid = (modelContext: unknown) => Settings.safeParse({ modelContext }).success
    expect(valid({ "chatgpt/gpt-6-astra": { window: 500_000 } })).toBe(true)
    expect(valid({ "chatgpt/gpt-6-astra": { window: 1_000, compactAt: 10_000_000 } })).toBe(true)
    expect(valid({ "openrouter/openai/gpt-6-luna": { compactAt: 200_000 } })).toBe(true)
    expect(valid({ "chatgpt/gpt-6-astra": { window: 999 } })).toBe(false)
    expect(valid({ "chatgpt/gpt-6-astra": { window: 10_000_001 } })).toBe(false)
    expect(valid({ "chatgpt/gpt-6-astra": { compactAt: 999 } })).toBe(false)
    expect(valid({ "chatgpt/gpt-6-astra": { window: 500_000.5 } })).toBe(false)
    expect(valid({ "chatgpt/gpt-6-astra": {} })).toBe(false)
    expect(valid({ "chatgpt/gpt-6-astra": { window: 500_000, size: 1 } })).toBe(false)
    expect(valid({ "gpt-6-astra": { window: 500_000 } })).toBe(false)
    expect(valid(Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`chatgpt/m${index}`, { window: 100_000 }])))).toBe(false)
  })

  test("a window above the model's known maximum is lowered to it; with no known maximum it is kept", () => {
    expect(clampWindow(1_000_000, 872_000)).toEqual({ tokens: 872_000, clamped: true })
    expect(clampWindow(500_000, 872_000)).toEqual({ tokens: 500_000, clamped: false })
    expect(clampWindow(5_000_000, undefined)).toEqual({ tokens: 5_000_000, clamped: false })
  })
})

describe("precedence: the session's /context-window, then modelContext, then the catalog", () => {
  const settings = { modelContext: { "chatgpt/gpt-6-astra": { window: 500_000 } } }
  test("windowOverride", () => {
    expect(windowOverride({ meta: facts(), sessionId, model: astra, settings })).toEqual({ tokens: 500_000, source: "model-setting" })
    expect(windowOverride({ meta: facts({ [`session.contextWindow:${sessionId}`]: "300000" }), sessionId, model: astra, settings })).toEqual({ tokens: 300_000, source: "session" })
    expect(windowOverride({ meta: facts(), sessionId, model: luna, settings })).toBeUndefined()
    expect(windowOverride({ meta: facts(), sessionId, model: astra, settings: { modelContext: { "chatgpt/gpt-6-astra": { window: 2_000_000 } } } })).toEqual({ tokens: 872_000, source: "model-setting" })
    expect(windowOverride({ meta: facts({ [`session.contextWindow:${sessionId}`]: "2000000" }), sessionId, model: astra, settings: {} })).toEqual({ tokens: 872_000, source: "session" })
  })

  test("the session's limits name the source, the known maximum and where it packs", () => {
    const report = { model: "gpt-6-astra", compactAtTokens: 450_000, estimatedTokens: 0 }
    const fromSetting = contextLimits({ report, catalog: [astra], providers: [], settings, environment: {} })
    expect(fromSetting).toMatchObject({ contextWindow: 500_000, contextWindowSource: "model-setting", maxContextWindow: 872_000, compactAtTokens: 450_000, compactAtSource: "threshold", thresholdPercent: 90 })
    expect(ContextLimits.safeParse(fromSetting).success).toBe(true)
    expect(contextLimits({ report: { ...report, compactAtTokens: 270_000 }, override: 300_000, catalog: [astra], providers: [], settings, environment: {} })).toMatchObject({ contextWindow: 300_000, contextWindowSource: "session" })
    expect(contextLimits({ report: { ...report, compactAtTokens: 244_800 }, catalog: [astra], providers: [], settings: {}, environment: {} })).toMatchObject({ contextWindow: 272_000, contextWindowSource: "catalog", compactAtSource: "threshold" })
    // No engine report (another engine runs it): still the setting's window.
    expect(contextLimits({ catalog: [astra], providers: [], settings, fallbackModel: "gpt-6-astra", environment: {} })).toMatchObject({ contextWindow: 500_000, contextWindowSource: "model-setting" })
  })

  test("compactAt of the model replaces compactAtTokens and is named; the daemon's environment still wins", () => {
    const both = { compactAtTokens: 200_000, modelContext: { "chatgpt/gpt-6-astra": { window: 500_000, compactAt: 400_000 } } }
    expect(globalTrigger(both, {}, 400_000)).toEqual({ tokens: 400_000, environment: false, modelSetting: true })
    expect(globalTrigger(both, { MENDCODE_COMPACT_AT_TOKENS: "300000" }, 400_000)).toEqual({ tokens: 300_000, environment: true })
    expect(compactPoint({}, { contextWindow: 500_000 }, { tokens: 400_000, environment: false, modelSetting: true })).toEqual({ tokens: 400_000, compactAtSource: "model-setting" })
    expect(contextLimits({ report: { model: "gpt-6-astra", compactAtTokens: 400_000, estimatedTokens: 0 }, catalog: [astra], providers: [], settings: both, environment: {} })).toMatchObject({ contextWindow: 500_000, compactAtTokens: 400_000, compactAtSource: "model-setting" })
    expect(modelCompactAt({ model: astra, providers: [], settings: both, environment: {} })).toBe(400_000)
    expect(modelCompactAt({ model: astra, providers: [], settings: { modelContext: { "chatgpt/gpt-6-astra": { window: 500_000 } } }, environment: {} })).toBe(450_000)
    expect(modelCompactAt({ model: astra, providers: [], settings: { modelContext: { "chatgpt/gpt-6-astra": { window: 2_000_000 } } }, environment: {} })).toBe(784_800)
    expect(modelCompactAt({ model: luna, providers: [], settings: both, environment: {} })).toBe(200_000)
  })
})

describe("session.context-window through the daemon", () => {
  let h: NativeHarness | undefined
  afterEach(async () => { await h?.cleanup(); h = undefined })
  const extraModels: ModelInfo[] = [{ id: "astra-test", name: "Astra test", efforts: [], contextWindow: 272_000, maxContextWindow: 872_000 }]

  async function onAstra() {
    h = await boot({ steps: [stop("done"), stop("again")], extraModels })
    const id = await openSession(h)
    expect(await h.client.send({ type: "session.model.set", sessionId: id, choice: { model: "astra-test" } })).toMatchObject({ ok: true })
    await say(h, id, "size me")
    return id
  }
  const report = async (id: string) => {
    const reply = await h!.client.send({ type: "context.query", sessionId: id as never })
    if (!reply.ok) throw new Error(reply.error.message)
    return ContextReport.parse(reply.result)
  }

  test("--always saves the window for the model, applies it to this session and every other one, and reset removes it", async () => {
    const id = await onAstra()
    expect(await h!.client.send({ type: "session.context-window", sessionId: id, tokens: 500_000, always: true })).toEqual({ ok: true, result: { contextWindow: 500_000, maxContextWindow: 872_000, modelWindow: 272_000, model: "chatgpt/astra-test", saved: "set" } })
    expect(h!.store.settings.get().modelContext).toEqual({ "chatgpt/astra-test": { window: 500_000 } })
    expect(await report(id)).toMatchObject({ contextWindow: 500_000, contextWindowModelSetting: true, compactAtTokens: 450_000 })
    // Another session on the same model follows the setting with no command of its own.
    const other = await openSession(h!)
    await h!.client.send({ type: "session.model.set", sessionId: other, choice: { model: "astra-test" } })
    expect(await report(other)).toMatchObject({ contextWindow: 500_000, contextWindowModelSetting: true })
    // A session's own window still wins over the setting.
    expect(await h!.client.send({ type: "session.context-window", sessionId: other, tokens: 300_000 })).toMatchObject({ ok: true, result: { contextWindow: 300_000 } })
    expect(await report(other)).toMatchObject({ contextWindow: 300_000, contextWindowOverride: true, compactAtTokens: 270_000 })
    // The models list shows the setting beside the catalog's window and maximum.
    const listed = await h!.client.send({ type: "models.list" })
    const astra = listed.ok ? (listed.result as unknown as ModelsReport).models.find((model) => model.id === "astra-test") : undefined
    expect(astra).toMatchObject({ contextWindow: 272_000, maxContextWindow: 872_000, contextSetting: { window: 500_000 }, compactAtTokens: 450_000 })
    expect(await h!.client.send({ type: "session.context-window", sessionId: id, tokens: null, always: true })).toEqual({ ok: true, result: { model: "chatgpt/astra-test", saved: "removed" } })
    expect(h!.store.settings.get().modelContext).toBeUndefined()
    expect((await report(id)).contextWindow).toBe(272_000)
  })

  test("a window above the known maximum is lowered to it, for the session and with --always", async () => {
    const id = await onAstra()
    expect(await h!.client.send({ type: "session.context-window", sessionId: id, tokens: 1_000_000 })).toMatchObject({ ok: true, result: { contextWindow: 872_000, requested: 1_000_000, maxContextWindow: 872_000, clamped: true } })
    expect(await report(id)).toMatchObject({ contextWindow: 872_000, contextWindowOverride: true })
    expect(await h!.client.send({ type: "session.context-window", sessionId: id, tokens: 1_000_000, always: true })).toMatchObject({ ok: true, result: { contextWindow: 872_000, clamped: true, saved: "set" } })
    expect(h!.store.settings.get().modelContext).toEqual({ "chatgpt/astra-test": { window: 872_000 } })
    // --always clears the session's own window: it follows the setting now.
    expect(await report(id)).toMatchObject({ contextWindow: 872_000, contextWindowModelSetting: true })
  })

  test("--always keeps the model's compactAt, and a model with no known maximum takes the window as asked", async () => {
    h = await boot({ steps: [stop("done")] })
    const id = await openSession(h)
    await h.client.send({ type: "session.model.set", sessionId: id, choice: { model: "script-1" } })
    await say(h, id, "size me")
    h.store.settings.set({ modelContext: { "chatgpt/script-1": { compactAt: 50_000 } } })
    expect(await h.client.send({ type: "session.context-window", sessionId: id, tokens: 5_000_000, always: true })).toEqual({ ok: true, result: { contextWindow: 5_000_000, model: "chatgpt/script-1", saved: "set" } })
    expect(h.store.settings.get().modelContext).toEqual({ "chatgpt/script-1": { compactAt: 50_000, window: 5_000_000 } })
    expect(await report(id)).toMatchObject({ contextWindow: 5_000_000, compactAtTokens: 50_000 })
    expect(await h.client.send({ type: "session.context-window", sessionId: id, tokens: null, always: true })).toMatchObject({ ok: true, result: { saved: "removed" } })
    expect(h.store.settings.get().modelContext).toEqual({ "chatgpt/script-1": { compactAt: 50_000 } })
  })
})
