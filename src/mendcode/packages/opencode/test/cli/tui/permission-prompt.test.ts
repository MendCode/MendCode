import { describe, expect, test } from "bun:test"
import { permissionPromptHoverSelection } from "@/cli/cmd/tui/routes/session/permission"

describe("permission prompt pointer selection", () => {
  test("does not let a synthetic hover undo keyboard navigation", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "over", x: 12, y: 5 }, "always", "once", pointer)).toBe("always")
  })

  test("does not let a parked cursor move replay undo keyboard navigation", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 5 }, "always", "once", pointer)).toBe("always")
  })

  test("follows the hovered option after a physical mouse move", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 7 }, "always", "once", pointer)).toBe("once")
    expect(pointer.keyboardNavigation).toBe(false)
  })
})
