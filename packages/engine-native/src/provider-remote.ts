import { ProviderModel, type ProviderTestResult } from "@mendcode/protocol"
import { authHeaders, createApiProvider, safeMessage, type ResolvedProvider } from "./provider-factory"
import { httpFailure, joinUrl, scrub, type Fetch } from "./provider-http"
import { fetchGeminiModels } from "./google-models"
import { copilotModel } from "./github-copilot"
import { COPILOT_HEADERS, copilotUrl } from "./github-copilot-auth"
import { fetchBedrockModels } from "./amazon-bedrock"
import { xaiBaseUrl, xaiVariants } from "./xai-responses"
import { mistralBaseUrl, mistralModel } from "./mistral"
import { deepinfraBaseUrl, deepinfraHeaders, isDeepInfra } from "./deepinfra"
import { perplexityUrl } from "./perplexity"
import { alibabaUrl } from "./alibaba"
import { zenUrl } from "./opencode-zen"
import { llmgatewayHeaders, llmgatewayUrl } from "./llmgateway"
import { nvidiaHeaders, nvidiaUrl } from "./nvidia"
import { fetchSapAIModels } from "./sap-ai-core"
import { zenmuxHeaders, zenmuxUrl } from "./zenmux"
import { fetchGitLabModels } from "./gitlab"
import { cerebrasHeaders, cerebrasUrl, isCerebras } from "./cerebras"
import { fetchCohereModels, isCohere } from "./cohere"
import { isTogetherAI, togetheraiUrl, togetheraiVariants } from "./togetherai"
import { kiloHeaders, kiloUrl } from "./kilo"
import { gatewayHeaders, gatewayUrl, isGatewayPreset } from "./gateway-presets"
import { cloudflareWorkersUrl } from "./cloudflare-workers-ai"
import { cloudflareGatewayUrl, CLOUDFLARE_GATEWAY_MODEL } from "./cloudflare-ai-gateway"

/** Most models a refreshed list keeps (OpenRouter lists a few hundred); the catalog and its reply stay small. */
export const MAX_REFRESHED_MODELS = 400
export const REFRESH_TIMEOUT_MS = 10_000
export const TEST_TIMEOUT_MS = 30_000

type RemoteModel = {
  id?: unknown
  name?: unknown
  display_name?: unknown
  context_length?: unknown
  context_window?: unknown
  supported_parameters?: unknown
  architecture?: { input_modalities?: unknown }
  max_output?: unknown
  input_modalities?: unknown
  output_modalities?: unknown
  capabilities?: { reasoning?: unknown }
  type?: unknown
  reasoning?: unknown
}

const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

/** Claude 3 and 3.5 models take no thinking budget; every later one does. */
const claudeThinks = (id: string) => !/^claude-3(?!-7)/.test(id)
/** OpenAI ids that are chat/reasoning models; the list also holds embeddings, speech, image and moderation models. */
const openaiChat = (id: string) => /^(gpt|o\d|chatgpt|codex)/.test(id) && !/(embedding|tts|whisper|dall-e|moderation|image|audio|realtime|transcribe|search-preview)/.test(id)
const openaiReasons = (id: string) => /^(o\d|gpt-5|gpt-6)/.test(id)

/** One entry of a `/models` answer as a model config, or undefined when the provider lists it but it is not a chat model. */
function toModel(type: ResolvedProvider["type"], raw: RemoteModel): ProviderModel | undefined {
  if (type === "mistral") return mistralModel(raw)
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 66) return undefined
  const id = raw.id
  if (type === "xai" && (!id.startsWith("grok-") || /(imagine|image|video|audio|voice|tts|realtime|embedding)/.test(id))) return undefined
  const name = typeof raw.display_name === "string" && raw.display_name ? raw.display_name : typeof raw.name === "string" && raw.name ? raw.name : undefined
  const context = positive(raw.context_length) ?? positive(raw.context_window)
  const modalities = Array.isArray(raw.architecture?.input_modalities) ? (raw.architecture!.input_modalities as unknown[]) : undefined
  const parameters = Array.isArray(raw.supported_parameters) ? (raw.supported_parameters as unknown[]) : undefined
  if (type === "openai" && !openaiChat(id)) return undefined
  const effort = type === "anthropic" ? claudeThinks(id) : type === "openai" ? openaiReasons(id) : parameters ? parameters.includes("reasoning") || parameters.includes("reasoning_effort") : undefined
  const images = type === "anthropic" ? true : modalities ? modalities.includes("image") : undefined
  return { id, ...(name ? { name: name.slice(0, 100) } : {}), ...(context ? { context } : {}), ...(effort !== undefined ? { effort } : {}), ...(images !== undefined ? { images } : {}), ...(type === "xai" ? { variants: xaiVariants(id) } : {}) }
}

