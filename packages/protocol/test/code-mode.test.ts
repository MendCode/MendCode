import { expect, test } from "bun:test"
import { Settings } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("Code Mode is an additive optional boolean; experimental patches accept discovery alongside it", () => {
  expect(Settings.parse({})).toEqual({})
  for (const code_mode of [true, false]) expect(Settings.parse({ experimental: { code_mode, tool_discovery: true, primary_tools: ["shell"], continue_loop_on_deny: false } }).experimental?.code_mode).toBe(code_mode)
  for (const code_mode of [null, "true", 1, {}]) expect(Settings.safeParse({ experimental: { code_mode } }).success).toBe(false)
  expect(isReadOnlyCommand("settings.set")).toBe(false)
})
