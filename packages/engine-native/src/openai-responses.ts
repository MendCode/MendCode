import { modelParameters } from "./model-parameters"
import { cacheHash } from "./cache-policy"
import { fingerprint, NativeCompactionError } from "./compaction-checkpoint"
import { redactSecrets, type ReasoningEffort } from "@mendcode/protocol"
import { orderedParts, withoutUnsupportedImages } from "./history"
import { isNetworkError, isQuotaBody, isTlsError, probeUrl } from "./network-wait"
import { RetryableProviderError, type RequestDocument, type RequestImage, type HostedTool, type HostedToolEvent, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest, type ToolSpec } from "./provider"
import { TOOL_SEARCH_NAME, TOOL_SEARCH_WIRE_NAME } from "./tool-discovery"

type Fetch = (url: string, init: RequestInit) => Promise<Response>

const functionTool = (tool: ToolSpec) => ({ type: "function", name: tool.name === TOOL_SEARCH_NAME ? TOOL_SEARCH_WIRE_NAME : tool.name, description: tool.description, parameters: tool.parameters, strict: false })

/**
 * Client-executed tool search (docs/tool-discovery.md, "Deferred loading on the ChatGPT backend"): which search result loads which found
 * tool. A found tool is defined once, in the `tool_search_output` of the last successful search that names it, so it travels at the tail of
 * `input` and the `tools` array keeps its bytes. The last, not the first: a model that searches again for a tool it already found must get
 * it in that answer, or it reads the empty result as "no such tool" (the earlier answer then loses it, which re-reads the prompt once). `listed` is what stays in `tools`: everything up to `tool_search`, plus the found tools no
 * search result in this history carries (activated by `code` or by a direct call), which are appended as before.
 */
export function searchLoads(tools: readonly ToolSpec[], messages: readonly ModelMessage[]) {
  const at = tools.findIndex((tool) => tool.name === TOOL_SEARCH_NAME)
  const pending = new Map(at === -1 ? [] : tools.slice(at + 1).map((tool) => [tool.name, tool] as const))
  const loads = new Map<string, ToolSpec[]>()
  const searches = messages.filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool" && message.name === TOOL_SEARCH_NAME)
  for (const message of searches) loads.set(message.callId, [])
  for (const message of searches.toReversed()) {
    if (message.isError) continue
    const found: ToolSpec[] = []
    for (const name of message.discoveredTools ?? []) {
      const spec = pending.get(name)
      if (spec && pending.delete(name)) found.push(spec)
    }
    loads.set(message.callId, found)
  }
  return { loads, listed: at === -1 ? [...tools] : [...tools.slice(0, at + 1), ...pending.values()] }
}

/**
 * Neutral history → Responses API `input` items. Tool calls and results are paired by call_id. With `loads` (client-executed tool
 * search) a `tool_search` call and its result are the API's own `tool_search_call` / `tool_search_output` items instead of a function call.
 */
export function toResponsesInput(messages: ModelMessage[], loads?: ReadonlyMap<string, readonly ToolSpec[]>) {
  const items: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const image = (entry: RequestImage) => ({ type: "input_image", image_url: `data:${entry.mime};base64,${entry.base64}` })
      const file = (entry: RequestDocument) => ({ type: "input_file", filename: entry.name, file_data: `data:${entry.mime};base64,${entry.base64}` })
      // Inline attachment tokens: the media sits where its token stands in the sentence.
      const ordered = orderedParts(message)
      items.push({
        role: "user",
        content: ordered
          ? ordered.map((part) => (part.type === "text" ? { type: "input_text", text: part.text } : part.type === "image" ? image(part.image) : file(part.document)))
          : [{ type: "input_text", text: message.content }, ...(message.images ?? []).map(image), ...(message.documents ?? []).map(file)],
      })
    } else if (message.role === "assistant") {
      if (message.content) items.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] })
      for (const call of message.toolCalls) {
        if (call.name === TOOL_SEARCH_NAME && (!call.args || typeof call.args !== "object" || Array.isArray(call.args)))
          throw new Error("Invalid stored tool_search arguments. History was preserved; fork before this call to recover without replaying it.")
        if (loads && call.name === TOOL_SEARCH_NAME) items.push({ type: "tool_search_call", call_id: call.callId, execution: "client", arguments: call.args, status: "completed" })
        else items.push({ type: "function_call", call_id: call.callId, name: call.name === TOOL_SEARCH_NAME ? TOOL_SEARCH_WIRE_NAME : call.name, arguments: JSON.stringify(call.args ?? {}) })
      }
    } else if (loads && message.name === TOOL_SEARCH_NAME) {
      // The definitions are the whole result: the model calls a loaded tool like a listed one. An empty or failed search loads nothing.
      items.push({ type: "tool_search_output", call_id: message.callId, status: "completed", execution: "client", tools: (loads.get(message.callId) ?? []).map((tool) => ({ ...functionTool(tool), defer_loading: true })) })
    } else items.push({ type: "function_call_output", call_id: message.callId, output: message.output })
  }
  return items
}

