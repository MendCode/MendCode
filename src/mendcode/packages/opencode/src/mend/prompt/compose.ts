import { Buffer } from "buffer"
import { readMendConfig } from "../config/project"
import { readWorktreePolicy, tsmStatus } from "../config/worktree"
import { readMflowConfig } from "../config/mflow"
import type { MendPromptMode } from "./mode"
import { focusNames, readPromptSource, resolvePromptSourceFile, sourceForFocus } from "./sources"
import { composeCustomizationCapabilitySection } from "./capabilities"

export type PromptBaseSource = "mendcode-harness-source" | "opencode-generic-provider-fallback" | "minimal-base"

export type PromptSection = {
  id: string
  label: string
  source: PromptBaseSource | "mendcode-context" | "integration-context" | "mode-boundary"
  text: string
  bytes: number
  preview: string
}

export type PromptComposition = {
  mode: MendPromptMode
  focusID: string
  basePromptSource: PromptBaseSource
  includeProjectInstructions: boolean
  includeSkillsByDefault: boolean
  includeCustomInstructions: boolean
  includeMcpContext: boolean
  usesOpenCodeGenericProviderPrompt: boolean
  usesMendCodeHarnessPrompt: boolean
  fallbackReason: string | null
  source: {
    label: string
    license: string
    sourcePolicy: string
    promptPath: string | null
    sourceRepo: string | null
    sourceCommit: string | null
    copiedAt: string | null
    promptAvailable: boolean
    rawSourceModeExposed: false
  } | null
  sections: PromptSection[]
  instructions: string
  instructionsBytes: number
  instructionsPreview: string
  policyInstructions: string
  policyInstructionsBytes: number
  policyInstructionsPreview: string
  basePrompt: string | null
  basePromptBytes: number
}

type ComposeInput = {
  root?: string
  mode?: string
  focusID?: string
  modelID?: string | null
  role?: string | null
  workflow?: string | null
}

function assertMode(mode: string): MendPromptMode {
  if (mode === "minimal" || mode === "focus" || mode === "full") return mode
  if (mode === "dev-js") return "full"
  throw new Error("prompt mode must be one of: minimal, focus, full")
}

function preview(text: string, limit = 240) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
}

function section(input: Omit<PromptSection, "bytes" | "preview">): PromptSection {
  return {
    ...input,
    bytes: Buffer.byteLength(input.text),
    preview: preview(input.text),
  }
}

type PromptSourceMetadata = {
  sourceRepo?: string | null
  sourceCommit?: string | null
  copiedAt?: string | null
}

function relativePath(root: string, file: string | null) {
  if (!file) return null
  return file.startsWith(root) ? file.slice(root.length + 1) : file
}

function promptSourceMetadata(value: unknown): PromptSourceMetadata | null {
  if (!value || typeof value !== "object") return null
  return value as PromptSourceMetadata
}

function minimalBoundary() {
  return [
    "You are MendCode CLI. Answer the user directly.",
    "Use the available terminal coding tools accurately.",
    "For monitored loops or repeated autonomous iterations, use the `loop` tool; `/loop` creates/activates and `/loops` lists or shows existing workflows. Ask only for missing critical settings.",
    "Before creating another loop for the same goal, list/show existing workflows; if a loop shows completed 0/0 or no next wakeup unexpectedly, report the invalid zero-budget state instead of recreating loops.",
    "Never set loop maxTurns to 0. Use a positive cap, or omit maxTurns for unlimited/unbounded monitoring.",
    "If the user asks the loop to write, edit, fix, implement, code, or create files, use normal execution rather than report-only; report-only is for inspection/monitoring/reporting objectives.",
    "Do not claim tests, builds, provider calls, or file writes passed unless they actually ran.",
    "Do not expose secrets or raw auth tokens.",
  ].join("\n")
}

