import { describe, expect, test } from "bun:test"
import type { ParsedKey } from "@opentui/core"
import { Keybind } from "../../../src/util/keybind"
import {
  isTextareaNewlineKey,
  textareaKeybindingsFromConfig,
} from "../../../src/cli/cmd/tui/component/textarea-keybindings"

function key(input: Pick<ParsedKey, "name"> & Partial<ParsedKey>): ParsedKey {
  return {
    ctrl: false,
    meta: false,
    shift: false,
    super: false,
    option: false,
    leader: false,
    sequence: input.name,
    number: false,
    raw: input.name,
    ...input,
  } as ParsedKey
}

describe("textarea keybindings", () => {
  test("puts newline bindings before submit so shift+enter inserts a line break", () => {
    const bindings = textareaKeybindingsFromConfig({
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    })

    const submitIndex = bindings.findIndex((binding) => binding.action === "submit" && binding.name === "return")
    const shiftEnterIndex = bindings.findIndex(
      (binding) => binding.action === "newline" && binding.name === "return" && binding.shift === true,
    )
    const ctrlJIndex = bindings.findIndex(
      (binding) => binding.action === "newline" && binding.name === "j" && binding.ctrl === true,
    )

    expect(shiftEnterIndex).toBeGreaterThanOrEqual(0)
    expect(ctrlJIndex).toBeGreaterThanOrEqual(0)
    expect(shiftEnterIndex).toBeLessThan(submitIndex)
    expect(ctrlJIndex).toBeLessThan(submitIndex)
  })

  test("detects newline keys so prompt submit can ignore textarea submit callbacks", () => {
    const keybinds = {
      input_newline: Keybind.parse("shift+return,ctrl+return,alt+return,ctrl+j"),
    }

    expect(isTextareaNewlineKey(key({ name: "return", shift: true }), keybinds)).toBe(true)
    expect(isTextareaNewlineKey(key({ name: "return", ctrl: true }), keybinds)).toBe(true)
    expect(isTextareaNewlineKey(key({ name: "return", meta: true }), keybinds)).toBe(true)
    expect(isTextareaNewlineKey(key({ name: "j", ctrl: true }), keybinds)).toBe(true)
    expect(isTextareaNewlineKey(key({ name: "return" }), keybinds)).toBe(false)
  })
})
