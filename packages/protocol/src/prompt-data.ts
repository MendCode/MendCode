/** Ordered by what they add to every model call: minimal < focus < guide (the provider guide) < full; `custom` is the project's own prompt. */
export const PROMPT_MODES = ["minimal", "focus", "guide", "full", "custom"] as const
export const PROMPT_FAMILIES = ["codex", "claude", "gemini", "kimi", "deepseek", "mistral", "glm", "minimax", "grok", "local"] as const
/** `auto` follows the session's model on every call; any other value is a family the user chose explicitly. */
export const PROMPT_FOCUS_CHOICES = ["auto", ...PROMPT_FAMILIES] as const
export type PromptMode = typeof PROMPT_MODES[number]
export type PromptFamily = typeof PROMPT_FAMILIES[number]
export type PromptFocusChoice = typeof PROMPT_FOCUS_CHOICES[number]
/** What a call really uses: a family, or `neutral` (no vendor guidance) when `auto` meets a model no family claims. */
export type PromptFocus = PromptFamily | "neutral"
/**
 * What a mode costs on every model call, estimated from the real composed text of the current model's family (characters over four),
 * without the project's instructions, skills, memory and context files. `overFocus` is the difference from `focus`.
 */
export type PromptModeCost = { mode: PromptMode; tokens: number; overFocus: number }
export type PromptStatus = {
  directory: string
  mode: PromptMode
  /** The cost of each available mode for the family the status resolves to. */
  costs?: PromptModeCost[]
  /** The saved choice: `auto` or an explicit family. */
  focusID: PromptFocusChoice
  /** The family that choice resolves to for the model the status was asked about. */
  resolvedFocus: PromptFocus
  available: PromptMode[]
  customPrompt: { name: string; path: string; bytes: number; available: boolean; fallbackReason: string | null }
}
export type PromptBuildReport = PromptStatus & {
  modelID: string | null
  role: string | null
  workflow: string | null
  promptOrigin: "preset" | "project-custom"
  basePromptSource: "minimal-base" | "native-harness" | "project-custom"
  includeProjectInstructions: boolean
  includeSkillsByDefault: boolean
  includeCustomInstructions: boolean
  fallbackReason: string | null
  sections: Array<{ id: string; label: string; bytes: number; preview: string }>
  instructionsBytes: number
  instructionsPreview: string
  printsFullPrompt: boolean
  instructions?: string
}

/** `auto → claude` for a followed model, the family name for an explicit choice. */
export const promptFocusLabel = (status: { focusID: PromptFocusChoice; resolvedFocus?: PromptFocus | undefined }) => status.focusID === "auto" ? `auto → ${status.resolvedFocus ?? "neutral"}` : status.focusID

const grouped = (value: number) => value.toLocaleString("en-US")
/** The cost notice of one mode: `guide · +620 tokens per call (1,190 total)` (added over `focus`), `focus · 570 tokens per call`. */
export function promptCostLine(cost: PromptModeCost | undefined): string {
  if (!cost) return ""
  if (cost.mode === "guide" || cost.mode === "full") return `${cost.mode} · +${grouped(cost.overFocus)} tokens per call (${grouped(cost.tokens)} total)`
  return `${cost.mode} · ${grouped(cost.tokens)} tokens per call`
}
/** The one-line warning shown with the modes that make every call bigger than `focus`; empty for the others. */
export const promptCostWarning = (mode: PromptMode): string => mode === "guide" || mode === "full" ? "sent with every call" : ""
/** The cost of `mode` in a status, if the daemon sent costs. */
export const promptCostOf = (status: { costs?: PromptModeCost[] | undefined }, mode: PromptMode): PromptModeCost | undefined => status.costs?.find((cost) => cost.mode === mode)
