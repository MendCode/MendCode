import type { ProviderModel, ProviderType } from "@mendcode/protocol"
import { createAnthropicProvider } from "./anthropic-messages"
import { outboundEndpoint } from "./endpoint-policy"
import { createGeminiProvider } from "./google-gemini"
import { createChatCompletionsProvider } from "./openai-compatible"
import { createResponsesProvider } from "./openai-responses"
import type { ResolvedProvider } from "./provider-factory"
import { catalogEfforts } from "./reasoning-levels"
import { RetryableProviderError, type ModelProvider } from "./provider"
import { scrub, type Fetch } from "./provider-http"

export const zenUrl = (value: string): URL => outboundEndpoint(value, "OpenCode Zen")

/**
 * Zen's free models (`big-pickle`, `*-free`) answer only OpenCode's own client: any other caller gets 403
 * `FreeTierError` (checked live 2026-10-17 without a key and with `public`; a real key was not tried). MendCode does not present itself as OpenCode, so the refusal is said
 * plainly instead of as a rejected key, with the way that does work: OpenCode itself as an ACP agent.
 */
export const ZEN_FREE_TIER_REFUSAL = "[PROVIDER]: OpenCode Zen serves its free models only to OpenCode's own client; run them through the opencode ACP agent (/connect → OpenCode (free)) or pick a paid Zen model"
const isFreeTierRefusal = (message: string) => /FreeTierError|free tier can only be used from within OpenCode/i.test(message)

export function zenWire(model: ProviderModel): ProviderType {
  const npm = model.provider?.npm
  if (npm === "@ai-sdk/openai") return "openai"
  if (npm === "@ai-sdk/anthropic") return "anthropic"
  if (npm === "@ai-sdk/google") return "google"
  if (npm === "@ai-sdk/openai-compatible") return "openai-compatible"
  if (npm) throw new Error("[PROVIDER]: unsupported OpenCode Zen model format; use a native SDK format in model metadata")
  if (model.id.startsWith("claude-")) return "anthropic"
  if (model.id.startsWith("gemini-")) return "google"
  if (/^(gpt-|o\d)/.test(model.id)) return "openai"
  return "openai-compatible"
}

export function createZenProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  return {
    id: provider.id, model: provider.models[0]?.id ?? "",
    async *stream(request) {
      const root = zenUrl(provider.baseUrl)
      const key = provider.apiKey()
      if (!key || key === "public") throw new Error("[AUTH]: OpenCode Zen requires a proxy token; use /connect opencode")
      const model = request.model ?? provider.models[0]?.id ?? ""
      const metadata: ProviderModel = provider.models.find((entry) => entry.id === model) ?? { id: model }
      const type = zenWire(metadata)
      const doFetch: Fetch = (url, init) => {
        const target = new URL(url)
        if (target.origin !== root.origin || target.username || target.password || target.hash) throw new Error("[PROVIDER]: OpenCode Zen request left the configured proxy")
        const headers = new Headers(init.headers)
        for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name)
        headers.set(type === "anthropic" ? "x-api-key" : type === "google" ? "x-goog-api-key" : "authorization", type === "anthropic" || type === "google" ? key : `Bearer ${key}`)
        return (request.fetch ?? input.fetch ?? fetch)(url, { ...init, headers, redirect: "error" })
      }
      const common = { id: provider.id, model, baseUrl: provider.baseUrl, apiKey: () => key, ...(provider.headers ? { headers: provider.headers } : {}), fetch: doFetch, idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000), takesImages: () => metadata.images !== false && (!metadata.modalities || metadata.modalities.input.includes("image")) }
      const adapter = type === "anthropic" ? createAnthropicProvider(common)
        : type === "google" ? createGeminiProvider(common)
        : type === "openai" ? createResponsesProvider({ ...common, headers: async () => ({ ...provider.headers, authorization: `Bearer ${key}` }), routingHeader: false, hostedTools: [], authHint: "rejected the proxy token; reconnect with /connect opencode" })
        : createChatCompletionsProvider({ ...common, requireKey: true, ...(provider.reasoningStyle ? { reasoningStyle: provider.reasoningStyle } : {}), reasoningLevels: () => catalogEfforts(metadata, provider.reasoningStyle) })
      try { yield* adapter.stream({ ...request, fetch: doFetch }) } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [key])
        if (isFreeTierRefusal(message)) throw new Error(ZEN_FREE_TIER_REFUSAL)
        if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
        throw new Error(message)
      }
    },
  }
}
