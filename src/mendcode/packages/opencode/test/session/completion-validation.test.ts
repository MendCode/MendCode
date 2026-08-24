import { describe, expect, test } from "bun:test"

import { completionValidationCommandAllowed } from "../../src/session/completion-validation"

describe("completion validation commands", () => {
  test("accepts bounded package-manager checks from a project subdirectory", () => {
    expect(completionValidationCommandAllowed("pnpm --dir app build")).toBe(true)
    expect(completionValidationCommandAllowed("pnpm -C app run test -- --runInBand")).toBe(true)
    expect(completionValidationCommandAllowed("npm --prefix app run typecheck")).toBe(true)
  })

  test("rejects directory escapes and unrelated package-manager commands", () => {
    expect(completionValidationCommandAllowed("pnpm --dir ../outside build")).toBe(false)
    expect(completionValidationCommandAllowed("pnpm --dir /tmp/outside build")).toBe(false)
    expect(completionValidationCommandAllowed("pnpm --dir app install")).toBe(false)
  })
})
