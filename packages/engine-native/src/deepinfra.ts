import type { ProviderModel, ReasoningEffort } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ResolvedProvider } from "./provider-factory"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

export const isDeepInfra = (provider: { id: string; npm?: string | undefined; deepinfra?: boolean | undefined }) => provider.deepinfra || provider.id === "deepinfra" || provider.npm === "@ai-sdk/deepinfra"

/** v2 takes the wire root; v1 SDK baseURL takes the root before /openai. */
export function deepinfraBaseUrl(value: string, sdkRoot = false) {
  const url = outboundEndpoint(value, "DeepInfra")
  const root = url.href.replace(/\/+$/, "")
  return sdkRoot && !url.pathname.replace(/\/+$/, "").endsWith("/openai") ? `${root}/openai` : root
}

/** v1 exposes effort variants only for reasoning models. */
export function deepinfraVariants(model: ProviderModel): NonNullable<ProviderModel["variants"]> {
  if (model.effort === false || model.reasoning === false || !(model.effort || model.reasoning)) return {}
  const id = model.id.toLowerCase()
  if (/(deepseek-(chat|reasoner|r1|v3)|minimax|kimi|k2p|qwen|big-pickle)/.test(id) || id.includes("glm") && !/glm-(5\.2|5-2|5p2)/.test(id)) return {}
  if (id.includes("grok") && !id.includes("grok-3-mini")) return {}
  let efforts = id.includes("grok-3-mini") ? ["low", "high"] : ["low", "medium", "high"]
  if (id.includes("gpt")) {
    const gpt5 = /(?:^|\/)gpt-5(?:[.-]|$)/.test(id)
    const version = Number(/(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/.exec(id)?.[1])
    if (gpt5 && id.includes("-chat")) efforts = version ? ["medium"] : []
    else if (/(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/.test(id)) efforts = ["high"]
    else if (gpt5 && id.includes("codex")) efforts = [...(version >= 3 ? ["none"] : []), "low", "medium", "high", ...(version >= 2 || id.includes("codex-max") ? ["xhigh"] : [])]
    else if (/(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/.test(id)) efforts = ["medium", "high", "xhigh"]
    else efforts = ["none", ...(version ? [] : ["minimal"]), "low", "medium", "high", ...(version !== 1 ? ["xhigh"] : []), ...(version >= 6 ? ["max"] : [])]
  } else if (id.includes("deepseek-v4")) efforts.push("max")
  return Object.fromEntries(efforts.map((effort) => [effort, { ...(effort !== "max" ? { effort: effort as ReasoningEffort } : {}), parameters: { reasoning_effort: effort } }]))
}

export function deepinfraHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(headers)
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

/** Use v2's streaming/tool transport; translate SDK generation options at its boundary. */
export function createDeepInfraProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const transport: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    deepinfraBaseUrl(url)
    const token = key ?? provider.apiKey()
    if (!token) throw new Error(`[AUTH]: no API key for ${provider.id}; set DEEPINFRA_API_KEY or use providers.set`)
    return doFetch(url, { ...init, headers: deepinfraHeaders(init.headers, token), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({
    id: provider.id,
    model: provider.models[0]?.id ?? "",
    baseUrl: deepinfraBaseUrl(provider.baseUrl),
    apiKey: provider.apiKey,
    requireKey: true,
    fetch: guarded(transport),
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    takesImages: (id) => {
      const model = provider.models.find((model) => model.id === id)
      return model?.images !== false && (!model?.modalities || model.modalities.input.includes("image"))
    },
  })
  const fields: Record<string, string> = { reasoningEffort: "reasoning_effort", minP: "min_p", topK: "top_k", repetitionPenalty: "repetition_penalty", parallelToolCalls: "parallel_tool_calls", responseFormat: "response_format" }
  return { ...adapter, async *stream(request) {
    const key = provider.apiKey()
    if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set DEEPINFRA_API_KEY or use providers.set`)
    const parameters = { ...request.parameters }
    for (const [sdk, wire] of Object.entries(fields)) if (sdk in parameters) {
      if (!(wire in parameters)) parameters[wire] = parameters[sdk]!
      delete parameters[sdk]
    }
    yield* adapter.stream({
      ...request,
      parameters,
      headers: Object.fromEntries(deepinfraHeaders({ ...provider.headers, ...request.headers }, key)),
      fetch: guarded(request.fetch ?? transport, key),
      transformBody: async (body) => {
        const transformed: Record<string, unknown> = { ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }
        if (request.maxOutputTokens) for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) if (field in transformed) transformed[field] = Math.min(typeof transformed[field] === "number" && transformed[field] > 0 ? transformed[field] : request.maxOutputTokens, request.maxOutputTokens)
        return transformed
      },
    })
  } }
}
