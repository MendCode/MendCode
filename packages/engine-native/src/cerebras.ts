import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import { deepinfraVariants } from "./deepinfra"
import type { ProviderModel } from "@mendcode/protocol"
import type { ResolvedProvider } from "./provider-factory"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

export const isCerebras = (provider: { id: string; npm?: string | undefined; cerebras?: boolean | undefined }) => provider.cerebras || provider.id === "cerebras" || provider.npm === "@ai-sdk/cerebras"
// v1 groups Cerebras and DeepInfra under the same model-family variant rules.
export const cerebrasVariants = (model: ProviderModel): NonNullable<ProviderModel["variants"]> => Object.fromEntries(Object.entries(deepinfraVariants(model)).map(([name, variant]) => {
  // `none` is a named wire variant, outside v2's shared effort enum.
  const { effort, ...fields } = variant
  return [name, { ...fields, ...(name !== "none" && effort ? { effort } : {}) }]
}))

export const cerebrasUrl = (value: string): string => outboundEndpoint(value, "Cerebras").href.replace(/\/+$/, "")

export function cerebrasHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(headers)
  if (!merged.has("X-Cerebras-3rd-Party-Integration")) merged.set("X-Cerebras-3rd-Party-Integration", "opencode")
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

export function cerebrasParameters(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body }
  const aliases: Record<string, string> = { reasoningEffort: "reasoning_effort", parallelToolCalls: "parallel_tool_calls", topLogprobs: "top_logprobs", logitBias: "logit_bias", serviceTier: "service_tier", reasoningFormat: "reasoning_format", promptCacheKey: "prompt_cache_key", responseFormat: "response_format" }
  for (const [sdk, wire] of Object.entries(aliases)) if (sdk in result) {
    if (!(wire in result)) result[wire] = result[sdk]
    delete result[sdk]
  }
  return result
}

/** Cerebras returns usage in its final SSE chunk without OpenAI's stream_options. */
export function cerebrasBody(body: Record<string, unknown>, limit?: number): Record<string, unknown> {
  const result = cerebrasParameters(body)
  const caps = [result.max_completion_tokens, result.max_tokens, result.max_output_tokens, limit].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
  if (caps.length) result.max_completion_tokens = Math.min(...caps)
  delete result.max_tokens
  delete result.max_output_tokens
  delete result.stream_options
  result.stream = true
  return result
}

export function createCerebrasProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const transport: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const guarded = (doFetch: Fetch, token?: string): Fetch => (url, init) => {
    cerebrasUrl(url)
    const key = token ?? provider.apiKey()
    if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set CEREBRAS_API_KEY or use providers.set`)
    return doFetch(url, { ...init, headers: cerebrasHeaders(init.headers, key), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({
    id: provider.id,
    model: provider.models[0]?.id ?? "",
    baseUrl: cerebrasUrl(provider.baseUrl),
    apiKey: provider.apiKey,
    requireKey: true,
    fetch: guarded(transport),
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    takesImages: (id) => {
      const model = provider.models.find((model) => model.id === id)
      return model?.images === true || model?.modalities?.input.includes("image") === true
    },
  })
  return { ...adapter, async *stream(request) {
    const key = provider.apiKey()
    if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set CEREBRAS_API_KEY or use providers.set`)
    yield* adapter.stream({
      ...request,
      parameters: { ...(request.effort ? { reasoning_effort: request.effort } : {}), ...cerebrasParameters(request.parameters ?? {}) } as NonNullable<typeof request.parameters>,
      headers: Object.fromEntries(cerebrasHeaders({ ...provider.headers, ...request.headers }, key)),
      fetch: guarded(request.fetch ?? transport, key),
      transformBody: async (body) => cerebrasBody(await request.transformBody?.(body) ?? body, request.maxOutputTokens),
    })
  } }
}
