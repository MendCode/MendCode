import { expect, test } from "bun:test"
import { acceptExperiment } from "../src/experiments"

test("metric improvement requires correctness, known cost and every cap", () => {
  const run = { baseline: 10, candidate: 9, direction: "min" as const, gates: [{ id: "correctness", status: "pass" as const }], iteration: 1, maxIterations: 3, costMicros: 10, maxCostMicros: 20, tokens: 100, maxTokens: 200 }
  expect(acceptExperiment(run).accepted).toBe(true)
  for (const patch of [{ gates: [] }, { gates: [{ id: "correctness", status: "fail" as const }] }, { iteration: 4 }, { costMicros: undefined }, { costMicros: 21 }, { tokens: 201 }, { candidate: 11 }, { candidate: NaN }]) expect(acceptExperiment({ ...run, ...patch }).accepted).toBe(false)
  expect(acceptExperiment({ ...run, direction: "max", candidate: 11 }).accepted).toBe(true)
})
