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

  test("prompt modes route monitored iterations through Loop Workflows", async () => {
    const minimal = await composePromptPolicy({ mode: "minimal", focusID: "codex" })
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(minimal.policyInstructions).toContain("monitored loops or repeated autonomous iterations")
    expect(minimal.policyInstructions).toContain("/loop` creates/activates")
    expect(minimal.policyInstructions).toContain("/loops` lists or shows existing workflows")
    expect(minimal.policyInstructions).toContain("Never set loop maxTurns to 0")
    expect(minimal.policyInstructions).toContain("normal execution rather than report-only")
    expect(minimal.policyInstructions).toContain("completed 0/0")
    expect(minimal.sections.find((item) => item.id === "loop-workflow-brief")).toBeUndefined()

    const brief = focus.sections.find((item) => item.id === "loop-workflow-brief")
    expect(brief?.text).toContain("turn this session into a loop")
    expect(brief?.text).toContain("/loops` lists workflows")
    expect(brief?.text).toContain("model/provider")
    expect(brief?.text).toContain("report-only mode")
    expect(brief?.text).toContain("do not write `Iteration 1/5`")
    expect(brief?.text).toContain("Never use `maxTurns: 0`")
    expect(brief?.text).toContain("explicit edit approval")
    expect(brief?.text).toContain("creating replacement loops repeatedly")
    expect(focus.sections.find((item) => item.id === "loop-workflow-full")).toBeUndefined()

    const fullContract = full.sections.find((item) => item.id === "loop-workflow-full")
    expect(fullContract?.text).toContain("durable workflow")
    expect(fullContract?.text).toContain("root session")
    expect(fullContract?.text).toContain("provider/model")
    expect(fullContract?.text).toContain("SSE is a live refresh channel")
    expect(fullContract?.text).toContain("mendcode loops activate <id>")
    expect(fullContract?.text).toContain("zero iteration cap")
    expect(fullContract?.text).toContain("explicit normal-execution intent")
    expect(fullContract?.text).toContain("completed 0/0")
  })
})
