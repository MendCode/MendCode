import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BudgetPolicy, type Settings } from "@mendcode/protocol"
import { createBudgets } from "../src/budgets"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(policy: unknown = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-budget-"))
  dirs.push(dir)
  let settings: Settings = { budgets: BudgetPolicy.parse(policy) }
  const input = { dir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) }
  const budget = createBudgets(input)
  return { dir, budget, restart: () => createBudgets(input), set: (next: unknown) => { settings = { budgets: BudgetPolicy.parse(next) } } }
}

describe("global API budget", () => {
  test("defaults and subscription never invent a USD gate; unknown calls stay unknown", async () => {
    const { budget, set } = fixture()
    expect(budget.report("m").policy).toMatchObject({ mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false })
    budget.record()
    set({ mode: "api-usage", stopUsd: 0, suppliedUsd: 20 })
    expect(budget.report("m").enforcement).toMatchObject({ state: "not-enforced", enforced: false, currentKnownUsd: 20 })
    expect(budget.report("m").enforcement.warnings.join(" ")).toContain("unknown cost")
    await budget.guard({ model: "m", signal: new AbortController().signal })
    set({ mode: "subscription", stopUsd: 0, prices: { m: { input: 1, output: 2, expensive: true } }, expensiveModelRequiresConfirm: true })
    await budget.guard({ model: "m", signal: new AbortController().signal })
  })
  test("known prices, supplied spend, warning and stop survive daemon restart", async () => {
    const { budget, restart } = fixture({ mode: "api-usage", warnUsd: 1, stopUsd: 2, suppliedUsd: 0.5, prices: { m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } } })
    budget.record({ provider: "fake", model: "m", input: 500_000, output: 200_000, cacheRead: 100_000, cacheWrite: 100_000 })
    expect(budget.report("m").enforcement).toMatchObject({ state: "warn", currentKnownUsd: 1.56 })
    budget.record({ provider: "fake", model: "m", input: 0, output: 0, costMicros: 500_000 })
    expect(restart().report("m").enforcement).toMatchObject({ state: "stop", currentKnownUsd: 2.06 })
    await expect(restart().guard({ model: "m", signal: new AbortController().signal })).rejects.toThrow("Budget stop reached")
    expect(restart().report("m").telemetry).toMatchObject({ recordedUsd: 1.56, suppliedUsd: 0.5, knownCalls: 2, unknownCalls: 0 })
  })
  test("cached pricing must be explicit and malformed ledgers fail closed", async () => {
    const { budget, dir } = fixture({ mode: "api-usage", prices: { m: { input: 1, output: 2 } } })
    budget.record({ provider: "fake", model: "m", input: 1, output: 1, cacheRead: 10 })
    expect(budget.report("m").telemetry.unknownCalls).toBe(1)
    expect(budget.price({ provider: "fake", model: "m", input: -1, output: 100 })).toBeUndefined()
    expect(budget.price({ provider: "fake", model: "m", input: 1, output: 1, costMicros: -1 })).toBeUndefined()
    mkdirSync(path.join(dir, "budget"), { recursive: true })
    writeFileSync(path.join(dir, "budget/spend.json"), '{"version":1,"costMicros":-1}')
    expect(budget.doctor("m")).toMatchObject({ ok: false, failures: ["Invalid budget spend ledger"] })
    await expect(budget.guard({ model: "m", signal: new AbortController().signal })).rejects.toThrow("Invalid budget spend ledger")
  })
  test("expensive calls require a foreground approval and recheck spend afterwards", async () => {
    const { budget } = fixture({ mode: "api-usage", stopUsd: 1, expensiveModelRequiresConfirm: true, prices: { m: { input: 1, output: 2, expensive: true } } })
    const signal = new AbortController().signal
    await expect(budget.guard({ model: "m", signal })).rejects.toThrow("foreground confirmation")
    await expect(budget.guard({ model: "m", signal, ask: async () => ({ kind: "deny" }) })).rejects.toThrow("not approved")
    await budget.guard({ model: "m", signal, ask: async () => ({ kind: "approve", scope: "once" }) })
    await expect(budget.guard({ model: "m", signal, ask: async () => {
      budget.record({ provider: "fake", model: "m", input: 0, output: 0, costMicros: 1_000_000 })
      return { kind: "approve", scope: "once" }
    } })).rejects.toThrow("Budget stop reached")
  })
})