/** GET `/models` of the provider (10 s limit). Throws a scrubbed error on any failure. */
export async function fetchProviderModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs?: number }): Promise<ProviderModel[]> {
  const { provider } = input
  if (isCohere(provider)) return fetchCohereModels(input)
  const togetherai = isTogetherAI(provider)
  if (togetherai) togetheraiUrl(provider.baseUrl)
  if (isDeepInfra(provider)) deepinfraBaseUrl(provider.baseUrl)
  if (isCerebras(provider)) cerebrasUrl(provider.baseUrl)
  if (provider.type === "xai") xaiBaseUrl(provider.baseUrl)
  if (provider.type === "mistral") mistralBaseUrl(provider.baseUrl)
  if (provider.type === "google-vertex" || provider.type === "google-vertex-anthropic") return provider.models
  if (provider.type === "amazon-bedrock") return fetchBedrockModels(input)
  // Azure model names are user-owned deployment ids. The global /models catalog cannot discover those.
  if (provider.type === "azure") {
    if (!provider.models.length) throw new Error(`[PROVIDER]: ${provider.id} needs explicit deployment ids in models; Azure refresh does not discover deployments`)
    return provider.models
  }
  if (provider.id === "cloudflare-ai-gateway") {
    cloudflareGatewayUrl(provider.baseUrl)
    if (!provider.apiKey()) throw new Error("[AUTH]: Cloudflare AI Gateway requires a token")
    if (provider.models.some((model) => !CLOUDFLARE_GATEWAY_MODEL.test(model.id))) throw new Error("[PROVIDER]: Cloudflare AI Gateway model must use provider/model")
    // Unified API has no OpenAI catalog endpoint; configured/offline models own this list, as in v1.
    return provider.models
  }
  if (provider.id === "cloudflare-workers-ai") {
    cloudflareWorkersUrl(provider.baseUrl)
    if (!provider.apiKey()) throw new Error("[AUTH]: no API key for cloudflare-workers-ai")
    // Like v1, the offline/configured catalog owns Workers AI model ids, not OpenAI GET /models.
    return provider.models
  }
  if (provider.id === "gitlab") return fetchGitLabModels(input)
  if (provider.id === "sap-ai-core") return fetchSapAIModels(input)
  if (provider.id === "perplexity") perplexityUrl(provider.baseUrl)
  if (provider.id === "alibaba") alibabaUrl(provider.baseUrl)
  if (provider.id === "opencode") zenUrl(provider.baseUrl)
  if (provider.id === "llmgateway") llmgatewayUrl(provider.baseUrl)
  if (provider.id === "nvidia") nvidiaUrl(provider.baseUrl)
  if (provider.id === "zenmux") zenmuxUrl(provider.baseUrl)
  if (provider.id === "kilo") kiloUrl(provider.baseUrl)
  if (isGatewayPreset(provider.id)) gatewayUrl(provider.id, provider.baseUrl)
  if (provider.type === "google") return fetchGeminiModels({ ...input, timeoutMs: input.timeoutMs ?? REFRESH_TIMEOUT_MS, maxModels: MAX_REFRESHED_MODELS })
  const doFetch: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const key = (provider.type === "github-copilot" ? await provider.copilotToken?.() : undefined) ?? provider.apiKey()
  if ((!key || provider.id === "opencode" && key === "public") && (isDeepInfra(provider) || isCerebras(provider) || togetherai || provider.keyRequired || ["perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "zenmux", "kilo"].includes(provider.id))) throw new Error(`[AUTH]: no API key for ${provider.id}; set it with providers.set or the provider's environment variable`)
  const url = joinUrl(provider.baseUrl, provider.type === "anthropic" ? "/models?limit=1000" : "/models")
  const headers = provider.type === "mistral" ? { ...Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization")), authorization: `Bearer ${key}` } : authHeaders(provider, key)
  const secrets = provider.type === "mistral" || isDeepInfra(provider) || isCerebras(provider) || togetherai ? [key ?? "", ...Object.values(provider.headers ?? {})] : [key ?? ""]
  if (provider.type === "github-copilot") copilotUrl(url)
  let response: Response
  try {
    const requestHeaders = { accept: "application/json", ...headers, ...(provider.type === "github-copilot" ? { ...COPILOT_HEADERS, authorization: `Bearer ${key}` } : {}), ...(["alibaba", "opencode"].includes(provider.id) ? { authorization: `Bearer ${key}` } : {}) }
    if (togetherai) {
      for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === "authorization") delete (requestHeaders as Record<string, string>)[name]
      requestHeaders.authorization = `Bearer ${key}`
    }
    response = await doFetch(url, { method: "GET", redirect: "error", headers: isGatewayPreset(provider.id) ? gatewayHeaders(requestHeaders, key) : isCerebras(provider) ? cerebrasHeaders(requestHeaders, key!) : isDeepInfra(provider) ? deepinfraHeaders(requestHeaders, key!) : provider.id === "nvidia" ? nvidiaHeaders(requestHeaders, key!) : provider.id === "llmgateway" ? llmgatewayHeaders(requestHeaders, key!) : provider.id === "zenmux" ? zenmuxHeaders(requestHeaders, key!) : provider.id === "kilo" ? kiloHeaders(requestHeaders, key!) : requestHeaders, signal: AbortSignal.timeout(input.timeoutMs ?? REFRESH_TIMEOUT_MS) })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    throw new Error(`[PROVIDER]: ${provider.id} ${timedOut ? "model list timed out" : scrub(safeMessage(error, key), secrets)}`)
  }
  if (!response.ok) throw await httpFailure({ providerId: provider.id, response, secrets })
  const payload = (await response.json().catch(() => undefined)) as { data?: unknown; models?: unknown } | undefined
  const list = togetherai && Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : undefined
  if (!list) throw new Error(`[PROVIDER]: ${provider.id} /models answered without a model list`)
  const models = (list as RemoteModel[]).flatMap((raw) => {
    if (togetherai) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.type !== undefined && !["chat", "language", "code"].includes(String(raw.type))) return []
      const model = toModel("openai-compatible", { ...raw, architecture: { input_modalities: raw.input_modalities ?? raw.architecture?.input_modalities } })
      if (!model) return []
      const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
      const reasoning = raw.reasoning ?? raw.capabilities?.reasoning
      const metadata = { ...model, ...(typeof reasoning === "boolean" ? { effort: reasoning } : {}), ...(parameters ? { tool_call: parameters.includes("tools") } : {}), ...(positive(raw.max_output) ? { outputLimit: positive(raw.max_output)! } : {}) }
      return [{ ...metadata, variants: togetheraiVariants(metadata) }]
    }
    if (provider.id === "zenmux") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Array.isArray(raw.output_modalities) && !raw.output_modalities.includes("text")) return []
      const model = toModel("openai-compatible", { ...raw, architecture: { input_modalities: raw.input_modalities ?? raw.architecture?.input_modalities } })
      if (!model) return []
      const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
      const outputLimit = positive(raw.max_output)
      return [{ ...model, ...(typeof raw.capabilities?.reasoning === "boolean" ? { effort: raw.capabilities.reasoning } : {}), ...(parameters ? { tool_call: parameters.includes("tools") } : {}), ...(outputLimit ? { outputLimit } : {}) }]
    }
    if (provider.id === "opencode") {
      if (!raw || typeof raw !== "object") return []
      const selected = Object.fromEntries(Object.entries(raw).filter(([name]) => name in ProviderModel.shape))
      const parsed = ProviderModel.safeParse({ ...toModel(provider.type, raw), ...selected })
      return parsed.success ? [parsed.data] : []
    }
    const model = provider.type === "github-copilot" ? copilotModel(raw) : toModel(provider.type, raw ?? {})
    if (isCerebras(provider) && model) {
      const outputLimit = positive(raw.max_output)
      return [{ ...model, ...(typeof raw.capabilities?.reasoning === "boolean" ? { effort: raw.capabilities.reasoning } : {}), ...(outputLimit ? { outputLimit } : {}) }]
    }
    if (["llmgateway", "nvidia", "kilo"].includes(provider.id) && model) {
      const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
      const outputLimit = positive(raw.max_output)
      return [{ ...model, ...(parameters ? { tool_call: parameters.includes("tools") } : {}), ...(outputLimit ? { outputLimit } : {}) }]
    }
    return model ? [{ ...model, ...(provider.id === "perplexity" ? { images: false, tool_call: false } : {}) }] : []
  })
  return (togetherai ? [...new Map(models.map((model) => [model.id, model])).values()] : models).sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_REFRESHED_MODELS)
}

