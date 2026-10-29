import { describe, expect, test } from "bun:test"
import { readGolden, record, SCENARIOS, SIZES } from "./views-scenarios"

/** The view-slot contract must not change the default look: every scenario frame equals the one recorded before it existed. */
describe("default look through the view contract", () => {
  for (const scenario of SCENARIOS) {
    for (const size of SIZES) {
      test(`${scenario.name} at ${size.width}x${size.height} is unchanged`, async () => {
        expect(record(await scenario.run(size))).toBe(readGolden(scenario.name, size))
      })
    }
  }
})
