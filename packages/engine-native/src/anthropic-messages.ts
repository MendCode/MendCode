import { modelParameters } from "./model-parameters"
import type { ReasoningEffort } from "@mendcode/protocol"
import { argsObject, orderedParts, pairToolCalls, withoutUnsupportedImages } from "./history"
import { MAX_SILENT_STREAM_BYTES, MAX_TOOL_ARGUMENT_CHARS, argumentGuard, sseData } from "./openai-responses"
import type { CacheTtl } from "@mendcode/protocol/wire"
import { HttpStatusError, guardedStream, joinUrl, parseToolArgs, postStream, scrub, type Fetch, type Watchdog } from "./provider-http"
import { probeUrl } from "./network-wait"
import { RetryableProviderError, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest, type ReasoningState, type ToolSpec } from "./provider"

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
export const ANTHROPIC_VERSION = "2023-06-01"
/** Room for the answer when the request does not say; modern Claude models allow at least this much. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32_000

/** Reasoning effort → thinking budget in tokens (no effort = thinking off). `minimal` and `none` are off too; `xhigh` and `max` go one and two steps past `high`. */
export const THINKING_BUDGETS: Record<ReasoningEffort, number> = { none: 0, minimal: 0, low: 2_000, medium: 8_000, high: 24_000, xhigh: 32_000, max: 48_000 }
/** The API refuses budgets below this. */
const MIN_THINKING_BUDGET = 1_024

type Block = Record<string, unknown>
type WireMessage = { role: "user" | "assistant"; content: Block[] }

/** Anthropic tool ids allow only `[A-Za-z0-9_-]`; ids other providers made are mapped the same way on both sides of a call. */
const toolId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool"

/**
 * A cache breakpoint. `1h` adds `ttl: "1h"` (written at 2x the input price instead of 1.25x); without it the provider keeps
 * the entry 5 minutes. Every breakpoint of one request gets the same mark: the API wants longer lifetimes before shorter ones,
 * and one lifetime per request can never break that order.
 */
type CacheMark = { type: "ephemeral"; ttl?: "1h" }
const cacheMarkFor = (ttl: CacheTtl | undefined): CacheMark => (ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" })
/** Conversations whose provider refused `ttl` (a 400); the oldest is forgotten past this many. */
const MAX_TTL_REFUSED_SESSIONS = 256

function userBlocks(message: Extract<ModelMessage, { role: "user" }>): Block[] {
  const blocks: Block[] = []
  // Inline attachment tokens: the media sits where its token stands in the sentence (a text block of only spaces is refused by the API).
  const ordered = orderedParts(message)
  if (ordered) {
    for (const part of ordered) {
      if (part.type === "text") {
        if (part.text.trim()) blocks.push({ type: "text", text: part.text })
      } else if (part.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: part.image.mime, data: part.image.base64 } })
      else blocks.push({ type: "document", title: part.document.name, source: { type: "base64", media_type: part.document.mime, data: part.document.base64 } })
    }
    return blocks
  }
  if (message.content.trim()) blocks.push({ type: "text", text: message.content })
  for (const image of message.images ?? []) blocks.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } })
  for (const file of message.documents ?? []) blocks.push({ type: "document", title: file.name, source: { type: "base64", media_type: file.mime, data: file.base64 } })
  return blocks
}

/**
 * Neutral history → Messages API messages. Tool results travel in a user message right after the assistant message that
 * called them (before any text or image that follows), consecutive same-role messages merge, and the assistant turn's
 * signed thinking blocks come first when `reasoning` was made by this model.
 */
