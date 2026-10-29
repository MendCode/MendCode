import { createResponsesProvider, toResponsesInput } from "./openai-responses"
import { RetryableProviderError, type ModelProvider, type ModelRequest } from "./provider"
import { scrub, type Fetch } from "./provider-http"
import type { ResolvedProvider } from "./provider-factory"
import { withoutUnsupportedImages } from "./history"

/** xAI uses Responses, with the system prompt in input and no OpenAI cache/summary fields. */
export function xaiBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("xAI endpoint requires HTTPS or loopback HTTP without credentials, query or fragment")
  return value.replace(/\/+$/, "")
}

export function xaiVariants(model: string): NonNullable<import("@mendcode/protocol").ProviderModel["variants"]> {
  return model.includes("grok-3-mini") ? { low: { effort: "low" }, high: { effort: "high" } } : {}
}

function xaiBody(body: Record<string, unknown>, request: ModelRequest, provider: string, model: string) {
  const input = request.messages.flatMap((message) => [
    ...(message.role === "assistant" && message.reasoning?.provider === provider && message.reasoning.model === model ? message.reasoning.blocks : []),
    ...toResponsesInput([message]),
  ])
  const out: Record<string, unknown> = { ...body, input: [...(request.system ? [{ role: "system", content: request.system }] : []), ...input] }
  delete out.instructions
  delete out.prompt_cache_key
  delete out.parallel_tool_calls
  const parameters = request.parameters ?? {}
  const effort = parameters.reasoningEffort ?? (body.reasoning as { effort?: unknown } | undefined)?.effort
  if (effort !== undefined) {
    if (model.includes("grok-3-mini") && effort !== "low" && effort !== "high") throw new Error("Grok 3 Mini reasoning effort must be low or high")
    out.reasoning = { effort }
  }
  delete out.reasoningEffort
  if (parameters.topLogprobs !== undefined) {
    out.top_logprobs = parameters.topLogprobs
    out.logprobs = true
  }
  delete out.topLogprobs
  if (parameters.previousResponseId !== undefined) out.previous_response_id = parameters.previousResponseId
  delete out.previousResponseId
  const include = Array.isArray(parameters.include) ? parameters.include.filter((entry): entry is string => typeof entry === "string") : []
  return { ...out, store: false, include: [...new Set([...include, "reasoning.encrypted_content"])] }
}

export function createXaiProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const baseUrl = xaiBaseUrl(provider.baseUrl)
  const adapter = createResponsesProvider({
    id: provider.id, model: provider.models[0]?.id ?? "", baseUrl,
    headers: async () => {
      const key = provider.apiKey()
      if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set XAI_API_KEY or use providers.set`)
      return { ...provider.headers, authorization: `Bearer ${key}` }
    },
    ...(input.fetch ? { fetch: input.fetch } : {}),
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    routingHeader: false, hostedTools: [], authHint: "rejected the API key (check it with providers.set)",
    usageInputIncludesCache: "auto", reasoningState: true,
    takesImages: (model) => {
      const entry = provider.models.find((entry) => entry.id === model)
      return entry?.images !== false && (!entry?.modalities || entry.modalities.input.includes("image"))
    },
  })
  return {
    id: adapter.id, model: adapter.model,
    ...(adapter.cacheBinding ? { cacheBinding: adapter.cacheBinding } : {}),
    async *stream(request) {
      const model = request.model ?? adapter.model
      const doFetch = request.fetch ?? input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
      const metadata = provider.models.find((entry) => entry.id === model)
      const replay = { ...request, messages: withoutUnsupportedImages(request.messages, metadata?.images !== false && (!metadata?.modalities || metadata.modalities.input.includes("image"))) }
      const { cacheKeyForBody: _cacheKey, ...stateless } = replay
      try {
        yield* adapter.stream({
          ...stateless, model,
          // xAI caches automatically; OpenAI's cache key is not part of its Responses contract.
          fetch: (url, init) => doFetch(url, { ...init, redirect: "error" }),
          transformBody: async (body) => {
            const configured = xaiBody(body, replay, provider.id, model)
            return await request.transformBody?.(configured) ?? configured
          },
        })
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [provider.apiKey() ?? ""])
        if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
        throw new Error(message)
      }
    },
  }
}