function toResponsesTools(tools: ToolSpec[], hosted: HostedTool[] = [], clientSearch = false) {
  if (tools.some((tool) => tool.name === TOOL_SEARCH_NAME) && tools.some((tool) => tool.name === TOOL_SEARCH_WIRE_NAME))
    throw new Error("Tool discovery wire-name conflict; rename the custom mendcode_tool_search tool before retrying.")
  return [
    ...tools.map((tool) => clientSearch && tool.name === TOOL_SEARCH_NAME ? { type: "tool_search", execution: "client", description: tool.description, parameters: tool.parameters } : functionTool(tool)),
    ...hosted.map((type) => ({ type })),
  ]
}

/** The backend refused a request that used client-executed tool search; the same call is sent again with the search as a plain function. */
class SearchShapeRejected extends Error {}
/** Sessions remembered as refused; the oldest is forgotten past this many. */
const MAX_REJECTED_SEARCH_SESSIONS = 256

/** What a `web_search_call` did: its queries, the page it opened, or what it looked for on a page. */
function webSearchDetail(item: Record<string, unknown>) {
  const action = item.action as { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string } | undefined
  if (!action) return undefined
  if (action.type === "search") return (action.queries?.length ? action.queries : action.query ? [action.query] : []).join(" · ") || undefined
  if (action.type === "open_page") return action.url
  if (action.type === "find_in_page") return [action.pattern, action.url].filter(Boolean).join(" in ") || undefined
  return undefined
}

const IMAGE_MIME: Record<string, "image/png" | "image/jpeg" | "image/webp"> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" }

/** An `image_generation_call` item: the revised prompt as detail and, once done, the base64 result. */
function imageGenerationEvent(item: Record<string, unknown>, id: string, done: boolean): HostedToolEvent {
  if (!done) return { type: "hosted_tool", id, tool: "image_generation", status: "started" }
  const detail = typeof item.revised_prompt === "string" && item.revised_prompt ? { detail: item.revised_prompt } : {}
  const mime = IMAGE_MIME[String(item.output_format ?? "png").toLowerCase()] ?? "image/png"
  if (item.status !== "completed" || typeof item.result !== "string" || item.result === "") return { type: "hosted_tool", id, tool: "image_generation", status: "failed", ...detail }
  return { type: "hosted_tool", id, tool: "image_generation", status: "completed", ...detail, image: { mime, base64: item.result } }
}

function hostedToolEvent(item: Record<string, unknown> | undefined, done: boolean): HostedToolEvent | undefined {
  if (typeof item?.id === "string" && item.type === "image_generation_call") return imageGenerationEvent(item, item.id, done)
  if (item?.type !== "web_search_call" || typeof item.id !== "string") return undefined
  if (!done) return { type: "hosted_tool", id: item.id, tool: "web_search", status: "started" }
  const detail = webSearchDetail(item)
  return { type: "hosted_tool", id: item.id, tool: "web_search", status: item.status === "failed" ? "failed" : "completed", ...(detail ? { detail } : {}) }
}

function parseArgs(raw: unknown) {
  if (typeof raw !== "string") return raw ?? {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { _raw: raw }
  }
}

/** Streams quiet longer than this are abandoned as stalled (the backend sends progress events well within it). */
export const DEFAULT_STREAM_IDLE_MS = 120_000

/**
 * A signal that follows `parent` and also aborts when `touch()` has not been called for `idleMs`, so a
 * request that never answers, or a stream that goes silent, ends instead of holding the turn forever.
 */