function loopWorkflowBrief() {
  return [
    "MendCode Loop Workflow:",
    "- Treat `/loop`, `turn this session into a loop`, `run this every N minutes`, or `run 5 monitored iterations` as Loop Workflow tool requests.",
    "- Use the `loop` tool; `/loop` creates or activates, `/loops` lists workflows unless a concrete loop id is provided for show.",
    "- Ask with the `question` tool only when objective, iteration limit, cadence, model/provider, max runtime, permissions, or stop condition are missing.",
    "- Create a reviewable loop draft first, or activate directly when the objective, model, iteration limit, cadence, permissions, and stop condition are already clear.",
    "- Use report-only mode unless the user explicitly allows edits; do not write `Iteration 1/5` through `Iteration 5/5` manually in the current chat turn.",
    "- A user request to write, edit, fix, implement, code, or create files is explicit edit approval for that loop; create it with normal execution instead of report-only.",
    "- Never use `maxTurns: 0`; fixed/max-goal loops need a positive cap, while unbounded-monitor loops should omit the cap.",
    "- If a loop appears completed without runs, `completed 0/0`, or missing an expected next wakeup, inspect it with list/show and report the invalid state instead of creating replacement loops repeatedly.",
    "- Report the loop id, current phase, next wakeup, and where the user can monitor it in the TUI.",
  ].join("\n")
}

function loopWorkflowFull() {
  return [
    "MendCode Loop Workflow full contract:",
    "- A loop is a durable workflow backed by MendCode storage, a root session, Agent View state, loop runs, and a scheduler/service wakeup path.",
    "- The normal user-facing flow is chat-first through the `loop` tool: when the user asks to convert the current session into a loop, create a Loop Workflow for that objective, activate it, and let the loop runner own future iterations.",
    "- Do not satisfy loop requests by performing all iterations inline in the current assistant turn. Inline iteration text is only a short preview when explicitly framed as a dry-run preview.",
    "- Drafts should capture name, objective, prompt, cadence or manual run mode, iteration cap, max wall-clock runtime when useful, stop condition, permission mode, provider/model, agent profile, and whether report-only is required.",
    "- When model/provider is unspecified and it matters for cost, speed, capability, or the user's request, ask the user to choose from the configured providers/models that are visible in the session. If no choice is needed, use the current session default.",
    "- Activation should create or reuse the loop root session, show it as Looping/background in Agent View, and ensure the project loop service when available.",
    "- For safe tests, prefer report-only execution: the agent may read and analyze, but edit/write/shell/subagent escalation remains denied unless the user explicitly opts into normal execution.",
    "- If the requested loop objective includes writing, editing, fixing, implementing, coding, or creating files, that is explicit normal-execution intent; do not downgrade it to report-only just because it is a loop.",
    "- For a bounded test loop such as five directory-inspection iterations, create a loop with a 5-run cap, report-only permissions, a concise per-run diff/new-findings report, and a final summary after the fifth run.",
    "- Never use a zero iteration cap. Use positive maxTurns for bounded/fixed work; omit maxTurns for unbounded-monitor cadence so scheduled loops do not complete as 0/0 before their first run.",
    "- Before recreating a loop, inspect existing workflows with list/show. A loop in completed 0/0, no-runs, or missing-next-wakeup state is an invalid workflow to report or fix, not a reason to create more loops blindly.",
    "- The loop service is responsible for durable wakeups after the TUI or chat session closes. SSE is a live refresh channel for open TUIs; storage is the source of truth when the TUI reopens.",
    "- Prefer the `loop` tool over shell commands. If the tool is unavailable, the CLI namespace is plural `mendcode loops`; never try `mendcode loop`.",
    "- Slash UX: `/loop <objective>` should produce an activate/draft flow; `/loops` should call list; `/loops <loop_id>` may call show with workflowID. For stop/pause/resume/run requests without a visible id, use the loop tool action and let it resolve the current session's contextual loop.",
    "- Fallback/debug commands are: `mendcode loops draft`, `mendcode loops activate <id>`, `mendcode loops tick <id> --execute --report-only`, `mendcode loops show <id>`, `mendcode loops tail <id>`, and `mendcode loops service status`.",
    "- Never promise always-on progress unless the loop service is installed/running for the project or another active scheduler is confirmed.",
    "- Do not push, merge, release, bump versions, run destructive commands, or allow normal edit execution from a loop unless the user's policy and the loop permission mode explicitly allow it.",
  ].join("\n")
}

function focusFallback(focusID: string, reason: string) {
  return [
    `Active focus: ${focusNames[focusID] || focusID} (${focusID}).`,
    `Harness prompt fallback: ${reason}.`,
    "Use a small MendCode coding baseline: inspect before editing, keep changes scoped, and verify with executable evidence.",
    "Preserve MendCode product identity. Do not claim to be an upstream CLI, company, or official harness.",
  ].join("\n")
}

