import { describe, expect, test } from "bun:test"
import { pickTuiSessionCacheEvictions } from "../../../src/cli/cmd/tui/util/session-cache"

describe("TUI session cache", () => {
  test("evicts oldest unprotected sessions at the cache limit", () => {
    const seen = new Set(["ses_old", "ses_middle", "ses_new"])

    const evicted = pickTuiSessionCacheEvictions({
      seen,
      limit: 2,
    })

    expect(evicted).toEqual(["ses_old"])
    expect([...seen]).toEqual(["ses_middle", "ses_new"])
  })

  test("preserves active sessions while evicting other stale entries", () => {
    const seen = new Set(["ses_old", "ses_active", "ses_new"])

    const evicted = pickTuiSessionCacheEvictions({
      seen,
      limit: 2,
      preserve: ["ses_active"],
    })

    expect(evicted).toEqual(["ses_old"])
    expect([...seen]).toEqual(["ses_active", "ses_new"])
  })
})
