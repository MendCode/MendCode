import { expect, test } from "bun:test"
import { compactFallback } from "../src/ui/app/compact-fallback"
import { contextLimit } from "../src/view/context-meter"
import type { AppState } from "../src/ui/app/context"

const state = (listed: number | undefined, setting?: number) => ({
  effectiveModel: { model: "claude-sonnet" },
  modelReport: { models: [{ id: "claude-sonnet", contextWindow: 200_000, ...(listed ? { compactAtTokens: listed } : {}) }] },
  settingsNow: { ...(setting ? { compactAtTokens: setting } : {}) },
}) as unknown as AppState

test("before the first message a Claude Code model is measured against the window it will be handed, the same number its calls state after", () => {
  expect(contextLimit(undefined, compactFallback(state(475_000, 300_000)))).toBe(475_000)
  expect(contextLimit({ contextTokens: 43_000, compactAt: 475_000, contextWindow: 1_000_000 }, compactFallback(state(475_000)))).toBe(475_000)
})

test("without a listed point the user's setting applies, never the model window of the catalog", () => {
  expect(compactFallback(state(undefined, 300_000))).toBe(300_000)
})
