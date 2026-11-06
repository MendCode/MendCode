import { expect, test } from "bun:test"
import type { EngineEvent } from "@mendcode/kernel"
import { acpUsage, createUpdateMapper } from "../src/updates"

test("an ACP turn's usage is one usage event with its cache, reasoning inside output and no cost", () => {
  const usage = acpUsage({ stopReason: "end_turn", usage: { inputTokens: 1_000, outputTokens: 300, thoughtTokens: 120, cachedReadTokens: 4_000, cachedWriteTokens: 50, totalTokens: 5_350 } }, "gemini/pro", { used: 6_000, size: 1_000_000 })
  expect(usage).toEqual({ type: "usage", provider: "acp", model: "gemini/pro", input: 1_000, output: 300, reasoning: 120, cacheRead: 4_000, cacheWrite: 50, context: 6_000, contextWindow: 1_000_000 })
})

test("an agent whose input already holds its cached tokens has them taken out, so the cache counts once", () => {
  const usage = acpUsage({ usage: { inputTokens: 5_000, outputTokens: 200, cachedReadTokens: 4_000, totalTokens: 5_200 } }, "agent")
  expect(usage).toMatchObject({ input: 1_000, cacheRead: 4_000, output: 200 })
})

test("a result without usage, or with only zeros, records nothing", () => {
  expect(acpUsage({ stopReason: "end_turn" }, "agent")).toBeUndefined()
  expect(acpUsage({ usage: { inputTokens: 0, outputTokens: 0 } }, "agent")).toBeUndefined()
  expect(acpUsage(undefined, "agent")).toBeUndefined()
})

test("the mapper keeps the agent's last usage_update for the turn's context and shows nothing for it", () => {
  const events: EngineEvent[] = []
  let n = 0
  const mapper = createUpdateMapper({ newItemId: () => `item_${n++}` as never, emit: (event) => events.push(event) })
  mapper.accept({ sessionUpdate: "usage_update", used: 1_200, size: 200_000 })
  mapper.accept({ sessionUpdate: "usage_update", used: 2_400 })
  expect(mapper.context()).toEqual({ used: 2_400, size: 200_000 })
  expect(events).toEqual([])
})
