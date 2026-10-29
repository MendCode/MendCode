import type { ProviderModel, ProviderType } from "@mendcode/protocol"
import { ANTHROPIC_VERSION, createAnthropicProvider } from "./anthropic-messages"
import { createChatCompletionsProvider, type ReasoningStyle } from "./openai-compatible"
import { createResponsesProvider } from "./openai-responses"
import { RetryableProviderError, type ModelProvider } from "./provider"
import { scrub, type Fetch } from "./provider-http"
import { createSdkProvider } from "./provider-sdk"
import { createGeminiProvider } from "./google-gemini"
import { createCopilotProvider } from "./github-copilot"
import { createAzureProvider } from "./azure-openai"
import { createBedrockProvider } from "./amazon-bedrock"
import { createVertexProvider } from "./google-vertex"
import { createVertexAnthropicProvider } from "./vertex-anthropic"
import { createXaiProvider } from "./xai-responses"
import { createMistralProvider } from "./mistral"
import { createDeepInfraProvider, isDeepInfra } from "./deepinfra"
import { createAlibabaProvider } from "./alibaba"
import { createZenProvider } from "./opencode-zen"
import { createLLMGatewayProvider } from "./llmgateway"
import { createNvidiaProvider } from "./nvidia"
import { createSapAIProvider } from "./sap-ai-core"
import { createZenmuxProvider } from "./zenmux"
import { createGitLabProvider } from "./gitlab"
import type { GitLabSocketFactory } from "./gitlab-workflow"
import { catalogEfforts } from "./reasoning-levels"
import { createTogetherAIProvider, isTogetherAI } from "./togetherai"
import { createKiloProvider } from "./kilo"
import { createGatewayProvider, isGatewayPreset } from "./gateway-presets"
import { createCerebrasProvider, isCerebras } from "./cerebras"
import { createCohereProvider, isCohere } from "./cohere"
import { createCloudflareWorkersProvider } from "./cloudflare-workers-ai"
import { createCloudflareGatewayProvider } from "./cloudflare-ai-gateway"

/** A provider as the daemon resolved it from providers.json, the presets and the environment. */
export type ResolvedProvider = {
  id: string
  type: ProviderType
  baseUrl: string
  /** Read on every request, so a key changed in the file or the environment applies at once; never logged. */
  apiKey(): string | undefined
  /** Whether a request without a key is refused up front (hosted providers) rather than sent anonymously (local servers, custom endpoints). */
  keyRequired: boolean
  headers?: Record<string, string>
  reasoningStyle?: ReasoningStyle
  parameters?: import("@mendcode/protocol").ModelChoice["parameters"]
  /** The `/fast` toggle, read per request; only the OpenAI Responses wire (`type: "openai"`) sends it. */
  serviceTier?(): "priority" | undefined
  timeout?: number | false
  chunkTimeout?: number | false
  models: ProviderModel[]
  compaction?: import("@mendcode/protocol").CompactionOverride
  npm?: string
  copilotToken?(): Promise<string | undefined>
  azure?: import("@mendcode/protocol").AzureOptions
  azureToken?(signal: AbortSignal): Promise<string>
  bedrock?: import("@mendcode/protocol").BedrockOptions
  awsCredentials?(signal: AbortSignal): Promise<import("./aws-signature").AwsCredentials>
  vertex?: import("@mendcode/protocol").VertexOptions
  googleToken?(signal: AbortSignal): Promise<string>
  googleQuotaProject?(): string | undefined
  deepinfra?: boolean
  cerebras?: boolean
  togetherai?: boolean
  sapAi?: import("@mendcode/protocol").SapAIConfig
  gitlab?: import("@mendcode/protocol").GitLabConfig
  cloudflareAiGateway?: import("@mendcode/protocol").CloudflareAIGatewayConfig
}

const takesImages = (provider: ResolvedProvider) => (model: string) => {
  const metadata = provider.models.find((entry) => entry.id === model)
  return metadata?.images !== false && (!metadata?.modalities || metadata.modalities.input.includes("image"))
}

