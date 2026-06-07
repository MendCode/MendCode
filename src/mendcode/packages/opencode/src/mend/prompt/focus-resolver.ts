import type { ModelRole } from "../config/models"

export type PromptFocusID = "codex" | "claude" | "gemini" | "kimi" | "deepseek" | "mistral" | "local" | "generic"

export type PromptFocusResolution = {
  focusID: PromptFocusID
  source: "override" | "model-family" | "provider-hint" | "fallback"
  reason: string
}

const modelRules: Array<{ match: RegExp; focusID: PromptFocusID; reason: string }> = [
  { match: /(^|[^a-z0-9])(kimi|moonshot)([^a-z0-9]|$)/i, focusID: "kimi", reason: "model id matches Kimi/Moonshot family" },
  { match: /(^|[^a-z0-9])(gpt|codex|o[1-9]|chatgpt)([^a-z0-9]|$)/i, focusID: "codex", reason: "model id matches OpenAI/Codex family" },
  { match: /(^|[^a-z0-9])(claude|anthropic)([^a-z0-9]|$)/i, focusID: "claude", reason: "model id matches Anthropic/Claude family" },
  { match: /(^|[^a-z0-9])(gemini|palm)([^a-z0-9]|$)/i, focusID: "gemini", reason: "model id matches Google/Gemini family" },
  { match: /(^|[^a-z0-9])(deepseek)([^a-z0-9]|$)/i, focusID: "deepseek", reason: "model id matches DeepSeek family" },
  { match: /(^|[^a-z0-9])(mistral|codestral|devstral)([^a-z0-9]|$)/i, focusID: "mistral", reason: "model id matches Mistral family" },
  { match: /(^|[^a-z0-9])(ollama|llama|qwen|local)([^a-z0-9]|$)/i, focusID: "local", reason: "model id matches local/open model family" },
]

const providerHints: Array<{ match: RegExp; focusID: PromptFocusID; reason: string }> = [
  { match: /(^|[^a-z0-9])(openai|opencode)([^a-z0-9]|$)/i, focusID: "codex", reason: "provider hints OpenAI/Codex behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(anthropic|claude)([^a-z0-9]|$)/i, focusID: "claude", reason: "provider hints Anthropic/Claude behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(gemini|google)([^a-z0-9]|$)/i, focusID: "gemini", reason: "provider hints Google/Gemini behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(kimi|moonshot)([^a-z0-9]|$)/i, focusID: "kimi", reason: "provider hints Kimi/Moonshot behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(deepseek)([^a-z0-9]|$)/i, focusID: "deepseek", reason: "provider hints DeepSeek behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(mistral)([^a-z0-9]|$)/i, focusID: "mistral", reason: "provider hints Mistral behavior when model family is unknown" },
  { match: /(^|[^a-z0-9])(ollama|local)([^a-z0-9]|$)/i, focusID: "local", reason: "provider hints local behavior when model family is unknown" },
]

export function resolvePromptFocus(input: {
  providerID?: string | null
  modelID?: string | null
  authMode?: string | null
  overrideFocusID?: string | null
}): PromptFocusResolution {
  if (input.overrideFocusID) {
    return { focusID: input.overrideFocusID as PromptFocusID, source: "override", reason: "explicit MendCode focus override" }
  }

  const modelID = input.modelID || ""
  for (const rule of modelRules) {
    if (rule.match.test(modelID)) return { focusID: rule.focusID, source: "model-family", reason: rule.reason }
  }

  const providerID = input.providerID || ""
  for (const rule of providerHints) {
    if (rule.match.test(providerID)) return { focusID: rule.focusID, source: "provider-hint", reason: rule.reason }
  }

  return { focusID: "generic", source: "fallback", reason: "no provider/model focus rule matched" }
}

export function resolvePromptFocusForRole(role?: ModelRole | null, overrideFocusID?: string | null) {
  return resolvePromptFocus({
    providerID: role?.providerID,
    modelID: role?.modelID,
    authMode: role?.authMode,
    overrideFocusID,
  })
}
