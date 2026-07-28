import { describe, expect, test } from "bun:test"
import { validateSession } from "../../../src/cli/cmd/tui/validate-session"

const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"

describe("TUI session validation", () => {
  test("validates -s locally before first paint without a server round trip", async () => {
    let fetched = false
    const result = await validateSession({
      url: "http://localhost",
      sessionID,
      remote: false,
      fetch: (() => {
        fetched = true
        throw new Error("unexpected fetch")
      }) as unknown as typeof fetch,
    })

    expect(String(result)).toBe(sessionID)
    expect(fetched).toBe(false)
  })

  test("still rejects malformed session IDs locally", async () => {
    expect(validateSession({ url: "http://localhost", sessionID: "bad", remote: false })).rejects.toThrow(
      "Invalid session ID",
    )
  })
})
