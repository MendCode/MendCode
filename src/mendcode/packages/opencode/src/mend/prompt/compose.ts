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

function relativePath(root: string, file: string | null) {
  if (!file) return null
  return file.startsWith(root) ? file.slice(root.length + 1) : file
}

function minimalBoundary() {
  return [
    "You are MendCode CLI. Answer the user directly.",
    "Use the available terminal coding tools accurately.",
    "Do not claim tests, builds, provider calls, or file writes passed unless they actually ran.",
    "Do not expose secrets or raw auth tokens.",
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
    "- Public entrypoint: ./bin/mend. Public CLI remains TUI-first.",
    "- Runtime config lives under .mendcode/ and typed runtime modules under src/mendcode/packages/opencode/src/mend/.",
    `- Default focus: ${config.focus?.default || "codex"}. Prompt mode is persisted in .mendcode/prompt-mode.json.`,
    "- Model roles are managed from ~/.mendcode/models.yaml and projected into each checkout generated runtime compatibility config.",
    "- Budget behavior is local policy; dry-run/status commands must not call providers.",
    "",
    "MendCode CLI map:",
    "- `mend` opens the interactive TUI. `mend run <message>` opens the TUI with a message queued. `mend chat <message>` runs a control-plane chat turn.",
    "- Health/config: `mend status`, `mend doctor`, `mend check`, `mend setup status|plan|doctor`, `mend config show|paths`.",
    "- Models/providers/auth: `mend models status|show|plan|presets|set-default|use-preset`, `mend providers status`, `mend auth status|login-plan|login`.",
    "- Prompt/runtime: `mend prompts sources|build|mode|cycle-mode`, `mend runtime status|configure|plan|adopt|registry`, `mend adapter status`, `mend upstream status|inspect|baseline`.",
    "- Memory: `mend memory status|search|preview|add|edit|delete|propose|list|apply|reject|import-codex|index|config`.",
    "- Project controls: `mend tui status|profile|apply|preview|propose`, `mend focus status|list|show|use`, `mend packages status|list|create|install|enable|disable|remove|search|show`.",
    "- Collaboration: `mend worktree status|plan|create|open|adopt|remove|reset|doctor`, `mend mflow status|setup|activate|deactivate|remove|plan|doctor`, `mend tsm status|plan|setup|activate|deactivate|remove|doctor`.",
    "",
    "Memory operating contract:",
    "- Use `mend memory add` only when the user explicitly asks to save/remember a fact.",
    "- Use `mend memory propose` for durable future-use candidates that still need approval.",
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

  if (mode === "full") {
    const full = await fullKnowledge(root)
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
  const metadata = harness?.metadata as any
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
