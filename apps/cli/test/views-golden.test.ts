import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_THEME } from "../src/themes"
import { setTheme } from "../src/ui/theme"
import { readGolden, record, SCENARIOS, SIZES } from "./views-scenarios"

/** The view-slot contract must not change the default look: every scenario frame equals the one recorded before it existed. */
describe("default look through the view contract", () => {
  // Another file in the same process may leave its theme active; the goldens are the default look.
  beforeEach(() => setTheme(DEFAULT_THEME))
  for (const scenario of SCENARIOS) {
    for (const size of SIZES) {
      test(`${scenario.name} at ${size.width}x${size.height} is unchanged`, async () => {
        expect(record(await scenario.run(size))).toBe(readGolden(scenario.name, size))
      })
    }
  }
})