export function idleWatchdog(parent: AbortSignal, idleMs: number, firstMs = idleMs, firstEventMs = idleMs) {
  const controller = new AbortController()
  /** What the request is waiting for: its response headers, the first bytes of the body, or more of a body that already started. */
  let phase: StallPhase = "request"
  let stalledIn: StallPhase | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const onParentAbort = () => controller.abort()
  const arm = (ms: number) => {
    clearTimeout(timer)
    if (ms <= 0) return
    timer = setTimeout(() => ((stalledIn = phase), controller.abort()), ms)
  }
  /** A deadline of its own applies only when it is shorter than the idle limit; otherwise the idle limit covers that wait. */
  const shorter = (ms: number) => (ms > 0 && (idleMs <= 0 || ms < idleMs) ? ms : idleMs)
  // The first touch is the response headers, every later one is bytes of the body.
  const touch = () => {
    const waited = phase
    phase = waited === "request" ? "headers" : "stream"
    arm(waited === "request" ? shorter(firstEventMs) : idleMs)
  }
  parent.addEventListener("abort", onParentAbort, { once: true })
  if (parent.aborted) controller.abort()
  // Until the first touch the shorter `firstMs` applies: a host that accepts the request answers at once.
  arm(shorter(firstMs))
  return {
    signal: controller.signal,
    touch,
    stalled: () => stalledIn !== undefined,
    /** The wait that ran out, when one did. */
    stalledIn: () => stalledIn,
    /** False while nothing came back at all, not even the response headers. */
    answered: () => phase !== "request",
    dispose: () => (clearTimeout(timer), parent.removeEventListener("abort", onParentAbort)),
  }
}

/** `request`: no response headers yet. `headers`: headers arrived, not one byte of the body. `stream`: the body started and went quiet. */
export type StallPhase = "request" | "headers" | "stream"

/**
 * A stream that keeps sending bytes but yields nothing (a model looping inside a tool call's arguments) never trips
 * the idle watchdog; these end it as a retryable failure instead of holding the turn in "generating".
 */
export const MAX_TOOL_ARGUMENT_CHARS = 1_000_000
/** Bytes of events the caller never sees (argument deltas excluded: they are bounded by their own guard). */
export const MAX_SILENT_STREAM_BYTES = 8 * 1024 * 1024
/** The last RUNAWAY_WINDOW argument chars repeating a unit of at most RUNAWAY_MAX_PERIOD chars ("\n\n\n…", "{}{}…") is a loop. */
const RUNAWAY_WINDOW = 4_096
const RUNAWAY_MAX_PERIOD = 32
const RUNAWAY_CHECK_EVERY = 1_024

function isPeriodic(text: string) {
  for (let period = 1; period <= RUNAWAY_MAX_PERIOD; period++) if (text.slice(period) === text.slice(0, -period)) return true
  return false
}

/** Tracks one response's function-call arguments and returns why they ran away, if they did. */
export function argumentGuard() {
  const calls = new Map<string, { tail: string; total: number; checkedAt: number }>()
  return (itemId: string, delta: string): string | undefined => {
    const call = calls.get(itemId) ?? { tail: "", total: 0, checkedAt: 0 }
    calls.set(itemId, call)
    call.total += delta.length
    call.tail = (call.tail + delta).slice(-RUNAWAY_WINDOW)
    if (call.total > MAX_TOOL_ARGUMENT_CHARS) return `tool call arguments passed ${MAX_TOOL_ARGUMENT_CHARS} chars`
    if (call.tail.length < RUNAWAY_WINDOW || call.total - call.checkedAt < RUNAWAY_CHECK_EVERY) return undefined
    call.checkedAt = call.total
    return isPeriodic(call.tail) ? "tool call arguments keep repeating" : undefined
  }
}

/**
 * The most one SSE event may hold before it ends: a whole tool call (1 MB of arguments) or a generated image (base64) fits many
 * times over. A server that streams bytes without ever ending the event would otherwise grow the buffer for as long as it sends.
 */
export const MAX_SSE_EVENT_BYTES = 64 * 1024 * 1024

