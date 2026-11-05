import { expect, test } from "bun:test"
import { createTurnState } from "../src/view/turn-state"

const SESSION = "ses_tokens"
let seq = 0
const event = (fields: Record<string, unknown>) => ({ sessionId: SESSION, seq: ++seq, at: 1_000 + seq, ...fields }) as never
const usage = (input: number, output: number, cache = { read: 0, write: 0 }) => event({ type: "usage.recorded", turnId: "trn_1", provider: "p", model: "m", input, output, reasoning: 0, cacheRead: cache.read, cacheWrite: cache.write })

test("only what the provider reported counts: streamed text and tool output add nothing, each call's usage adds up", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_1", queueId: "que_1" }))
  state.apply(event({ type: "item.started", itemId: "itm_answer", kind: "agent_message" }))
  state.apply(event({ type: "item.delta", itemId: "itm_answer", text: "x".repeat(400) }))
  // The call still streams: nothing is guessed from its text.
  expect([state.input, state.output]).toEqual([0, 0])
  state.apply(usage(1_000, 97, { read: 30_000, write: 200 }))
  expect([state.input, state.output]).toEqual([31_200, 97])
  state.apply(event({ type: "item.started", itemId: "itm_tool", kind: "tool_call", meta: { tool: "shell" } }))
  state.apply(event({ type: "item.delta", itemId: "itm_tool", text: "y".repeat(4_000) }))
  state.apply(event({ type: "item.started", itemId: "itm_think", kind: "reasoning" }))
  state.apply(event({ type: "item.delta", itemId: "itm_think", text: "z".repeat(40) }))
  expect(state.output).toBe(97)
  state.apply(usage(500, 12))
  expect([state.input, state.output]).toEqual([31_700, 109])
  // The next turn starts from zero.
  state.apply(event({ type: "turn.completed", turnId: "trn_1" }))
  state.apply(event({ type: "turn.started", turnId: "trn_2", queueId: "que_2" }))
  expect([state.input, state.output]).toEqual([0, 0])
})

test("the working row tells new input from the context the provider read from its cache, so a long turn is not read as 1.7M sent", async () => {
  const { tokensText } = await import("../src/view/working-row")
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_c", queueId: "que_c" }))
  // A turn of a real session (2026-11-01, gpt-6-astra): 142K new input and 1.52M of resent context read from the cache.
  state.apply(usage(100_000, 2_000, { read: 0, write: 0 }))
  state.apply(usage(42_000, 2_307, { read: 1_520_000, write: 0 }))
  expect([state.input, state.cached]).toEqual([1_662_000, 1_520_000])
  expect(tokensText({ input: state.input, cached: state.cached, output: state.output })).toBe("↑142K +1.5M cached ↓4,307 tokens")
  // Without a cache read the row reads as before.
  expect(tokensText({ input: 45_200, cached: 0, output: 1_240 })).toBe("↑45.2K ↓1,240 tokens")
  expect(tokensText({ input: 0, output: 12 })).toBe("↓12 tokens")
  // The inline look: the received figure alone, as Claude Code writes it; `activityTokens` adds the others in the order it lists them.
  expect(tokensText({ input: state.input, cached: state.cached, output: state.output }, { style: "inline" })).toBe("↓ 4,307 tokens")
  expect(tokensText({ input: 142_000, output: 88_600 }, { style: "inline" })).toBe("↓ 88.6k tokens")
  expect(tokensText({ input: state.input, cached: state.cached, output: state.output }, { style: "inline", show: ["in", "cache", "out"] })).toBe("↑ 142k +1.5M cached ↓ 4,307 tokens")
  expect(tokensText({ input: state.input, cached: state.cached, output: state.output }, { style: "inline", show: ["cache"] })).toBe("+1.5M cached tokens")
  expect(tokensText({ input: 0, output: 12 }, { style: "classic", show: ["in", "out"] })).toBe("↓12 tokens")
  state.apply(event({ type: "turn.completed", turnId: "trn_c" }))
  state.apply(event({ type: "turn.started", turnId: "trn_d", queueId: "que_d" }))
  expect(state.cached).toBe(0)
})

test("an engine that reports no usage has no token count: nothing is estimated for it", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_3", queueId: "que_3" }))
  state.apply(event({ type: "item.started", itemId: "itm_a", kind: "agent_message" }))
  for (let index = 0; index < 5; index++) state.apply(event({ type: "item.delta", itemId: "itm_a", text: "word " }))
  expect([state.input, state.output]).toEqual([0, 0])
})
