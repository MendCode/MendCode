import type { ProviderModel } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { pairToolCalls, withoutUnsupportedImages } from "./history"
import { MAX_SILENT_STREAM_BYTES, MAX_TOOL_ARGUMENT_CHARS, sseData } from "./openai-responses"
import { guardedStream, httpFailure, joinUrl, parseToolArgs, postStream, scrub, type Fetch } from "./provider-http"
import { RetryableProviderError, type ModelEvent, type ModelMessage, type ModelProvider } from "./provider"
import type { ResolvedProvider } from "./provider-factory"

export const isCohere = (provider: { id: string; type?: string | undefined; npm?: string | undefined }) => provider.id === "cohere" || provider.type === "cohere" || provider.npm === "@ai-sdk/cohere"

export const cohereUrl = (value: string): string => outboundEndpoint(value, "Cohere").href.replace(/\/+$/, "")

export function cohereHeaders(headers: HeadersInit | undefined, key: string): Record<string, string> {
  const result = new Headers(headers)
  result.set("authorization", `Bearer ${key}`)
  return Object.fromEntries(result)
}

export function toCohereMessages(messages: ModelMessage[], system: string, images: boolean): Record<string, unknown>[] {
  return [
    ...(system.trim() ? [{ role: "system", content: system }] : []),
    ...pairToolCalls(withoutUnsupportedImages(messages, images)).map((message): Record<string, unknown> => {
      if (message.role === "user") return { role: "user", content: message.images?.length ? [{ type: "text", text: message.content }, ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }))] : message.content }
      if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.output }
      return { role: "assistant", ...(message.content ? { content: message.content } : {}), ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}) }
    }),
  ]
}

/** v1's SDK options translated to native Cohere fields; conversation/auth cannot be generation options. */
export function cohereParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const aliases: Record<string, string> = { topP: "p", top_p: "p", topK: "k", top_k: "k", maxOutputTokens: "max_tokens", max_output_tokens: "max_tokens", max_completion_tokens: "max_tokens", stopSequences: "stop_sequences", stop: "stop_sequences", frequencyPenalty: "frequency_penalty", presencePenalty: "presence_penalty", responseFormat: "response_format", toolChoice: "tool_choice", safetyMode: "safety_mode" }
  const allowed = new Set(["temperature", "p", "k", "max_tokens", "stop_sequences", "seed", "frequency_penalty", "presence_penalty", "response_format", "tool_choice", "safety_mode", "strict_tools", "thinking", "logprobs"])
  return Object.fromEntries(Object.entries(parameters).flatMap(([name, value]) => {
    const key = aliases[name] ?? name
    return allowed.has(key) && (key === name || !(key in parameters)) ? [[key, value]] : []
  }))
}