export function toAnthropicMessages(messages: readonly ModelMessage[], model: string): WireMessage[] {
  const wire: WireMessage[] = []
  const push = (role: WireMessage["role"], blocks: Block[]) => {
    if (blocks.length === 0) return
    const last = wire.at(-1)
    if (last && last.role === role) {
      if (role === "user") {
        // tool_result blocks must lead the user message that answers a tool_use.
        const results = [...last.content, ...blocks].filter((block) => block.type === "tool_result")
        const rest = [...last.content, ...blocks].filter((block) => block.type !== "tool_result")
        last.content = [...results, ...rest]
      } else last.content.push(...blocks)
    } else wire.push({ role, content: blocks })
  }
  for (const message of pairToolCalls(messages)) {
    if (message.role === "user") push("user", userBlocks(message))
    else if (message.role === "tool") push("user", [{ type: "tool_result", tool_use_id: toolId(message.callId), content: message.output || "(no output)", ...(message.isError ? { is_error: true } : {}) }])
    else {
      const replay = message.reasoning?.provider === "anthropic" && message.reasoning.model === model ? (message.reasoning.blocks as Block[]) : []
      push("assistant", [
        ...replay,
        ...(message.content.trim() ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: toolId(call.callId), name: call.name, input: argsObject(call.args) })),
      ])
    }
  }
  // The API wants the conversation to start with a user message.
  if (wire[0]?.role === "assistant") wire.unshift({ role: "user", content: [{ type: "text", text: "(conversation continues)" }] })
  return wire
}

/** Marks the last content block of the last user message as a cache breakpoint (the conversation so far becomes the cached prefix). */
function markLastUserTurn(wire: WireMessage[], cacheMark: CacheMark) {
  for (let index = wire.length - 1; index >= 0; index--) {
    const message = wire[index]!
    if (message.role !== "user") continue
    const last = message.content.at(-1)
    if (last) last.cache_control = cacheMark
    return
  }
}

/**
 * Marks the last block of the user message before the last one: where the previous request put its breakpoint. A lookup
 * checks only about 20 blocks back from a breakpoint for an earlier entry, and a step with parallel tool calls adds a
 * tool_use and a tool_result block per call, so the new breakpoint alone can sit too far from what is already cached.
 */
function markPreviousUserTurn(wire: WireMessage[], cacheMark: CacheMark) {
  let seen = 0
  for (let index = wire.length - 1; index >= 0; index--) {
    const message = wire[index]!
    if (message.role !== "user" || ++seen < 2) continue
    const last = message.content.at(-1)
    if (last) last.cache_control = cacheMark
    return
  }
}

/** `breakpoint` marks the last tool: the tool list (first in Anthropic's cache order) stays cached when the system prompt after it changes. */
function toAnthropicTools(tools: ToolSpec[], breakpoint: CacheMark | undefined) {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", ...tool.parameters },
    ...(breakpoint && index === tools.length - 1 ? { cache_control: breakpoint } : {}),
  }))
}

/** The request body with `ttl` taken off every cache breakpoint (tools, system blocks, message blocks): what a provider that refuses the field is sent. */
export function withoutCacheTtl(body: Record<string, unknown>): Record<string, unknown> {
  const strip = (block: unknown): unknown => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block
    const control = (block as Block).cache_control
    if (!control || typeof control !== "object" || !("ttl" in control)) return block
    const { ttl: _ttl, ...mark } = control as Record<string, unknown>
    return { ...(block as Block), cache_control: mark }
  }
  const blocks = (value: unknown) => (Array.isArray(value) ? value.map(strip) : value)
  return {
    ...body,
    ...(body.system !== undefined ? { system: blocks(body.system) } : {}),
    ...(body.tools !== undefined ? { tools: blocks(body.tools) } : {}),
    ...(Array.isArray(body.messages) ? { messages: body.messages.map((message: unknown) => (message && typeof message === "object" && Array.isArray((message as WireMessage).content) ? { ...(message as WireMessage), content: blocks((message as WireMessage).content) } : message)) } : {}),
  }
}

/**
 * Whether the tool loop in progress (everything after the last real user message) can carry thinking: the API wants the
 * signed thinking blocks of every assistant step that called a tool, and a step this model did not make (another model,
 * a retry that lost them) has none. Without them thinking is left off for the request, as the API allows mid-loop.
 */
