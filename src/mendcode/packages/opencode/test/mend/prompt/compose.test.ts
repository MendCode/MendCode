import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { composePromptPolicy } from "../../../src/mend/prompt/compose"
import { MAX_CUSTOM_PROMPT_BYTES } from "../../../src/mend/prompt/custom"
import {
  advancedCommands,
  deprecatedAliases,
  internalCommands,
  primaryCommands,
} from "../../../src/mend/cli/public-bin"
import { tmpdir } from "../../fixture/fixture"

describe("mend prompt composition", () => {
  test("composes a valid project custom prompt without preset sections", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "# Project rules\nUse the repository conventions.\n")

    const policy = await composePromptPolicy({ root: tmp.path, mode: "custom", focusID: "codex" })

    expect(policy.mode).toBe("custom")
    expect(policy.promptOrigin).toBe("project-custom")
    expect(policy.sections.map((item) => item.id)).toEqual(["mode-boundary", "project-custom"])
    expect(policy.sections[1]?.text).toContain("Use the repository conventions")
    expect(policy.customPrompt).toMatchObject({
      path: ".mendcode/prompts/custom.md",
      available: true,
    })
    expect(policy.source).toBeNull()
    expect(policy.basePrompt).toBeNull()
    expect(policy.instructions).not.toContain("MendCode basics:")
    expect(policy.instructions).not.toContain("MendCode knowledge:")
  })

  test("exposes the custom context name while composing only its body", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "---\nname: Hello World Demo\n---\nalways say first Hello World!\n")

    const policy = await composePromptPolicy({ root: tmp.path, mode: "custom", focusID: "codex" })

    expect(policy.customPrompt).toMatchObject({ name: "Hello World Demo", available: true })
    expect(policy.sections.find((item) => item.id === "project-custom")?.label).toBe("Hello World Demo")
    expect(policy.sections.find((item) => item.id === "project-custom")?.text).toBe("always say first Hello World!")
    expect(policy.instructions).not.toContain("name: Hello World Demo")
  })

  test("falls back without including oversized custom prompt content", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "x".repeat(MAX_CUSTOM_PROMPT_BYTES + 1))

    const policy = await composePromptPolicy({ root: tmp.path, mode: "custom", focusID: "codex" })

    expect(policy.customPrompt?.available).toBe(false)
    expect(policy.customPrompt?.fallbackReason).toContain("exceeds")
    expect(policy.sections.find((item) => item.id === "project-custom")).toBeUndefined()
    expect(policy.instructions).not.toContain("x".repeat(256))
  })

  test("full mode advertises TUI markdown and Mermaid rendering", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(focus.sections.find((item) => item.id === "tui-markdown-rendering")).toBeUndefined()
    const section = full.sections.find((item) => item.id === "tui-markdown-rendering")
    expect(section?.text).toContain("Full text Markdown")
    expect(section?.text).toContain("tables")
    expect(section?.text).toContain("Mermaid fenced blocks")
    expect(section?.text).toContain("flowcharts")
    expect(section?.text).toContain("sequence")
    expect(section?.text).toContain("#RRGGBB")
    expect(section?.text).toContain("ordinary rendered text")
    expect(section?.text).toContain("Embedded HTML and Markdown images are outside")
    expect(section?.text).not.toMatch(/\b(you may|do not|prefer|use)\b/i)
  })

  test("full mode documents TODO discipline, async consent, and cost-aware routing", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(focus.sections.find((item) => item.id === "task-lifecycle")).toBeUndefined()

    const lifecycle = full.sections.find((item) => item.id === "task-lifecycle")
    expect(lifecycle?.text).toContain("`todowrite`")
    expect(lifecycle?.text).toContain("at most one item `in_progress`")
    expect(lifecycle?.text).toContain("configured `small`/`subagent` role")
    expect(lifecycle?.text).toContain("Never invent model IDs")

    const background = full.sections.find((item) => item.id === "background-subagents")
    expect(background?.text).toContain("`background: true`")
    expect(background?.text).toContain("explicit user choice")
    expect(background?.text).toContain("`question`")
    expect(background?.text).toContain("Do not silently turn ordinary work into background work")
  })

  test("minimal mode keeps the TUI rendering guidance out of the prompt", async () => {
    const policy = await composePromptPolicy({ mode: "minimal", focusID: "codex" })

    expect(policy.sections.find((item) => item.id === "tui-markdown-rendering")).toBeUndefined()
    expect(policy.policyInstructions).not.toContain("Mermaid fenced blocks")
  })

  test("adds public model behavior guidance in focused and full modes", async () => {
    const minimal = await composePromptPolicy({ mode: "minimal", focusID: "claude", modelID: "claude-sonnet-5" })
    const focus = await composePromptPolicy({ mode: "focus", focusID: "claude", modelID: "claude-sonnet-5" })
    const full = await composePromptPolicy({ mode: "full", focusID: "claude", modelID: "claude-sonnet-5" })

    expect(minimal.sections.find((item) => item.id === "model-behavior")).toBeUndefined()
    const focusSection = focus.sections.find((item) => item.id === "model-behavior")
    expect(focusSection?.text).toContain("Claude Sonnet 5 public behavior guidance")
    expect(focusSection?.text).toContain("State instructions explicitly")
    expect(focusSection?.text).toContain("not an upstream hidden prompt")
    expect(focus.instructions).not.toContain("You are Claude")

    const fullSection = full.sections.find((item) => item.id === "model-behavior")
    expect(fullSection?.text).toContain("use tools deliberately")
    expect(full.policyInstructions).toContain("Claude Sonnet 5 public behavior guidance")
  })

  test("does not present the GPT-5.2 snapshot as a GPT-5.6 prompt", async () => {
    const policy = await composePromptPolicy({ mode: "focus", focusID: "codex", modelID: "openai/gpt-5.6-luna-fast" })

    expect(policy.source?.promptPath).toContain("gpt_5_codex_prompt.md")
    expect(policy.sections.find((item) => item.id === "model-behavior")?.text).toContain("GPT-5.6 compatibility")
  })

  test("uses the current Mistral Vibe CLI snapshot", async () => {
    const policy = await composePromptPolicy({ mode: "focus", focusID: "mistral", modelID: "devstral-2" })

    expect(policy.source?.promptPath).toContain("mistral/cli_2026-07_v2.md")
    expect(policy.instructions).toContain("Instruction hierarchy")
    expect(policy.instructions).toContain("MendCode adapted harness prompt source")
  })

  test("adds GLM-5.2 guidance without claiming an upstream system prompt", async () => {
    const policy = await composePromptPolicy({ mode: "full", focusID: "glm", modelID: "z-ai/glm-5.2" })

    expect(policy.source?.label).toBe("GLM-family")
    expect(policy.source?.sourcePolicy).toBe("behavior-only")
    expect(policy.sections.find((item) => item.id === "model-behavior")?.text).toContain(
      "GLM-5.2 public behavior guidance",
    )
    expect(policy.instructions).toContain("long-horizon work as iterative")
    expect(policy.instructions).not.toContain("You are GLM")
  })

  test.each([
    ["kimi", "moonshot/kimi-k2.5", "Kimi K2.5 public behavior guidance"],
    ["deepseek", "deepseek-v3.2-exp", "DeepSeek V3.2-Exp public behavior guidance"],
    ["glm", "glm-5.1", "GLM-5.1 public behavior guidance"],
    ["minimax", "minimax-m2.7", "MiniMax M2 public behavior guidance"],
    ["grok", "grok-code-fast-1", "Grok Code Fast 1 public safety guidance"],
  ])("adds %s model-specific behavior guidance", async (focusID, modelID, label) => {
    const policy = await composePromptPolicy({ mode: "focus", focusID, modelID })

    expect(policy.sections.find((item) => item.id === "model-behavior")?.text).toContain(label)
    expect(policy.sections.find((item) => item.id === "model-behavior")?.text).toContain(
      "not an upstream hidden prompt",
    )
  })

  test("all prompt modes teach notification-driven background subagents", async () => {
    const minimal = await composePromptPolicy({ mode: "minimal", focusID: "codex" })
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(minimal.policyInstructions).toContain("background: true")
    expect(minimal.policyInstructions).toContain("end the current turn")
    expect(minimal.policyInstructions).toContain("Do not call `task_status` or `wait` repeatedly")
    expect(minimal.sections.find((item) => item.id === "focus-mendcode-basics")).toBeUndefined()
    const focusSection = focus.sections.find((item) => item.id === "focus-mendcode-basics")
    expect(focusSection?.text).toContain("`task` with `background: true`")
    expect(focusSection?.text).toContain("`task_status`")
    expect(focusSection?.text).toContain("do not poll")
    expect(focusSection?.text).toContain("foreground task blocks this session")
    expect(focusSection?.text).toContain("only after `task` returns its `task_id`")

    const section = full.sections.find((item) => item.id === "background-subagents")
    expect(section?.text).toContain("`task` with `background: true`")
    expect(section?.text).toContain("`task_status`")
    expect(section?.text).toContain("`wait`")
    expect(section?.text).toContain("`cancel`")
    expect(section?.text).toContain("automatically deliver at most one coalesced internal runtime wake")
    expect(section?.text).toContain("subagent_owner_wake: false")
    expect(section?.text).toContain("not a user message")
    expect(section?.text).toContain("Do not busy-poll")
    expect(section?.text).toContain("end the turn")
    expect(section?.text).toContain("retry a timed-out `wait`")
    expect(section?.text).toContain("Use `loop`")
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

    const brief = full.sections.find((item) => item.id === "loop-workflow-brief")
    expect(brief?.text).toContain("turn this session into a loop")
    expect(brief?.text).toContain("/loops` lists workflows")
    expect(brief?.text).toContain("model/provider")
    expect(brief?.text).toContain("report-only mode")
    expect(brief?.text).toContain("do not write `Iteration 1/5`")
    expect(brief?.text).toContain("Never use `maxTurns: 0`")
    expect(brief?.text).toContain("explicit edit approval")
    expect(brief?.text).toContain("creating replacement loops repeatedly")
    expect(focus.sections.find((item) => item.id === "loop-workflow-brief")).toBeUndefined()
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

  test("focus mode stays sparse: provider harness plus compact MendCode basics", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })

    expect(focus.sections.map((item) => item.id)).toEqual(["mode-boundary", "harness", "focus-mendcode-basics"])
    expect(focus.policyInstructions).toContain("monitored loops or repeated autonomous iterations")
    expect(focus.usesMendCodeHarnessPrompt).toBe(true)
    expect(focus.includeProjectInstructions).toBe(false)
    expect(focus.includeSkillsByDefault).toBe(false)
    expect(focus.includeCustomInstructions).toBe(false)
    expect(focus.includeMcpContext).toBe(false)
    expect(focus.instructions).not.toContain("MendCode knowledge:")
    expect(focus.instructions).not.toContain("MendCode marketplace and extension contract")
  })

  test("full mode includes the complete MendCode capability catalog and real CLI families", async () => {
    const minimal = await composePromptPolicy({ mode: "minimal", focusID: "codex" })
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })
    const catalog = full.sections.find((item) => item.id === "product-capability-catalog")

    expect(minimal.sections.find((item) => item.id === "product-capability-catalog")).toBeUndefined()
    expect(focus.sections.find((item) => item.id === "product-capability-catalog")).toBeUndefined()
    expect(catalog?.text).toContain("MendCode complete product capability catalog")
    for (const command of [...primaryCommands, ...advancedCommands, ...internalCommands, ...deprecatedAliases]) {
      expect(catalog?.text).toContain(`mendcode ${command}`)
    }
    expect(catalog?.text).toContain("`/commands`")
    expect(catalog?.text).toContain("`task`/`task_status`")
    expect(catalog?.text).toContain("Custom AI tools are loaded from `{tool,tools}/*.{ts,js}`")
    expect(catalog?.text).toContain("sanitized `<server>_<tool>` names")
    expect(catalog?.text).toContain("MCP prompts are projected into the command/slash catalog")
    expect(catalog?.text).toContain("first-class `workflow` surface")
    expect(catalog?.text).toContain("Installation, enablement, compatibility, trust, and active projection")
    expect(full.policyInstructions).toContain("The actual tool schemas attached to the current model are authoritative")
  })

  test("full mode documents the live TUI customization contract", async () => {
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })
    const section = full.sections.find((item) => item.id === "customization-capabilities")

    expect(section?.text).toContain("Ctrl+P -> Customize TUI")
    expect(section?.text).toContain("/customize")
    expect(section?.text).toContain("Space/Enter")
    expect(section?.text).toContain("api.ui.runtime.customization")
    expect(section?.text).toContain("setWidget")
    expect(section?.text).toContain("customization.reset")
  })

  test("full mode explains marketplace extension boundaries", async () => {
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })
    const section = full.sections.find((item) => item.id === "marketplace-extension-contract")

    expect(section?.text).toContain("reusable .mendcode bundles")
    expect(section?.text).toContain("mendcode marketplace install <pack-id> [source-id]")
    expect(section?.text).toContain("@mendcode/plugin/tui")
    expect(section?.text).toContain("custom pages")
    expect(section?.text).toContain(".mendcode/tools")
    expect(section?.text).toContain(".mendcode/prompts/custom.md")
    expect(section?.text).toContain("Custom AI tools")
    expect(section?.text).toContain("sessionBottomDock")
    expect(section?.text).toContain("Ctrl+T toggles")
    expect(section?.text).toContain("api.shell.spawn()")
    expect(section?.text).toContain("This is not a PTY")
    expect(section?.text).toContain("Do not import private runtime internals")
    expect(full.policyInstructions).toContain("Marketplace packages are reusable .mendcode bundles")
  })

  test("focus mode stays sparse while full mode includes MendCode debugging context", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(focus.sections.map((item) => item.id)).toEqual(["mode-boundary", "harness", "focus-mendcode-basics"])
    expect(focus.basePrompt).toBeTruthy()
    expect(focus.policyInstructions).not.toContain("MendCode CLI map")
    expect(focus.policyInstructions).not.toContain("MendCode customization capabilities")
    expect(focus.policyInstructions).not.toContain("Marketplace packages")

    expect(full.sections.map((item) => item.id)).toContain("harness")
    expect(full.sections.map((item) => item.id)).toContain("mendcode-context")
    expect(full.sections.map((item) => item.id)).toContain("customization-capabilities")
    expect(full.includeProjectInstructions).toBe(true)
    expect(full.includeSkillsByDefault).toBe(true)
    expect(full.includeCustomInstructions).toBe(true)
    expect(full.includeMcpContext).toBe(true)
    expect(full.policyInstructions).toContain("MendCode CLI map")
    expect(full.policyInstructions).toContain("MendCode TUI customization capabilities")
  })

  test("full mode retains the focused provider harness and appends MendCode context", async () => {
    const focus = await composePromptPolicy({ mode: "focus", focusID: "codex" })
    const full = await composePromptPolicy({ mode: "full", focusID: "codex" })

    expect(focus.basePrompt).toBeTruthy()
    expect(full.basePrompt).toBe(focus.basePrompt)
    expect(full.sections.find((item) => item.id === "harness")?.text).toBe(
      focus.sections.find((item) => item.id === "harness")?.text,
    )
    expect(full.policyInstructions).toContain("MendCode knowledge:")
  })
})
