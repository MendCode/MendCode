import { expect, test } from "bun:test"
import { UsageActivityDay, UsageModel, UsageReport } from "../src"

test("older usage reports remain valid; new projection fields are optional and nonnegative", () => {
  const activity = { day: "2026-09-30", prompts: 1, words: 8, aiMs: 200, toolMs: 20 }
  const model = { provider: "local", model: "fixture", input: 10, output: 2, calls: 1, costMicros: 0 }
  const report = { from: activity.day, to: activity.day, days: [], models: [model], activity: [activity], quotas: [] }
  expect(UsageReport.parse(report)).toEqual(report)
  expect(UsageActivityDay.parse({ ...activity, longestAiMs: 0 }).longestAiMs).toBe(0)
  expect(UsageModel.parse({ ...model, costUnknownCalls: 1 }).costUnknownCalls).toBe(1)
  expect(UsageActivityDay.safeParse({ ...activity, longestAiMs: -1 }).success).toBe(false)
  expect(UsageModel.safeParse({ ...model, costUnknownCalls: -1 }).success).toBe(false)
})