/** Splits an SSE byte stream into `data:` payloads (one per event). `onChunk` runs for every chunk read, before parsing. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, onChunk: (bytes: number) => void = () => {}, maxEventBytes = MAX_SSE_EVENT_BYTES) {
  const decoder = new TextDecoder()
  // Read line by line: an event ends at an empty line (CRLF or LF). The text of an unfinished line is kept as chunks and joined once:
  // appending to one buffer and searching it again at every read copied a long event (a tool call's whole arguments) once per chunk,
  // 150 ms and 130 MB of peak RSS for a 2 MB event in 16 KB reads.
  let partial: string[] = []
  let data: string[] = []
  /** Bytes read for the event being read (its unfinished line and its `data:` lines so far). */
  let pending = 0
  const reader = body.getReader()
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read().catch((error: unknown) => {
        if (signal.aborted) return { value: undefined, done: true as const }
        // A connection that drops mid-answer is a network failure, not a broken response.
        throw new RetryableProviderError(`[PROVIDER]: stream interrupted: ${error instanceof Error ? error.message : String(error)}`, undefined, isNetworkError(error) ? "network" : "transient")
      })
      if (done) break
      onChunk(value.byteLength)
      let text = decoder.decode(value, { stream: true })
      let newline = text.indexOf("\n")
      while (newline >= 0) {
        const raw = partial.length ? partial.join("") + text.slice(0, newline) : text.slice(0, newline)
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
        partial = []
        text = text.slice(newline + 1)
        if (line === "") {
          const event = data.join("\n")
          data = []
          pending = 0
          if (event) yield event
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
        newline = text.indexOf("\n")
      }
      if (text) partial.push(text)
      pending += value.byteLength
      if (pending > maxEventBytes) throw new RetryableProviderError(`[PROVIDER]: one stream event passed ${maxEventBytes} bytes without ending, stream abandoned`)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    // Leaving early (completion, a failure, a runaway guard) must also stop the body, or the socket keeps filling.
    cancel()
  }
}

/** The wait a 429/5xx asks for: `retry-after-ms`, `retry-after` in seconds, or `retry-after` as an HTTP date (capped at 10 minutes). */
export function retryAfter(response: Response) {
  const ms = Number(response.headers.get("retry-after-ms"))
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 600_000)
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.min(seconds * 1_000, 600_000) : undefined
  const date = Date.parse(header)
  return Number.isFinite(date) && date > Date.now() ? Math.min(date - Date.now(), 600_000) : undefined
}

/**
 * OpenAI Responses API adapter (streaming). Auth is injected by `headers()` so the same adapter
 * serves an API key or a subscription token source; the adapter never reads credentials itself.
 */
