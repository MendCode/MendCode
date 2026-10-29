import { PROMPT_FAMILIES, type PromptFamily, type PromptFocus, type PromptFocusChoice } from "@mendcode/protocol/wire"

/**
 * Which family's guidance a model id gets under `auto`. Matching is on whole words of the model name first
 * (`anthropic:claude-sonnet-5-5` -> `claude-sonnet-5-5`), then on the provider prefix, so a gateway
 * (`openrouter/anthropic/claude-3`) follows the model behind it. Order matters only between words of one id.
 */
const FAMILY_WORDS: Array<{ family: PromptFamily; words: RegExp }> = [
  { family: "claude", words: /^(?:claude|anthropic|sonnet|opus|haiku)$/ },
  { family: "codex", words: /^(?:gpt\d*|codex|chatgpt|openai|o\d+)$/ },
  { family: "gemini", words: /^gemini$/ },
  { family: "kimi", words: /^(?:kimi|moonshot|moonshotai)$/ },
  { family: "deepseek", words: /^deepseek$/ },
  { family: "mistral", words: /^(?:mistral|codestral|devstral|magistral|mixtral|ministral)$/ },
  { family: "glm", words: /^(?:glm\d*|chatglm\d*|zhipu|zhipuai|zai|bigmodel)$/ },
  { family: "minimax", words: /^minimax$/ },
  { family: "grok", words: /^(?:grok\d*|xai)$/ },
  // Open-weight models and the hosts that run them on the user's side: small, strict about tool-call format, short on context.
  { family: "local", words: /^(?:local|ollama|lmstudio|llamacpp|llamafile|vllm|llama\d*|codellama|qwen\d*|qwq|gemma\d*|phi\d*|granite\d*|starcoder\d*|smollm\d*|tinyllama)$/ },
]

/** Spellings that split one name into two words: `z.ai`, `z-ai`, `mini-max`, `lm-studio`. */
const JOINED_NAMES: Array<[RegExp, string]> = [[/z[-_.]ai/g, "zai"], [/mini[-_.]max/g, "minimax"], [/lm[-_ ]studio/g, "lmstudio"], [/llama[-_.]cpp/g, "llamacpp"]]

function familyOf(text: string): PromptFamily | undefined {
  const lower = JOINED_NAMES.reduce((value, [pattern, joined]) => value.replace(pattern, joined), text.toLowerCase())
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean)
  for (const word of words) for (const rule of FAMILY_WORDS) if (rule.words.test(word)) return rule.family
  return undefined
}

/** `neutral` when no family claims the model: unknown ids get no vendor's guidance (open-weight and local-host ids are `local`). */
export function familyForModel(modelID: string | undefined): PromptFocus {
  const id = (modelID ?? "").trim()
  if (!id) return "neutral"
  const cut = Math.max(id.lastIndexOf("/"), id.lastIndexOf(":"))
  return familyOf(cut >= 0 ? id.slice(cut + 1) : id) ?? (cut >= 0 ? familyOf(id.slice(0, cut)) : undefined) ?? "neutral"
}

/** An explicit family always wins; `auto` follows the model of the call being built. */
export function resolveFocus(choice: PromptFocusChoice, modelID: string | undefined): PromptFocus {
  return (PROMPT_FAMILIES as readonly string[]).includes(choice) ? choice as PromptFamily : familyForModel(modelID)
}
