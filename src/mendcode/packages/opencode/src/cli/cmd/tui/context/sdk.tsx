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
    }
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
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
    let watchdog: Timer | undefined
    const maxReconnectAttempts = props.reconnect?.maxAttempts ?? 10
    const retryDelay = props.reconnect?.retryDelay ?? 1000
    const maxRetryDelay = props.reconnect?.maxRetryDelay ?? 30000
    const staleDelay = Math.max(500, props.reconnect?.staleDelay ?? 25_000)

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
      const now = Date.now()
      const type = event.payload.type as string
      const wasReconnecting = connection.status === "reconnecting" || connection.status === "failed"
      const recoveringSince = wasReconnecting ? connection.recoveringSince ?? now : connection.recoveringSince
      const applicationEventAt = isControlEvent(type) ? connection.lastApplicationEventAt : now

      if (type === "server.connected" || type === "server.heartbeat") {
        setConnection({
          status: "connected",
          attempt: 0,
          nextRetryAt: undefined,
          error: undefined,
          lastEventAt: now,
          lastApplicationEventAt: applicationEventAt,
          recoveringSince,
        })
      } else {
        setConnection({
          status: "connected",
          attempt: 0,
          nextRetryAt: undefined,
          error: undefined,
          lastEventAt: now,
          lastApplicationEventAt: now,
          recoveringSince: undefined,
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

    const startWatchdog = () => {
      if (watchdog) clearInterval(watchdog)
      watchdog = setInterval(() => {
        if (abort.signal.aborted) return
        if (connection.status !== "connected") return
        const lastSeen = connection.lastEventAt
        if (!lastSeen || Date.now() - lastSeen <= staleDelay) return
        setConnection({
          status: "reconnecting",
          attempt: Math.max(connection.attempt, 1),
          nextRetryAt: undefined,
          error: "Event stream stalled",
          lastEventAt: lastSeen,
          lastApplicationEventAt: connection.lastApplicationEventAt,
          recoveringSince: connection.recoveringSince ?? Date.now(),
        })
      }, Math.max(1_000, Math.min(5_000, Math.floor(staleDelay / 2))))
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        setConnection("status", "connecting")
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          let error: unknown
          let connectedThisAttempt = false
          try {
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

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
        startWatchdog()
      }
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
      fetch: props.fetch ?? fetch,
      headers: props.headers,
      url: props.url,
      connection,
    }
  },
})