/**
 * One tiny streaming request (8 output tokens) with the provider's own adapter, to check the key, the endpoint and the
 * model end to end. Never throws: the result says what happened. It costs a few tokens, so callers run it on a user action only.
 */
export async function testProvider(input: { provider: ResolvedProvider; model?: string | undefined; fetch?: Fetch; timeoutMs?: number; now?: () => number; gitlabSocket?: import("./gitlab-workflow").GitLabSocketFactory }): Promise<ProviderTestResult> {
  const { provider } = input
  const now = input.now ?? (() => performance.now())
  const model = input.model ?? provider.models[0]?.id
  if (!model) return { ok: false, latencyMs: 0, error: `no model configured for ${provider.id}; run providers.refresh or set models` }
  const started = now()
  const signal = AbortSignal.timeout(input.timeoutMs ?? TEST_TIMEOUT_MS)
  const key = provider.apiKey()
  try {
    const adapter = createApiProvider({ provider, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.gitlabSocket ? { gitlabSocket: input.gitlabSocket } : {}) })
    let finished = false
    for await (const event of adapter.stream({ system: "Reply with one short word.", messages: [{ role: "user", content: "ping" }], tools: [], model, maxOutputTokens: 8, signal })) if (event.type === "finish") finished = true
    if (!finished) return { ok: false, latencyMs: Math.round(now() - started), model, error: signal.aborted ? "timed out" : "the stream ended without an answer" }
    return { ok: true, latencyMs: Math.round(now() - started), model }
  } catch (error) {
    return { ok: false, latencyMs: Math.round(now() - started), model, error: signal.aborted ? "timed out" : safeMessage(error, key) }
  }
}
