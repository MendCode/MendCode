import { expect, test } from "bun:test"
import { Settings } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("experimental discovery is an additive, optional boolean alongside native permission policy", () => {
  expect(Settings.parse({})).toEqual({})
  for (const tool_discovery of [true, false]) expect(Settings.parse({ experimental: { tool_discovery, primary_tools: ["mcp__root__*"], continue_loop_on_deny: false } }).experimental?.tool_discovery).toBe(tool_discovery)
  for (const value of ["true", 1, null, {}]) expect(Settings.safeParse({ experimental: { tool_discovery: value } }).success).toBe(false)
  expect(Settings.safeParse({ experimental: { unknown: true } }).success).toBe(false)
  expect(isReadOnlyCommand("settings.set")).toBe(false)
})