type Chunk = {
  type?: string
  index?: number
  delta?: {
    message?: { content?: { text?: string; thinking?: string }; tool_plan?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } } }
    finish_reason?: string
    usage?: { tokens?: { input_tokens?: number; output_tokens?: number }; billed_units?: { input_tokens?: number; output_tokens?: number } }
  }
  message?: string
}
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** Native /v2/chat SSE, behind an explicitly enabled authenticated local proxy. */
export function createCohereProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const baseUrl = cohereUrl(provider.baseUrl)
  const transport: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  return {
    id: provider.id,
    model: provider.models[0]?.id ?? "",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.signal.aborted) return
      const key = provider.apiKey()
      if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set COHERE_API_KEY or use providers.set`)
      const model = request.model ?? provider.models[0]?.id ?? ""
      const metadata = provider.models.find((entry) => entry.id === model)
      const built: Record<string, unknown> = {
        ...cohereParameters(request.parameters ?? {}),
        model,
        messages: toCohereMessages(request.messages, request.system, metadata?.images === true || metadata?.modalities?.input.includes("image") === true),
        ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
        stream: true,
      }
      const body = await request.transformBody?.(built) ?? built
      if (request.signal.aborted) return
      const caps = [body.max_tokens, request.maxOutputTokens, metadata?.outputLimit ?? metadata?.limit?.output].filter((value): value is number => typeof value === "number" && value > 0 && Number.isFinite(value))
      if (caps.length) body.max_tokens = Math.min(...caps)
      body.stream = true
      const doFetch: Fetch = (url, init) => {
        cohereUrl(url)
        return (request.fetch ?? transport)(url, { ...init, headers: cohereHeaders(init.headers, key), redirect: "error" })
      }
      yield* guardedStream({
        providerId: provider.id,
        signal: request.signal,
        idleMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
        run: async function* ({ watchdog, progress }) {
          const invalid = () => new RetryableProviderError(`[PROVIDER]: ${provider.id} invalid or unfinished Cohere stream`)
          try {
            const response = await postStream({ providerId: provider.id, url: joinUrl(baseUrl, "/chat"), headers: cohereHeaders({ ...provider.headers, ...request.headers }, key), body, doFetch, watchdog, secrets: [key] })
            if (!response) return
            const calls = new Map<number, { callId: string; name: string; args: string; ended: boolean }>()
            let totalArgs = 0
            for await (const data of sseData(response.body!, watchdog.signal, (bytes) => { watchdog.touch(); progress.silentBytes += bytes })) {
              if (watchdog.signal.aborted) return
              if (progress.silentBytes > MAX_SILENT_STREAM_BYTES) throw invalid()
              let chunk: Chunk
              try { chunk = JSON.parse(data) as Chunk } catch { throw invalid() }
              if (!chunk || typeof chunk !== "object" || typeof chunk.type !== "string") throw invalid()
              if (chunk.type === "error") throw new Error(`[PROVIDER]: ${provider.id} ${scrub(chunk.message ?? "Cohere stream error", [key])}`)
              const delta = chunk.delta?.message
              if (chunk.type === "content-delta") {
                if (typeof delta?.content?.thinking === "string") yield { type: "reasoning", delta: delta.content.thinking }
                else if (typeof delta?.content?.text === "string") yield { type: "text", delta: delta.content.text }
                else throw invalid()
              }
              if (chunk.type === "tool-plan-delta" && typeof delta?.tool_plan === "string") yield { type: "text", delta: delta.tool_plan }
              if (chunk.type === "tool-call-start" || chunk.type === "tool-call-delta" || chunk.type === "tool-call-end") {
                const index = chunk.index
                if (!Number.isInteger(index) || index! < 0 || index! > 1023) throw invalid()
                if (chunk.type === "tool-call-start") {
                  const call = delta?.tool_calls
                  if (!call?.id || call.id.length > 256 || !call.function?.name || call.function.name.length > 256 || calls.has(index!) || [...calls.values()].some((entry) => entry.callId === call.id)) throw invalid()
                  calls.set(index!, { callId: call.id, name: call.function.name, args: "", ended: false })
                }
                const call = calls.get(index!)
                if (!call || call.ended) throw invalid()
                const args = delta?.tool_calls?.function?.arguments
                if (args !== undefined) {
                  if (typeof args !== "string") throw invalid()
                  totalArgs += args.length
                  if (totalArgs > MAX_TOOL_ARGUMENT_CHARS) throw new Error(`[PROVIDER]: ${provider.id} oversized tool arguments`)
                  call.args += args
                }
                if (chunk.type === "tool-call-end") call.ended = true
              }
              if (chunk.type !== "message-end") continue
              if ([...calls.values()].some((call) => !call.ended)) throw invalid()
              const reason = chunk.delta?.finish_reason
              if (!["COMPLETE", "STOP_SEQUENCE", "MAX_TOKENS", "TOOL_CALL"].includes(reason ?? "")) throw invalid()
              if (reason === "TOOL_CALL" && !calls.size) throw invalid()
              for (const call of calls.values()) yield { type: "tool_call", call: { callId: call.callId, name: call.name, args: call.args.trim() === "null" ? {} : parseToolArgs(call.args) } }
              const usage = chunk.delta?.usage?.tokens ?? chunk.delta?.usage?.billed_units
              if (usage) yield { type: "usage", usage: { input: count(usage.input_tokens), output: count(usage.output_tokens), reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
              yield { type: "finish", reason: reason === "MAX_TOKENS" ? "length" : calls.size || reason === "TOOL_CALL" ? "tool_calls" : "stop" }
              return
            }
            if (!watchdog.signal.aborted) throw invalid()
          } catch (error) {
            if (watchdog.signal.aborted) return
            const message = scrub(error instanceof Error ? error.message : String(error), [key, ...Object.values(provider.headers ?? {}), ...Object.values(request.headers ?? {})])
            if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
            throw new Error(message)
          }
        },
      })
    },
  }
}

/** Cohere lists chat models at /v1/models; one deadline, bounded pages, no non-chat models. */
export async function fetchCohereModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs?: number }): Promise<ProviderModel[]> {
  const { provider } = input
  const baseUrl = cohereUrl(provider.baseUrl).replace(/\/v2$/, "")
  const key = provider.apiKey()
  if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set COHERE_API_KEY or use providers.set`)
  const doFetch = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const signal = AbortSignal.timeout(input.timeoutMs ?? 10_000)
  const models = new Map<string, ProviderModel>()
  const seen = new Set<string>()
  let page: string | undefined
  do {
    const url = new URL(joinUrl(baseUrl, "/v1/models"))
    url.searchParams.set("endpoint", "chat")
    url.searchParams.set("page_size", "400")
    if (page) url.searchParams.set("page_token", page)
    const response = await doFetch(url.href, { method: "GET", headers: cohereHeaders({ accept: "application/json", ...provider.headers }, key), redirect: "error", signal }).catch((error) => { throw new Error(`[PROVIDER]: ${provider.id} ${scrub(String(error), [key])}`) })
    if (!response.ok) throw await httpFailure({ providerId: provider.id, response, secrets: [key] })
    const payload = await response.json().catch(() => undefined) as { models?: unknown; next_page_token?: unknown } | undefined
    if (!Array.isArray(payload?.models)) throw new Error(`[PROVIDER]: ${provider.id} /models answered without a model list`)
    for (const raw of payload.models) {
      if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name || raw.name.length > 66 || raw.is_deprecated || !Array.isArray(raw.endpoints) || !raw.endpoints.includes("chat")) continue
      models.set(raw.name, { id: raw.name, ...(count(raw.context_length) ? { context: count(raw.context_length) } : {}) })
      if (models.size >= 400) break
    }
    page = typeof payload.next_page_token === "string" && payload.next_page_token.length <= 2048 ? payload.next_page_token : undefined
    if (page && seen.has(page)) throw new Error(`[PROVIDER]: ${provider.id} repeated model-list page`)
    if (page) seen.add(page)
  } while (page && models.size < 400 && seen.size < 10)
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}
