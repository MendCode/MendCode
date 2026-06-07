import { describe, expect, test } from "bun:test"
import { resolveWorkingStartedAt } from "@/cli/cmd/tui/component/prompt"

describe("resolveWorkingStartedAt", () => {
  test("keeps the original assistant start when a follower already stored a local start", () => {
    expect(
      resolveWorkingStartedAt({
        stored: 1_000,
        activeAssistantCreated: 100,
        fallback: 2_000,
      }),
    ).toBe(100)
  })

  test("falls back to stored or local start when active assistant history is not loaded yet", () => {
    expect(resolveWorkingStartedAt({ stored: 1_000, fallback: 2_000 })).toBe(1_000)
    expect(resolveWorkingStartedAt({ fallback: 2_000 })).toBe(2_000)
  })
})
