import { redactSecrets } from "@mendcode/protocol"
import { isNetworkError, isQuotaBody, isTlsError } from "./network-wait"
import { DEFAULT_STREAM_IDLE_MS, idleWatchdog, retryAfter } from "./openai-responses"
import { RetryableProviderError, type ModelEvent } from "./provider"

/** What the API-key adapters (Anthropic Messages, Chat Completions) share: the POST, its failures and the stall guard. */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>
export type Watchdog = ReturnType<typeof idleWatchdog>

/** Text that may reach a log, an event or a reply: secret-shaped strings and the provider's own key are replaced. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = redactSecrets(text).text
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted:api-key]")
  return out
}

/** A connection failure is a network wait; a certificate problem never heals; anything else is worth another try. */
export function connectionError(providerId: string, error: unknown, secrets: readonly string[] = []) {
  const message = scrub(`[PROVIDER]: ${providerId} ${error instanceof Error ? error.message : String(error)}`, secrets)
  if (error instanceof RetryableProviderError) return new RetryableProviderError(message, error.retryAfterMs, error.kind)
  if (isTlsError(error)) return new Error(message)
  return new RetryableProviderError(message, undefined, isNetworkError(error) ? "network" : "transient")
}

/**
 * The error for a non-2xx answer. 408, 429 (unless the body says the quota is spent) and 5xx retry, honouring
 * `retry-after`; 401/403 name the key; everything else is final. The body is redacted and cut to 500 characters.
 */
export async function httpFailure(input: { providerId: string; response: Response; secrets?: readonly string[] }): Promise<Error> {
  const { providerId, response } = input
  const detail = scrub((await response.text().catch(() => "")).slice(0, 500), input.secrets).trim()
  if (response.status === 401 || response.status === 403) return new Error(`[AUTH]: ${providerId} ${response.status} rejected the API key (check it with providers.set) ${detail}`.trim())
  const message = `[PROVIDER]: ${providerId} ${response.status} ${detail}`.trim()
  const quota = response.status === 429 && isQuotaBody(detail)
  if (!quota && (response.status === 408 || response.status === 429 || response.status >= 500)) return new RetryableProviderError(message, retryAfter(response))
  return new HttpStatusError(message, response.status)
}

/** A final (not retried) non-2xx answer, with its status for an adapter that has another request shape to try. */
export class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Sends the JSON body; resolves to the streaming response, or undefined when the call was cancelled meanwhile. */
export async function postStream(input: { providerId: string; url: string; headers: Record<string, string>; body: unknown; doFetch: Fetch; watchdog: Watchdog; secrets?: readonly string[] }): Promise<Response | undefined> {
  const { signal } = input.watchdog
  let response: Response
  try {
    response = await input.doFetch(input.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "text/event-stream", ...input.headers }, body: JSON.stringify(input.body), signal })
  } catch (error) {
    if (signal.aborted) return undefined
    throw connectionError(input.providerId, error, input.secrets)
  }
  input.watchdog.touch()
  if (!response.ok || !response.body) throw await httpFailure({ providerId: input.providerId, response, ...(input.secrets ? { secrets: input.secrets } : {}) })
  return response
}

/**
 * Runs one streamed call under the idle watchdog: a request that never answers or a stream that goes silent ends as a
 * retryable stall, a user cancel ends quietly, and every other failure passes through.
 */
export async function* guardedStream(input: {
  providerId: string
  signal: AbortSignal
  idleMs?: number
  run(context: { watchdog: Watchdog; progress: { silentBytes: number } }): AsyncIterable<ModelEvent>
}): AsyncIterable<ModelEvent> {
  const idleMs = input.idleMs ?? DEFAULT_STREAM_IDLE_MS
  const watchdog = idleWatchdog(input.signal, idleMs)
  const stalled = () => watchdog.stalled() && !input.signal.aborted
  const stalledError = () => new RetryableProviderError(`[PROVIDER]: ${input.providerId} no data for ${Math.round(idleMs / 1_000)}s, stream stalled`, undefined, "network")
  const progress = { silentBytes: 0 }
  try {
    for await (const event of input.run({ watchdog, progress })) {
      progress.silentBytes = 0
      yield event
    }
  } catch (error) {
    throw stalled() ? stalledError() : error
  } finally {
    watchdog.dispose()
  }
  if (stalled()) throw stalledError()
}

/** Parses tool-call arguments the model streamed as text; text that is not JSON is kept as `_raw` so the tool can say so. */
export function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { _raw: raw }
  }
}

/** `base` without a trailing slash, `path` appended. */
export function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}${path}`
}
