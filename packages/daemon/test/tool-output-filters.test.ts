import { expect, test } from "bun:test"
import { Settings } from "@mendcode/protocol"
import { toolOutputSettings } from "../src/tool-output"

const on = (settings: Settings) => toolOutputSettings(settings).filters

test("output filters follow the tier: off with no tier and in minimalist, on in balanced and full", () => {
  expect(on({})).toBe(false)
  expect(on({ tier: "minimalist" })).toBe(false)
  expect(on({ tier: "balanced" })).toBe(true)
  expect(on({ tier: "full" })).toBe(true)
})

test("the user's own switches win: features.output_filters, then tool_output.filters, then the tier", () => {
  expect(on({ tier: "balanced", features: { output_filters: false } })).toBe(false)
  expect(on({ tier: "minimalist", features: { output_filters: true } })).toBe(true)
  expect(on({ tier: "balanced", tool_output: { filters: false } })).toBe(false)
  expect(on({ tool_output: { filters: true } })).toBe(true)
  expect(on({ tier: "full", tool_output: { filters: false }, features: { output_filters: true } })).toBe(true)
})

test("the configured caps are kept and the setting validates", () => {
  expect(toolOutputSettings({ tier: "balanced", tool_output: { max_lines: 10, max_bytes: 2048 } })).toEqual({ max_lines: 10, max_bytes: 2048, filters: true })
  expect(Settings.safeParse({ tool_output: { filters: true } }).success).toBe(true)
  expect(Settings.safeParse({ tool_output: { filters: "yes" } }).success).toBe(false)
  expect(Settings.safeParse({ features: { output_filters: true, forecast: false } }).success).toBe(true)
})
