import { describe, expect, test } from "bun:test"
import { shouldNotifyUpdate } from "../../src/cli/upgrade"
import { Installation } from "../../src/installation"

describe("upgrade notifications", () => {
  test("notifies by default for the 0.1.20 to 0.1.21 patch update", () => {
    const kind = Installation.getReleaseType("0.1.20", "0.1.21")

    expect(shouldNotifyUpdate(undefined, kind)).toBe(true)
  })

  test("only silently auto-updates patch releases when explicitly enabled", () => {
    expect(shouldNotifyUpdate(true, "patch")).toBe(false)
    expect(shouldNotifyUpdate("notify", "patch")).toBe(true)
    expect(shouldNotifyUpdate(undefined, "patch")).toBe(true)
  })

  test("notifies for minor and major releases even when auto-update is enabled", () => {
    expect(shouldNotifyUpdate(true, "minor")).toBe(true)
    expect(shouldNotifyUpdate(true, "major")).toBe(true)
  })
})
