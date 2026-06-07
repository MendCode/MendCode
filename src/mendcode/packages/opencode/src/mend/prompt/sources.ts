import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"

export type PromptSource = {
  label: string
  license: string
  sourcePolicy: "oss-source" | "behavior-only"
  promptPath: string | null
  fallbackPath: string | null
  promptFiles?: Record<string, string>
  behavior: string[]
}

const promptSources: Record<string, PromptSource> = {
  codex: {
    label: "OpenAI Codex",
    license: "Apache-2.0",
    sourcePolicy: "oss-source",
    promptPath: "codex/gpt_5_2_prompt.md",
    fallbackPath: "codex/gpt_5_codex_prompt.md",
    promptFiles: {
      "gpt-5.2": "codex/gpt_5_2_prompt.md",
      "gpt-5.2-codex": "codex/gpt-5.2-codex_prompt.md",
      "gpt-5.1": "codex/gpt_5_1_prompt.md",
      "gpt-5-codex": "codex/gpt_5_codex_prompt.md",
      codex: "codex/gpt_5_codex_prompt.md",
      review: "codex/review_prompt.md",
      apply: "codex/prompt_with_apply_patch_instructions.md",
      edit: "codex/prompt_with_apply_patch_instructions.md",
    },
    behavior: ["AGENTS.md hierarchy", "sandbox/approval posture", "patch-first editing", "executable verification"],
  },
  gemini: {
    label: "Gemini CLI",
    license: "Apache-2.0",
    sourcePolicy: "oss-source",
    promptPath: "gemini/system-prompt.md",
    fallbackPath: null,
    behavior: ["GEMINI.md context", "large-context checkpointing", "Google auth/search grounding awareness", "eval/checkpoint style"],
  },
  kimi: {
    label: "Kimi CLI",
    license: "Apache-2.0",
    sourcePolicy: "oss-source",
    promptPath: "kimi/init.md",
    fallbackPath: "kimi/compact.md",
    behavior: ["shell-command workflow", "ACP/server posture", "markdown tool descriptions", "skills/subagents"],
  },
  mistral: {
    label: "Mistral Vibe",
    license: "Apache-2.0",
    sourcePolicy: "oss-source",
    promptPath: "mistral/system_prompt.py",
    fallbackPath: "mistral/cli.md",
    behavior: ["max-turn/max-price gates", "AGENTS.md layering", "custom system prompt ids", "tool allow/deny patterns"],
  },
  claude: {
    label: "OpenClaude / Claude-like",
    license: "proprietary-derived-warning",
    sourcePolicy: "behavior-only",
    promptPath: null,
    fallbackPath: null,
    behavior: ["task planning discipline", "CLAUDE.md context", "careful bash/edit policy", "compact output"],
  },
  deepseek: {
    label: "DeepSeek-TUI",
    license: "public-reference-unverified",
    sourcePolicy: "behavior-only",
    promptPath: null,
    fallbackPath: null,
    behavior: ["model+thinking auto-routing", "visible reasoning stream", "parallel-first tools", "cost/cache/context awareness"],
  },
}

export const focusNames: Record<string, string> = {
  codex: "Codex harness",
  claude: "Claude-like",
  gemini: "Gemini CLI",
  kimi: "Kimi CLI",
  mistral: "Mistral Vibe",
  deepseek: "DeepSeek",
  local: "Local/open model",
  generic: "Generic MendCode",
}

async function readJsonIfExists(file: string, fallback: any) {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8"))
}

function relative(root: string, file: string | null) {
  return file ? path.relative(root, file) : null
}

function sourceFile(root: string, rel: string | null | undefined) {
  return rel ? path.join(mendPaths(root).promptSourcesRoot, rel) : null
}

export function sourceForFocus(focusID: string) {
  return promptSources[focusID] || null
}

function sourceMetadataDir(source: PromptSource) {
  if (source.label === "OpenAI Codex") return "codex"
  if (source.label === "Gemini CLI") return "gemini"
  if (source.label === "Kimi CLI") return "kimi"
  if (source.label === "Mistral Vibe") return "mistral"
  return ""
}

async function sourceMetadata(root: string, source: PromptSource) {
  const metadata = await readJsonIfExists(mendPaths(root).promptSourcesMetadata, { sources: {} })
  return Object.values(metadata.sources || {}).find((entry: any) => entry.label === source.label) || null
}

