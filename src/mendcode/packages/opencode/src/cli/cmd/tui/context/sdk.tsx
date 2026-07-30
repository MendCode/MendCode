import { createOpencodeClient } from "@mendcode/sdk/v2"
import type { GlobalEvent } from "@mendcode/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Flag } from "@mendcode/core/flag/flag"
import { batch, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export type SDKConnectionRefresh = () => Promise<{
  url: string
  headers?: RequestInit["headers"]
}>

export type SDKConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "failed"

type SDKConnection = {
  status: SDKConnectionStatus
  attempt: number
  nextRetryAt?: number
  error?: string
  lastEventAt?: number
  lastApplicationEventAt?: number
  recoveringSince?: number
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Connection lost"
}

function eventID(event: GlobalEvent) {
  const payload = event.payload as { type?: unknown; id?: unknown; syncEvent?: unknown }
  if (payload.type === "sync" && payload.syncEvent && typeof payload.syncEvent === "object") {
    const id = (payload.syncEvent as { id?: unknown }).id
    if (typeof id === "string" && id) return id
  }
  return typeof payload.id === "string" && payload.id ? payload.id : undefined
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
    reconnect?: {
      maxAttempts?: number
      retryDelay?: number
      maxRetryDelay?: number
      staleDelay?: number
      refresh?: SDKConnectionRefresh
    }
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    let activeURL = props.url
    let activeHeaders = props.headers

    function createSDK(input?: { url: string; headers?: RequestInit["headers"] }) {
      if (input) {
        activeURL = input.url
        activeHeaders = input.headers
      }
      return createOpencodeClient({
        baseUrl: activeURL,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: activeHeaders,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    const [connection, setConnection] = createStore<SDKConnection>({
      status: "connecting",
      attempt: 0,
    })

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const seenEventIDs = new Set<string>()
    const seenEventOrder: string[] = []
    const maxSeenEventIDs = 4096
    let watchdog: Timer | undefined
    let watchdogLastTick = Date.now()
    let sseAttemptStartedAt = Date.now()
    const maxReconnectAttempts = props.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY
    const retryDelay = props.reconnect?.retryDelay ?? 1000
    const maxRetryDelay = props.reconnect?.maxRetryDelay ?? 30_000
    const staleDelay = Math.max(500, props.reconnect?.staleDelay ?? 25_000)
    const watchdogInterval = Math.max(1_000, Math.min(5_000, Math.floor(staleDelay / 2)))

    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const timeout = setTimeout(resolve, ms)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout)
            resolve()
          },
          { once: true },
        )
      })

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const isControlEvent = (type: string) => type === "server.connected" || type === "server.heartbeat"

    const handleEvent = (event: GlobalEvent) => {
      const type = event.payload.type as string
      if (!isControlEvent(type)) {
        const id = eventID(event)
        if (id) {
          if (seenEventIDs.has(id)) return
          seenEventIDs.add(id)
          seenEventOrder.push(id)
          if (seenEventOrder.length > maxSeenEventIDs) {
            const expired = seenEventOrder.shift()
            if (expired) seenEventIDs.delete(expired)
          }
        }
      }
      const now = Date.now()
      const wasReconnecting = connection.status === "reconnecting" || connection.status === "failed"
      const recoveringSince = wasReconnecting ? (connection.recoveringSince ?? now) : connection.recoveringSince
      const recoveryConfirmed = type === "server.heartbeat" && recoveringSince !== undefined
      const applicationEventAt = isControlEvent(type) ? connection.lastApplicationEventAt : now

      if (type === "server.connected" || type === "server.heartbeat") {
        setConnection({
          status: "connected",
          attempt: 0,
          nextRetryAt: undefined,
          error: undefined,
          lastEventAt: now,
          lastApplicationEventAt: applicationEventAt,
          recoveringSince: recoveryConfirmed ? undefined : recoveringSince,
        })
      } else {
        setConnection({
          status: "connected",
          attempt: 0,
          nextRetryAt: undefined,
          error: undefined,
          lastEventAt: now,
          lastApplicationEventAt: now,
          // An application event may have been buffered while the stream was
          // recovering. Keep the recovery marker until a fresh heartbeat proves
          // that the transport is healthy, so the TUI does not flash "generating".
          recoveringSince,
        })
      }

      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    const recoverEventSource = (reason: string) => {
      const now = Date.now()
      setConnection({
        status: "reconnecting",
        attempt: Math.max(connection.attempt, 1),
        nextRetryAt: undefined,
        error: reason,
        lastEventAt: connection.lastEventAt,
        lastApplicationEventAt: connection.lastApplicationEventAt,
        recoveringSince: connection.recoveringSince ?? now,
      })

      const controlEvent = (type: "server.connected" | "server.heartbeat") =>
        ({
          id: `mendcode-recovery-${type}-${now}`,
          directory: "global",
          payload: { id: `mendcode-recovery-${type}-${now}`, type, properties: {} },
        }) as GlobalEvent

      // Worker-backed transports do not have an SSE reconnect handshake. Emit
      // the same control events so SyncProvider refreshes data missed while
      // the machine was asleep, including pending questions and permissions.
      handleEvent(controlEvent("server.connected"))
      handleEvent(controlEvent("server.heartbeat"))
    }

    const startWatchdog = () => {
      if (watchdog) clearInterval(watchdog)
      watchdogLastTick = Date.now()
      watchdog = setInterval(() => {
        if (abort.signal.aborted) return
        const now = Date.now()
        const drift = now - watchdogLastTick
        watchdogLastTick = now
        const resumed = drift > Math.max(staleDelay, watchdogInterval + 5_000)
        if (props.events) {
          if (!resumed || connection.status === "disconnected") return
          recoverEventSource("System resumed; refreshing event state")
          return
        }
        const lastSeen = connection.lastEventAt
        const stalled = connection.status === "connected" && (!lastSeen || now - lastSeen > staleDelay)
        const reconnectStalled =
          (connection.status === "connecting" || connection.status === "reconnecting") &&
          now - sseAttemptStartedAt > staleDelay &&
          (!connection.nextRetryAt || connection.nextRetryAt <= now)
        if (!resumed && !stalled && !reconnectStalled) return
        if (connection.status === "disconnected") return
        if (connection.status === "failed" && !resumed) return
        const reason = resumed
          ? "System resumed; refreshing event stream"
          : stalled
            ? "Event stream stalled"
            : "Reconnect attempt timed out"
        startSSE({ reconnecting: true, reason })
      }, watchdogInterval)
    }

    function startSSE(input?: { reconnecting?: boolean; reason?: string }) {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        setConnection({
          status: input?.reconnecting ? "reconnecting" : "connecting",
          attempt: input?.reconnecting ? Math.max(connection.attempt, 1) : 0,
          nextRetryAt: undefined,
          error: input?.reason,
          lastEventAt: connection.lastEventAt,
          lastApplicationEventAt: connection.lastApplicationEventAt,
          recoveringSince: input?.reconnecting
            ? (connection.recoveringSince ?? Date.now())
            : connection.recoveringSince,
        })
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          sseAttemptStartedAt = Date.now()

          let error: unknown
          let connectedThisAttempt = false
          try {
            if (props.reconnect?.refresh) {
              sdk = createSDK(await props.reconnect.refresh())
            }
            const events = await sdk.global.event({
              signal: ctrl.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await sdk.sync.start().catch(() => {})
            }

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              if (event.payload.type === "server.connected") connectedThisAttempt = true
              handleEvent(event)
            }
          } catch (e) {
            error = e
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          if (connectedThisAttempt) attempt = 0
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          if (attempt > maxReconnectAttempts) {
            setConnection({
              status: "failed",
              attempt: maxReconnectAttempts,
              nextRetryAt: undefined,
              error: error ? errorMessage(error) : "Connection lost",
            })
            break
          }

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          setConnection({
            status: "reconnecting",
            attempt,
            nextRetryAt: Date.now() + backoff,
            error: error ? errorMessage(error) : undefined,
            lastEventAt: connection.lastEventAt,
            lastApplicationEventAt: connection.lastApplicationEventAt,
            recoveringSince: connection.recoveringSince ?? Date.now(),
          })
          await sleep(backoff, ctrl.signal)
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        setConnection({
          status: "connected",
          attempt: 0,
          nextRetryAt: undefined,
          error: undefined,
          lastEventAt: Date.now(),
          lastApplicationEventAt: Date.now(),
          recoveringSince: undefined,
        })
        onCleanup(unsub)
        startWatchdog()

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
        return
      }

        startSSE()
        startWatchdog()
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      setConnection("status", "disconnected")
      if (timer) clearTimeout(timer)
      if (watchdog) clearInterval(watchdog)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      get fetch() {
        return props.fetch ?? fetch
      },
      get headers() {
        return activeHeaders
      },
      get url() {
        return activeURL
      },
      connection,
    }
  },
})