function canThink(messages: readonly ModelMessage[], model: string) {
  let start = messages.length
  while (start > 0) {
    const message = messages[start - 1]!
    if (message.role === "user" && !(message.attachments?.length && message.content.startsWith("[image from "))) break
    start--
  }
  return messages.slice(start).every((message) => message.role !== "assistant" || message.toolCalls.length === 0 || (message.reasoning?.provider === "anthropic" && message.reasoning.model === model))
}

/** Anthropic's stop reasons on the neutral scale. */
function finishReason(stop: string | undefined, sawToolCall: boolean): "stop" | "tool_calls" | "length" {
  if (stop === "max_tokens") return "length"
  if (stop === "tool_use" || sawToolCall) return "tool_calls"
  return "stop"
}

type StreamEvent = {
  type?: string
  index?: number
  message?: { usage?: Usage }
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
  usage?: Usage
  error?: { type?: string; message?: string }
}
type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

/**
 * Anthropic Messages API adapter (streaming). The key is read through `apiKey()` on every request, sent only as
 * `x-api-key`, and scrubbed from anything that can reach a log or the UI.
 */
export function createAnthropicProvider(options: {
  id: string
  model: string
  apiKey(): string | undefined | Promise<string | undefined>
  baseUrl?: string
  /** Extra request headers (a gateway's own), after the defaults. */
  headers?: Record<string, string>
  fetch?: Fetch
  idleTimeoutMs?: number
  maxTokens?: number
  takesImages?(model: string): boolean
}): ModelProvider {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const url = joinUrl(options.baseUrl ?? ANTHROPIC_BASE_URL, "/messages")
  /** Conversations (and models) whose `ttl` this host refused: they are sent without it from then on. */
  const ttlRefused = new Set<string>()
  return {
    id: options.id,
    model: options.model,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const model = request.model ?? options.model
      const key = request.headers?.["x-api-key"] ?? await options.apiKey()
      // Outside the request's try: a missing key ([AUTH]) stops the turn instead of being retried.
      if (!key && !request.headers?.authorization) throw new Error(`[AUTH]: no API key for ${options.id}; set it with providers.set or the provider's environment variable`)
      const secrets = [...(key ? [key] : []), ...Object.values(request.headers ?? {})]
      const messages = withoutUnsupportedImages([...request.messages], options.takesImages?.(model) ?? true)
      const budget = Math.min(THINKING_BUDGETS[request.effort ?? "minimal"], request.maxOutputTokens ? Math.max(0, request.maxOutputTokens - 1) : Infinity)
      const thinkingWanted = budget >= MIN_THINKING_BUDGET
      const thinking = thinkingWanted && canThink(messages, model) ? budget : 0
      const thinkingDropped = thinkingWanted && thinking === 0
      const wire = toAnthropicMessages(messages, model)
      // `promptCache`: off = no breakpoints · legacy (default) = system and last user message · smart = tools too.
      const cacheMode = request.cacheMode ?? "legacy"
      // `promptCacheTtl` / `wait_cache`: one lifetime for every breakpoint of the request, unless this host refused the field for the conversation.
      const ttlSession = `${request.conversationId ?? ""}\n${model}`
      const longTtl = cacheMode !== "off" && request.cacheTtl === "1h" && !ttlRefused.has(ttlSession)
      const cacheMark = cacheMarkFor(longTtl ? "1h" : undefined)
      if (cacheMode !== "off") markLastUserTurn(wire, cacheMark)
      // Tools, system, the previous request's breakpoint and this one: the four Anthropic allows.
      if (cacheMode === "smart") markPreviousUserTurn(wire, cacheMark)
      const maxTokens = request.maxOutputTokens ?? Math.max(options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS, thinking ? thinking + 8_192 : 0)
      const built: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(request.system.trim() ? { system: [{ type: "text", text: request.system, ...(cacheMode === "off" ? {} : { cache_control: cacheMark }) }] } : {}),
        messages: wire,
        ...(request.tools.length ? { tools: toAnthropicTools(request.tools, cacheMode === "smart" ? cacheMark : undefined), tool_choice: { type: "auto" } } : {}),
        ...(thinking ? { thinking: { type: "enabled", budget_tokens: thinking } } : {}),
      }
      const configured = modelParameters(built, request)
      if (request.maxOutputTokens && configured.thinking && typeof configured.thinking === "object") {
        const thinking = configured.thinking as { type?: string; budget_tokens?: number }
        if (thinking.type === "enabled") {
          const cap = Math.max(0, Number(configured.max_tokens) - 1)
          if (cap < MIN_THINKING_BUDGET) delete configured.thinking
          else configured.thinking = { ...thinking, budget_tokens: Math.min(thinking.budget_tokens ?? cap, cap) }
        }
      }
      const body = (await request.transformBody?.(configured)) ?? configured
      yield* guardedStream({
        providerId: options.id,
        signal: request.signal,
        ...(options.idleTimeoutMs !== undefined ? { idleMs: options.idleTimeoutMs } : {}),
        run: async function* ({ watchdog, progress }) {
          const post = (sent: Record<string, unknown>) => postStream({
            providerId: options.id,
            url,
            headers: { ...(key ? { "x-api-key": key } : {}), "anthropic-version": ANTHROPIC_VERSION, ...options.headers, ...request.headers },
            body: sent,
            doFetch: request.fetch ?? doFetch,
            watchdog,
            secrets,
          })
          let response: Response | undefined
          let cacheTtl = longTtl
          try {
            response = await post(body)
          } catch (error) {
            if (!longTtl || !(error instanceof HttpStatusError) || error.status !== 400) throw error
            // Refused with `ttl` in it: the same call again without the field, once. The conversation is only remembered when that
            // one is answered, so a request refused for another reason (it fails again here, with its own error) changes nothing.
            response = await post(withoutCacheTtl(body))
            if (!response) return
            cacheTtl = false
            if (ttlRefused.size >= MAX_TTL_REFUSED_SESSIONS) ttlRefused.delete(ttlRefused.values().next().value!)
            ttlRefused.add(ttlSession)
          }
          if (!response) return
          yield* readStream({ response, model, watchdog, progress, providerId: options.id, secrets, thinkingDropped, cacheTtl })
        },
      })
    },
    probe: () => probeUrl({ url, fetch: doFetch }),
  }
}

