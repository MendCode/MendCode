import { describe, expect, test } from "bun:test"
import { composeCustomizationCapabilitySection } from "../../../src/mend/prompt/capabilities"

describe("mend prompt capabilities", () => {
  test("describes real customization surfaces and blocked boundaries", () => {
    const text = composeCustomizationCapabilitySection()
    expect(text).toContain("MendCode TUI customization capabilities")
    expect(text).toContain("Contract version: 2.0.0")
    expect(text).toContain("footer.entry: available")
    expect(text).toContain("session.prompt.fullEditor: available")
    expect(text).toContain("add a widget to the status bar -> footer.entry")
    expect(text).toContain("Protected/blocked in v1")
    expect(text).toContain("prompt.parser.override -> session.prompt.visual/session.prompt.fullEditor")
  })
})
