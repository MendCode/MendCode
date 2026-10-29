import type { ProviderType } from "@mendcode/protocol"

/**
 * The terminal's copy of the API-key presets the daemon knows (packages/engine-native/src/provider-presets.ts): only
 * what /connect and the model page need to show (id, name, wire format, endpoint, key variable). The engine's list is the
 * source of truth; test/connect.test.ts compares the two so a new preset cannot go unnoticed. No model ids live here.
 */
export type ConnectPreset = {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  /** The environment variable the daemon reads for this preset's key. */
  keyEnv?: string
  /** A local server: no key. */
  keyless?: true
}

export const CONNECT_PRESETS: readonly ConnectPreset[] = [
  { id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "openrouter", name: "OpenRouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  { id: "vercel", name: "Vercel AI Gateway", type: "openai-compatible", baseUrl: "https://ai-gateway.vercel.sh/v1", keyEnv: "AI_GATEWAY_API_KEY" },
  { id: "groq", name: "Groq", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  { id: "deepseek", name: "DeepSeek", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "ollama", name: "Ollama", type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", keyless: true },
  { id: "lmstudio", name: "LM Studio", type: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", keyless: true },
  { id: "google", name: "Google Gemini", type: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY" },
  { id: "github-copilot", name: "GitHub Copilot", type: "github-copilot", baseUrl: "https://api.githubcopilot.com", keyEnv: "GITHUB_COPILOT_TOKEN" },
  { id: "azure", name: "Azure OpenAI", type: "azure", baseUrl: "", keyEnv: "AZURE_API_KEY" },
  { id: "amazon-bedrock", name: "Amazon Bedrock", type: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", keyEnv: "AWS_BEARER_TOKEN_BEDROCK" },
  { id: "google-vertex", name: "Google Vertex AI", type: "google-vertex", baseUrl: "https://us-central1-aiplatform.googleapis.com/v1" },
  { id: "google-vertex-anthropic", name: "Vertex Anthropic", type: "google-vertex-anthropic", baseUrl: "https://aiplatform.googleapis.com/v1" },
  { id: "xai", name: "xAI", type: "xai", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  { id: "mistral", name: "Mistral", type: "mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  { id: "deepinfra", name: "DeepInfra", type: "openai-compatible", baseUrl: "https://api.deepinfra.com/v1/openai", keyEnv: "DEEPINFRA_API_KEY" },
  { id: "perplexity", name: "Perplexity", type: "openai-compatible", baseUrl: "https://api.perplexity.ai", keyEnv: "PERPLEXITY_API_KEY" },
  { id: "alibaba", name: "Alibaba", type: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyEnv: "DASHSCOPE_API_KEY" },
  { id: "opencode", name: "OpenCode Zen", type: "openai-compatible", baseUrl: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_API_KEY" },
  { id: "llmgateway", name: "LLMGateway", type: "openai-compatible", baseUrl: "https://api.llmgateway.io/v1", keyEnv: "LLMGATEWAY_API_KEY" },
  { id: "nvidia", name: "NVIDIA", type: "openai-compatible", baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY" },
  { id: "sap-ai-core", name: "SAP AI Core", type: "openai-compatible", baseUrl: "", keyEnv: "AICORE_SERVICE_KEY" },
  { id: "zenmux", name: "Zenmux", type: "openai-compatible", baseUrl: "https://zenmux.ai/api/v1", keyEnv: "ZENMUX_API_KEY" },
  { id: "gitlab", name: "GitLab", type: "openai-compatible", baseUrl: "", keyEnv: "GITLAB_TOKEN" },
  { id: "cerebras", name: "Cerebras", type: "openai-compatible", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
  { id: "cohere", name: "Cohere", type: "cohere", baseUrl: "https://api.cohere.com/v2", keyEnv: "COHERE_API_KEY" },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", type: "openai-compatible", baseUrl: "", keyEnv: "CLOUDFLARE_API_KEY" },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", type: "openai-compatible", baseUrl: "", keyEnv: "CLOUDFLARE_API_TOKEN" },
  { id: "togetherai", name: "TogetherAI", type: "openai-compatible", baseUrl: "https://api.together.ai/v1", keyEnv: "TOGETHER_API_KEY" },
  { id: "kilo", name: "Kilo", type: "openai-compatible", baseUrl: "https://api.kilo.ai/api/gateway", keyEnv: "KILO_API_KEY" },
  { id: "fireworks", name: "Fireworks", type: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY" },
  { id: "huggingface", name: "Hugging Face", type: "openai-compatible", baseUrl: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN" },
  { id: "baseten", name: "Baseten", type: "openai-compatible", baseUrl: "https://inference.baseten.co/v1", keyEnv: "BASETEN_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI", type: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY" },
  { id: "minimax", name: "MiniMax", type: "openai-compatible", baseUrl: "https://api.minimax.io/v1", keyEnv: "MINIMAX_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", type: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", keyEnv: "XIAOMI_API_KEY" },
  { id: "zai", name: "Z.AI", type: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
  { id: "opencode-go", name: "OpenCode Go", type: "openai-compatible", baseUrl: "https://opencode.ai/zen/go/v1", keyEnv: "OPENCODE_GO_API_KEY" },
  { id: "ant-ling", name: "Ant Ling", type: "openai-compatible", baseUrl: "https://api.tbox.cn/api/llm/v1", keyEnv: "ANT_LING_API_KEY" },
  { id: "nearai", name: "NEAR AI", type: "openai-compatible", baseUrl: "https://cloud-api.near.ai/v1", keyEnv: "NEARAI_API_KEY" },
  { id: "foundry", name: "Microsoft Foundry", type: "openai-compatible", baseUrl: "", keyEnv: "AZURE_AI_FOUNDRY_API_KEY" },
  { id: "atomic-chat", name: "Atomic Chat", type: "openai-compatible", baseUrl: "http://127.0.0.1:1337/v1", keyless: true },
]

/** Plain Chat Completions hosts (engine: gateway-presets.ts), listed after the older presets so digits 1-9 stay put. */
export const GATEWAY_CHOICES: readonly string[] = ["fireworks", "huggingface", "baseten", "moonshotai", "minimax", "xiaomi", "zai", "opencode-go", "ant-ling", "nearai", "foundry", "atomic-chat"]

export const presetOf =(id: string): ConnectPreset | undefined => CONNECT_PRESETS.find((preset) => preset.id === id)

/**
 * Not a provider: OpenCode's free Zen models answer only OpenCode's own client, so `/connect` adds the user's `opencode` CLI
 * as the ACP agent `opencode` (its models appear in `/model` as `acp:opencode/<model>`).
 */
export const OPENCODE_FREE = "opencode-free"
export const OPENCODE_AGENT = { name: "opencode", config: { command: "opencode", args: ["acp"], envKeys: [] as string[] } }

/** The name a provider goes by in lists: the preset's, else its own id. */
export const providerName = (id: string) => (id === OPENCODE_FREE ? "OpenCode (free)" : presetOf(id)?.name ?? id)

/** Wire formats in the order the custom endpoint form cycles them. */
export const PROVIDER_TYPE_CHOICES: readonly ProviderType[] = ["openai-compatible", "openai", "anthropic", "google", "azure", "xai", "mistral", "cohere"]

/** The `providers.set` id rule (`PROVIDER_ID` in @mendcode/protocol) without loading the schemas; the ids the daemon reserves. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
export const RESERVED_IDS: readonly string[] = ["chatgpt"]
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const BASE_URL_PATTERN = /^https?:\/\/[^\s]+$/i

/**
 * The outbound endpoint rule (`outboundEndpoint` in @mendcode/engine-native) without loading the engine: HTTPS to any host,
 * plain HTTP only to a literal loopback host, never credentials, a query or a fragment in the URL.
 */
export function isOutboundEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    const secure = url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    return secure && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export const isVertexPreset = (id: string | undefined) => id === "google-vertex" || id === "google-vertex-anthropic"
