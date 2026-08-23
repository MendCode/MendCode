import { describe, expect, test } from "bun:test"
import {
  permissionPromptHoverSelection,
  type PermissionPromptPointerState,
} from "@/cli/cmd/tui/routes/session/permission"

describe("permission prompt pointer selection", () => {
  test("does not let a synthetic hover undo keyboard navigation", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "over", x: 12, y: 5 }, "always", "once", pointer)).toBe("always")
  })

  test("does not let a parked cursor move replay undo keyboard navigation", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 5 }, "always", "once", pointer)).toBe("always")
  })

  test("does not treat the first observed cursor coordinates as mouse intent", () => {
    const pointer: PermissionPromptPointerState = { keyboardNavigation: true }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 5 }, "always", "once", pointer)).toBe("always")
    expect(pointer).toEqual({ keyboardNavigation: true, x: 12, y: 5 })
  })

  test("does not infer mouse intent from changed relative coordinates", () => {
    const pointer = { keyboardNavigation: true, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 7 }, "always", "once", pointer)).toBe("always")
    expect(pointer).toEqual({ keyboardNavigation: true, x: 12, y: 7 })
  })

  test("follows hover while the pointer owns selection", () => {
    const pointer = { keyboardNavigation: false, x: 12, y: 5 }
    expect(permissionPromptHoverSelection({ type: "move", x: 12, y: 7 }, "once", "always", pointer)).toBe("always")
  })
})