function tuiMarkdownRendering() {
  return [
    "MendCode TUI rendering:",
    "- Full text Markdown is supported in assistant responses: headings, bold/italic text, inline code, fenced code blocks, links, lists, checklists, blockquotes, and tables.",
    "- Mermaid fenced blocks are supported for flowcharts and other useful diagrams.",
    "- Embedded HTML and Markdown images are outside the terminal text rendering contract.",
  ].join("\n")
}

async function fullKnowledge(root: string) {
  const [config, policy, mflow, tsm] = await Promise.all([
    Promise.resolve(readMendConfig(root)),
    readWorktreePolicy(root),
    readMflowConfig(root),
    tsmStatus(root),
  ])
  const lines = [
    "MendCode knowledge:",
    "- MendCode is a terminal coding TUI with MendCode-owned runtime configuration.",
    "- Public entrypoint: mendcode. Public CLI remains TUI-first.",
    "- Runtime config lives under .mendcode/ and typed runtime modules under src/mendcode/packages/opencode/src/mend/.",
    `- Default focus: ${config.focus?.default || "codex"}. Prompt mode is persisted in .mendcode/prompt-mode.json.`,
    "- Model roles are managed from ~/.mendcode/models.yaml and projected into each checkout generated runtime compatibility config.",
    "- Budget behavior is local policy; dry-run/status commands must not call providers.",
    "",
    "MendCode CLI map:",
    "- `mendcode` opens the interactive terminal coding TUI. `mendcode run <message>` opens the TUI with a message queued. `mendcode chat <message>` runs a control-plane chat turn.",
    "- Health/setup: `mendcode status`, `mendcode doctor`, `mendcode check`, `mendcode setup status|plan|doctor`.",
    "- Models/providers/auth: `mendcode models status|show|plan|presets|set-default|use-preset`, `mendcode providers status`, `mendcode auth status|login-plan|login`.",
    "- Prompt/runtime internals are debug-only and should not be presented as the normal user workflow.",
    "- Memory inspection: `mendcode memory status|search|preview|list|index|config`.",
    "- Project controls: `mendcode focus status|list|show|use`, `mendcode packages status|list|create|install|enable|disable|remove|search|show`.",
    "- Collaboration: `mendcode worktree status|plan|create|open|adopt|remove|reset|doctor`, `mendcode mflow status|setup|activate|deactivate|remove|plan|doctor`, `mendcode tsm status|plan|setup|activate|deactivate|remove|doctor`.",
    "",
    "Memory operating contract:",
    "- Do not call `mendcode memory add` or `mendcode memory propose` for implicit preferences, corrections, rules, or durable future-use candidates.",
    "- Let the post-turn memory extractor create approval-gated pending proposals from normal chat content.",
    "- Use direct memory mutation commands only when the user explicitly asks to save, remember, add, edit, delete, apply, or reject memory now, including equivalent explicit memory wording in the user's language.",
    "- List/search before editing, deleting, applying, or rejecting memory IDs.",
    "- Treat injected memories as soft context; current user instructions and repository evidence win.",
  ]
  const integration: string[] = []
  if (mflow.enabled) {
    integration.push(
      "Mflow context:",
      "- Runtime mflow coordination is enabled. File edit locks are enforced by MendCode hooks; do not call mflow manually unless the user asks.",
    )
  }
  if (tsm.enabled || tsm.lifecycle === "active" || tsm.lifecycle === "degraded" || (tsm.policy?.mode && tsm.policy.mode !== "off")) {
    integration.push(
      "TSM context:",
      `- TSM lifecycle=${tsm.lifecycle}, enabled=${tsm.enabled}, worktreeCapable=${tsm.worktreeCapable}. Do not install, activate, run, remove, or delegate worktrees to TSM unless explicitly requested.`,
    )
  }
  if (policy.mode === "live-sync" && !mflow.enabled) {
    integration.push("Worktree context:", "- Worktree policy mentions live-sync, but Mflow is not fully enabled; keep live operations blocked.")
  }
  return { knowledge: lines.join("\n"), integration: integration.join("\n") }
}

