import { expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { modelsCard, tokensCard } from "../src/view/sidebar-cards"
import { createTurnState } from "../src/view/turn-state"
import { createUsageNotes } from "../src/view/usage-notes"

// Every engine reports reasoning inside `output` (docs/usage.md, "Every harness"): the figures outside /usage agree with it.
const ids = createIdFactory()
const sessionId = ids("session")
const turnId = ids("turn")
let seq = 0
const event = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: Date.now(), ...patch }) as SessionEvent
const usage = () => event({ type: "usage.recorded", turnId, provider: "openai", model: "gpt", input: 1_000, output: 400, reasoning: 300, cacheRead: 5_000, cacheWrite: 200 })
const plain = (lines: Array<Array<{ text: string }>>) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")

test("the turn's output figure and the session totals count reasoning once", () => {
  const state = createTurnState()
  state.apply(event({ type: "turn.started", turnId, queueId: ids("queue") }))
  state.apply(usage())
  expect(state.output).toBe(400)
  expect(state.totals.output).toBe(400)
  expect(state.input).toBe(6_200)
})

test("the sidebar's tokens and models cards show output with its reasoning inside, not added again", () => {
  const notes = createUsageNotes()
  notes.apply(usage())
  expect(notes.totals.output).toBe(400)
  const tokens = plain(tokensCard({ usage: notes.totals, subscription: true }, 40))
  expect(tokens).toContain("Output 400")
  const models = plain(modelsCard(notes.models, 40))
  expect(models).toContain("Out 400")
  expect(models).not.toContain("Out 700")
  expect(plain(modelsCard([], 40))).toContain("No model usage yet")
})
