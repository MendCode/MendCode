import { describe, expect, test } from "bun:test"
import {
  shouldNotifyUpdate,
  skippedUpdateVersion,
  SKIPPED_UPDATE_VERSION_KEY,
  updateAction,
} from "../../src/cli/upgrade"
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

  test("notifies an installed v0.1.23 runtime about the public v0.1.25 patch", () => {
    expect(updateAction(undefined, "0.1.23", "0.1.25")).toBe("notify")
    expect(updateAction("notify", "0.1.23", "0.1.25")).toBe("notify")
    expect(updateAction(true, "0.1.23", "0.1.25")).toBe("upgrade")
  })

  test("does not notify when the public release is not newer", () => {
    expect(updateAction(undefined, "0.1.25", "0.1.25")).toBe("none")
    expect(updateAction(undefined, "0.1.25", "0.1.24")).toBe("none")
  })

  test("ignores the legacy upstream skipped-version key", () => {
    expect(skippedUpdateVersion({ skipped_version: "1.18.5" })).toBeUndefined()
    expect(skippedUpdateVersion({ [SKIPPED_UPDATE_VERSION_KEY]: "0.1.25" })).toBe("0.1.25")
  })
})
