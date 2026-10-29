import { modelParameters } from "./model-parameters"
import { cacheHash } from "./cache-policy"
import type { ReasoningEffort } from "@mendcode/protocol"
import { argsObject, orderedParts, pairToolCalls, withoutUnsupportedImages } from "./history"
import { probeUrl } from "./network-wait"
import { MAX_SILENT_STREAM_BYTES, MAX_TOOL_ARGUMENT_CHARS, argumentGuard, sseData } from "./openai-responses"
import { RetryableProviderError, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest, type ToolSpec } from "./provider"
import { guardedStream, joinUrl, parseToolArgs, postStream, scrub, type Fetch, type Watchdog } from "./provider-http"
import { perplexityBody, perplexitySources, perplexityUrl } from "./perplexity"
import { zenmuxReasoning, zenmuxReasoningStream } from "./zenmux-reasoning"

/**
 * How a provider wants the reasoning effort: OpenAI's `reasoning_effort` string, OpenRouter's `reasoning: { effort }`
 * object, or DeepSeek's own API, which takes `reasoning_effort` together with `thinking: { type: "enabled" }` and turns
 * thinking off with `thinking: { type: "disabled" }` (what OpenCode sends it).
 */
export type ReasoningStyle = "reasoning_effort" | "reasoning-object" | "deepseek"

type WireMessage = Record<string, unknown>

/** Neutral history → Chat Completions messages (system first, tool results as `tool` messages after their assistant message). */
export function toChatMessages(system: string, messages: readonly ModelMessage[], zenmuxModel?: string): WireMessage[] {
  const wire: WireMessage[] = []
  if (system.trim()) wire.push({ role: "system", content: system })
  for (const message of pairToolCalls(messages)) {
    if (message.role === "user") {
      const images = message.images ?? []
      const documents = message.documents ?? []
      // Inline attachment tokens: the media sits where its token stands in the sentence.
      const ordered = orderedParts(message)
      wire.push({
        role: "user",
        content: ordered
          ? ordered.map((part) => (part.type === "text" ? { type: "text", text: part.text } : part.type === "image" ? { type: "image_url", image_url: { url: `data:${part.image.mime};base64,${part.image.base64}` } } : { type: "file", file: { filename: part.document.name, file_data: `data:${part.document.mime};base64,${part.document.base64}` } }))
          : images.length || documents.length
          ? [{ type: "text", text: message.content || "(attachment)" }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } })), ...documents.map((file) => ({ type: "file", file: { filename: file.name, file_data: `data:${file.mime};base64,${file.base64}` } }))]
          : message.content || "(empty message)",
      })
    } else if (message.role === "assistant") {
      if (!message.content && message.toolCalls.length === 0) continue
      wire.push({
        role: "assistant",
        content: message.content || (message.toolCalls.length ? null : ""),
        ...(zenmuxModel ? zenmuxReasoning(message.reasoning, zenmuxModel) : {}),
        ...(message.toolCalls.length
          ? { tool_calls: message.toolCalls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: JSON.stringify(argsObject(call.args)) } })) }
          : {}),
      })
    } else wire.push({ role: "tool", tool_call_id: message.callId, content: message.output || "(no output)" })
  }
  return wire
}

function toChatTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}

type Usage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  /** DeepSeek's cache counters. */
  prompt_cache_hit_tokens?: number
  /** OpenRouter's price of the call in credits (USD). */
  cost?: number | { total_cost?: number }
  reasoning_tokens?: number
  total_cost?: number
  /** DeepInfra's estimated price of the call in USD. */
  estimated_cost?: number
  /** TogetherAI also reports cache reads at the top level. */
  cached_tokens?: number
}