export function createResponsesProvider(options: {
  id: string
  model: string
  baseUrl: string
  headers(): Promise<Record<string, string>>
  effort?: ReasoningEffort
  fetch?: Fetch
  /** Every response's headers (also on errors), e.g. to read pushed quota. */
  onResponseHeaders?(headers: Headers): void
  /** Abandon a request or stream after this long without a byte (retryable). */
  idleTimeoutMs?: number
  /**
   * Abandon a request whose response headers have not arrived after this long (retryable). Unset: the idle timeout covers it. Only for
   * a host known to answer at once: the ChatGPT backend sent headers and `response.created` in 1.2 s on a request whose first text
   * took 21.7 s (measured 2026-10-09), while a local server may hold the headers until its model is loaded.
   */
  headerTimeoutMs?: number
  /**
   * Abandon a request whose response headers arrived but whose body has not sent one byte after this long (retryable). Any byte counts,
   * a keep-alive included, so it never measures "no text yet": a model that reasons for minutes has long since sent `response.created`.
   * Unset: the idle timeout covers it. Same condition as `headerTimeoutMs`: only for a host known to start its stream at once.
   */
  firstEventTimeoutMs?: number
  /** Abandon a stream that sends this many bytes without a single event for the caller (retryable). */
  maxSilentStreamBytes?: number
  /** Send the conversation id as a `session_id` header (the ChatGPT backend routes its cache by it; API-key hosts do not need it). Default true. */
  routingHeader?: boolean
  /** Read per request: `priority` adds `service_tier: "priority"` (the `/fast` toggle); an explicit `service_tier` parameter still wins. */
  serviceTier?(): "priority" | undefined
  /** Hosted tools the host supports; the others a request asks for are left out. All by default. */
  hostedTools?: readonly HostedTool[]
  /** Set for API-key hosts: a 401/403 becomes a clear `[AUTH]` error that names the key instead of a bare status, and an empty tool list sends no tool policy. */
  authHint?: string
  /** Whether a model takes image input; images are replaced by a note when it does not. Every model by default. */
  takesImages?(model: string): boolean
  /** xAI may report uncached input separately when cached_tokens exceeds input_tokens. */
  usageInputIncludesCache?: "auto"
  /** Keep encrypted Responses reasoning for stateless tool-loop replay. */
  reasoningState?: boolean
  /**
   * Send `tool_search` as the API's client-executed tool search, so a found tool is defined in `input` and `tools` never changes
   * (docs/tool-discovery.md). Default: only the ChatGPT backend, where a live canary accepted it (gpt-6.1-sol, 2026-10-12). A host
   * that answers 400 or 422 gets the same call again with the plain function, once, and the session stays on the function.
   */
  clientToolSearch?: boolean
}): ModelProvider {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const responsesUrl = `${options.baseUrl.replace(/\/$/, "")}/responses`
  const idleMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS
  const maxSilentBytes = options.maxSilentStreamBytes ?? MAX_SILENT_STREAM_BYTES
  const nativeOrigin = options.baseUrl.replace(/\/+$/, "")
  const supportsNative = nativeOrigin === "https://api.openai.com/v1" || nativeOrigin === "https://chatgpt.com/backend-api/codex"
  const clientToolSearch = options.clientToolSearch ?? nativeOrigin === "https://chatgpt.com/backend-api/codex"
  const rejectedSearch = new Set<string>()
  /** Conversations whose request ran out of the header deadline, and how many times: each one doubles the deadline of that conversation's later requests. */
  const slowHeaders = new Map<string, number>()
  return {
    id: options.id,
    model: options.model,
    async cacheBinding(model) {
      const headers = new Headers(await options.headers())
      const account = headers.get("chatgpt-account-id"), authorization = headers.get("authorization")
      return { provider: options.id, model: model ?? options.model, endpoint: options.baseUrl, auth: account ? "oauth" : authorization && options.authHint ? "api" : "unknown", transport: "responses", ...(account || authorization ? { account: cacheHash(account ?? authorization) } : {}) }
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      // A per-call model brings its own effort (none = the model's default); otherwise the adapter's.
      const effort = request.model ? request.effort : options.effort
      const model = request.model ?? options.model
      const hostedTools = options.hostedTools ? request.hostedTools?.filter((tool) => options.hostedTools!.includes(tool)) : request.hostedTools
      const discovery = request.tools.some((tool) => tool.name === TOOL_SEARCH_NAME)
      const searchSession = `${request.conversationId ?? ""}\n${model}`
      const messages = withoutUnsupportedImages(request.messages, options.takesImages?.(model) ?? true)
      /** The body and its cache key, with the search as the API's own tool (`client`) or as a plain function. */
      const prepare = async (client: boolean) => {
        const search = client ? searchLoads(request.tools, messages) : undefined
        const tools = toResponsesTools(search?.listed ?? request.tools, hostedTools, client)
        const built: Record<string, unknown> = {
          model,
          instructions: request.system,
          input: [...(request.nativeContext ?? []), ...toResponsesInput(messages, search?.loads)],
          tools,
          // A request without tools (a connection test, a side question) must not name a tool policy on an API-key host, which rejects it.
          // Parallel calls on: the engine runs every call of a step in order, and a model that may batch independent reads and
          // searches into one step needs a third of the round trips (each one re-sends the whole prompt).
          ...(tools.length || !options.authHint ? { tool_choice: "auto", parallel_tool_calls: true } : {}),
          ...(request.maxOutputTokens ? { max_output_tokens: Math.max(16, request.maxOutputTokens) } : {}),
          stream: true,
          store: false,
          ...(request.cacheMode !== "off" && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
          ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
          ...((request.fast ?? options.serviceTier?.() === "priority") ? { service_tier: "priority" } : {}),
        }
        const configured = modelParameters(built, request)
        const body = (await request.transformBody?.(configured)) ?? configured
        const key = request.cacheKeyForBody?.(body)
        if (request.cacheKeyForBody) { if (key) body.prompt_cache_key = key; else delete body.prompt_cache_key }
        if (request.cacheMode === "off") delete body.prompt_cache_key
        return { body, key }
      }
      // The header deadline fits a request the host answers at once. One it cannot answer that fast (a body of several megabytes of images, a
      // loaded connection) would run out of the same deadline on every retry and never end, so each time it does the conversation gets twice as long, up to the idle limit.
      const firstMs = options.headerTimeoutMs !== undefined ? options.headerTimeoutMs * 2 ** Math.min(slowHeaders.get(searchSession) ?? 0, 8) : idleMs
      const firstEventMs = options.firstEventTimeoutMs ?? idleMs
      let watchdog = idleWatchdog(request.signal, idleMs, firstMs, firstEventMs)
      const stalled = () => watchdog.stalled() && !request.signal.aborted
      const ownDeadline = (ms: number) => ms > 0 && (idleMs <= 0 || ms < idleMs)
      const seconds = (ms: number) => `${Math.round(ms / 1_000)}s`
      const stalledError = () => {
        const phase = watchdog.stalledIn()
        // A deadline of its own names itself and is retried at once: the wait already happened, and the next request is usually answered in a second or two.
        const deadline = phase === "request" && ownDeadline(firstMs)
          ? `did not answer the request in ${seconds(firstMs)}`
          : phase === "headers" && ownDeadline(firstEventMs)
            ? `sent no event in ${seconds(firstEventMs)} after answering`
            : undefined
        if (phase === "request" && ownDeadline(firstMs)) {
          if (!slowHeaders.has(searchSession) && slowHeaders.size >= MAX_REJECTED_SEARCH_SESSIONS) slowHeaders.delete(slowHeaders.keys().next().value!)
          slowHeaders.set(searchSession, (slowHeaders.get(searchSession) ?? 0) + 1)
        }
        return new RetryableProviderError(`[PROVIDER]: ${options.id} ${deadline ?? `no data for ${seconds(idleMs)}`}, stream stalled`, undefined, "network", deadline !== undefined)
      }
      const progress = { silentBytes: 0 }
      const send = async function* (client: boolean): AsyncIterable<ModelEvent> {
        const { body, key } = await prepare(client)
        // The backend routes by the session_id header (measured: the body key alone did not reuse the cache).
        const routeKey = key ?? request.cacheKey
        const routing = request.cacheMode !== "off" && routeKey && options.routingHeader !== false ? { session_id: routeKey } : {}
        for await (const event of streamEvents(body, routing, watchdog, progress, discovery, client, request.headers, request.fetch)) {
          progress.silentBytes = 0
          yield event
        }
      }
      try {
        try {
          yield* send(clientToolSearch && discovery && !rejectedSearch.has(searchSession))
        } catch (error) {
          if (!(error instanceof SearchShapeRejected)) throw error
          // Refused before any event: the same call again with the plain function, once. The session is only remembered when that one is
          // answered, so a request refused for another reason (it fails again here, with its own error) does not switch the shape.
          watchdog.dispose()
          watchdog = idleWatchdog(request.signal, idleMs, firstMs, firstEventMs)
          let answered = false
          for await (const event of send(false)) {
            if (!answered) {
              answered = true
              if (rejectedSearch.size >= MAX_REJECTED_SEARCH_SESSIONS) rejectedSearch.delete(rejectedSearch.values().next().value!)
              rejectedSearch.add(searchSession)
            }
            yield event
          }
        }
      } catch (error) {
        throw stalled() ? stalledError() : error
      } finally {
        watchdog.dispose()
      }
      if (stalled()) throw stalledError()
    },
    probe: () => probeUrl({ url: responsesUrl, fetch: doFetch }),
    async nativeBinding(model) {
      if (!supportsNative) return undefined
      const headers = await options.headers()
      // Public account identity and credential category only: no key/token enters the binding.
      return fingerprint({ provider: options.id, origin: nativeOrigin, model: model ?? options.model, account: headers["chatgpt-account-id"] ?? "api", protocol: "responses-v1" })
    },
    async compact(request) {
      if (!supportsNative) throw new NativeCompactionError("unsupported", "No native adapter for this origin")
      const auth = await options.headers()
      let response: Response
      try {
        response = await doFetch(`${responsesUrl}/compact`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json", ...auth },
          body: JSON.stringify({ model: request.model ?? options.model, instructions: request.system, input: [...(request.nativeContext ?? []), ...toResponsesInput(withoutUnsupportedImages(request.messages, options.takesImages?.(request.model ?? options.model) ?? true))], store: false }),
          signal: request.signal,
        })
      } catch {
        throw new NativeCompactionError(request.signal.aborted ? "cancelled" : "http", "Native compaction transport failed")
      }
      options.onResponseHeaders?.(response.headers)
      if (!response.ok) {
        await response.body?.cancel()
        throw new NativeCompactionError("http", `Native compaction failed (${response.status})`, response.status)
      }
      if (!response.body) throw new NativeCompactionError("malformed", "Native compaction returned no body")
      const reader = response.body.getReader()
      const cancel = () => void reader.cancel().catch(() => {})
      request.signal.addEventListener("abort", cancel, { once: true })
      const decoder = new TextDecoder()
      let text = "", bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 8 * 1024 * 1024) throw new NativeCompactionError("oversized", "Native response exceeds 8 MiB")
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
        if (request.signal.aborted) throw new NativeCompactionError("cancelled", "Native compaction cancelled")
        let result: { output?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; id?: unknown }
        try { result = JSON.parse(text) } catch { throw new NativeCompactionError("malformed", "Native compaction returned invalid JSON") }
        if (!result || !Array.isArray(result.output) || !result.output.length || result.output.some((item) => !item || typeof item !== "object" || Array.isArray(item)) || !result.output.some((item) => item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0)) throw new NativeCompactionError("malformed", "Native compaction returned no canonical checkpoint")
        if (Buffer.byteLength(JSON.stringify(result.output)) > 4 * 1024 * 1024) throw new NativeCompactionError("oversized", "Native checkpoint exceeds 4 MiB")
        const requestId = response.headers.get("x-request-id") ?? (typeof result.id === "string" ? result.id : undefined)
        const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
        return { output: result.output as Record<string, unknown>[], ...(requestId ? { requestId } : {}), ...(result.usage ? { usage: { input: tokens(result.usage.input_tokens), output: tokens(result.usage.output_tokens), reasoning: 0, cacheRead: 0, cacheWrite: 0 } } : {}) }
      } finally {
        request.signal.removeEventListener("abort", cancel)
        cancel()
      }
    },
  }

  /** A connection failure is a network wait; a certificate problem never heals; anything else is worth another try. */
  function connectionError(error: unknown) {
    const message = `[PROVIDER]: ${options.id} ${error instanceof Error ? error.message : String(error)}`
    if (isTlsError(error)) return new Error(message)
    return new RetryableProviderError(message, undefined, isNetworkError(error) ? "network" : "transient")
  }

  /** One request and its SSE stream, cancelled by the watchdog's signal (the caller tells a stall from a user cancel). */
  async function* streamEvents(body: Record<string, unknown>, routing: Record<string, string>, watchdog: ReturnType<typeof idleWatchdog>, progress: { silentBytes: number }, discovery: boolean, clientSearch: boolean, pluginHeaders?: Record<string, string>, pluginFetch?: Fetch): AsyncIterable<ModelEvent> {
    const { signal } = watchdog
    // Outside the request's try: a missing or expired login ([AUTH]) stops the turn instead of being retried.
    const auth = pluginHeaders?.authorization ? pluginHeaders : { ...await options.headers(), ...pluginHeaders }
    let response: Response
    try {
      response = await (pluginFetch ?? doFetch)(responsesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...routing, ...auth },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) return
      throw connectionError(error)
    }
    watchdog.touch()
    options.onResponseHeaders?.(response.headers)
    if (!response.ok || !response.body) {
      // A provider may echo part of a credential in its error body; it is redacted before it reaches logs or the UI.
      const detail = redactSecrets((await response.text().catch(() => "")).slice(0, 500)).text
      if (options.authHint && (response.status === 401 || response.status === 403)) throw new Error(`[AUTH]: ${options.id} ${response.status} ${options.authHint} ${detail}`.trim())
      const message = `[PROVIDER]: ${options.id} ${response.status} ${detail}`.trim()
      if (clientSearch && (response.status === 400 || response.status === 422)) throw new SearchShapeRejected(message)
      const quota = response.status === 429 && isQuotaBody(detail)
      if (!quota && (response.status === 408 || response.status === 429 || response.status >= 500)) throw new RetryableProviderError(message, retryAfter(response))
      throw new Error(message)
    }
    let sawToolCall = false
    const reasoning: Record<string, unknown>[] = []
    const runaway = (why: string) => new RetryableProviderError(`[PROVIDER]: ${options.id} ${why}, stream abandoned`)
    const argumentsRanAway = argumentGuard()
    /** The function calls being written, by output item id: their arguments stream under the item's id, the call is named by its call id. */
    const writing = new Map<string, { callId: string; name: string }>()
    const onChunk = (bytes: number) => {
      watchdog.touch()
      progress.silentBytes += bytes
    }
    for await (const data of sseData(response.body, signal, onChunk)) {
      if (data === "[DONE]") break
      if (progress.silentBytes > maxSilentBytes) throw runaway(`${Math.round(progress.silentBytes / 1024)} KB without output`)
      let event: { type?: string; delta?: string; item_id?: string; item?: Record<string, unknown>; response?: Record<string, unknown>; message?: string; error?: { message?: string } }
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      switch (event.type) {
        case "response.function_call_arguments.delta": {
          const why = event.delta ? argumentsRanAway(event.item_id ?? "", event.delta) : undefined
          if (why) throw runaway(why)
          progress.silentBytes = 0
          const call = writing.get(event.item_id ?? "")
          if (call && event.delta) yield { type: "tool_input", callId: call.callId, name: call.name, delta: event.delta }
          break
        }
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", delta: event.delta }
          break
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) yield { type: "reasoning", delta: event.delta }
          break
        case "response.output_item.added": {
          if (event.item?.type === "function_call" && typeof event.item.id === "string" && typeof event.item.call_id === "string" && typeof event.item.name === "string") writing.set(event.item.id, { callId: event.item.call_id, name: event.item.name })
          const hosted = hostedToolEvent(event.item, false)
          if (hosted) yield hosted
          break
        }
        case "response.output_item.done": {
          if (options.reasoningState && event.item?.type === "reasoning" && typeof event.item.encrypted_content === "string") reasoning.push(event.item)
          const hosted = hostedToolEvent(event.item, true)
          if (hosted) yield hosted
          if (event.item?.type === "function_call") {
            sawToolCall = true
            const name = String(event.item.name)
            yield { type: "tool_call", call: { callId: String(event.item.call_id), name: name === TOOL_SEARCH_WIRE_NAME && discovery ? TOOL_SEARCH_NAME : name, args: parseArgs(event.item.arguments) } }
          } else if (clientSearch && event.item?.type === "tool_search_call" && event.item.execution === "client") {
            // The model's search, for the host to run: `arguments` is an object here, not a JSON string.
            sawToolCall = true
            yield { type: "tool_call", call: { callId: String(event.item.call_id), name: TOOL_SEARCH_NAME, args: parseArgs(event.item.arguments) } }
          }
          break
        }
        case "response.completed":
        case "response.incomplete": {
          const usage = event.response?.usage as
            | { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
            | undefined
          if (usage) {
            const cached = usage.input_tokens_details?.cached_tokens ?? 0
            yield {
              type: "usage",
              usage: { input: options.usageInputIncludesCache === "auto" && cached > (usage.input_tokens ?? 0) ? usage.input_tokens ?? 0 : Math.max(0, (usage.input_tokens ?? 0) - cached), output: usage.output_tokens ?? 0, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
            }
          }
          if (options.reasoningState) {
            const output = event.response?.output
            const blocks = Array.isArray(output) ? output.filter((item) => item?.type === "reasoning" && typeof item.encrypted_content === "string") : reasoning
            if (blocks.length) yield { type: "reasoning_state", state: { provider: options.id, model: String(body.model), blocks } }
          }
          yield { type: "finish", reason: event.type === "response.incomplete" ? "length" : sawToolCall ? "tool_calls" : "stop" }
          return
        }
        case "response.failed":
        case "error": {
          const message = event.error?.message ?? (event.response?.error as { message?: string } | undefined)?.message ?? event.message ?? "stream failed"
          throw new RetryableProviderError(`[PROVIDER]: ${options.id} ${message}`)
        }
      }
    }
    if (!signal.aborted) throw new RetryableProviderError(`[PROVIDER]: ${options.id} stream ended without completion`)
  }
}
