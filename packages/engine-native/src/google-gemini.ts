import { outboundEndpoint } from "./endpoint-policy"
import { argsObject, orderedParts, pairToolCalls, withoutUnsupportedImages } from "./history"
import { MAX_SILENT_STREAM_BYTES, MAX_TOOL_ARGUMENT_CHARS, sseData } from "./openai-responses"
import { guardedStream, httpFailure, joinUrl, postStream, scrub, type Fetch, type Watchdog } from "./provider-http"
import { probeUrl } from "./network-wait"
import { RetryableProviderError, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "./provider"

type Part = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: unknown }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
}
type Content = { role: "user" | "model"; parts: Part[] }
type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number }
type Chunk = {
  candidates?: { index?: number; content?: { parts?: Part[] }; finishReason?: string }[]
  usageMetadata?: Usage
  promptFeedback?: { blockReason?: string }
  error?: { code?: number; message?: string; status?: string }
}

/** Signed parts are replayed intact, in order, only to the model that produced them. */
export function toGeminiContents(messages: readonly ModelMessage[], model: string, providerId = "google"): Content[] {
  const contents: Content[] = []
  const wireIds = new Map<string, string | undefined>()
  const push = (role: Content["role"], parts: Part[]) => {
    if (!parts.length) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  for (const message of pairToolCalls(messages)) {
    if (message.role === "user") {
      // Inline attachment tokens: the media sits where its token stands in the sentence.
      const ordered = orderedParts(message)
      if (ordered) push("user", ordered.map((part): Part => (part.type === "text" ? { text: part.text } : { inlineData: { mimeType: part.type === "image" ? part.image.mime : part.document.mime, data: part.type === "image" ? part.image.base64 : part.document.base64 } })))
      else push("user", [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mime, data: image.base64 } })),
        ...(message.documents ?? []).map((file) => ({ inlineData: { mimeType: file.mime, data: file.base64 } })),
      ])
    } else if (message.role === "assistant") {
      const replay = message.reasoning?.provider === providerId && message.reasoning.model === model ? message.reasoning.blocks as Part[] : undefined
      const replayCalls = replay?.filter((part) => part.functionCall)
      message.toolCalls.forEach((call, index) => wireIds.set(call.callId, replayCalls?.length ? replayCalls[index]?.functionCall?.id : call.callId))
      push("model", replay?.length ? replay : [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          functionCall: { id: call.callId, name: call.name, args: argsObject(call.args) },
          // Google's documented escape hatch for imported history, never for native signed parts.
          ...(/^gemini-3/.test(model) ? { thoughtSignature: "skip_thought_signature_validator" } : {}),
        })),
      ])
    } else {
      const id = wireIds.get(message.callId)
      push("user", [{ functionResponse: { ...(id ? { id } : {}), name: message.name, response: { [message.isError ? "error" : "output"]: message.output || "(no output)" } } }])
    }
  }
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "(conversation continues)" }] })
  return contents
}

