import { describe, expect, test } from "bun:test"
import type { AppState } from "../src/ui/app/context"
import { usageInForce } from "../src/ui/app/usage-in-force"

const report = { engine: "native", models: [{ id: "gpt-6-astra", name: "GPT-6-Astra", efforts: [] }, { id: "claude-opus", name: "Claude Opus", efforts: [], engine: "claude" }, { id: "codex-gpt", name: "Codex", efforts: [], engine: "codex" }] }
const claudeCall = { provider: "claude", model: "claude-opus-5-5", contextTokens: 342_115, contextWindow: 1_000_000 }
const nativeCall = { provider: "chatgpt", model: "gpt-6-astra", contextTokens: 80_000 }
const state = (usage: object | undefined, model: string | undefined, models: object | null = report) =>
  ({ transcript: { lastUsage: usage }, effectiveModel: model ? { model } : undefined, modelReport: models ?? undefined }) as unknown as AppState

describe("the context shown is the one of the engine in force", () => {
  test("after a switch from Claude Code to the native engine there is no context until the new model answers", () => {
    expect(usageInForce(state(claudeCall, "gpt-6-astra"))).toBeUndefined()
    expect(usageInForce(state(nativeCall, "claude-opus"))).toBeUndefined()
    expect(usageInForce(state(claudeCall, "codex-gpt"))).toBeUndefined()
  })

  test("the same engine keeps it, also across native models; an unknown model list or no model keeps the last call", () => {
    expect(usageInForce(state(claudeCall, "claude-opus"))).toEqual(claudeCall)
    expect(usageInForce(state(nativeCall, "gpt-6-astra"))).toEqual(nativeCall)
    expect(usageInForce(state({ ...nativeCall, provider: "zen" }, "gpt-6-astra"))).toMatchObject({ provider: "zen" })
    expect(usageInForce(state(claudeCall, "gpt-6-astra", null))).toEqual(claudeCall)
    expect(usageInForce(state(claudeCall, undefined))).toEqual(claudeCall)
    expect(usageInForce(state(undefined, "gpt-6-astra"))).toBeUndefined()
  })
})

test("a daemon that runs on one engine of another program has nothing to switch: its calls' context always shows", () => {
  const codexDaemon = { engine: "codex", models: [{ id: "gpt-6", name: "GPT 6", efforts: [] }] }
  const call = { provider: "p", model: "gpt-6", contextTokens: 48_000 }
  expect(usageInForce(state(call, "gpt-6", codexDaemon))).toEqual(call)
})