/** The SSE events of one Messages response as neutral events. */
async function* readStream(input: { response: Response; model: string; watchdog: Watchdog; progress: { silentBytes: number }; providerId: string; secrets: readonly string[]; thinkingDropped?: boolean; cacheTtl?: boolean }): AsyncIterable<ModelEvent> {
  const { watchdog, providerId } = input
  const { signal } = watchdog
  const blocks = new Map<number, { kind: string; id?: string; name?: string; json: string; text: string; signature: string; data?: string }>()
  const reasoning: unknown[] = []
  const guard = argumentGuard()
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let stop: string | undefined
  let sawToolCall = false
  const runaway = (why: string) => new RetryableProviderError(`[PROVIDER]: ${providerId} ${why}, stream abandoned`)
  const state = (): ReasoningState => ({ provider: "anthropic", model: input.model, blocks: [...reasoning] })
  const onChunk = (bytes: number) => {
    watchdog.touch()
    input.progress.silentBytes += bytes
  }
  for await (const data of sseData(input.response.body!, signal, onChunk)) {
    if (input.progress.silentBytes > MAX_SILENT_STREAM_BYTES) throw runaway(`${Math.round(input.progress.silentBytes / 1024)} KB without output`)
    let event: StreamEvent
    try {
      event = JSON.parse(data) as StreamEvent
    } catch {
      continue
    }
    switch (event.type) {
      case "message_start": {
        const u = event.message?.usage
        if (u) {
          usage.input = u.input_tokens ?? 0
          usage.cacheRead = u.cache_read_input_tokens ?? 0
          usage.cacheWrite = u.cache_creation_input_tokens ?? 0
          usage.output = u.output_tokens ?? 0
        }
        break
      }
      case "content_block_start": {
        const block = event.content_block
        if (event.index === undefined || !block) break
        blocks.set(event.index, { kind: block.type ?? "", ...(block.id ? { id: block.id } : {}), ...(block.name ? { name: block.name } : {}), json: "", text: "", signature: "", ...(block.data ? { data: block.data } : {}) })
        break
      }
      case "content_block_delta": {
        const block = event.index === undefined ? undefined : blocks.get(event.index)
        const delta = event.delta
        if (!block || !delta) break
        if (delta.type === "text_delta" && delta.text) yield { type: "text", delta: delta.text }
        else if (delta.type === "thinking_delta" && delta.thinking) {
          block.text += delta.thinking
          yield { type: "reasoning", delta: delta.thinking }
        } else if (delta.type === "signature_delta" && delta.signature) block.signature += delta.signature
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const why = guard(String(event.index), delta.partial_json)
          if (why) throw runaway(why)
          block.json += delta.partial_json
          if (block.json.length > MAX_TOOL_ARGUMENT_CHARS) throw runaway(`tool call arguments passed ${MAX_TOOL_ARGUMENT_CHARS} chars`)
          input.progress.silentBytes = 0
          if (block.id && block.name) yield { type: "tool_input", callId: block.id, name: block.name, delta: delta.partial_json }
        }
        break
      }
      case "content_block_stop": {
        const block = event.index === undefined ? undefined : blocks.get(event.index)
        if (!block) break
        if (block.kind === "tool_use" && block.id && block.name) {
          sawToolCall = true
          yield { type: "tool_call", call: { callId: block.id, name: block.name, args: parseToolArgs(block.json) } }
        } else if (block.kind === "thinking" && block.signature) {
          reasoning.push({ type: "thinking", thinking: block.text, signature: block.signature })
          yield { type: "reasoning_state", state: state() }
        } else if (block.kind === "redacted_thinking" && block.data) {
          reasoning.push({ type: "redacted_thinking", data: block.data })
          yield { type: "reasoning_state", state: state() }
        }
        break
      }
      case "message_delta": {
        if (event.delta?.stop_reason) stop = event.delta.stop_reason
        if (event.usage?.output_tokens !== undefined) usage.output = event.usage.output_tokens
        // Usage repeated here is cumulative; input-side counts may be refreshed too.
        if (event.usage?.input_tokens !== undefined && event.usage.input_tokens > 0) usage.input = event.usage.input_tokens
        if (event.usage?.cache_read_input_tokens !== undefined) usage.cacheRead = event.usage.cache_read_input_tokens
        if (event.usage?.cache_creation_input_tokens !== undefined) usage.cacheWrite = event.usage.cache_creation_input_tokens
        break
      }
      case "message_stop": {
        // Thinking tokens are part of output_tokens; the API does not report them apart.
        yield { type: "usage", usage: { input: usage.input, output: usage.output, reasoning: 0, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(input.thinkingDropped ? { thinkingDropped: true as const } : {}), ...(input.cacheTtl ? { cacheTtl: "1h" as const } : {}) } }
        yield { type: "finish", reason: finishReason(stop, sawToolCall) }
        return
      }
      case "error": {
        const type = event.error?.type ?? ""
        const message = scrub(`[PROVIDER]: ${providerId} ${type} ${event.error?.message ?? "stream failed"}`.replace(/\s+/g, " ").trim(), input.secrets)
        // Overload and rate limits pass; an invalid request or a bad key will not.
        if (type === "overloaded_error" || type === "rate_limit_error" || type === "api_error" || type === "timeout_error") throw new RetryableProviderError(message)
        throw new Error(message)
      }
    }
  }
  if (!signal.aborted) throw new RetryableProviderError(`[PROVIDER]: ${providerId} stream ended without completion`)
}
