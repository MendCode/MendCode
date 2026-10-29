import type { ProviderModel, ProviderType } from "@mendcode/protocol"
import { xaiVariants } from "./xai-responses"
import { mistralVariants } from "./mistral"
import { GITLAB_MODELS } from "./gitlab-models"

/**
 * Every built-in fact about API-key providers lives here: their endpoints, the environment variable that enables
 * each one, and a small starting model list. The ids below are the flagship models at the time of writing and WILL
 * age: a `models` list in providers.json replaces them, and `providers.refresh` replaces them with what the provider
 * itself lists. Nothing else in the code names a model.
 */
export type ProviderPreset = {
  type: ProviderType
  name: string
  baseUrl: string
  /** The environment variable that holds the key and enables this preset when it is set. */
  keyEnv?: string
  /** Local servers need no key. */
  keyless?: boolean
  /** Some adapters require explicit enablement even when a key is available. */
  defaultEnabled?: boolean
  /** How the host takes a reasoning effort (Chat Completions only). */
  reasoningStyle?: import("./openai-compatible").ReasoningStyle
  /** Starting model list (provider's own ids); empty when the host serves whatever the user installed. */
  models: ProviderModel[]
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    type: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-6-sol", name: "GPT-6 Sol", effort: true, images: true },
      { id: "gpt-6-luna", name: "GPT-6 Luna", effort: true, images: true },
    ],
  },
  anthropic: {
    type: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 200_000, effort: true, images: true },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, effort: true, images: true },
    ],
  },
  openrouter: {
    type: "openai-compatible",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    reasoningStyle: "reasoning-object",
    models: [
      { id: "google/gemini-3-pro", name: "Gemini 3 Pro", effort: true, images: true },
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", effort: true, images: true },
    ],
  },
  vercel: {
    type: "openai-compatible",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyEnv: "AI_GATEWAY_API_KEY",
    models: [
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", images: true },
      { id: "openai/gpt-6-luna", name: "GPT-6 Luna", images: true },
    ],
  },
  groq: {
    type: "openai-compatible",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    models: [
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", effort: true, images: false },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", images: false },
    ],
  },
  deepseek: {
    type: "openai-compatible",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    reasoningStyle: "deepseek",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", images: false },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", images: false },
    ],
  },
  ollama: { type: "openai-compatible", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", keyless: true, models: [] },
  lmstudio: { type: "openai-compatible", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", keyless: true, models: [] },
  google: {
    type: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_048_576, effort: true, images: true, variants: geminiVariants("gemini-2.5-flash") },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1_048_576, effort: true, images: true, variants: geminiVariants("gemini-2.5-pro") },
    ],
  },
  "github-copilot": {
    type: "github-copilot",
    name: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    keyEnv: "GITHUB_COPILOT_TOKEN",
    defaultEnabled: false,
    models: [],
  },
  azure: {
    type: "azure",
    name: "Azure OpenAI",
    baseUrl: "",
    keyEnv: "AZURE_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  "amazon-bedrock": {
    type: "amazon-bedrock",
    name: "Amazon Bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    keyEnv: "AWS_BEARER_TOKEN_BEDROCK",
    defaultEnabled: false,
    models: [
      { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", context: 200_000, effort: true, images: true },
      { id: "amazon.nova-lite-v1:0", name: "Nova Lite", context: 300_000, images: true },
    ],
  },
  "google-vertex": {
    type: "google-vertex",
    name: "Google Vertex AI",
    baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
    defaultEnabled: false,
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_048_576, effort: true, images: true, variants: geminiVariants("gemini-2.5-flash") },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1_048_576, effort: true, images: true, variants: geminiVariants("gemini-2.5-pro") },
    ],
  },
  "google-vertex-anthropic": {
    type: "google-vertex-anthropic",
    name: "Vertex Anthropic",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    defaultEnabled: false,
    models: [
      { id: "claude-sonnet-4-5@20250929", name: "Claude Sonnet 4.5", context: 200_000, effort: true, images: true },
      { id: "claude-haiku-4-5@20251001", name: "Claude Haiku 4.5", context: 200_000, effort: true, images: true },
    ],
  },
  xai: {
    type: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "grok-code-fast-1", name: "Grok Code Fast 1", images: false },
      { id: "grok-3-mini", name: "Grok 3 Mini", images: false, variants: xaiVariants("grok-3-mini") },
    ],
  },
  mistral: {
    type: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "mistral-large-latest", name: "Mistral Large" },
      { id: "mistral-small-latest", name: "Mistral Small", effort: true, variants: mistralVariants("mistral-small-latest") },
      { id: "devstral-latest", name: "Devstral" },
    ],
  },
  deepinfra: {
    type: "openai-compatible",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash", effort: true, images: false },
    ],
  },
  perplexity: {
    type: "openai-compatible",
    name: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    keyEnv: "PERPLEXITY_API_KEY",
    defaultEnabled: false,
    models: ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"].map((id) => ({ id, images: false, tool_call: false })),
  },
  alibaba: {
    type: "openai-compatible",
    name: "Alibaba",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "qwen-plus", name: "Qwen Plus", images: false, tool_call: true, options: { temperature: 0.55, top_p: 1 } },
      { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", images: false, tool_call: true, options: { temperature: 0.55, top_p: 1 } },
    ],
  },
  opencode: {
    type: "openai-compatible",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyEnv: "OPENCODE_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  llmgateway: {
    type: "openai-compatible",
    name: "LLMGateway",
    baseUrl: "https://api.llmgateway.io/v1",
    keyEnv: "LLMGATEWAY_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  nvidia: {
    type: "openai-compatible",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  "sap-ai-core": {
    type: "openai-compatible",
    name: "SAP AI Core",
    baseUrl: "",
    keyEnv: "AICORE_SERVICE_KEY",
    defaultEnabled: false,
    models: [],
  },
  zenmux: {
    type: "openai-compatible",
    name: "Zenmux",
    baseUrl: "https://zenmux.ai/api/v1",
    keyEnv: "ZENMUX_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  gitlab: { type: "openai-compatible", name: "GitLab", baseUrl: "", keyEnv: "GITLAB_TOKEN", defaultEnabled: false, models: GITLAB_MODELS },
  cerebras: {
    type: "openai-compatible",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    defaultEnabled: false,
    models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B", context: 131_072, outputLimit: 32_768, effort: true, images: false, tool_call: true }],
  },
  cohere: {
    type: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.com/v2",
    keyEnv: "COHERE_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "command-a-03-2025", name: "Command A", context: 256_000, outputLimit: 8_000, images: false, tool_call: true },
      { id: "command-r-plus-08-2024", name: "Command R+", context: 128_000, outputLimit: 4_000, images: false, tool_call: true },
    ],
  },
  "cloudflare-workers-ai": {
    type: "openai-compatible",
    name: "Cloudflare Workers AI",
    baseUrl: "",
    keyEnv: "CLOUDFLARE_API_KEY",
    defaultEnabled: false,
    models: [{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B", context: 24_000, images: false, tool_call: true }],
  },
  "cloudflare-ai-gateway": {
    type: "openai-compatible",
    name: "Cloudflare AI Gateway",
    baseUrl: "",
    keyEnv: "CLOUDFLARE_API_TOKEN",
    defaultEnabled: false,
    models: [],
  },
  togetherai: {
    type: "openai-compatible",
    name: "TogetherAI",
    baseUrl: "https://api.together.ai/v1",
    keyEnv: "TOGETHER_API_KEY",
    defaultEnabled: false,
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B", images: false, tool_call: true },
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", effort: true, images: false, tool_call: true },
    ],
  },
  kilo: {
    type: "openai-compatible",
    name: "Kilo",
    baseUrl: "https://api.kilo.ai/api/gateway",
    keyEnv: "KILO_API_KEY",
    defaultEnabled: false,
    models: [],
  },
  // Plain Chat Completions hosts behind the shared guard in gateway-presets.ts; each lists models through `providers.refresh`.
  fireworks: { type: "openai-compatible", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", defaultEnabled: false, models: [] },
  huggingface: { type: "openai-compatible", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN", defaultEnabled: false, models: [] },
  baseten: { type: "openai-compatible", name: "Baseten", baseUrl: "https://inference.baseten.co/v1", keyEnv: "BASETEN_API_KEY", defaultEnabled: false, models: [] },
  moonshotai: { type: "openai-compatible", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY", defaultEnabled: false, models: [] },
  minimax: { type: "openai-compatible", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", keyEnv: "MINIMAX_API_KEY", defaultEnabled: false, models: [] },
  xiaomi: { type: "openai-compatible", name: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", keyEnv: "XIAOMI_API_KEY", defaultEnabled: false, models: [] },
  zai: { type: "openai-compatible", name: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZHIPU_API_KEY", defaultEnabled: false, models: [] },
  "opencode-go": { type: "openai-compatible", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", keyEnv: "OPENCODE_GO_API_KEY", defaultEnabled: false, models: [] },
  "ant-ling": { type: "openai-compatible", name: "Ant Ling", baseUrl: "https://api.tbox.cn/api/llm/v1", keyEnv: "ANT_LING_API_KEY", defaultEnabled: false, models: [] },
  nearai: { type: "openai-compatible", name: "NEAR AI", baseUrl: "https://cloud-api.near.ai/v1", keyEnv: "NEARAI_API_KEY", defaultEnabled: false, models: [] },
  foundry: { type: "openai-compatible", name: "Microsoft Foundry", baseUrl: "", keyEnv: "AZURE_AI_FOUNDRY_API_KEY", defaultEnabled: false, models: [] },
  "atomic-chat": { type: "openai-compatible", name: "Atomic Chat", baseUrl: "http://127.0.0.1:1337/v1", keyless: true, defaultEnabled: false, models: [] },
}

/** Efforts a model with `effort: true` offers, by wire format. The Anthropic ones are thinking budgets (2k / 8k / 24k tokens). */
export const PROVIDER_EFFORTS = ["low", "medium", "high"] as const
/** Effort a model starts with when the user picks none: OpenAI reasoning models run `medium`, the rest leave reasoning off. */
export const DEFAULT_PROVIDER_EFFORT: Partial<Record<ProviderType, (typeof PROVIDER_EFFORTS)[number]>> = { openai: "medium" }

/** Namespace a provider's model id: `anthropic` + `claude-x` → `anthropic:claude-x`. */
export const namespacedModel = (providerId: string, model: string) => `${providerId}:${model}`

/** Splits a catalog id at its first colon; undefined when it has no namespace (a ChatGPT subscription model). */
export function splitModelId(id: string): { providerId: string; model: string } | undefined {
  const colon = id.indexOf(":")
  if (colon <= 0 || colon === id.length - 1) return undefined
  return { providerId: id.slice(0, colon), model: id.slice(colon + 1) }
}

/** v1's named Gemini variants, expressed as v2 generation parameters. */
export function geminiVariants(model: string): NonNullable<ProviderModel["variants"]> {
  if (model.includes("2.5")) return {
    high: { parameters: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } } },
    max: { parameters: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24_576 } } },
  }
  if (!model.startsWith("gemini-3")) return {}
  return Object.fromEntries((model.includes("3.1") ? ["low", "medium", "high"] : ["low", "high"]).map((level) => [level, { parameters: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } } }]))
}
