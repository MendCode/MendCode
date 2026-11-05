import { expect, test } from "bun:test"
import { Settings, type ModelInfo } from "@mendcode/protocol"
import { PORTABLE_SETTINGS } from "../src/config-bundle/classify"
import { contextLimits, modelCompactAt, modelLimits } from "../src/context-limits"

const sol: ModelInfo = { id: "gpt-6.1-sol", name: "Sol", efforts: [], contextWindow: 500_000 }
const unlisted: ModelInfo = { id: "opencode-go:deepseek-v4.1-flash", name: "Flash", efforts: [], provider: "opencode-go" }
const settings = { defaultContextWindow: 450_000 }

test("defaultContextWindow is validated like a modelContext window and is a portable preference", () => {
  const valid = (defaultContextWindow: unknown) => Settings.safeParse({ defaultContextWindow }).success
  expect([valid(450_000), valid(1_000), valid(10_000_000)]).toEqual([true, true, true])
  expect([valid(999), valid(10_000_001), valid(1.5), valid("450k")]).toEqual([false, false, false, false])
  expect(PORTABLE_SETTINGS.has("defaultContextWindow")).toBe(true)
})

test("it is the window of a model nobody states one for; a session window, modelContext and a known window all win over it", () => {
  expect(modelLimits({ model: unlisted, providers: [], fallbackWindow: 450_000 })).toEqual({ contextWindow: 450_000 })
  expect(modelLimits({ model: sol, providers: [], fallbackWindow: 450_000 })).toEqual({ contextWindow: 500_000 })
  expect(modelLimits({ model: unlisted, providers: [], override: 300_000, fallbackWindow: 450_000 })).toEqual({ contextWindow: 300_000 })
  expect(modelCompactAt({ model: unlisted, providers: [], settings, environment: {} })).toBe(405_000)
  expect(modelCompactAt({ model: unlisted, providers: [], settings: { ...settings, modelContext: { "opencode-go/deepseek-v4.1-flash": { window: 200_000 } } }, environment: {} })).toBe(180_000)
  expect(modelCompactAt({ model: sol, providers: [], settings, environment: {} })).toBe(450_000)
  expect(modelCompactAt({ model: unlisted, providers: [], settings: {}, environment: {} })).toBe(160_000)
})

test("a session's limits name the default as the source only when nothing else states the window", () => {
  const base = { catalog: [unlisted, sol], providers: [], environment: {} }
  const fallback = contextLimits({ ...base, report: { model: unlisted.id, compactAtTokens: 405_000, estimatedTokens: 0 }, settings })
  expect(fallback).toMatchObject({ contextWindow: 450_000, contextWindowSource: "default-setting", compactAtTokens: 405_000 })
  expect(contextLimits({ ...base, report: { model: sol.id, compactAtTokens: 450_000, estimatedTokens: 0 }, settings })).toMatchObject({ contextWindow: 500_000, contextWindowSource: "catalog" })
  expect(contextLimits({ ...base, report: { model: unlisted.id, compactAtTokens: 180_000, estimatedTokens: 0 }, override: 200_000, settings })).toMatchObject({ contextWindow: 200_000, contextWindowSource: "session" })
  expect(contextLimits({ ...base, fallbackModel: unlisted.id, settings })).toMatchObject({ contextWindow: 450_000, contextWindowSource: "default-setting" })
  expect(contextLimits({ ...base, fallbackModel: unlisted.id, settings: {} }).contextWindowSource).toBe("unknown")
})
