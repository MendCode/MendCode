import { expect, test } from "bun:test"
import { Command, CompactionConfig, Settings, createIdFactory, isReadOnlyCommand } from "../src"

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
