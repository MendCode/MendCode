import type { ProviderModel } from "@mendcode/protocol"
import { createChatCompletionsProvider, toChatMessages } from "./openai-compatible"
import { RetryableProviderError, type ModelProvider, type ModelRequest } from "./provider"
import { scrub, type Fetch } from "./provider-http"
import type { ResolvedProvider } from "./provider-factory"
import { withoutUnsupportedImages } from "./history"

export function mistralBaseUrl(value: string) {
  const url = new URL(value)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Mistral endpoint requires HTTPS or loopback HTTP without credentials, query or fragment")
  return value.replace(/\/+$/, "")
}

export function mistralVariants(model: string): NonNullable<ProviderModel["variants"]> {
  return ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5", "mistral-medium-2604"].some((id) => model.includes(id))
    ? { high: { effort: "high", parameters: { reasoningEffort: "high" } } }
    : {}
}

export function mistralModel(raw: Record<string, unknown>): ProviderModel | undefined {
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 66) return undefined
  const capabilities = raw.capabilities as { completion_chat?: boolean; vision?: boolean } | undefined
  if (capabilities?.completion_chat === false || /embed|moderation|ocr|transcrib|audio/.test(raw.id)) return undefined
  const name = typeof raw.name === "string" ? raw.name : undefined
  const context = raw.max_context_length ?? raw.context_length ?? raw.context_window
  const variants = mistralVariants(raw.id)
  return {
    id: raw.id,
    ...(name ? { name: name.slice(0, 100) } : {}),
    ...(typeof context === "number" && Number.isFinite(context) && context > 0 ? { context: Math.floor(context) } : {}),
    ...(typeof capabilities?.vision === "boolean" ? { images: capabilities.vision } : {}),
    effort: Boolean(variants.high), variants,
  }
}

function mistralMessages(request: ModelRequest) {
  const messages = toChatMessages(request.system, request.messages)
  const ids = new Map<string, string>()
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const message of messages) for (const call of message.tool_calls as Array<{ id: string }> ?? [])
    if (/^[a-zA-Z0-9]{9}$/.test(call.id)) used.add(call.id)
  let sequence = 0
  const callId = (original: string) => {
    const existing = ids.get(original)
    if (existing) return existing
    let next = original.replace(/[^a-zA-Z0-9]/g, "").slice(0, 9).padEnd(9, "0")
    if (next !== original && used.has(next)) do { next = (++sequence).toString(36).padStart(9, "0") } while (used.has(next))
    ids.set(original, next)
    used.add(next)
    return next
  }
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === "user") {
      if (wire.at(-1)?.role === "tool") wire.push({ role: "assistant", content: "Done." })
      const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]
      wire.push({ ...message, content: content.map((part) => {
        if (part.type === "image_url") return { type: "image_url", image_url: part.image_url.url }
        if (part.type === "file") return { type: "document_url", document_url: part.file.file_data }
        return part
      }) })
    } else if (message.role === "assistant") {
      const calls = message.tool_calls as Array<{ id: string; function: { name: string } }> | undefined
      wire.push({ ...message, content: message.content ?? "", ...(calls ? { tool_calls: calls.map((call) => {
        names.set(call.id, call.function.name)
        return { ...call, id: callId(call.id) }
      }) } : {}) })
    } else if (message.role === "tool") {
      const original = message.tool_call_id as string
      wire.push({ ...message, tool_call_id: callId(original), name: names.get(original) })
    } else wire.push(message)
  }
  const last = wire.at(-1)
  if (last?.role === "assistant") last.prefix = true
  return wire
}

function mistralBody(body: Record<string, unknown>, request: ModelRequest) {
  const out: Record<string, unknown> = { ...body, messages: mistralMessages(request) }
  const parameters = { ...request.parameters, ...(request.parameters?.mistral as Record<string, unknown> | undefined) }
  for (const name of ["structuredOutputs", "strictJsonSchema"] as const)
    if (parameters[name] !== undefined && typeof parameters[name] !== "boolean") throw new Error(`Invalid Mistral ${name}`)
  for (const [name, field] of [["safePrompt", "safe_prompt"], ["documentImageLimit", "document_image_limit"], ["documentPageLimit", "document_page_limit"], ["parallelToolCalls", "parallel_tool_calls"], ["seed", "random_seed"]] as const) {
    const value = parameters[name] ?? parameters[field]
    if (value === undefined) continue
    const boolean = name === "safePrompt" || name === "parallelToolCalls"
    if (boolean ? typeof value !== "boolean" : typeof value !== "number" || !Number.isSafeInteger(value) || name !== "seed" && value < 0) throw new Error(`Invalid Mistral ${name}`)
    out[field] = value
  }
  const effort = parameters.reasoningEffort ?? parameters.reasoning_effort ?? (request.effort === "high" && mistralVariants(String(body.model)).high ? "high" : undefined)
  if (effort !== undefined && effort !== "high" && effort !== "none") throw new Error("Mistral reasoning effort must be high or none")
  const configured: Record<string, unknown> = out
  delete configured.reasoning_effort
  if (effort !== undefined) configured.reasoning_effort = effort
  const format = parameters.responseFormat as { type?: string; schema?: unknown; name?: string; description?: string } | undefined
  if (format?.type === "json") {
    configured.response_format = format.schema && parameters.structuredOutputs !== false
      ? { type: "json_schema", json_schema: { schema: format.schema, strict: parameters.strictJsonSchema === true, name: format.name ?? "response", ...(format.description ? { description: format.description } : {}) } }
      : { type: "json_object" }
    if (!format.schema) configured.messages = [{ role: "system", content: "Return a JSON object." }, ...out.messages as Record<string, unknown>[]]
  }
  if (!request.tools.length) delete configured.parallel_tool_calls
  for (const field of ["stream_options", "prompt_cache_key", "reasoning", "mistral", "safePrompt", "documentImageLimit", "documentPageLimit", "parallelToolCalls", "seed", "reasoningEffort", "structuredOutputs", "strictJsonSchema", "responseFormat", "topK", "frequencyPenalty", "presencePenalty", "stopSequences"]) delete configured[field]
  return configured
}

export function createMistralProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const adapter = createChatCompletionsProvider({
    id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: mistralBaseUrl(provider.baseUrl),
    apiKey: provider.apiKey, requireKey: true, contentParts: true,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    takesImages: (model) => provider.models.find((entry) => entry.id === model)?.images !== false,
  })
  return {
    id: adapter.id, model: adapter.model,
    ...(adapter.cacheBinding ? { cacheBinding: adapter.cacheBinding } : {}),
    async *stream(request) {
      const key = provider.apiKey()
      if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set MISTRAL_API_KEY or use providers.set`)
      const doFetch = request.fetch ?? input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
      const configuredHeaders = { ...provider.headers, ...request.headers }
      const headers = { ...Object.fromEntries(Object.entries(configuredHeaders).filter(([name]) => name.toLowerCase() !== "authorization")), authorization: `Bearer ${key}` }
      const metadata = provider.models.find((entry) => entry.id === (request.model ?? adapter.model))
      const replay = { ...request, messages: withoutUnsupportedImages(request.messages, metadata?.images !== false && (!metadata?.modalities || metadata.modalities.input.includes("image"))) }
      try {
        yield* adapter.stream({
          ...replay, headers,
          fetch: (url, init) => doFetch(url, { ...init, redirect: "error" }),
          transformBody: async (body) => {
            const configured = mistralBody(body, replay)
            return await request.transformBody?.(configured) ?? configured
          },
        })
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [key, ...Object.values(headers)])
        if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
        throw new Error(message)
      }
    },
  }
}
