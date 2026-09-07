import type { NamedError } from "@mendcode/core/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export type Err = ReturnType<NamedError["toObject"]>

export const MANAGED_PROVIDER_LIMIT_MESSAGE = "Managed provider usage limit exceeded. Configure a direct provider in MendCode setup."

export const RETRY_INITIAL_DELAY = 1000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 5000
export const RETRY_NETWORK_INTERVAL = 1000
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_ATTEMPTS = 8
export const RETRY_MAX_DURATION_MS = 15 * 60 * 1000

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError, elapsedMs = 0, now = Date.now()) {
  // Network recovery must not inherit a provider's rate-limit hint. The
  // request is already known to be transport-bound, so probe again quickly.
  if (error && MessageV2.isNetworkError(error)) return elapsedMs < 30_000 ? RETRY_NETWORK_INTERVAL : 5000

  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number(retryAfterMs)
        if (retryAfterMs.trim() && Number.isFinite(parsedMs) && parsedMs >= 0) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number(retryAfter)
        if (retryAfter.trim() && Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = /^[A-Za-z]{3}, /.test(retryAfter) ? Date.parse(retryAfter) - now : NaN
        if (Number.isFinite(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

    }
  }
  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err) {
  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    if (status === 400 || status === 401 || status === 403 || status === 422) return undefined
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) return MANAGED_PROVIDER_LIMIT_MESSAGE
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
  }

  // Check for rate limit patterns in plain text error messages
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("stream timed out")
    ) {
      return msg
    }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return "Too Many Requests"
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return "Provider is overloaded"
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return "Rate Limited"
  }
  return undefined
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  maxAttempts?: number
  maxDurationMs?: number
  onExhausted?: (message: string) => Effect.Effect<void>
}) {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? RETRY_MAX_ATTEMPTS))
  const maxDurationMs = Math.max(1, Math.floor(opts.maxDurationMs ?? RETRY_MAX_DURATION_MS))
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const message = retryable(error)
      if (!message) return Cause.done(meta.attempt)
      const networkFailure = MessageV2.isNetworkError(error)
      const attemptLimit = networkFailure && opts.maxAttempts === undefined ? Number.POSITIVE_INFINITY : maxAttempts
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined, meta.elapsed, now)
        if (meta.attempt >= attemptLimit || meta.elapsed + wait >= maxDurationMs) {
          yield* (opts.onExhausted?.("Recovery paused · retry to continue; retry budget or provider cooldown reached") ?? Effect.void)
          return yield* Cause.done(meta.attempt)
        }
        const status = MessageV2.APIError.isInstance(error) ? error.data.statusCode : undefined
        const label = networkFailure ? "Connection unavailable" : status && status >= 500
          ? `Provider unavailable (${status})` : /stream timed out/i.test(message)
          ? "Provider response stalled" : status === 429 ? "Waiting for provider cooldown" : message
        yield* opts.set({ attempt: meta.attempt, message: label, next: now + wait })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
