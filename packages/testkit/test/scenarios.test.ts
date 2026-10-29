import { describe, expect, test } from "bun:test"
import { simulate } from "../src"

const SEEDS = Number(process.env.SIM_SEEDS ?? 300)

function report(result: Awaited<ReturnType<typeof simulate>>) {
  return `seed=${result.seed}\n${result.violations.map((v) => `${v.invariant}: ${v.message}`).join("\n")}\nlast steps:\n${result.steps.slice(-15).join("\n")}`
}

describe("deterministic simulation", () => {
  test(`${SEEDS} random interleavings keep every invariant (I1–I7, I9, I11)`, async () => {
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const result = await simulate({ seed, steps: 60 })
      if (result.violations.length > 0) failures.push(report(result))
      if (failures.length >= 3) break
    }
    expect(failures).toEqual([])
  }, 120_000)

  test("the same seed reproduces exactly the same event log", async () => {
    const a = await simulate({ seed: 42, steps: 80 })
    const b = await simulate({ seed: 42, steps: 80 })
    expect(a.steps).toEqual(b.steps)
    expect(a.events.map((e) => e.type)).toEqual(b.events.map((e) => e.type))
  })

  test("control: a background job that writes foreground state (v1 FC-01 class) is detected", async () => {
    let detected = 0
    for (let seed = 1; seed <= 100; seed++) {
      const result = await simulate({ seed, steps: 60, faults: { jobWritesForeground: true } })
      if (result.violations.some((v) => v.invariant === "I3" || v.invariant === "I2")) detected++
    }
    expect(detected).toBeGreaterThan(0)
  }, 60_000)
})