export async function composePromptPolicy(input: ComposeInput = {}): Promise<PromptComposition> {
  const root = process.env.MENDCODE_ROOT || input.root || process.cwd()
  const mode = assertMode(input.mode || "focus")
  const focusID = input.focusID || "codex"
  const sourceInput = { ...input, root }
  const source = sourceForFocus(focusID)
  const harness = await readPromptSource(source, sourceInput)
  const found = source ? resolvePromptSourceFile(source, sourceInput) : null
  const sections: PromptSection[] = []
  const includeProjectInstructions = true
  const includeSkillsByDefault = mode !== "minimal"
  const includeCustomInstructions = true
  const includeMcpContext = true

  sections.push(section({
    id: "mode-boundary",
    label: "MendCode mode boundary",
    source: "mode-boundary",
    text: minimalBoundary(),
  }))

  let basePrompt: string | null = null
  let basePromptSource: PromptBaseSource = "minimal-base"
  let fallbackReason: string | null = null

  if (mode !== "minimal") {
    if (harness) {
      basePrompt = harness.text
      basePromptSource = "mendcode-harness-source"
      sections.push(section({
        id: "harness",
        label: `${source?.label || focusID} harness prompt`,
        source: "mendcode-harness-source",
        text: harness.text,
      }))
    } else {
      fallbackReason = source
        ? source.sourcePolicy === "oss-source"
          ? "MendCode prompt source file is missing"
          : `focus source policy is ${source.sourcePolicy}`
        : "unknown focus"
      basePromptSource = "opencode-generic-provider-fallback"
      sections.push(section({
        id: "fallback",
        label: "MendCode focus fallback",
        source: "opencode-generic-provider-fallback",
        text: focusFallback(focusID, fallbackReason),
      }))
    }
  }

  if (mode !== "minimal") {
    sections.push(section({
      id: "loop-workflow-brief",
      label: "MendCode Loop Workflow",
      source: "mendcode-context",
      text: loopWorkflowBrief(),
    }))

    sections.push(section({
      id: "tui-markdown-rendering",
      label: "MendCode TUI Markdown rendering",
      source: "mendcode-context",
      text: tuiMarkdownRendering(),
    }))
  }

  if (mode === "full") {
    const full = await fullKnowledge(root)
    sections.push(section({
      id: "loop-workflow-full",
      label: "MendCode Loop Workflow full contract",
      source: "mendcode-context",
      text: loopWorkflowFull(),
    }))
    sections.push(section({
      id: "mendcode-context",
      label: "MendCode knowledge",
      source: "mendcode-context",
      text: full.knowledge,
    }))
    if (full.integration) {
      sections.push(section({
        id: "integrations",
        label: "Active integration knowledge",
        source: "integration-context",
        text: full.integration,
      }))
    }
    sections.push(section({
      id: "customization-capabilities",
      label: "MendCode customization capabilities",
      source: "mendcode-context",
      text: composeCustomizationCapabilitySection(),
    }))
  }

  const instructions = sections.map((item) => item.text).join("\n\n")
  const policyInstructions = sections
    .filter((item) => item.id !== "harness")
    .map((item) => item.text)
    .join("\n\n")
  const metadata = promptSourceMetadata(harness?.metadata)
  return {
    mode,
    focusID,
    basePromptSource,
    includeProjectInstructions,
    includeSkillsByDefault,
    includeCustomInstructions,
    includeMcpContext,
    usesOpenCodeGenericProviderPrompt: basePromptSource === "opencode-generic-provider-fallback",
    usesMendCodeHarnessPrompt: basePromptSource === "mendcode-harness-source",
    fallbackReason,
    source: source
      ? {
          label: source.label,
          license: source.license,
          sourcePolicy: source.sourcePolicy,
          promptPath: relativePath(root, harness?.path || found),
          sourceRepo: metadata?.sourceRepo || null,
          sourceCommit: metadata?.sourceCommit || null,
          copiedAt: metadata?.copiedAt || null,
          promptAvailable: Boolean(harness),
          rawSourceModeExposed: false,
        }
      : null,
    sections,
    instructions,
    instructionsBytes: Buffer.byteLength(instructions),
    instructionsPreview: preview(instructions),
    policyInstructions,
    policyInstructionsBytes: Buffer.byteLength(policyInstructions),
    policyInstructionsPreview: preview(policyInstructions),
    basePrompt,
    basePromptBytes: Buffer.byteLength(basePrompt || ""),
  }
}

export async function promptModeInstructions(input: ComposeInput = {}) {
  return composePromptPolicy(input)
}
