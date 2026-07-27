import { describe, expect, test } from "bun:test"
import { renderSessionExitSummary } from "@/cli/cmd/tui/util/session-exit-summary"
import { defaultTuiProfile, type MendTuiProfile } from "@/mend/profile"

function profile(input: Partial<MendTuiProfile> = {}): MendTuiProfile {
  return {
    ...defaultTuiProfile(),
    ...input,
    identity: {
      ...defaultTuiProfile().identity,
      ...input.identity,
    },
    surfaces: {
      ...defaultTuiProfile().surfaces,
      ...input.surfaces,
    },
  }
}

describe("session exit summary", () => {
  test("renders configured title and resume command", () => {
    const rendered = renderSessionExitSummary({
      profile: profile({ identity: { productName: "Vorlen", tagline: "", logoFont: "classic", logoMode: "title" } }),
      width: 100,
      sessionTitle: "Implement memory graph",
      sessionID: "ses_123",
    })

    expect(rendered).toContain("█ █")
    expect(rendered).toContain("Session")
    expect(rendered).toContain("Implement memory graph")
    expect(rendered).toContain("Continue")
    expect(rendered).toContain("mendcode -s ses_123")
  })

  test("renders pet logo with product title without replacing it", () => {
    const rendered = renderSessionExitSummary({
      profile: profile({
        identity: { productName: "MendCode", tagline: "", logoFont: "mendcode", logoMode: "title" },
        surfaces: { ...defaultTuiProfile().surfaces, homeLogo: { text: " /\\_/\\\n( o.o )\n > ^ <" } },
      }),
      width: 120,
      sessionTitle: "Pet logo test",
      sessionID: "ses_pet",
    })

    expect(rendered).toContain("/\\_/\\")
    expect(rendered).toContain("█▀▀▄")
    expect(rendered).toContain("mendcode -s ses_pet")
  })

  test("narrow layout prioritizes resume details over ascii art", () => {
    const rendered = renderSessionExitSummary({
      profile: profile({ identity: { productName: "VeryLongCustomMendCode", tagline: "", logoFont: "shadow", logoMode: "mascot" } }),
      width: 38,
      sessionTitle: "A very long session title that should be shortened",
      sessionID: "ses_narrow",
      usage: { usage: "↑1 ↓2", model: "openai/gpt-5.5", elapsed: "1m 02s" },
    })

    expect(rendered).toContain("VeryLongCustomMendCode")
    expect(rendered).toContain("mendcode -s ses_narrow")
    expect(rendered).toContain("Usage")
    expect(rendered).not.toContain("████")
  })
})
