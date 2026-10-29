import { expect, test } from "bun:test"
import { Command, LoopCostBudget, LoopRubric, LoopUsage, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }

test("B44 schemas are opt-in and old loop.create stays wire compatible", () => {
  const old = { ...base, type: "loop.create", name: "watch", directory: "/fake", objective: "watch CI", trigger: { kind: "manual" }, budget: { mode: "monitor" } } as const
  expect(Command.parse(old)).toEqual(old)
  expect(Command.safeParse({ ...old, costBudget: { maxTokens: 100, maxCost: 0.1, unknownCost: "block" }, approvalPolicy: { requireApprovalFor: ["push"] } }).success).toBe(true)
  for (const invalid of [{ maxTokens: 0 }, { maxTokens: 1.5 }, { maxCost: -1 }, { maxCost: Infinity }, { unknownCost: "guess" }]) expect(LoopCostBudget.safeParse(invalid).success).toBe(false)
  expect(LoopUsage.safeParse({ tokens: 0, costMicros: 0, unknownCostCalls: 0 }).success).toBe(true)
})

test("B44 rubric rejects duplicate ids and invalid thresholds or scores", () => {
  const criterion = { id: "tests", description: "tests pass", weight: 3, minScore: 5, evidenceRequired: ["success checks"] }
  expect(LoopRubric.safeParse({ criteria: [criterion], passThreshold: 0.85 }).success).toBe(true)
  for (const invalid of [{ criteria: [criterion, criterion] }, { criteria: [criterion], passThreshold: 1.1 }, { criteria: [{ ...criterion, weight: -1 }] }, { criteria: [{ ...criterion, minScore: 6 }] }]) expect(LoopRubric.safeParse(invalid).success).toBe(false)
})

test("B44 review is mutating and requires nonempty reviewer, reason, run and checkpoint evidence", () => {
  const valid = { ...base, type: "loop.review", loopId: ids("loop"), action: "waive", gateId: "bun test", run: 1, checkpointHash: "a".repeat(64), reviewer: "user", reason: "checked" }
  expect(Command.safeParse(valid).success).toBe(true)
  for (const change of [{ reviewer: " " }, { reason: " " }, { run: 0 }, { checkpointHash: "stale" }]) expect(Command.safeParse({ ...valid, ...change }).success).toBe(false)
  expect(isReadOnlyCommand("loop.review")).toBe(false)
})
