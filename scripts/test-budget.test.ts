import { expect, test } from "bun:test"
import { budgetMs, missingTool, REQUIRE_TOOLS_ENV, TIME_SCALE_ENV, timeScale, toolGate } from "./test-budget"

test("the time scale is 1 unless the environment sets it, and a bad value is an error rather than a silent 1", () => {
  expect(timeScale({})).toBe(1)
  expect(timeScale({ [TIME_SCALE_ENV]: "" })).toBe(1)
  expect(timeScale({ [TIME_SCALE_ENV]: "3" })).toBe(3)
  expect(timeScale({ [TIME_SCALE_ENV]: "2.5" })).toBe(2.5)
  for (const bad of ["0", "0.5", "-2", "fast", "NaN", "Infinity"]) expect(() => timeScale({ [TIME_SCALE_ENV]: bad })).toThrow("[TEST]")
})

test("a time budget is multiplied by the scale and unchanged without one", () => {
  expect(budgetMs(50, {})).toBe(50)
  expect(budgetMs(50, { [TIME_SCALE_ENV]: "3" })).toBe(150)
})

test("a tool lookup honours the PATH it is given", () => {
  expect(missingTool("bun-that-does-not-exist-anywhere")).toBe("bun-that-does-not-exist-anywhere is not on PATH")
  expect(missingTool("sh", "/nonexistent-directory")).toBe("sh is not on PATH")
  expect(missingTool("sh", "/bin:/usr/bin")).toBeUndefined()
})

test("a missing tool skips with a reason in the title, and fails instead when the workflow requires it", () => {
  const absent = "no-such-tool-for-the-gate"
  expect(toolGate("sh", {}).suffix).toBe("")
  expect(toolGate(absent, {}).suffix).toBe(` (skipped: ${absent} is not on PATH)`)
  expect(toolGate(absent, { [REQUIRE_TOOLS_ENV]: `rg, ${absent}` })).toEqual({ test, suffix: "" })
  expect(toolGate(absent, { [REQUIRE_TOOLS_ENV]: "rg,zsh" }).suffix).toContain("skipped")
})
