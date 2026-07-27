import { describe, expect, test } from "bun:test"
import { defaultTuiProfile } from "../../src/mend/profile"
import { renderAsciiText } from "../../src/cli/cmd/tui/component/ascii-text"
import { renderSessionExitSummary } from "../../src/cli/cmd/tui/util/session-exit-summary"

describe("session exit summary", () => {
  test("renders MendCode identity with truthful resume and usage context", () => {
    const summary = renderSessionExitSummary({
      profile: defaultTuiProfile(),
      width: 100,
      sessionTitle: "Memory graph follow-up",
      sessionID: "ses_123",
      usage: {
        usage: "↑1,200 ↓300",
        compaction: "ctx 1,500 12%",
        model: "openai/gpt-5.5",
        provider: "openai",
        agent: "build",
        elapsed: "2m 3s",
      },
    })

    expect(summary).toContain(renderAsciiText("MendCode", "mendcode").split("\n")[0].trim())
    expect(summary).toContain("Session")
    expect(summary).toContain("Memory graph follow-up")
    expect(summary).toContain("Continue")
    expect(summary).toContain("mendcode -s ses_123")
    expect(summary).toContain("Usage")
    expect(summary).toContain("↑1,200 ↓300")
    expect(summary).toContain("Context")
    expect(summary).toContain("ctx 1,500 12%")
    expect(summary).toContain("Model")
    expect(summary).toContain("openai/gpt-5.5")
    expect(summary).toContain("Provider")
    expect(summary).toContain("openai")
    expect(summary).toContain("Agent")
    expect(summary).toContain("build")
    expect(summary).toContain("Elapsed")
    expect(summary).toContain("2m 3s")
  })

  test("renders configured pet logo with title without hiding resume command", () => {
    const profile = structuredClone(defaultTuiProfile())
    profile.identity.productName = "MendLab"
    profile.identity.logoMode = "title"
    profile.surfaces.homeLogo = { text: "(=^.^=)\n /|_|\\" }

    const summary = renderSessionExitSummary({
      profile,
      width: 120,
      sessionTitle: "Pet session",
      sessionID: "ses_pet",
    })

    expect(summary).toContain("(=^.^=)")
    expect(summary).toContain(renderAsciiText("MendLab", "mendcode").split("\n")[0].trim())
    expect(summary).toContain("Pet session")
    expect(summary).toContain("mendcode -s ses_pet")
  })

  test("prioritizes resume details on tiny widths and omits unavailable usage", () => {
    const summary = renderSessionExitSummary({
      profile: defaultTuiProfile(),
      width: 32,
      sessionTitle: "A very long session title that should be truncated cleanly",
      sessionID: "ses_tiny",
    })

    expect(summary).toContain("MendCode")
    expect(summary).toContain("Session")
    expect(summary).toContain("Continue")
    expect(summary).toContain("mendcode -s ses_tiny")
    expect(summary).not.toContain("Usage")
    expect(summary).not.toContain("unavailable")
    for (const line of summary.split("\n")) {
      expect(Bun.stringWidth(line.replace(/\x1b\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(34)
    }
  })
})
