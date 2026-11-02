import { expect, test } from "bun:test"
import { createTurnState } from "../src/view/turn-state"

const SESSION = "ses_tokens"
let seq = 0
const event = (fields: Record<string, unknown>) => ({ sessionId: SESSION, seq: ++seq, at: 1_000 + seq, ...fields }) as never
const usage = (input: number, output: number, cache = { read: 0, write: 0 }) => event({ type: "usage.recorded", turnId: "trn_1", provider: "p", model: "m", input, output, reasoning: 0, cacheRead: cache.read, cacheWrite: cache.write })

test("a streaming call is estimated from its text, its reported usage replaces the estimate, and input adds up per call", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_1", queueId: "que_1" }))
  state.apply(event({ type: "item.started", itemId: "itm_answer", kind: "agent_message" }))
  state.apply(event({ type: "item.delta", itemId: "itm_answer", text: "x".repeat(400) }))
  expect(state.outputLive).toBe(100)
  expect(state.estimating).toBe(true)
  expect(state.input).toBe(0)
  state.apply(usage(1_000, 97, { read: 30_000, write: 200 }))
  expect(state.outputLive).toBe(97)
  expect(state.estimating).toBe(false)
  expect(state.input).toBe(31_200)
  // A tool's output streams too, but it is not the model's: it is not counted as received.
  state.apply(event({ type: "item.started", itemId: "itm_tool", kind: "tool_call", meta: { tool: "shell" } }))
  state.apply(event({ type: "item.delta", itemId: "itm_tool", text: "y".repeat(4_000) }))
  expect(state.outputLive).toBe(97)
  state.apply(event({ type: "item.started", itemId: "itm_think", kind: "reasoning" }))
  state.apply(event({ type: "item.delta", itemId: "itm_think", text: "z".repeat(40) }))
  expect(state.outputLive).toBe(107)
  state.apply(usage(500, 12))
  expect([state.input, state.output, state.outputLive]).toEqual([31_700, 109, 109])
  // The next turn starts from zero.
  state.apply(event({ type: "turn.completed", turnId: "trn_1" }))
  state.apply(event({ type: "turn.started", turnId: "trn_2", queueId: "que_2" }))
  expect([state.input, state.output, state.outputLive, state.estimating]).toEqual([0, 0, 0, false])
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
  expect(tokensText({ input: 45_200, cached: 0, output: 1_240, estimated: true })).toBe("↑45.2K ↓~1,240 tokens")
  expect(tokensText({ input: 0, output: 12 })).toBe("↓12 tokens")
  state.apply(event({ type: "turn.completed", turnId: "trn_c" }))
  state.apply(event({ type: "turn.started", turnId: "trn_d", queueId: "que_d" }))
  expect(state.cached).toBe(0)
})

test("an engine that reports no usage keeps its estimate for the whole turn", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_3", queueId: "que_3" }))
  state.apply(event({ type: "item.started", itemId: "itm_a", kind: "agent_message" }))
  for (let index = 0; index < 5; index++) state.apply(event({ type: "item.delta", itemId: "itm_a", text: "word " }))
  expect(state.outputLive).toBe(7)
  expect(state.estimating).toBe(true)
})
