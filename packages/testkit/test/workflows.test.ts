import { describe, expect, test } from "bun:test"
import { simulateWorkflows } from "../src"

const SEEDS = Number(process.env.WORKFLOW_SIM_SEEDS ?? 1_000)

function report(result: Awaited<ReturnType<typeof simulateWorkflows>>) {
  return `seed=${result.seed}\n${result.violations.map((v) => `${v.invariant}: ${v.message}`).join("\n")}\nlast steps:\n${result.steps.slice(-15).join("\n")}`
}

describe("workflow simulation", () => {
  test(`${SEEDS} random runs keep W-I1..W-I8 through outcomes, approvals, cancels and restarts`, async () => {
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const result = await simulateWorkflows({ seed, steps: 80 })
      if (result.violations.length) failures.push(report(result))
      if (failures.length >= 3) break
    }
    expect(failures).toEqual([])
  }, 120_000)

  test("the same seed replays the same steps and the same final run", async () => {
    const a = await simulateWorkflows({ seed: 7, steps: 80 })
    const b = await simulateWorkflows({ seed: 7, steps: 80 })
    expect(a.steps).toEqual(b.steps)
    expect(a.run).toEqual(b.run)
  })

  test("control: a service that starts a task before its needs are done is caught", async () => {
    let caught = 0
    let injected = 0
    for (let seed = 1; seed <= 200; seed++) {
      const result = await simulateWorkflows({ seed, steps: 80, broken: true })
      if (result.run?.tasks.some((task) => task.needs.length)) injected++
      if (result.violations.some((v) => v.invariant === "W-I3")) caught++
    }
    expect(injected).toBeGreaterThan(50)
    expect(caught).toBeGreaterThan(50)
  })
})