type Chunk = {
  choices?: Array<{
    delta?: {
      content?: string | null | Array<{ type: string; text?: string; thinking?: Array<{ type: string; text?: string }> }>
      reasoning_content?: string | null
      reasoning?: string | null
      reasoning_details?: unknown
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: Usage | null
  citations?: unknown
  search_results?: unknown
  error?: { message?: string; code?: number | string; type?: string }
}

function neutralUsage(usage: Usage, gateway = false, togetherai = false) {
  // Hosts report cache reads under their own name: `prompt_tokens_details.cached_tokens` (OpenAI, GLM/z.ai, OpenRouter),
  // `prompt_cache_hit_tokens` (DeepSeek, which may send both) or a top-level `cached_tokens` (TogetherAI). The first one that
  // reports a read wins (so a zero in one place does not hide a read in another), never more than the prompt.
  const reported = [usage.prompt_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens, togetherai ? usage.cached_tokens : undefined].find((value) => typeof value === "number" && value > 0) ?? 0
  const cached = usage.prompt_tokens === undefined ? reported : Math.min(reported, usage.prompt_tokens)
  const cacheWrite = gateway ? usage.prompt_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens ?? 0 : 0
  const output = usage.completion_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? (gateway || togetherai ? usage.reasoning_tokens : undefined) ?? 0
  const cost = (typeof usage.cost === "object" ? usage.cost.total_cost : usage.cost) ?? usage.total_cost ?? usage.estimated_cost
  const costMicros = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost === 0 ? 0 : Math.max(1, Math.round(cost * 1_000_000)) : undefined
  return { input: Math.max(0, (usage.prompt_tokens ?? 0) - cached - cacheWrite), output, reasoning, cacheRead: cached, cacheWrite, ...(costMicros !== undefined ? { costMicros } : {}) }
}

/**
 * Chat Completions adapter (streaming) for OpenRouter, AI gateways, Groq, DeepSeek and local servers (Ollama, LM Studio).
 * The key, when the host needs one, is read through `apiKey()` per request and scrubbed from anything that can be shown.
 */
export function createChatCompletionsProvider(options: {
  id: string
  model: string
  baseUrl: string
  /** Undefined for hosts without auth (local servers). */
  apiKey?(): string | undefined | Promise<string | undefined>
  /** Require a key: a missing one is an `[AUTH]` error instead of an anonymous request. */
  requireKey?: boolean
  headers?: Record<string, string>
  reasoningStyle?: ReasoningStyle
  /** The levels the model's catalog entry lists, when it lists them: a level named there goes to the host as named. */
  reasoningLevels?(model: string): readonly ReasoningEffort[] | undefined
  fetch?: Fetch
  idleTimeoutMs?: number
  takesImages?(model: string): boolean
  contentParts?: boolean
  sonar?: boolean
  togetherai?: boolean
}): ModelProvider {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const url = joinUrl(options.baseUrl, "/chat/completions")
  return {
    id: options.id,
    model: options.model,
    async cacheBinding(model) {
      const key = await options.apiKey?.()
      return { provider: options.id, model: model ?? options.model, endpoint: options.baseUrl, auth: key ? "api" : "unknown", transport: "chat", ...(key ? { account: cacheHash(key) } : {}) }
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      if (options.sonar) perplexityUrl(options.baseUrl)
      const model = request.model ?? options.model
      const key = await options.apiKey?.()
      if (!key && !request.headers?.authorization && options.requireKey) throw new Error(`[AUTH]: no API key for ${options.id}; set it with providers.set or the provider's environment variable`)
      const secrets = [...(key ? [key] : []), ...Object.values(request.headers ?? {})]
      const messages = withoutUnsupportedImages([...request.messages], options.takesImages?.(model) ?? true)
      const effort = request.effort && request.effort !== "minimal" ? request.effort : undefined
      const built: Record<string, unknown> = {
        model,
        messages: toChatMessages(request.system, messages, options.id === "zenmux" ? model : undefined),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.id === "openrouter" && options.baseUrl.replace(/\/+$/, "") === "https://openrouter.ai/api/v1" && key && request.cacheMode === "smart" && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(request.tools.length ? { tools: toChatTools(request.tools), tool_choice: "auto" } : {}),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(effort ? reasoningParameter(effort, options.reasoningStyle ?? "reasoning_effort", options.reasoningLevels?.(model)) : {}),
      }
      const configured = modelParameters(built, request)
      const transformed = (await request.transformBody?.(configured)) ?? configured
      const body = options.sonar ? perplexityBody(transformed) : transformed
      const keyForBody = request.cacheKeyForBody?.(body)
      if (options.id === "openrouter" && request.cacheKeyForBody) { if (keyForBody) body.prompt_cache_key = keyForBody; else delete body.prompt_cache_key }
      if (request.cacheMode === "off") delete body.prompt_cache_key
      yield* guardedStream({
        providerId: options.id,
        signal: request.signal,
        ...(options.idleTimeoutMs !== undefined ? { idleMs: options.idleTimeoutMs } : {}),
        run: async function* ({ watchdog, progress }) {
          const response = await postStream({
            providerId: options.id,
            url,
            headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...options.headers, ...request.headers },
            body,
            doFetch: options.sonar ? (url, init) => (request.fetch ?? doFetch)(url, { ...init, redirect: "error" }) : request.fetch ?? doFetch,
            watchdog,
            secrets,
          })
          if (!response) return
          yield* readStream({ response, watchdog, progress, providerId: options.id, secrets, contentParts: options.contentParts, sonar: options.sonar, togetherai: options.togetherai, model })
        },
      })
    },
    probe: () => {
      if (options.sonar) try { perplexityUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return probeUrl({ url, fetch: doFetch })
    },
  }
}

export function reasoningParameter(effort: ReasoningEffort, style: ReasoningStyle, levels?: readonly ReasoningEffort[]): Record<string, unknown> {
  // `xhigh` is OpenAI's own level: a host that does not list it gets `high`. `max` and `none` are offered only where a
  // catalog or the host's protocol names them, so they go as named.
  const level = effort === "xhigh" && !levels?.includes("xhigh") ? "high" : effort
  if (style === "deepseek") return level === "none" ? { thinking: { type: "disabled" } } : { reasoning_effort: level, thinking: { type: "enabled" } }
  return style === "reasoning-object" ? { reasoning: { effort: level } } : { reasoning_effort: level }
}

/** The SSE chunks of one Chat Completions response as neutral events. */
async function* readStream(input: { response: Response; watchdog: Watchdog; progress: { silentBytes: number }; providerId: string; secrets: readonly string[]; contentParts?: boolean | undefined; sonar?: boolean | undefined; togetherai?: boolean | undefined; model: string }): AsyncIterable<ModelEvent> {
  const { watchdog, providerId } = input
  const { signal } = watchdog
  const calls = new Map<number, { id: string; name: string; args: string }>()
  const guard = argumentGuard()
  let finish: string | undefined
  let emittedCalls = false
  let usage: Usage | undefined
  const sources = input.sonar ? perplexitySources() : undefined
  const signed = providerId === "zenmux" ? zenmuxReasoningStream(input.model) : undefined
  const runaway = (why: string) => new RetryableProviderError(`[PROVIDER]: ${providerId} ${why}, stream abandoned`)
  const onChunk = (bytes: number) => {
    watchdog.touch()
    input.progress.silentBytes += bytes
  }
  /** Tool calls are complete once the model's finish reason arrives; they leave in the order the model started them. */
  function* flushCalls(): Generator<ModelEvent> {
    if (emittedCalls) return
    emittedCalls = true
    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue
      yield { type: "tool_call", call: { callId: call.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: call.name, args: parseToolArgs(call.args) } }
    }
  }
  const end = function* (): Generator<ModelEvent> {
    const references = sources?.text(input.secrets)
    if (references) yield { type: "text", delta: references }
    yield* flushCalls()
    if (usage) yield { type: "usage", usage: neutralUsage(usage, ["llmgateway", "zenmux", "kilo", "cloudflare-ai-gateway"].includes(providerId), input.togetherai) }
    const reasoning = signed?.state()
    if (reasoning) yield { type: "reasoning_state", state: reasoning }
    const sawToolCall = [...calls.values()].some((call) => call.name)
    yield { type: "finish", reason: finish === "length" ? "length" : finish === "tool_calls" || finish === "function_call" || sawToolCall ? "tool_calls" : "stop" }
  }
  for await (const data of sseData(input.response.body!, signal, onChunk)) {
    if (data === "[DONE]") {
      if (finish === undefined) break
      yield* end()
      return
    }
    if (input.progress.silentBytes > MAX_SILENT_STREAM_BYTES) throw runaway(`${Math.round(input.progress.silentBytes / 1024)} KB without output`)
    let chunk: Chunk
    try {
      chunk = JSON.parse(data) as Chunk
    } catch {
      continue
    }
    if (chunk.error) {
      const code = Number(chunk.error.code)
      const message = scrub(`[PROVIDER]: ${providerId} ${chunk.error.message ?? chunk.error.type ?? "stream failed"}`, input.secrets)
      if (code === 408 || code === 429 || code >= 500 || chunk.error.type === "overloaded_error") throw new RetryableProviderError(message)
      throw new Error(message)
    }
    sources?.update(chunk)
    if (chunk.usage) {
      const raw = chunk.usage
      const cost = typeof raw.cost === "object" ? raw.cost?.total_cost : raw.cost ?? raw.total_cost
      const reasoning = raw.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens
      usage = input.sonar ? { ...raw, ...(cost !== undefined ? { cost } : {}), completion_tokens_details: { ...raw.completion_tokens_details, ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}) } } : raw
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      if (input.sonar && (delta?.tool_calls?.length || choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call")) throw new Error("[PROVIDER]: Perplexity Sonar does not support client tool calls")
      if (typeof delta?.content === "string" && delta.content) yield { type: "text", delta: delta.content }
      else if (input.contentParts && Array.isArray(delta?.content)) for (const part of delta.content) {
        if (part.type === "text" && part.text) yield { type: "text", delta: part.text }
        if (part.type === "thinking") for (const thought of part.thinking ?? []) if (thought.type === "text" && thought.text) yield { type: "reasoning", delta: thought.text }
      }
      const thought = delta?.reasoning_content || delta?.reasoning
      if (thought) yield { type: "reasoning", delta: thought }
      signed?.add(thought, delta?.reasoning_details)
      for (const part of delta?.tool_calls ?? []) {
        let index = part.index ?? 0
        // Some local servers number every call 0; a different id at a taken index is a new call.
        const taken = calls.get(index)
        if (taken?.id && part.id && taken.id !== part.id) index = Math.max(...calls.keys()) + 1
        const call = calls.get(index) ?? { id: "", name: "", args: "" }
        calls.set(index, call)
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) {
          const why = guard(String(index), part.function.arguments)
          if (why) throw runaway(why)
          call.args += part.function.arguments
          if (call.args.length > MAX_TOOL_ARGUMENT_CHARS) throw runaway(`tool call arguments passed ${MAX_TOOL_ARGUMENT_CHARS} chars`)
          input.progress.silentBytes = 0
          if (call.id && call.name) yield { type: "tool_input", callId: call.id, name: call.name, delta: part.function.arguments }
        }
      }
      if (choice.finish_reason) {
        finish = choice.finish_reason
        // Calls leave as soon as they are whole; usage follows in its own chunk, so keep reading for it.
        yield* flushCalls()
      }
    }
  }
  // Some servers close the stream after the last chunk without a [DONE] line; a finish reason means the answer was complete.
  if (finish !== undefined) {
    yield* end()
    return
  }
  if (!signal.aborted) throw new RetryableProviderError(`[PROVIDER]: ${providerId} stream ended without completion`)
}
