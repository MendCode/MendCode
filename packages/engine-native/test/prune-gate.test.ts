import { describe, expect, test } from "bun:test"
import type { CompactionConfig } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelMessage, type ModelRequest } from "../src"
import { pruneDue, PRUNE_FROM } from "../src/compaction-policy"
import { echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const OUTPUT = "x".repeat(40_000)
const bigTool = defineTool({ name: "big", description: "a large result", permission: "read", args: z.object({ part: z.number() }), execute: async () => ({ output: OUTPUT, truncated: false, title: "big", isError: false }) })
const usage = (input: number): ModelEvent => ({ type: "usage", usage: { input, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
/** Each call has its own argument: identical calls in a row are stopped as a repeated action. */
const calls = (name: string, count: number, args: (part: number) => unknown = (part) => ({ part })): ModelEvent[] => [...Array.from({ length: count }, (_, part): ModelEvent => ({ type: "tool_call", call: { callId: ids("item"), name, args: args(part) } })), { type: "finish", reason: "tool_calls" }]
const outputs = (request: ModelRequest) => request.messages.flatMap((message) => message.role === "tool" && message.name === "big" ? [message.output] : [])
const pruned = (request: ModelRequest) => outputs(request).filter((output) => output.startsWith("[Old tool output pruned")).length

/**
 * The shape of the session that lost its cache: a first turn with 100k tokens of tool results (ten of 10k), a second turn, and a third
 * whose first request used to carry the oldest results pruned. `reported` is the context each call reports, in call order.
 */
async function threeTurns(input: { window: number; reported: number[]; compaction?: CompactionConfig; historyPruning?: boolean }) {
  const steps = [calls("big", 10), stop("read"), stop("second"), calls("echo", 1, () => ({ text: "hi" })), stop("third")]
  const { provider, requests } = scriptedProvider(steps.map((step, index) => [usage(input.reported[index]!), ...step]))
  const history = memoryHistory()
  const engine = createNativeEngine({
    provider, history, tools: [bigTool, echoTool], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize",
    contextWindowFor: () => input.window,
    ...(input.compaction ? { compaction: () => input.compaction! } : {}),
    ...(input.historyPruning === false ? { pruneToolOutputs: () => false } : {}),
  })
  const sessionId = ids("session")
  for (const text of ["one", "two", "three"]) expect(await engine.runTurn(turn({ text, sessionId, mode: () => "full" }).input)).toEqual({ status: "ok" })
  expect(requests).toHaveLength(5)
  expect(outputs(requests[2]!)).toHaveLength(10)
  return { requests, stored: ((await history.load(sessionId)) ?? []) as ModelMessage[] }
}

describe("old tool outputs are pruned only close to the compaction threshold", () => {
  test("the rule: from 80 % of the compaction threshold on", () => {
    expect(PRUNE_FROM).toBe(0.8)
    // The session: about 100k of context, compaction at 95 % of a 475k window.
    expect(pruneDue(100_000, 451_250)).toBe(false)
    expect(pruneDue(360_999, 451_250)).toBe(false)
    expect(pruneDue(361_000, 451_250)).toBe(true)
  })

  test("far from the threshold a new turn sends every earlier tool result as it was, so the request before it stays a prefix", async () => {
    const { requests, stored } = await threeTurns({ window: 475_000, reported: [1_000, 100_000, 100_000, 100_000, 100_000] })
    for (const request of requests.slice(1)) expect(outputs(request)).toEqual(Array.from({ length: 10 }, () => OUTPUT))
    // Turn three begins with the whole last request of turn two: nothing before the new user message changed.
    expect(requests[3]!.messages.slice(0, requests[2]!.messages.length)).toEqual(requests[2]!.messages)
    expect(JSON.stringify(stored)).not.toContain("Old tool output pruned")
  })

  test("close to the threshold the old results are pruned, in the request and in the stored history", async () => {
    // 95 % of 130k is 123.5k; 80 % of that is 98.8k.
    const { requests, stored } = await threeTurns({ window: 130_000, reported: [1_000, 100_000, 100_000, 100_000, 100_000] })
    expect(pruned(requests[2]!)).toBe(0)
    expect(pruned(requests[3]!)).toBeGreaterThan(0)
    expect(pruned(requests[4]!)).toBe(pruned(requests[3]!))
    expect(JSON.stringify(stored)).toContain("Old tool output pruned")
  })

  test("a prune does not undo itself when the next call reports the smaller, pruned context", async () => {
    // Only the per-request prune (nothing stored): the call after the prune reports 40k, far below the 98.8k it takes to prune.
    const { requests, stored } = await threeTurns({ window: 130_000, reported: [1_000, 100_000, 100_000, 40_000, 40_000], historyPruning: false })
    expect(pruned(requests[3]!)).toBeGreaterThan(0)
    expect(outputs(requests[4]!)).toEqual(outputs(requests[3]!))
    expect(JSON.stringify(stored)).not.toContain("Old tool output pruned")
  })

  test("`prune: false` keeps every result even at the threshold, in the request and in the stored history", async () => {
    const { requests, stored } = await threeTurns({ window: 130_000, reported: [1_000, 120_000, 120_000, 120_000, 120_000], compaction: { prune: false } })
    for (const request of requests.slice(1)) expect(pruned(request)).toBe(0)
    expect(JSON.stringify(stored)).not.toContain("Old tool output pruned")
  })
})