/** The reasoning levels a model's catalog entry lists, for a Chat Completions host (undefined when it lists none). */
export const reasoningLevels = (provider: Pick<ResolvedProvider, "models" | "reasoningStyle">) => (model: string) => {
  const metadata = provider.models.find((entry) => entry.id === model)
  return metadata ? catalogEfforts(metadata, provider.reasoningStyle) : undefined
}

/** The adapter for a resolved provider's wire format. `fetch` is for tests; `idleTimeoutMs` bounds a silent stream. */
function adapterFor(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number; gitlabSocket?: GitLabSocketFactory }): ModelProvider {
  const { provider } = input
  if (isCohere(provider)) return createCohereProvider(input)
  if (isCerebras(provider)) return createCerebrasProvider(input)
  if (isGatewayPreset(provider.id)) return createGatewayProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), ...(provider.reasoningStyle ? { reasoningStyle: provider.reasoningStyle } : {}), reasoningLevels: reasoningLevels(provider), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (isTogetherAI(provider)) return createTogetherAIProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "kilo") return createKiloProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "cloudflare-ai-gateway") return createCloudflareGatewayProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.cloudflareAiGateway ? { gateway: provider.cloudflareAiGateway } : {}), ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "cloudflare-workers-ai") return createCloudflareWorkersProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "gitlab") return createGitLabProvider(input)
  if (provider.id === "zenmux") return createZenmuxProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "sap-ai-core") return createSapAIProvider(input)
  if (provider.id === "nvidia") return createNvidiaProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "llmgateway") return createLLMGatewayProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "opencode") return createZenProvider(input)
  if (provider.id === "alibaba") return createAlibabaProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (isDeepInfra(provider)) return createDeepInfraProvider(input)
  if (isTogetherAI(provider)) return createTogetherAIProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.id === "kilo") return createKiloProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}), takesImages: takesImages(provider), ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000) })
  if (provider.type === "xai") return createXaiProvider(input)
  if (provider.type === "mistral") return createMistralProvider(input)
  if (provider.type === "google-vertex") return createVertexProvider(input)
  if (provider.type === "google-vertex-anthropic") return createVertexAnthropicProvider(input)
  if (provider.type === "azure") return createAzureProvider(input)
  if (provider.type === "amazon-bedrock") return createBedrockProvider(input)
  const type = provider.id === "perplexity" ? "openai-compatible" : provider.type
  if (type === "github-copilot") return createCopilotProvider(input)
  if (provider.npm && provider.id !== "perplexity") return createSdkProvider(provider, provider.npm)
  const model = provider.models[0]?.id ?? ""
  const common = { id: provider.id, model, ...(input.fetch ? { fetch: input.fetch } : {}), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000), takesImages: provider.id === "perplexity" ? () => false : takesImages(provider) }
  if (type === "anthropic") return createAnthropicProvider({ ...common, baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}) })
  if (type === "google") return createGeminiProvider({ ...common, baseUrl: provider.baseUrl, apiKey: provider.apiKey, ...(provider.headers ? { headers: provider.headers } : {}) })
  if (type === "openai")
    return createResponsesProvider({
      ...common,
      baseUrl: provider.baseUrl,
      headers: async () => {
        const key = provider.apiKey()
        if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set it with providers.set or the provider's environment variable`)
        return { authorization: `Bearer ${key}`, ...provider.headers }
      },
      routingHeader: false,
      ...(provider.serviceTier ? { serviceTier: provider.serviceTier } : {}),
      // Web search runs on OpenAI's side; image generation needs models and an organization this adapter cannot assume.
      hostedTools: ["web_search"],
      authHint: "rejected the API key (check it with providers.set)",
    })
  return createChatCompletionsProvider({
    ...common,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    requireKey: provider.keyRequired,
    ...(provider.id === "perplexity" ? { sonar: true, requireKey: true } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(provider.reasoningStyle ? { reasoningStyle: provider.reasoningStyle } : {}),
    reasoningLevels: reasoningLevels(provider),
  })
}

