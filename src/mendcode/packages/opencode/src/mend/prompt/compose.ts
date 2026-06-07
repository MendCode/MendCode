import { Buffer } from "buffer"
import { readMendConfig } from "../config/project"
import { mflowStatus, readWorktreePolicy, tsmStatus } from "../config/worktree"
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
  if (mode === "minimal" || mode === "focus" || mode === "full" || mode === "dev-js") return mode
  throw new Error("prompt mode must be one of: minimal, focus, full, dev-js")
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
    mflowStatus(root),
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
  ]
  const integration: string[] = []
  if (mflow.enabled) {
    integration.push(
      "Mflow context:",
      `- Mflow live sync is configured active with mode=${mflow.mode}. Respect neverSync boundaries and require explicit visible start/stop actions.`,
    )
  }
  if (tsm.policy?.mode && tsm.policy.mode !== "off") {
    integration.push(
      "TSM context:",
      `- TSM is relevant as a terminal-session/worktree orchestration candidate with policy mode=${tsm.policy.mode}. Do not install or run TSM unless explicitly requested.`,
    )
  }
  if (policy.mode === "live-sync" && !mflow.enabled) {
    integration.push("Worktree context:", "- Worktree policy mentions live-sync, but Mflow is not fully enabled; keep live operations blocked.")
  }
  return { knowledge: lines.join("\n"), integration: integration.join("\n") }
}

function devJsKnowledge() {
  return [
    "JavaScript development mode:",
    "- Prefer the existing repo stack and package manager. When the repo has no package-manager signal and a choice is needed, use pnpm.",
    "- Do not install packages or run networked package-manager commands unless the user explicitly approves it.",
    "- Use vanilla JavaScript, HTML, CSS, Web APIs, and small focused modules when they satisfy the product goal.",
    "- Use the framework already present in the repo. Introduce a framework only when the requested app genuinely needs framework-level state, routing, rendering, or build ergonomics.",
    "- Do not introduce TanStack libraries unless the repo already uses them or the user explicitly asks for them.",
    "- Keep dependency changes exact and minimal. Prefer built-in platform APIs over new packages for parsing, dates, fetch, storage, and simple state.",
    "- For frontend work, build the actual usable interface first and verify rendered behavior when feasible.",
  ].join("\n")
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

  if (mode === "full" || mode === "dev-js") {
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

  if (mode === "dev-js") {
    sections.push(section({
      id: "dev-js-policy",
      label: "JavaScript development policy",
      source: "mendcode-context",
      text: devJsKnowledge(),
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
