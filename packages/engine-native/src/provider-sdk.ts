import { pathToFileURL } from "node:url"
import { RetryableProviderError, type ModelEvent, type ModelProvider, type ModelRequest } from "./provider"
import type { ResolvedProvider } from "./provider-factory"

type Part = Record<string, unknown> & { type: string }
type LanguageModel = { specificationVersion: string; provider: string; doStream(options: Record<string, unknown>): Promise<{ stream: ReadableStream<Part> }> }
type Sdk = { languageModel(model: string): LanguageModel }
type Factory = (options: Record<string, unknown>) => Sdk | ModelProvider | Promise<Sdk | ModelProvider>
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {}
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

function prompt(request: ModelRequest, provider: ResolvedProvider, model: string) {
  const messages: Record<string, unknown>[] = [{ role: "system", content: request.system }]
  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: message.callId, toolName: message.name, output: { type: message.isError ? "error-text" : "text", value: message.output } }] })
      continue
    }
    const content: Record<string, unknown>[] = []
    if (message.role === "assistant" && message.reasoning?.provider === provider.id && message.reasoning.model === model) content.push(...message.reasoning.blocks.map(object))
    if (message.content) content.push({ type: "text", text: message.content })
    if (message.role === "user") {
      if (provider.models.find((entry) => entry.id === model)?.images !== false) for (const image of message.images ?? []) content.push({ type: "file", mediaType: image.mime, data: Buffer.from(image.base64, "base64") })
      for (const doc of message.documents ?? []) content.push({ type: "file", mediaType: doc.mime, filename: doc.name, data: Buffer.from(doc.base64, "base64") })
    } else for (const call of message.toolCalls) content.push({ type: "tool-call", toolCallId: call.callId, toolName: call.name, input: call.args })
    messages.push({ role: message.role, content })
  }
  return messages
}

