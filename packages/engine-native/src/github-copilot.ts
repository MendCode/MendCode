import type { ProviderModel } from "@mendcode/protocol"
import { createAnthropicProvider } from "./anthropic-messages"
import { createChatCompletionsProvider } from "./openai-compatible"
import { createResponsesProvider } from "./openai-responses"
import { COPILOT_HEADERS, copilotUrl } from "./github-copilot-auth"
import type { ResolvedProvider } from "./provider-factory"
import { RetryableProviderError, type ModelProvider, type ModelRequest } from "./provider"
import { scrub, type Fetch } from "./provider-http"

export function copilotEndpoint(model: string): NonNullable<ProviderModel["copilotEndpoint"]> {
  const generation = /^gpt-(\d+)/.exec(model)
  return generation && Number(generation[1]) >= 5 && !model.startsWith("gpt-5-mini") ? "/responses" : "/chat/completions"
}

/** Per-call adapters preserve native streaming/tool/usage semantics, with Copilot's auth and request rules. */
export function createCopilotProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const baseUrl = copilotUrl(provider.baseUrl)
  return {
    id: provider.id, model: provider.models[0]?.id ?? "",
    async *stream(request: ModelRequest) {
      const model = request.model ?? provider.models[0]?.id ?? ""
      const key = await provider.copilotToken?.() ?? provider.apiKey()
      if (!key) throw new Error("[AUTH]: no GitHub Copilot token; use /connect github-copilot")
      const metadata = provider.models.find((entry) => entry.id === model)
      const endpoint = metadata?.copilotEndpoint ?? copilotEndpoint(model)
      const doFetch: Fetch = async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (model.includes("gpt")) { delete body.max_tokens; delete body.max_output_tokens }
        if (endpoint === "/v1/messages" && metadata?.maxOutputTokens && typeof body.max_tokens === "number") {
          body.max_tokens = Math.min(body.max_tokens, metadata.maxOutputTokens)
          const thinking = body.thinking as { budget_tokens?: number } | undefined
          if (thinking && typeof thinking.budget_tokens === "number") thinking.budget_tokens = Math.min(thinking.budget_tokens, Number(body.max_tokens) - 1)
        }
        const headers = new Headers(init.headers)
        headers.delete("x-api-key")
        headers.set("authorization", `Bearer ${key}`)
        for (const [name, value] of Object.entries(COPILOT_HEADERS)) headers.set(name, value)
        const messages = (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []) as Array<{ role?: string; type?: string; content?: unknown }>
        const last = messages.at(-1)
        const final = request.messages.at(-1)
        const toolImage = final?.role === "user" && /^\[image from .+ call\]/.test(final.content)
        headers.set("x-initiator", request.initiator ?? (last?.role === "user" && final?.role === "user" && !toolImage ? "user" : "agent"))
        const content = JSON.stringify(messages)
        const vision = content.includes('"type":"image_url"') || content.includes('"type":"input_image"') || content.includes('"type":"image"')
        headers.delete("copilot-vision-request")
        if (vision) headers.set("copilot-vision-request", "true")
        if (endpoint === "/v1/messages") headers.set("anthropic-beta", "interleaved-thinking-2025-05-14")
        return (input.fetch ?? fetch)(url, { ...init, redirect: "error", headers, body: JSON.stringify(body) })
      }
      const common = { id: provider.id, model, fetch: doFetch, ...(input.idleTimeoutMs ? { idleTimeoutMs: input.idleTimeoutMs } : {}), takesImages: (id: string) => provider.models.find((entry) => entry.id === id)?.images !== false }
      const headers = { ...provider.headers, ...COPILOT_HEADERS }
      const adapter = endpoint === "/v1/messages" ? createAnthropicProvider({ ...common, baseUrl: `${baseUrl}/v1`, apiKey: () => key, headers, ...(metadata?.maxOutputTokens ? { maxTokens: metadata.maxOutputTokens } : {}) })
        : endpoint === "/responses" ? createResponsesProvider({ ...common, baseUrl, headers: async () => ({ ...headers, authorization: `Bearer ${key}` }), routingHeader: false, hostedTools: [], authHint: "rejected GitHub Copilot authorization; reconnect with /connect github-copilot" })
        : createChatCompletionsProvider({ ...common, baseUrl, apiKey: () => key, requireKey: true, headers })
      try { yield* adapter.stream(request) } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [key])
        if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
        throw new Error(message)
      }
    },
  }
}

/** Copilot's catalog controls visibility, policy, limits, vision and per-model wire endpoint. */
export function copilotModel(value: unknown): ProviderModel | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { id?: unknown; name?: unknown; model_picker_enabled?: boolean; policy?: { state?: string }; supported_endpoints?: string[]; capabilities?: { limits?: { max_context_window_tokens?: number; max_output_tokens?: number; vision?: { supported_media_types?: string[] } }; supports?: { streaming?: boolean; tool_calls?: boolean; vision?: boolean; adaptive_thinking?: boolean; reasoning_effort?: string[]; max_thinking_budget?: number } } }
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 66 || raw.model_picker_enabled !== true || raw.policy?.state === "disabled") return undefined
  const limits = raw.capabilities?.limits, supports = raw.capabilities?.supports
  const endpoint = Array.isArray(raw.supported_endpoints) && raw.supported_endpoints.includes("/v1/messages") ? "/v1/messages" : copilotEndpoint(raw.id)
  const variants: NonNullable<ProviderModel["variants"]> = {}
  for (const effort of Array.isArray(supports?.reasoning_effort) ? supports.reasoning_effort : []) {
    if (!["low", "medium", "high", "xhigh"].includes(effort)) continue
    variants[effort] = endpoint === "/v1/messages" && supports?.adaptive_thinking
      ? { effort: effort as "low" | "medium" | "high" | "xhigh", parameters: { thinking: { type: "adaptive" }, output_config: { effort } } }
      : { effort: effort as "low" | "medium" | "high" | "xhigh" }
  }
  const budget = supports?.max_thinking_budget
  if (!Object.keys(variants).length && endpoint === "/v1/messages" && typeof budget === "number" && budget > 2048) {
    variants.high = { parameters: { thinking: { type: "enabled", budget_tokens: Math.floor(budget / 2) } } }
    variants.max = { parameters: { thinking: { type: "enabled", budget_tokens: budget - 1 } } }
  }
  const context = limits?.max_context_window_tokens
  const output = limits?.max_output_tokens
  return { id: raw.id, ...(typeof raw.name === "string" && raw.name ? { name: raw.name.slice(0, 100) } : {}), ...(typeof context === "number" && Number.isFinite(context) && context >= 1 ? { context: Math.floor(context) } : {}), ...(typeof output === "number" && Number.isFinite(output) && output >= 1 ? { maxOutputTokens: Math.floor(output) } : {}), images: supports?.vision === true || Boolean(Array.isArray(limits?.vision?.supported_media_types) && limits.vision.supported_media_types.some((type) => typeof type === "string" && type.startsWith("image/"))), effort: Boolean(supports?.adaptive_thinking || (Array.isArray(supports?.reasoning_effort) && supports.reasoning_effort.length) || (typeof budget === "number" && budget > 0)), copilotEndpoint: endpoint, ...(Object.keys(variants).length ? { variants } : {}) }
}
