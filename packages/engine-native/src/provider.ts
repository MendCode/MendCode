import type { BlobRef, PromptCacheMode, ReasoningEffort } from "@mendcode/protocol"

/** Provider-neutral conversation, kept by the native engine and replayed to any model provider. */
export type ToolCall = { callId: string; name: string; args: unknown }

/** Image bytes for one request; history keeps only `attachments` (blob refs), never the bytes. */
export type RequestImage = { mime: string; base64: string }
export type RequestDocument = { mime: "application/pdf"; base64: string; name: string }

/**
 * The order of a user message that has inline attachment tokens, for one request: text, then the image or document (an index into
 * `images` / `documents`) the token before it names, and so on. Absent for every message without tokens, whose content is the text
 * followed by the images and then the documents, as it has always been.
 */
export type RequestPart = { text: string } | { image: number } | { document: number }

export type ModelMessage =
  | { role: "user"; content: string; attachments?: BlobRef[]; images?: RequestImage[]; documents?: RequestDocument[]; layout?: RequestPart[]; loadedInstructions?: string[]; compaction?: import("./compaction-checkpoint").CompactionCheckpoint }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; reasoning?: ReasoningState }
  | { role: "tool"; callId: string; name: string; output: string; isError: boolean; loadedInstructions?: string[]; discoveredTools?: string[] }

/**
 * Opaque reasoning a provider needs back to continue a tool loop (Anthropic's signed thinking blocks). The engine keeps it
 * on the assistant message for the rest of the turn; only the provider that made it (and only for the same model) reads it.
 */
export type ReasoningState = { provider: string; model: string; blocks: unknown[] }

export type ToolSpec ={ name: string; description: string; parameters: Record<string, unknown> }

export type ModelUsage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; costMicros?: number; thinkingDropped?: true; /** The answered request carried `ttl: "1h"` on its cache breakpoints. */ cacheTtl?: "1h" }

/** Tools the provider runs on its side (no local execution, no approval); their results reach the model directly. */
export type HostedTool = "web_search" | "image_generation"

/**
 * A hosted tool's progress, for display only: `id` pairs start and end, `detail` says what it did
 * (e.g. the search queries). History never replays these; the model's answer carries what it found.
 */
export type HostedToolEvent = {
  type: "hosted_tool"
  id: string
  tool: HostedTool
  status: "started" | "completed" | "failed"
  detail?: string
  /** A finished image_generation call: the generated image (the engine stores it as a blob). */
  image?: { mime: "image/png" | "image/jpeg" | "image/webp"; base64: string }
}

/** What a provider streams for one model call. `finish` is always last unless the stream throws. */
export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  /** Part of a call's arguments as the model writes them (a whole file, a long script); its `tool_call` with the same `callId` follows when they are whole. */
  | { type: "tool_input"; callId: string; name: string; delta: string }
  | HostedToolEvent
  | { type: "usage"; usage: ModelUsage }
  /** Everything reasoned so far in this call, for replay on the next step of a tool loop; a later event replaces an earlier one. */
  | { type: "reasoning_state"; state: ReasoningState }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" }

/** `model`/`effort` override the provider's own for this call; a `model` without `effort` uses that model's default effort. */
export type ModelRequest = {
  system: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  hostedTools?: HostedTool[]
  model?: string
  effort?: ReasoningEffort | undefined
  /** This session's `/fast`: true asks for priority processing, false refuses it; undefined follows the provider's `serviceTier`. */
  fast?: boolean | undefined
  parameters?: import("@mendcode/protocol").ModelChoice["parameters"] | undefined
  /** Stable per conversation (per lineage in `smart` mode), so the provider routes its requests to the same prompt cache. Absent in `off` mode. */
  cacheKey?: string
  /** Scoped keys fingerprint the final provider prefix, after request hooks and parameter translation. */
  cacheKeyForBody?(body: Record<string, unknown>): string | undefined
  /** The `promptCache` setting (docs/prompt-cache.md); an adapter that places cache breakpoints itself (Anthropic) reads it. Absent = `legacy`. */
  cacheMode?: PromptCacheMode
  /** `1h`: the Anthropic adapter asks for the one-hour cache lifetime on every breakpoint of this request. Absent or `5m`: no `ttl` (the provider's 5 minutes). */
  cacheTtl?: import("@mendcode/protocol/wire").CacheTtl | undefined
  /** Cap on the answer's tokens, for tiny calls (a connection test); the provider's own generous default when absent. */
  maxOutputTokens?: number
  /** Canonical private Responses items, only replayed to the checkpoint's bound transport. */
  nativeContext?: Record<string, unknown>[]
  /** Daemon plugin headers; never part of the wire protocol or stored transcript. */
  headers?: Record<string, string>
  /** Optional transport provided by an opted-in daemon auth plugin; never serialized. */
  fetch?: import("./provider-http").Fetch
  /** Auxiliary/subagent calls are agent-initiated even when their last message has role user. */
  initiator?: "user" | "agent"
  /**
   * Opt-in: lets the caller (the engine's request hook) replace the provider's request body right before it is
   * sent. Return `undefined` to keep it. Only adapters that build a JSON body call it (the Responses adapter does).
   */
  transformBody?(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined>
  signal: AbortSignal
  /** Stable through local tool execution; a bidirectional provider closes on turn cancellation. */
  turnSignal?: AbortSignal
  /** Daemon session identity for providers with server-side conversation state. */
  conversationId?: string
}

/**
 * A model provider adapter (OpenAI Responses, Anthropic Messages, …). Adapters translate this
 * neutral shape to their wire format; the engine never sees provider specifics.
 */
export interface ModelProvider {
  id: string
  model: string
  /** The provider that serves `model` when this one dispatches to several (a router); `id` when absent. Names the usage of a call. */
  idFor?(model: string | undefined): string
  cacheBinding?(model: string | undefined): Promise<import("./cache-policy").CacheBinding | undefined>
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
  /**
   * Whether the provider's host answers at all (any HTTP status); lets a network wait end as soon as the link is back. A router
   * probes the provider of `model` (the call that waits), else the one of its latest call.
   */
  probe?(model?: string): Promise<boolean>
  compactionLimits?(model: string | undefined): import("./compaction-policy").CompactionLimits
  nativeBinding?(model: string | undefined): Promise<string | undefined>
  compact?(request: ModelRequest): Promise<{ output: Record<string, unknown>[]; requestId?: string; usage?: ModelUsage }>
}

/**
 * Thrown by adapters for failures worth retrying. `network`: the connection failed or dropped (offline, sleep, wifi
 * switch); `transient`: the provider answered with a temporary failure (408, 429 without a quota marker, 5xx, a failed
 * or unfinished stream). Both are retried until the user cancels.
 */
export class RetryableProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    readonly kind: "network" | "transient" = "transient",
    /** The first retry of the call starts without a backoff wait: a deadline already spent its time waiting for this host. */
    readonly immediate = false,
  ) {
    super(message)
    this.name = "RetryableProviderError"
  }
}