async function* streamSdk(language: LanguageModel, provider: ResolvedProvider, request: ModelRequest): AsyncIterable<ModelEvent> {
  if (language.specificationVersion !== "v3") throw new Error("unsupported SDK specification")
  const model = request.model ?? provider.models[0]?.id ?? ""
  const namespace = language.provider.split(".")[0] || provider.id
  const parameters = { ...request.parameters }
  const supplied = object(parameters.providerOptions)
  const specific: Record<string, unknown> = { ...object(supplied[namespace]), ...(request.effort ? { reasoningEffort: request.effort } : {}), ...(request.cacheKey ? { promptCacheKey: request.cacheKey } : {}) }
  const generation: Record<string, unknown> = {}
  for (const name of ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "stopSequences", "seed", "responseFormat", "maxOutputTokens"]) if (parameters[name] !== undefined) generation[name] = parameters[name]
  // Provider-native options remain namespaced; transport and conversation fields are owned here.
  for (const [name, value] of Object.entries(parameters)) if (!(name in generation) && name !== "providerOptions") specific[name] = value
  const response = await language.doStream({ ...generation, prompt: prompt(request, provider, model), tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })), toolChoice: { type: "auto" }, abortSignal: request.signal, headers: provider.headers, providerOptions: { ...supplied, [namespace]: specific }, ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}) })
  const reader = response.stream.getReader()
  const reasoning = new Map<string, Record<string, unknown>>()
  const abort = () => { void reader.cancel().catch(() => {}) }
  request.signal.addEventListener("abort", abort, { once: true })
  let finished = false
  try {
    while (true) {
      if (request.signal.aborted) throw new Error("cancelled")
      const next = await reader.read()
      if (request.signal.aborted) throw new Error("cancelled")
      if (next.done) break
      const part = next.value
      if (part.type === "error") throw part.error ?? new Error("SDK stream failed")
      if (part.type === "text-delta" && typeof part.delta === "string") yield { type: "text", delta: part.delta }
      if (part.type.startsWith("reasoning-")) {
        const id = String(part.id ?? "reasoning")
        const block = reasoning.get(id) ?? { type: "reasoning", text: "" }
        if (part.type === "reasoning-delta" && typeof part.delta === "string") { block.text = String(block.text) + part.delta; yield { type: "reasoning", delta: part.delta } }
        if (part.providerMetadata) block.providerOptions = { ...object(block.providerOptions), ...object(part.providerMetadata) }
        reasoning.set(id, block)
      }
      if (part.type === "tool-call") {
        if (part.providerExecuted) continue
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string" || typeof part.input !== "string") throw new Error("invalid SDK tool call")
        yield { type: "tool_call", call: { callId: part.toolCallId, name: part.toolName, args: JSON.parse(part.input) } }
      }
      if (part.type === "finish") {
        const usage = object(part.usage), input = object(usage.inputTokens), output = object(usage.outputTokens)
        if (reasoning.size) yield { type: "reasoning_state", state: { provider: provider.id, model, blocks: [...reasoning.values()] } }
        // `input` is the uncached part, as every adapter reports it: the SDK's total also counts what the cache read and wrote.
        const uncached = typeof input.noCache === "number" ? count(input.noCache) : Math.max(0, count(input.total) - count(input.cacheRead) - count(input.cacheWrite))
        yield { type: "usage", usage: { input: uncached, output: count(output.total), reasoning: count(output.reasoning), cacheRead: count(input.cacheRead), cacheWrite: count(input.cacheWrite) } }
        const reason = object(part.finishReason).unified
        if (reason === "error") throw new Error("SDK stream failed")
        yield { type: "finish", reason: reason === "tool-calls" ? "tool_calls" : reason === "length" ? "length" : "stop" }
        finished = true
        break
      }
    }
    if (!finished) throw new Error("SDK stream ended without finish")
  } finally {
    request.signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Opt-in, already installed SDK. No package installer or schema enters the CLI startup graph. */
export function createSdkProvider(provider: ResolvedProvider, module: string): ModelProvider {
  let loaded: Promise<Factory> | undefined
  const load = () => loaded ??= (async () => {
    try {
      const name = module.startsWith("/") ? pathToFileURL(module).href : module
      if (name.startsWith("file:")) { const url = new URL(name); if (url.hostname || url.search || url.hash) throw new Error("invalid module") }
      else if (!/^(@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:\/[a-zA-Z0-9._/-]+)?$/.test(name)) throw new Error("invalid module")
      const sdk = await import(name) as Record<string, unknown>
      const factory = sdk.createProvider ?? Object.entries(sdk).find(([key, value]) => key.startsWith("create") && typeof value === "function")?.[1]
      if (typeof factory !== "function") throw new Error("missing factory")
      return factory as Factory
    } catch { loaded = undefined; throw new Error(`[PROVIDER]: ${provider.id} SDK unavailable; configure an installed local module`) }
  })()
  return { id: provider.id, model: provider.models[0]?.id ?? "", async *stream(request) {
    if (request.signal.aborted) throw new Error("[PROVIDER]: request cancelled")
    const factory = await load()
    const key = provider.apiKey()
    if (provider.keyRequired && !key) throw new Error(`[AUTH]: no API key for ${provider.id}`)
    try {
      const sdk = await factory({ provider, name: provider.id, baseURL: provider.baseUrl, apiKey: key, headers: provider.headers })
      if ("stream" in sdk && typeof sdk.stream === "function") yield* sdk.stream(request)
      else if ("languageModel" in sdk && typeof sdk.languageModel === "function") yield* streamSdk(sdk.languageModel(request.model ?? provider.models[0]?.id ?? ""), provider, request)
      else throw new Error("invalid SDK")
    } catch (cause) {
      const message = request.signal.aborted ? "[PROVIDER]: request cancelled" : `[PROVIDER]: ${provider.id} SDK request failed; check its local configuration`
      const error = object(cause)
      if (!request.signal.aborted && (cause instanceof RetryableProviderError || error.isRetryable === true)) throw new RetryableProviderError(message, cause instanceof RetryableProviderError ? cause.retryAfterMs : undefined, cause instanceof RetryableProviderError ? cause.kind : "transient")
      throw new Error(message)
    }
  } }
}