/** Request headers that authenticate a plain GET (model listing) for a wire format. */
export function authHeaders(provider: Pick<ResolvedProvider, "type" | "headers">, key: string | undefined): Record<string, string> {
  if (provider.type === "google") return { ...provider.headers, "x-goog-api-key": key ?? "" }
  const auth = provider.type === "anthropic" ? { "x-api-key": key ?? "", "anthropic-version": ANTHROPIC_VERSION } : key ? { authorization: `Bearer ${key}` } : {}
  return { ...auth, ...provider.headers }
}

/** The text a failed admin call may show: scrubbed of the key and cut short. */
export function safeMessage(error: unknown, key: string | undefined, max = 300) {
  return scrub(error instanceof Error ? error.message : String(error), key ? [key] : []).slice(0, max)
}

/** Generation defaults and metadata follow the selected model on every call. */
export function createApiProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number; gitlabSocket?: GitLabSocketFactory }): ModelProvider {
  const { provider } = input
  const cache = new Map<string, ModelProvider>()
  return {
    id: provider.id, model: provider.models[0]?.id ?? "",
    compactionLimits: (model) => {
      const entry = provider.models.find((entry) => entry.id === (model ?? provider.models[0]?.id))
      const contextWindow = entry?.context ?? entry?.limit?.context
      const inputLimit = entry?.inputLimit ?? entry?.limit?.input
      const outputLimit = entry?.outputLimit ?? entry?.limit?.output
      return { ...(contextWindow ? { contextWindow } : {}), ...(inputLimit ? { inputLimit } : {}), ...(outputLimit ? { outputLimit } : {}), ...(provider.compaction ? { provider: provider.compaction } : {}), ...(entry?.compaction ? { model: entry.compaction } : {}) }
    },
    async *stream(request) {
      const name = request.model ?? provider.models[0]?.id ?? ""
      const metadata = provider.models.find((model) => model.id === name)
      let adapter = cache.get(name)
      if (!adapter) {
        adapter = adapterFor({ ...input, provider: { ...provider, headers: { ...provider.headers, ...metadata?.headers } } })
        cache.set(name, adapter)
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      request.signal.addEventListener("abort", abort, { once: true })
      if (request.signal.aborted) abort()
      let expired = false
      const timeout = provider.timeout ?? 300_000
      const timer = timeout === false ? undefined : setTimeout(() => { expired = true; controller.abort() }, timeout)
      const parameters = { ...provider.parameters, ...metadata?.options, ...request.parameters }
      if (metadata?.temperature === false) { delete parameters.temperature; delete parameters.top_p }
      const limit = isDeepInfra(provider) || isCerebras(provider) || isTogetherAI(provider) || ["llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", "cloudflare-ai-gateway"].includes(provider.id) ? metadata?.outputLimit ?? metadata?.limit?.output : metadata?.limit?.output
      // Provider-native variants may lower the output cap, but cannot raise the model's limit.
      for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) if (limit && typeof parameters[key] === "number") parameters[key] = Math.min(parameters[key], limit)
      try {
        for await (const event of adapter.stream({ ...request, parameters, ...(limit ? { maxOutputTokens: Math.min(request.maxOutputTokens ?? limit, limit) } : {}), ...(metadata?.tool_call === false ? { tools: [], hostedTools: [] } : {}), signal: controller.signal })) {
          if (event.type !== "usage" || event.usage.costMicros !== undefined || !metadata?.cost) { yield event; continue }
          const cost = event.usage.input + event.usage.cacheRead > 200_000 ? metadata.cost.context_over_200k ?? metadata.cost : metadata.cost
          yield { ...event, usage: { ...event.usage, costMicros: Math.round(event.usage.input * cost.input + event.usage.output * cost.output + event.usage.cacheRead * (cost.cache_read ?? cost.input) + event.usage.cacheWrite * (cost.cache_write ?? cost.input)) } }
        }
        if (expired && !request.signal.aborted) throw new RetryableProviderError(`[PROVIDER]: ${provider.id} request timed out after ${timeout}ms`)
      } catch (error) {
        if (expired && !request.signal.aborted) throw new RetryableProviderError(`[PROVIDER]: ${provider.id} request timed out after ${timeout}ms`)
        throw error
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener("abort", abort)
      }
    },
  }
}