/** Effort is model-family specific; Gemini 3 retains v1's high default. */
function generationConfig(request: ModelRequest, model: string): Record<string, unknown> {
  const config: Record<string, unknown> = { temperature: 1, topP: 0.95, topK: 64 }
  if (/^gemini-(2\.5|3)/.test(model)) {
    const effort = request.effort
    const thinking: Record<string, unknown> = { includeThoughts: true, ...(model.startsWith("gemini-3") ? { thinkingLevel: "high" } : {}) }
    if (effort && model.startsWith("gemini-3")) {
      thinking.thinkingLevel = effort === "none" || effort === "minimal" || effort === "low" ? "low" : effort === "medium" && !/^gemini-3(?:\.0)?-pro/.test(model) ? "medium" : "high"
    } else if (effort) {
      thinking.thinkingBudget = { none: model.includes("pro") ? 128 : 0, minimal: model.includes("pro") ? 128 : 0, low: 1_024, medium: 8_192, high: 16_000, xhigh: 24_576, max: 32_768 }[effort]
    }
    config.thinkingConfig = thinking
  }
  const allowed = new Set(["temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "presencePenalty", "frequencyPenalty", "seed", "responseMimeType", "responseSchema", "responseJsonSchema", "thinkingConfig"])
  const nested = request.parameters?.generationConfig
  const parameters = { ...request.parameters, ...(nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {}) }
  for (const [key, value] of Object.entries(parameters)) {
    if (!allowed.has(key)) continue
    const previous = config[key]
    config[key] = key === "thinkingConfig" && value && typeof value === "object" && !Array.isArray(value) ? { ...(previous as object), ...value } : value
  }
  if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens
  return config
}

export const geminiUrl = (value: string): URL => outboundEndpoint(value, "Gemini")

/** Native GenerateContent SSE transport; credentials travel in a header, never in the URL. */
export function createGeminiProvider(options: {
  id: string
  model: string
  baseUrl: string
  apiKey(): string | undefined | Promise<string | undefined>
  headers?: Record<string, string>
  fetch?: Fetch
  idleTimeoutMs?: number
  takesImages?(model: string): boolean
  bearerToken?(signal: AbortSignal): Promise<string>
  modelPath?(model: string): string
  quotaProject?(): string | undefined
  authHint?: string
}): ModelProvider {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  return {
    id: options.id,
    model: options.model,
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.signal.aborted) return
      geminiUrl(options.baseUrl)
      const key = options.bearerToken ? await options.bearerToken(request.signal) : await options.apiKey()
      if (!key) throw new Error(`[AUTH]: no API key for ${options.id}; set it with providers.set or the provider's environment variable`)
      request.signal.throwIfAborted()
      const model = (request.model ?? options.model).replace(/^models\//, "")
      if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error(`[PROVIDER]: ${options.id} invalid Gemini model id`)
      const built: Record<string, unknown> = {
        contents: toGeminiContents(withoutUnsupportedImages(request.messages, options.takesImages?.(model) ?? true), model, options.id),
        ...(request.system.trim() ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
        ...(request.tools.length ? {
          tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: { type: "object", ...tool.parameters } })) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        } : {}),
        generationConfig: generationConfig(request, model),
      }
      const body = (await request.transformBody?.(built)) ?? built
      const quotaProject = options.quotaProject?.()
      if (quotaProject && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(quotaProject)) throw new Error("[AUTH]: invalid Vertex quota project")
      yield* guardedStream({
        providerId: options.id,
        signal: request.signal,
        ...(options.idleTimeoutMs ? { idleMs: options.idleTimeoutMs } : {}),
        run: async function* ({ watchdog, progress }) {
          try {
            const response = await postStream({ providerId: options.id, url: joinUrl(options.baseUrl, `${options.modelPath?.(model) ?? `/models/${model}`}:streamGenerateContent?alt=sse`), headers: { ...options.headers, ...(options.bearerToken ? { authorization: `Bearer ${key}`, ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}) } : { "x-goog-api-key": key }) }, body, doFetch: options.bearerToken ? (url, init) => doFetch(url, { ...init, redirect: "error" }) : doFetch, watchdog, secrets: [key] })
            if (response) yield* readStream({ response, model, watchdog, progress, providerId: options.id, key })
          } catch (error) {
            if (error instanceof RetryableProviderError) throw new RetryableProviderError(scrub(error.message, [key]), error.retryAfterMs, error.kind)
            throw new Error(scrub(error instanceof Error ? error.message : `[PROVIDER]: ${options.id} stream failed`, [key]).replace("rejected the API key (check it with providers.set)", options.authHint ?? "rejected the API key (check it with providers.set)"))
          }
        },
      })
    },
    probe: () => probeUrl({ url: joinUrl(options.baseUrl, "/models"), fetch: doFetch }),
  }
}

