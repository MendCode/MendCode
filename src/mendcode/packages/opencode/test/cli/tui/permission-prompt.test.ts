import { describe, expect, test } from "bun:test"
import { permissionPromptHoverSelection } from "@/cli/cmd/tui/routes/session/permission"

describe("permission prompt pointer selection", () => {
  test("does not let a stale hover undo keyboard navigation", () => {
    expect(permissionPromptHoverSelection("keyboard", "always", "once")).toBe("always")
  })

  test("follows the hovered option after real mouse movement", () => {
    expect(permissionPromptHoverSelection("mouse", "always", "once")).toBe("once")
  })
})
