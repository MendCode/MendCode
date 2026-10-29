import type { ProviderModel } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { Fetch } from "./provider-http"

export const isTogetherAI = (provider: { id: string; npm?: string | undefined; togetherai?: boolean | undefined }) => provider.togetherai || provider.id === "togetherai" || provider.npm === "@ai-sdk/togetherai"

/** TogetherAI stays opt-in: it needs an explicit enable and a Bearer key. */
export const togetheraiUrl = (value: string): URL => outboundEndpoint(value, "TogetherAI")

/** v1's reasoning variants; explicit model variants take precedence in the daemon. */
export function togetheraiVariants(model: ProviderModel): NonNullable<ProviderModel["variants"]> {
  if (model.effort === false || model.reasoning === false || !(model.effort || model.reasoning)) return {}
  const variants = Object.fromEntries((["low", "medium", "high"] as const).map((effort) => [effort, { effort, parameters: { reasoning_effort: effort } }]))
  return model.id.toLowerCase().includes("deepseek-v4") ? { ...variants, max: { parameters: { reasoning_effort: "max" } } } : variants
}

/** SDK option names become native generation fields; credentials never become body parameters. */
function togetheraiOptions(body: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...body }
  const fields: Record<string, string> = { reasoningEffort: "reasoning_effort", topK: "top_k", minP: "min_p", repetitionPenalty: "repetition_penalty", parallelToolCalls: "parallel_tool_calls", responseFormat: "response_format" }
  for (const [sdk, wire] of Object.entries(fields)) if (sdk in parameters) {
    if (!(wire in parameters)) parameters[wire] = parameters[sdk]
    delete parameters[sdk]
  }
  for (const field of ["apiKey", "api_key", "baseURL", "baseUrl", "headers"]) delete parameters[field]
  return parameters
}

export function togetheraiBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...togetheraiOptions(body), stream: true, stream_options: { include_usage: true } }
}

export function createTogetherAIProvider(options: Parameters<typeof createChatCompletionsProvider>[0]) {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key: string): Fetch => (url, init) => {
    togetheraiUrl(url)
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${key}`)
    return doFetch(url, { ...init, headers, redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, togetherai: true })
  return {
    ...adapter,
    async *stream(request: Parameters<typeof adapter.stream>[0]) {
      togetheraiUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error(`[AUTH]: no API key for ${options.id}; set TOGETHER_API_KEY or use providers.set`)
      yield* createChatCompletionsProvider({ ...options, apiKey: () => key, requireKey: true, togetherai: true }).stream({
        ...request,
        parameters: togetheraiOptions(request.parameters ?? {}) as NonNullable<typeof request.parameters>,
        headers: { ...options.headers, ...request.headers },
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => togetheraiBody(await request.transformBody?.(body) ?? body),
      })
    },
    probe: async () => {
      try {
        togetheraiUrl(options.baseUrl)
        const key = await options.apiKey?.()
        if (!key) return false
        return (await guarded(transport, key)(`${options.baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", ...(options.headers ? { headers: options.headers } : {}), signal: AbortSignal.timeout(5_000) })).ok
      } catch { return false }
    },
  }
}