async function* readStream(input: { response: Response; model: string; watchdog: Watchdog; progress: { silentBytes: number }; providerId: string; key: string }): AsyncIterable<ModelEvent> {
  const { watchdog, providerId } = input
  const parts: Part[] = []
  let replayChars = 0
  let usage: Usage | undefined
  let finish: string | undefined
  const calls: Extract<ModelEvent, { type: "tool_call" }>[] = []
  const interrupted = () => new RetryableProviderError(`[PROVIDER]: ${providerId} stream ended without completion`)
  for await (const data of sseData(input.response.body!, watchdog.signal, (bytes) => { watchdog.touch(); input.progress.silentBytes += bytes })) {
    if (watchdog.signal.aborted) return
    if (input.progress.silentBytes > MAX_SILENT_STREAM_BYTES) throw interrupted()
    let chunk: Chunk
    try { chunk = JSON.parse(data) as Chunk } catch { throw interrupted() }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw interrupted()
    if (chunk.error) {
      const code = chunk.error.code ?? 500
      throw await httpFailure({ providerId, response: Response.json(chunk.error, { status: code >= 400 && code <= 599 ? code : 500 }), secrets: [input.key] })
    }
    if (chunk.promptFeedback?.blockReason) throw new Error(`[PROVIDER]: ${providerId} prompt blocked (${chunk.promptFeedback.blockReason})`)
    if (chunk.usageMetadata) usage = { ...usage, ...chunk.usageMetadata }
    const candidate = chunk.candidates?.find((entry) => entry.index === undefined || entry.index === 0)
    for (const part of candidate?.content?.parts ?? []) {
      if (watchdog.signal.aborted) return
      const saved: Part = { ...part }
      if (part.functionCall) {
        const call = part.functionCall
        if (!call.name || (call.args !== undefined && (!call.args || typeof call.args !== "object" || Array.isArray(call.args))) || JSON.stringify(call.args ?? {}).length > MAX_TOOL_ARGUMENT_CHARS) throw new Error(`[PROVIDER]: ${providerId} invalid or oversized tool call`)
        const callId = call.id || `gemini_${crypto.randomUUID()}`
        if (calls.some((event) => event.call.callId === callId)) throw new Error(`[PROVIDER]: ${providerId} duplicate tool call id`)
        calls.push({ type: "tool_call", call: { callId, name: call.name, args: argsObject(call.args) } })
      }
      replayChars += JSON.stringify(saved).length
      if (replayChars > MAX_SILENT_STREAM_BYTES) throw new Error(`[PROVIDER]: ${providerId} signed response exceeded replay limit`)
      parts.push(saved)
      if (part.text) yield { type: part.thought ? "reasoning" : "text", delta: part.text }
      if (part.functionCall) input.progress.silentBytes = 0
    }
    if (candidate?.finishReason) finish = candidate.finishReason
  }
  if (watchdog.signal.aborted) return
  if (!finish) throw interrupted()
  if (finish !== "STOP" && finish !== "MAX_TOKENS") throw new Error(`[PROVIDER]: ${providerId} generation stopped (${finish})`)
  if (parts.length) yield { type: "reasoning_state", state: { provider: providerId, model: input.model, blocks: parts } }
  // Incomplete or blocked generations must never execute a partial tool call.
  if (finish === "STOP") for (const call of calls) yield call
  if (usage) {
    const count = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0
    const cached = count(usage.cachedContentTokenCount)
    const reasoning = count(usage.thoughtsTokenCount)
    yield { type: "usage", usage: { input: Math.max(0, count(usage.promptTokenCount) - cached), output: count(usage.candidatesTokenCount) + reasoning, reasoning, cacheRead: cached, cacheWrite: 0 } }
  }
  yield { type: "finish", reason: finish === "MAX_TOKENS" ? "length" : calls.length ? "tool_calls" : "stop" }
}
