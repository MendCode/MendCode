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

test("an engine that reports no usage keeps its estimate for the whole turn", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId: "trn_3", queueId: "que_3" }))
  state.apply(event({ type: "item.started", itemId: "itm_a", kind: "agent_message" }))
  for (let index = 0; index < 5; index++) state.apply(event({ type: "item.delta", itemId: "itm_a", text: "word " }))
  expect(state.outputLive).toBe(7)
  expect(state.estimating).toBe(true)
})
