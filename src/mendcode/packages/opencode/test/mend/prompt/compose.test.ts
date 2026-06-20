import { describe, expect, test } from "bun:test"
import { composePromptPolicy } from "../../../src/mend/prompt/compose"

describe("mend prompt composition", () => {
  test("focus and full modes advertise TUI markdown and Mermaid rendering", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    for (const policy of [focus, full]) {
      const section = policy.sections.find((item) => item.id === "tui-markdown-rendering")
      expect(section?.text).toContain("Full text Markdown")
      expect(section?.text).toContain("tables")
      expect(section?.text).toContain("Mermaid fenced blocks")
      expect(section?.text).toContain("flowcharts")
      expect(section?.text).toContain("Embedded HTML and Markdown images are outside")
      expect(section?.text).not.toMatch(/\b(you may|do not|prefer|use)\b/i)
    }
  })

  test("minimal mode keeps the TUI rendering guidance out of the prompt", async () => {
    const policy = await composePromptPolicy({ mode: "minimal", focusID: "codex" })

    expect(policy.sections.find((item) => item.id === "tui-markdown-rendering")).toBeUndefined()
    expect(policy.policyInstructions).not.toContain("Mermaid fenced blocks")
  })
})
