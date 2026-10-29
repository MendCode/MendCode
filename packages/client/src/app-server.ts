import type { AppServerItem, AppServerMessage, AppServerMethods, AppServerNotifications, AppServerServerRequests, AppServerTurn } from "@mendcode/protocol/wire"

/**
 * A typed client for `mendcode app-server` (docs/embedding.md). It owns no process: give it the server's stdout
 * lines with `receive` and a `write` for its stdin, so it works over a spawned child, a pipe or a test double.
 * `examples/app-server-client.ts` spawns the real server with it.
 */
export type AppServerClientOptions = {
  /** Writes one line (already ending in a newline) to the server's stdin. */
  write(line: string): void
  clientInfo: { name: string; version?: string }
  /** Answers on the host's behalf when the server asks; each key is a server request method. Unhandled requests are declined. */
  handlers?: { [K in keyof AppServerServerRequests]?: (params: AppServerServerRequests[K]["params"]) => Promise<AppServerServerRequests[K]["result"]> | AppServerServerRequests[K]["result"] }
  /** Fails a request that gets no reply in this many milliseconds (default: wait). */
  timeoutMs?: number
}

export class AppServerError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

type Waiting = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> | undefined }
type Listener = (method: string, params: unknown) => void

export type TurnResult = { turn: AppServerTurn; text: string; items: AppServerItem[] }

export function createAppServerClient(options: AppServerClientOptions) {
  let nextId = 1
  const waiting = new Map<number | string, Waiting>()
  const listeners = new Set<Listener>()
  const closers = new Set<(error: Error) => void>()
  let closed = false

  const write = (message: Record<string, unknown>) => options.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)

  function request<M extends keyof AppServerMethods>(method: M, params: AppServerMethods[M]["params"]): Promise<AppServerMethods[M]["result"]> {
    if (closed) return Promise.reject(new Error("the app-server client is closed"))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const entry: Waiting = { resolve: resolve as (value: unknown) => void, reject }
      if (options.timeoutMs) entry.timer = setTimeout(() => (waiting.delete(id), reject(new Error(`${method} timed out`))), options.timeoutMs)
      waiting.set(id, entry)
      write({ id, method, params })
    })
  }

  async function answer(message: AppServerMessage) {
    const handler = options.handlers?.[message.method as keyof AppServerServerRequests] as ((params: unknown) => unknown) | undefined
    try {
      if (!handler) return write({ id: message.id, error: { code: -32601, message: `no handler for ${message.method}` } })
      write({ id: message.id, result: await handler(message.params) })
    } catch (error) {
      write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  function receive(line: string) {
    if (!line.trim()) return
    let message: AppServerMessage
    try {
      message = JSON.parse(line) as AppServerMessage
    } catch {
      return
    }
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) void answer(message)
      else for (const listener of listeners) listener(message.method, message.params)
      return
    }
    if (message.id === undefined || message.id === null) return
    const entry = waiting.get(message.id)
    if (!entry) return
    waiting.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new AppServerError(message.error.code, message.error.message, message.error.data))
    else entry.resolve(message.result)
  }

  /** Subscribes to every notification; returns a function that stops it. */
  function listen(listener: Listener) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  /** Subscribes to one notification with its typed params. */
  function on<N extends keyof AppServerNotifications>(method: N, handler: (params: AppServerNotifications[N]) => void) {
    return listen((name, params) => {
      if (name === method) handler(params as AppServerNotifications[N])
    })
  }

  /** `initialize` then the `initialized` notification, as the handshake wants. */
  async function initialize() {
    const result = await request("initialize", { clientInfo: options.clientInfo })
    write({ method: "initialized", params: {} })
    return result
  }

  /** Starts a turn and resolves when it ends, with the final assistant text and the items it produced. A queued turn is awaited by its queue id. */
  async function runTurn(params: AppServerMethods["turn/start"]["params"]): Promise<TurnResult> {
    // Notifications can arrive in the same chunk as the reply, before this function continues: record them all, then match.
    const itemsByTurn = new Map<string, AppServerItem[]>()
    const turnByQueue = new Map<string, string>()
    const ended = new Map<string, AppServerTurn>()
    let target: string | undefined
    let finish: (() => void) | undefined
    const settle = () => {
      if (target !== undefined && ended.has(target)) finish?.()
    }
    const stops = [
      on("turn/started", (event) => {
        if (event.threadId !== params.threadId) return
        for (const started of [event.queueId, ...(event.joinedQueueIds ?? [])]) {
          turnByQueue.set(started, event.turn.id)
          if (queueId !== undefined && started === queueId) target = event.turn.id
        }
      }),
      on("item/completed", (event) => {
        if (event.threadId === params.threadId) itemsByTurn.set(event.turnId, [...(itemsByTurn.get(event.turnId) ?? []), event.item])
      }),
      on("turn/completed", (event) => {
        if (event.threadId !== params.threadId) return
        ended.set(event.turn.id, event.turn)
        settle()
      }),
    ]
    let queueId: string | undefined
    try {
      const started = await request("turn/start", params)
      queueId = started.queueId
      target = started.turn?.id ?? turnByQueue.get(queueId)
      if (target === undefined || !ended.has(target)) {
        let abort: ((error: Error) => void) | undefined
        await new Promise<void>((resolve, reject) => {
          finish = resolve
          abort = reject
          closers.add(reject)
          settle()
        }).finally(() => abort && closers.delete(abort))
      }
    } finally {
      for (const stop of stops) stop()
    }
    const turn = ended.get(target!)!
    const items = itemsByTurn.get(turn.id) ?? []
    const text = items.filter((item): item is Extract<AppServerItem, { type: "agentMessage" }> => item.type === "agentMessage").map((item) => item.text).join("\n\n")
    return { turn, text, items }
  }

  return {
    request,
    receive,
    listen,
    on,
    initialize,
    runTurn,
    /** Rejects every waiting request; call it when the server's stdout ends. */
    close() {
      closed = true
      for (const abort of closers) abort(new Error("the app-server connection closed"))
      for (const [id, entry] of waiting) {
        clearTimeout(entry.timer)
        entry.reject(new Error("the app-server connection closed"))
        waiting.delete(id)
      }
    },
  }
}

export type AppServerClient = ReturnType<typeof createAppServerClient>
