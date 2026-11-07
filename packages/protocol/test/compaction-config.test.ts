import { expect, test } from "bun:test"
import { Command, CompactionConfig, ProviderModel, ProvidersSet, Settings, THRESHOLD_RULE, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
test("B23 compaction config is additive, bounded and retains the v1 configuration names", () => {
  const config = { auto: false, prune: true, tail_turns: 2, preserve_recent_tokens: 8000, reserved: 20_000, threshold: 95, token_limit: 150_000, strategy: "auto", portable_mode: "incremental", timeout_ms: 1000, max_summary_tokens: 512, on_native_error: "portable" } as const
  expect(Settings.parse({ compaction: config }).compaction).toEqual(config)
  expect(CompactionConfig.parse({ tail_turns: 0, preserve_recent_tokens: 0, reserved: 0 })).toEqual({ tail_turns: 0, preserve_recent_tokens: 0, reserved: 0 })
  for (const patch of [{ timeout_ms: 999 }, { timeout_ms: 300_001 }, { max_summary_tokens: 511 }, { max_summary_tokens: 8193 }, { tail_turns: -1 }, { threshold: Infinity }, { strategy: "unknown" }]) expect(CompactionConfig.safeParse(patch).success).toBe(false)
  expect(Settings.safeParse({}).success).toBe(true)
})

test("B23 provider and model thresholds pass the existing mutation boundary, never read-only", () => {
  const command = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "openai", compaction: { threshold: 92 }, models: [{ id: "model", context: 200_000, inputLimit: 180_000, outputLimit: 20_000, compaction: { token_limit: 100_000 } }] }
  expect(Command.safeParse(command).success).toBe(true)
  expect(Command.safeParse({ ...command, compaction: null }).success).toBe(true)
  expect(Command.safeParse({ ...command, compaction: { token_limit: -1 } }).success).toBe(false)
  expect(isReadOnlyCommand("providers.set")).toBe(false)
  expect(isReadOnlyCommand("settings.set")).toBe(false)
})

test("providers.set bounds model thresholds on writes without rejecting saved legacy models", () => {
  const base = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "openai", compaction: { threshold: 80 } }
  for (const threshold of [0.8, 1, 80, 100]) {
    const command = { ...base, models: [{ id: "custom", compaction: { threshold } }] }
    expect(ProvidersSet.parse(command).models?.[0]?.compaction?.threshold).toBe(threshold)
    expect(Command.safeParse(command).success).toBe(true)
  }
  for (const threshold of [0, -5, 150, Infinity, NaN]) {
    const command = { ...base, models: [{ id: "valid" }, { id: "custom", compaction: { threshold } }] }
    const result = ProvidersSet.safeParse(command)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(["models", 1, "compaction", "threshold"])
    expect(result.error?.issues[0]?.message).toBe(THRESHOLD_RULE)
    expect(Command.safeParse(command).success).toBe(false)
  }
  expect(ProviderModel.parse({ id: "legacy", compaction: { threshold: 150 } }).compaction).toEqual({ threshold: 150 })
  expect(ProvidersSet.safeParse({ ...base, models: [{ id: "custom", compaction: { token_limit: 1000 } }] }).success).toBe(true)
  expect(ProvidersSet.safeParse({ ...base, models: [] }).success).toBe(true)
})
