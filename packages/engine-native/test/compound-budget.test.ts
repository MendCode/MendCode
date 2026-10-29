import { afterEach, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "@mendcode/tools"
import { createIdFactory, type CompoundLimits } from "@mendcode/protocol"
import { estimateTokens } from "@mendcode/protocol/wire"
import type { TurnInput } from "@mendcode/kernel"
import { createCompoundBudget, createNativeEngine, memoryHistory, RetryableProviderError, type CompoundCall, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const budgets: ReturnType<typeof createCompoundBudget>[] = []
afterEach(() => { for (const budget of budgets.splice(0)) budget.stop() })
const limits: CompoundLimits = { maxModelRequests: 3, maxTotalTokens: 40_000, maxRuntimeMs: 10_000, unknownCost: "allow-with-token-cap" }
const pricing = { inputUsdPer1M: 1, outputUsdPer1M: 2, cacheReadUsdPer1M: .5, cacheWriteUsdPer1M: 1, source: "local catalog" }
function setup(patch: Partial<CompoundLimits> = {}, prices: boolean = false) {
  const budget = createCompoundBudget({ limits: { ...limits, ...patch }, pricing: prices ? { small: pricing } : {} })
  budgets.push(budget)
  const call: CompoundCall = { budget, role: "primary", choice: { model: "small" } }
  const request: ModelRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }
  return { budget, call, request }
}
function provider(events: ModelEvent[] | Error, seen: ModelRequest[] = []): ModelProvider {
  return { id: "fake", model: "small", async *stream(request) { seen.push(request); if (events instanceof Error) throw events; yield* events } }
}
const completion: ModelEvent[] = [{ type: "text", delta: "ok" }, { type: "usage", usage: { input: 30, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "stop" }]
async function consume(iterable: AsyncIterable<ModelEvent>) { for await (const _ of iterable) {} }

test("admission rounds fractional text estimates up, leaving at least one output token", async () => {
  const { budget, call, request } = setup({ maxTotalTokens: 3 })
  request.system = "a"
  request.messages = []
  request.maxOutputTokens = 1
  // 1 system character + two empty JSON arrays = 5 characters, 2 estimated input tokens.
  const seen: ModelRequest[] = []
  await consume(budget.stream(provider([{ type: "finish", reason: "stop" }], seen), request, call))
  expect(estimateTokens(5)).toBe(2)
  expect(budget.ledger.requests[0]!.reservedTokens).toBe(3)
  expect(seen[0]!.maxOutputTokens).toBe(1)
})

test("each dispatch reserves tokens and caps output before a provider sees it", async () => {
  const { budget, call, request } = setup({ maxTotalTokens: 1_000 })
  const seen: ModelRequest[] = []
  await consume(budget.stream(provider(completion, seen), request, call))
  expect(seen[0]!.maxOutputTokens).toBeLessThan(1_000)
  expect(budget.ledger.requests[0]).toMatchObject({ state: "completed", inputTokens: 30, outputTokens: 20, costSource: "unknown" })
  expect(budget.ledger.tokens).toBe(1_000)
  await expect(consume(budget.stream(provider(completion, seen), request, call))).rejects.toThrow("token_limit")
  expect(seen).toHaveLength(1)
})
test("request caps include tool-loop calls, unknown prices block before dispatch", async () => {
  const seen: ModelRequest[] = []
  const one = setup({ maxModelRequests: 1 })
  await consume(one.budget.stream(provider(completion, seen), one.request, one.call))
  await expect(consume(one.budget.stream(provider(completion, seen), one.request, one.call))).rejects.toThrow("request_limit")
  const unknown = setup({ unknownCost: "block", maxCostUsd: 1 })
  await expect(consume(unknown.budget.stream(provider(completion, seen), unknown.request, unknown.call))).rejects.toThrow("unknown_cost")
  expect(seen).toHaveLength(1)
  expect(unknown.budget.ledger.requests).toHaveLength(0)
})
test("USD admission uses catalog prices and actual overages block acceptance", async () => {
  const cap = setup({ maxCostUsd: .000001 }, true)
  await expect(consume(cap.budget.stream(provider(completion), cap.request, cap.call))).rejects.toThrow("cost_limit")
  const paid = setup({ maxCostUsd: .1 }, true)
  await consume(paid.budget.stream(provider([{ type: "usage", usage: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 200_000 } }, { type: "finish", reason: "stop" }]), paid.request, paid.call))
  expect(paid.budget.ledger.costUsd).toBe(.2)
  expect(paid.budget.ledger.blocked).toBe("cost_limit")
  expect(paid.budget.ledger.requests[0]!.costSource).toBe("provider")
})
test("unknown dispatch and missing usage retain reservations and cannot replay", async () => {
  const { budget, call, request } = setup()
  await expect(consume(budget.stream(provider(new RetryableProviderError("lost")), request, call))).rejects.toThrow("lost")
  expect(budget.ledger.requests[0]!.state).toBe("unknown")
  expect(budget.ledger.tokens).toBeGreaterThan(4_096)
  await expect(consume(budget.stream(provider(completion), request, call))).rejects.toThrow("unknown_dispatch")
  const missing = setup()
  await consume(missing.budget.stream(provider([{ type: "finish", reason: "stop" }]), missing.request, missing.call))
  expect(missing.budget.ledger.tokens).toBeGreaterThan(4_096)
  expect(missing.budget.ledger.requests[0]!.inputTokens).toBeUndefined()
})
test("runtime budget cancels even a provider that ignores its abort signal", async () => {
  const { budget, call, request } = setup({ maxRuntimeMs: 20 })
  const hung: ModelProvider = { id: "hung", model: "small", async *stream() { await new Promise(() => {}); yield { type: "finish", reason: "stop" } } }
  await expect(consume(budget.stream(hung, request, call))).rejects.toThrow("timed out")
  expect(budget.ledger.requests[0]!.state).toBe("cancelled")
  expect(budget.ledger.blocked).toBe("runtime_limit")
})
test("critic rejects tools, malformed usage and truncated streams", async () => {
  const a = setup()
  await expect(consume(a.budget.stream(provider([{ type: "tool_call", call: { callId: "one", name: "shell", args: {} } }]), a.request, { ...a.call, critic: true }))).rejects.toThrow("Critic requested tools")
  const b = setup()
  await expect(consume(b.budget.stream(provider([{ type: "text", delta: "partial" }]), b.request, b.call))).rejects.toThrow("without a finish")
  const c = setup()
  await expect(consume(c.budget.stream(provider([{ type: "usage", usage: { input: -1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }]), c.request, c.call))).rejects.toThrow("Invalid provider usage")
})
function turn(): TurnInput {
  const ids = createIdFactory()
  return { sessionId: ids("session"), turnId: ids("turn"), text: "work", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} }
}
test("native tool loops use one shared ledger and never retry dispatched compound calls", async () => {
  const { budget, call } = setup({ maxModelRequests: 2 })
  const seen: ModelRequest[] = []
  const tool = defineTool({ name: "read", description: "local fake", permission: "read", args: z.object({}), execute: async () => ({ output: "file", title: "read", truncated: false, isError: false }) })
  const p: ModelProvider = { id: "fake", model: "small", async *stream(request) { seen.push(request); yield { type: "tool_call", call: { callId: `call-${seen.length}`, name: "read", args: {} } }; yield { type: "finish", reason: "tool_calls" } } }
  const engine = createNativeEngine({ provider: p, tools: [tool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", compound: () => call })
  expect(await engine.runTurn(turn())).toMatchObject({ status: "error" })
  expect(seen).toHaveLength(2)
  expect(budget.ledger.requests).toHaveLength(2)
  const failed = setup()
  const retried: ModelRequest[] = []
  const noRetry = createNativeEngine({ provider: provider(new RetryableProviderError("offline"), retried), tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", compound: () => failed.call, sleep: async () => {} })
  expect(await noRetry.runTurn(turn())).toMatchObject({ status: "error" })
  expect(retried).toHaveLength(1)
})
test("native critic strips extension hooks, hosted tools, mentions and tools", async () => {
  const { call } = setup()
  const seen: ModelRequest[] = []
  const input = turn()
  input.text = "Snapshot with @/etc/passwd as literal data"
  const engine = createNativeEngine({ provider: provider(completion, seen), tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "project system", compactionPrompt: "summarize", compound: () => ({ ...call, critic: true }), hostedTools: () => ["web_search"], hooks: { has: () => true, system: async () => { throw new Error("hook must not run") } } })
  expect(await engine.runTurn(input)).toEqual({ status: "ok" })
  expect(seen[0]!.tools).toEqual([])
  expect(seen[0]!.hostedTools).toBeUndefined()
  expect(seen[0]!.messages[0]).toMatchObject({ role: "user", content: input.text })
  expect(seen[0]!.system).not.toContain("project system")
})
