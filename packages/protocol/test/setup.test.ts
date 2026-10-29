import { describe, expect, test } from "bun:test"
import { BudgetPolicy, Command, createIdFactory, Settings } from "../src"

const ids = createIdFactory()
describe("setup and budget wire contract", () => {
  test("policy defaults are opt-in and numeric limits are validated", () => {
    expect(BudgetPolicy.parse({})).toEqual({ mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false, prices: {}, suppliedUsd: null })
    for (const invalid of [{ warnUsd: -1 }, { stopUsd: Infinity }, { warnUsd: 2, stopUsd: 1 }, { prices: { m: { input: -1, output: 1 } } }]) expect(BudgetPolicy.safeParse(invalid).success).toBe(false)
    expect(Settings.parse({ budgets: { mode: "api-usage", warnUsd: 1, stopUsd: 3 }, setupPreset: "minimal" }).budgets?.stopUsd).toBe(3)
  })
  test("additive commands parse and helper history is bounded", () => {
    const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
    for (const type of ["setup.status", "setup.plan", "setup.doctor", "budget.status", "budget.doctor"]) expect(Command.safeParse({ ...base, type }).success).toBe(true)
    expect(Command.parse({ ...base, type: "setup.ask", text: "Which preset?" })).toMatchObject({ history: [] })
    expect(Command.safeParse({ ...base, type: "setup.ask", text: "x", history: Array.from({ length: 13 }, () => ({ role: "user", text: "x" })) }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "setup.ask", text: "x".repeat(4001) }).success).toBe(false)
  })
})
