import { describe, expect, test } from "bun:test"
import { shouldHandleDialogSelectCustomKeybinds } from "../../../src/cli/cmd/tui/ui/dialog-select"

describe("DialogSelect custom keybinds", () => {
  test("ignores custom keybinds while typing in the focused filter input", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: true }, "clau")).toBe(false)
  })

  test("allows custom keybinds for the selected option when the focused filter is empty", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: true }, "")).toBe(true)
  })

  test("allows custom keybinds when the filter input is not focused", () => {
    expect(shouldHandleDialogSelectCustomKeybinds({ focused: false }, "clau")).toBe(true)
    expect(shouldHandleDialogSelectCustomKeybinds(undefined, "clau")).toBe(true)
  })
})
