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

export type PromptBehaviorProfile = {
  id: string
  focusID: string
  label: string
  sourcePolicy: "public-model-guidance" | "mendcode-compatibility"
  behavior: string[]
}

const modelBehaviorProfiles: Array<PromptBehaviorProfile & { match: RegExp }> = [
  {
    id: "gpt-5.6",
    focusID: "codex",
    label: "GPT-5.6 compatibility",
    sourcePolicy: "mendcode-compatibility",
    match: /(^|[^a-z0-9])gpt[-_.:/]?5[-_.:/]?6([^a-z0-9]|$)/i,
    behavior: [
      "No public GPT-5.6-specific Codex harness snapshot is tracked; use the actual runtime contract instead of assuming GPT-5.2 behavior.",
      "Treat aliases, transport, reasoning settings, caching, and advanced features as runtime configuration; use only capabilities exposed by this session.",
    ],
  },
  {
    id: "claude-sonnet-5",
    focusID: "claude",
    label: "Claude Sonnet 5 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])claude[-_.:/]?sonnet[-_.:/]?5(?:3)?([^a-z0-9]|$)/i,
    behavior: [
      "State instructions explicitly and scope them to every item they govern; do not rely on silent generalization.",
      "For complex coding or agentic work, use tools deliberately, verify results, and provide useful progress updates without repetitive forced summaries.",
      "Keep simple responses concise and expand only when the task complexity requires it.",
    ],
  },
  {
    id: "claude-opus-5",
    focusID: "claude",
    label: "Claude Opus 5 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])claude[-_.:/]?opus[-_.:/]?5(?:3)?([^a-z0-9]|$)/i,
    behavior: [
      "Treat complex coding as long-horizon agentic work: decompose the task, use tools, inspect results, and self-verify before reporting completion.",
      "Keep the requested scope and runtime permissions explicit instead of inferring capabilities from the model name or transport.",
    ],
  },
  {
    id: "glm-5.2",
    focusID: "glm",
    label: "GLM-5.2 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])(?:glm|zhipu|z[-_.]?ai)[-_.:/]?5[-_.:/]?2([^a-z0-9]|$)/i,
    behavior: [
      "Treat long-horizon work as iterative: plan, use tools, inspect results, and revise rather than stopping after the first pass.",
      "Use repository evidence and the context actually exposed by the runtime; do not assume a large context window or reasoning mode is available.",
      "Keep reasoning effort and thinking controls as runtime configuration; do not promise max, high, or disabled thinking unless the session exposes it.",
    ],
  },
  {
    id: "glm-5.1",
    focusID: "glm",
    label: "GLM-5.1 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])(?:glm|zhipu|z[-_.]?ai)[-_.:/]?5[-_.:/]?1([^a-z0-9]|$)/i,
    behavior: [
      "Treat long-horizon work as iterative: plan, use tools, inspect results, and revise rather than stopping after the first pass.",
      "Use repository evidence and the context actually exposed by the runtime; do not assume a large context window or reasoning mode is available.",
      "Keep reasoning effort and thinking controls as runtime configuration; do not promise max, high, or disabled thinking unless the session exposes it.",
    ],
  },
  {
    id: "deepseek-v4",
    focusID: "deepseek",
    label: "DeepSeek V4 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])deepseek[-_.:/]?v?4(?:[-_.:/]?(?:flash|pro))?(?:\[[^\]]+\])?([^a-z0-9]|$)/i,
    behavior: [
      "Use the actual model and tools exposed by the provider; compatibility layers may alias Claude model names to DeepSeek models.",
      "Treat thinking, context limits, web search, and subagent settings as runtime configuration rather than prompt guarantees.",
      "On long tasks, use tools and verify results; report uncertainty instead of inventing provider-specific behavior.",
    ],
  },
  {
    id: "deepseek-v3.2-exp",
    focusID: "deepseek",
    label: "DeepSeek V3.2-Exp public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])deepseek[-_.:/]?v?3[-_.:/]?2(?:[-_.:/]?exp)?([^a-z0-9]|$)/i,
    behavior: [
      "Use the actual model and tools exposed by the provider; do not infer capabilities from an OpenAI- or Anthropic-compatible transport.",
      "Treat thinking, context limits, web search, and subagent settings as runtime configuration rather than prompt guarantees.",
      "For coding work, iterate with tools and verify the result before reporting completion.",
    ],
  },
  {
    id: "kimi-k2.5",
    focusID: "kimi",
    label: "Kimi K2.5 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])(?:kimi|moonshot)[-_.:/]?k2[-_.:/]?5([^a-z0-9]|$)/i,
    behavior: [
      "Treat multimodal and agentic capabilities as runtime features; use only the tools and modes exposed by the current provider.",
      "Keep instant and thinking modes as runtime configuration rather than assuming one from the model name.",
      "Use the coding toolchain deliberately, inspect outputs, and verify changes before reporting completion.",
    ],
  },
  {
    id: "minimax-m2",
    focusID: "minimax",
    label: "MiniMax M2 public behavior guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])(?:minimax|mini[-_.]?max)[-_.:/]?m2(?:[-_.:/]?(?:1|5|7))?([^a-z0-9]|$)/i,
    behavior: [
      "Treat MiniMax M2.x as coding and agentic model guidance, not as a replacement for MendCode's runtime policy.",
      "Use tools and skills only when exposed by the current session; do not infer Agent Teams or dynamic tool search from the model name alone.",
      "Verify tool results and keep the final response proportional to the requested work.",
    ],
  },
  {
    id: "grok-code-fast-1",
    focusID: "grok",
    label: "Grok Code Fast 1 public safety guidance",
    sourcePolicy: "public-model-guidance",
    match: /(^|[^a-z0-9])grok[-_.:/]?code[-_.:/]?fast[-_.:/]?1([^a-z0-9]|$)/i,
    behavior: [
      "The official xAI source provides a safety prefix, not a complete coding-agent harness; do not present it as one.",
      "Keep safety boundaries explicit and use the actual tools, permissions, and runtime contract exposed by MendCode.",
      "Do not expose proprietary prompts or infer hidden xAI behavior from a model alias.",
    ],
  },
]

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
    promptPath: "mistral/cli_2026-07_v2.md",
    fallbackPath: "mistral/cli.md",
    behavior: ["max-turn/max-price gates", "AGENTS.md layering", "custom system prompt ids", "tool allow/deny patterns"],
  },
  claude: {
    label: "Anthropic-family",
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
  minimax: {
    label: "MiniMax-family",
    license: "public-reference-unverified",
    sourcePolicy: "behavior-only",
    promptPath: null,
    fallbackPath: null,
    behavior: ["coding and agentic workflow awareness", "tool and skill capability boundaries", "runtime-model honesty", "verified outputs"],
  },
  grok: {
    label: "xAI/Grok-family",
    license: "public-safety-reference",
    sourcePolicy: "behavior-only",
    promptPath: null,
    fallbackPath: null,
    behavior: ["explicit safety boundaries", "runtime capability awareness", "no proprietary prompt claims", "verified coding outputs"],
  },
  glm: {
    label: "GLM-family",
    license: "public-reference-unverified",
    sourcePolicy: "behavior-only",
    promptPath: null,
    fallbackPath: null,
    behavior: ["long-horizon task decomposition", "tool-driven iteration", "reasoning-effort awareness", "context-aware execution"],
  },
}

export const focusNames: Record<string, string> = {
  codex: "Codex harness",
  claude: "Anthropic-family",
  gemini: "Gemini CLI",
  kimi: "Kimi CLI",
  mistral: "Mistral Vibe",
  deepseek: "DeepSeek",
  glm: "GLM/Zhipu",
  local: "Local/open model",
  minimax: "MiniMax",
  grok: "xAI/Grok",
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

export function promptBehaviorForModel(input: { focusID?: string | null; modelID?: string | null }) {
  const focusID = input.focusID || ""
  const modelID = input.modelID || ""
  return modelBehaviorProfiles.find((profile) => profile.focusID === focusID && profile.match.test(modelID)) || null
}

export function promptBehaviorText(profile: PromptBehaviorProfile) {
  return [
    `Model-specific MendCode adapter: ${profile.label}.`,
    `Source policy: ${profile.sourcePolicy}; this is behavioral guidance, not an upstream hidden prompt.`,
    ...profile.behavior.map((item) => `- ${item}`),
  ].join("\n")
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
  if (modelKey && source.label === "OpenAI Codex" && candidates.length === 0) candidates.push(source.fallbackPath)
  else candidates.push(source.promptPath, source.fallbackPath)
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
