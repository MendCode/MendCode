import { describe, expect, test } from "bun:test"
import type { NamedError } from "@mendcode/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Fiber, Layer, Schedule } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Session as SessionNs } from "../../src/session/session"
import { Database, eq } from "../../src/storage/db"
import { SessionStatusTable } from "../../src/session/session.sql"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("test")
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))
const itWithSession = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer))

function apiError(headers?: Record<string, string>, message = "boom"): MessageV2.APIError {
  return MessageV2.APIError.Schema.parse(
    new MessageV2.APIError({
      message,
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("keeps network retries on a short interval instead of reaching 30 seconds", () => {
    const error = apiError(undefined, "Network connection lost")
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_NETWORK_INTERVAL)
    expect(SessionRetry.delay(99, error)).toBe(SessionRetry.RETRY_NETWORK_INTERVAL)
  })

  test("does not delay network recovery because of a provider retry hint", () => {
    const error = apiError({ "retry-after-ms": "60000" }, "Network connection lost")
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_NETWORK_INTERVAL)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.live("policy updates retry status and increments attempts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })
        const status = yield* SessionStatus.Service

        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            parse: (err) => MessageV2.APIError.Schema.parse(err),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        yield* step(error)
        yield* step(error)

        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      }),
    ),
  )

  itWithSession.instance("does not write SQLite for a silently throttled retry status", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "retry persistence" })

      yield* status.set(session.id, { type: "busy" })
      const before = Database.use((db) =>
        db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, session.id)).get(),
      )

      yield* status.set(
        session.id,
        { type: "retry", attempt: 2, message: "Network connection lost", next: Date.now() + 1_000 },
        { notify: false },
      )
      const silent = Database.use((db) =>
        db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, session.id)).get(),
      )

      expect(silent?.time_updated).toBe(before?.time_updated)
      expect(silent?.data).toMatchObject({ type: "busy" })
      expect(yield* status.get(session.id)).toMatchObject({ type: "retry", attempt: 2 })

      yield* status.set(
        session.id,
        { type: "retry", attempt: 3, message: "Network connection lost", next: Date.now() + 1_000 },
      )
      const persisted = Database.use((db) =>
        db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, session.id)).get(),
      )
      expect(persisted?.data).toMatchObject({ type: "retry", attempt: 3 })
    }),
  )

  it.effect("keeps transient network retries alive past the normal retry cap", () =>
    Effect.gen(function* () {
      const error = MessageV2.APIError.Schema.parse(
        new MessageV2.APIError({
          message: "Network connection lost",
          isRetryable: true,
          responseHeaders: { "retry-after-ms": "0" },
          metadata: { code: "ENETDOWN" },
        }).toObject(),
      )
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          parse: (err) => MessageV2.APIError.Schema.parse(err),
          set: () => Effect.void,
        }),
      )
      const attempts = SessionRetry.RETRY_MAX_ATTEMPTS + 2
      const fiber = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < attempts; attempt++) {
          yield* step(error)
        }
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(`${attempts} seconds`)
      yield* Fiber.join(fiber)
    }),
  )
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Internal server error")
  })

  test("retries 502 bad gateway errors", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Bad gateway")
  })

  test("retries 503 service unavailable errors", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Service unavailable")
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Response decompression failed")
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("converts fetch failed DNS errors to retryable APIError", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    })
    const error = new TypeError("fetch failed", { cause })

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(result.data.message).toBe("Network unavailable")
    expect(result.data.metadata?.code).toBe("ENOTFOUND")
  })

  test("retries AI SDK connection refusal errors wrapped in an API call error", () => {
    const cause = Object.assign(new Error("connect failed"), {
      code: "ConnectionRefused",
    })
    const error = Object.assign(
      new APICallError({
        message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
        url: "https://chatgpt.com/backend-api/codex/responses",
        requestBodyValues: {},
        isRetryable: false,
      }),
      { cause },
    )

    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(result.data.message).toBe("Provider connection refused")
    expect(result.data.metadata?.code).toBe("ECONNREFUSED")
    expect(SessionRetry.retryable(result)).toBe("Provider connection refused")
    expect(SessionRetry.delay(99, result)).toBe(SessionRetry.RETRY_NETWORK_INTERVAL)
  })

  test("converts connection timeouts to retryable APIError", () => {
    const error = Object.assign(new Error("connection timed out"), {
      code: "ETIMEDOUT",
      syscall: "connect",
    })

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(result.data.message).toBe("Network connection timed out")
    expect(SessionRetry.retryable(result)).toBe("Network connection timed out")
  })

  test("converts undici header and body timeouts to retryable APIError", () => {
    for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      const result = MessageV2.fromError(Object.assign(new Error(`${code}: stream timeout`), { code }), {
        providerID,
      })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Network connection timed out")
      expect(SessionRetry.retryable(result)).toBe("Network connection timed out")
    }
  })

  test("converts unreachable network and socket hang up errors to retryable APIError", () => {
    const cases = [
      {
        input: Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }),
        message: "Network unavailable",
      },
      { input: new Error("Network connection lost"), message: "Network connection lost" },
      { input: new Error("socket hang up"), message: "Network connection lost" },
    ]

    for (const item of cases) {
      const result = MessageV2.fromError(item.input, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe(item.message)
      expect(SessionRetry.retryable(result)).toBe(item.message)
    }
  })

  test("classifies undici request-aborted errors as MessageAbortedError when explicitly aborted", () => {
    const result = MessageV2.fromError(
      Object.assign(new Error("Request aborted"), { code: "UND_ERR_REQUEST_ABORTED" }),
      { providerID, aborted: true },
    )

    expect(result.name).toBe("MessageAbortedError")
    expect(SessionRetry.retryable(result)).toBeUndefined()
  })

  test("keeps silent stream stalls distinct from physical network failures", () => {
    const result = MessageV2.fromError(new Error("SSE read timed out"), { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(result.data.message).toBe("AI backend stream stalled")
    expect(result.data.metadata).toMatchObject({ kind: "stream_timeout", message: "SSE read timed out" })
    expect(MessageV2.isNetworkError(result)).toBe(false)
    expect(SessionRetry.retryable(result)).toBe("AI backend stream stalled")
    expect(SessionRetry.delay(1, result)).toBe(SessionRetry.RETRY_INITIAL_DELAY)
  })

  test("retries processor idle stream watchdog timeouts", () => {
    const msg = "LLM stream timed out after 60000ms without events"
    expect(SessionRetry.retryable(wrap(msg))).toBe(msg)
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result)).toBe("An error occurred while processing your request.")
  })
})
