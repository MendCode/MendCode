import { describe, expect, test } from "bun:test"
import { permissionPromptHoverSelection } from "@/cli/cmd/tui/routes/session/permission"

describe("permission prompt pointer selection", () => {
  test("does not let a synthetic hover undo keyboard navigation", () => {
    expect(permissionPromptHoverSelection("over", "always", "once")).toBe("always")
  })

  test("follows the hovered option after a real mouse move", () => {
    expect(permissionPromptHoverSelection("move", "always", "once")).toBe("once")
  })
})
