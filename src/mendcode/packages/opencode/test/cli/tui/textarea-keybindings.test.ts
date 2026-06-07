import { describe, expect, test } from "bun:test"
import { Keybind } from "../../../src/util/keybind"
import {
  isTextareaNewlineKey,
  textareaKeybindingsFromConfig,
} from "../../../src/cli/cmd/tui/component/textarea-keybindings"

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

    expect(isTextareaNewlineKey({ name: "return", shift: true, ctrl: false, meta: false }, keybinds)).toBe(true)
    expect(isTextareaNewlineKey({ name: "return", ctrl: true, shift: false, meta: false }, keybinds)).toBe(true)
    expect(isTextareaNewlineKey({ name: "return", meta: true, ctrl: false, shift: false }, keybinds)).toBe(true)
    expect(isTextareaNewlineKey({ name: "j", ctrl: true, shift: false, meta: false }, keybinds)).toBe(true)
    expect(isTextareaNewlineKey({ name: "return", ctrl: false, shift: false, meta: false }, keybinds)).toBe(false)
  })
})