export function resolvePromptSourceFile(source: PromptSource | null, input: { root?: string; modelID?: string | null; role?: string | null; workflow?: string | null } = {}) {
  if (!source || source.sourcePolicy !== "oss-source") return null
  const root = mendPaths(input.root).root
  const candidates: Array<string | null | undefined> = []
  const modelKey = String(input.modelID || "").toLowerCase()
  if (input.role === "review") candidates.push(source.promptFiles?.review)
  if (input.workflow === "apply" || input.workflow === "edit") candidates.push(source.promptFiles?.[input.workflow])
  if (modelKey) {
    if (source.promptFiles?.[modelKey]) candidates.push(source.promptFiles[modelKey])
    else if (modelKey.includes("gpt-5.2-codex")) candidates.push(source.promptFiles?.["gpt-5.2-codex"])
    else if (modelKey.includes("gpt-5.2")) candidates.push(source.promptFiles?.["gpt-5.2"])
    else if (modelKey.includes("gpt-5.1")) candidates.push(source.promptFiles?.["gpt-5.1"])
    else if (modelKey.includes("gpt-5-codex") || modelKey === "codex" || modelKey.includes("codex")) candidates.push(source.promptFiles?.["gpt-5-codex"])
  }
  candidates.push(source.promptPath, source.fallbackPath)
  for (const candidate of candidates.filter(Boolean)) {
    const file = path.isAbsolute(candidate!) ? candidate! : sourceFile(root, candidate)!
    if (existsSync(file)) return file
  }
  return null
}

function adaptPromptText(source: PromptSource, rawText: string) {
  let text = rawText
  if (source.label === "OpenAI Codex") {
    text = text.replace(/^You are .*?Codex CLI.*?\n/im, "You are MendCode CLI, a terminal-based coding assistant adapting public OpenAI Codex CLI behavior without impersonating Codex.\n")
  }
  if (source.label === "Gemini CLI") text = text.replace(/\bGemini CLI\b/g, "Gemini CLI-style harness")
  if (source.label === "Kimi CLI") text = text.replace(/\bKimi CLI\b/g, "Kimi CLI-style harness")
  if (source.label === "Mistral Vibe") text = text.replace(/\bMistral Vibe\b/g, "Mistral Vibe-style harness")
  return [
    `MendCode adapted harness prompt source: ${source.label}.`,
    `License/source policy: ${source.license} / ${source.sourcePolicy}.`,
    "Preserve MendCode product identity. Do not claim to be the upstream CLI, company, or official harness.",
    "",
    text,
  ].join("\n")
}

export async function readPromptSource(source: PromptSource | null, input: { root?: string; modelID?: string | null; role?: string | null; workflow?: string | null } = {}) {
  if (!source || source.sourcePolicy !== "oss-source") return null
  const found = resolvePromptSourceFile(source, input)
  if (!found) return null
  return {
    path: found,
    metadata: await sourceMetadata(mendPaths(input.root).root, source),
    text: adaptPromptText(source, (await readFile(found, "utf8")).trim()),
  }
}

export async function promptSourcesStatus(root?: string) {
  const paths = mendPaths(root)
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(promptSources).map(async ([id, source]) => {
        const harness = await readPromptSource(source, { root: paths.root })
        const metadata: any = await sourceMetadata(paths.root, source)
        return [
          id,
          {
            label: source.label,
            license: source.license,
            sourcePolicy: source.sourcePolicy,
            promptPath: harness ? relative(paths.root, harness.path) : relative(paths.root, sourceFile(paths.root, source.promptPath)),
            fallbackPath: relative(paths.root, sourceFile(paths.root, source.fallbackPath)),
            sourceRepo: metadata?.sourceRepo || null,
            sourceCommit: metadata?.sourceCommit || null,
            copiedAt: metadata?.copiedAt || null,
            promptAvailable: Boolean(harness),
            promptBytes: harness ? Buffer.byteLength(harness.text) : null,
            availableForFocusEvidence: Boolean(harness),
            behavior: source.behavior,
          },
        ]
      }),
    ),
  )
  return { sources, note: "Prompt sources are inventory/evidence for provider-aware focus mode. Raw source is not exposed as a normal prompt mode." }
}

export async function promptModeInstructions(input: { root?: string; mode?: string; focusID?: string; modelID?: string | null; role?: string | null; workflow?: string | null } = {}) {
  const { composePromptPolicy } = await import("./compose")
  return composePromptPolicy(input)
}
