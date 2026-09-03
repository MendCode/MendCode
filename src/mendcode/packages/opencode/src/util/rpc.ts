type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    let parsed: { type?: string; method?: string; input?: unknown; id?: number }
    try {
      parsed = JSON.parse(evt.data)
    } catch {
      return
    }
    if (parsed.type !== "rpc.request" || typeof parsed.id !== "number") return
    try {
      const method = parsed.method && rpc[parsed.method]
      if (!method) throw new Error(`Unknown RPC method: ${parsed.method ?? "<missing>"}`)
      const result = await method(parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    } catch (error) {
      postMessage(
        JSON.stringify({
          type: "rpc.error",
          error: error instanceof Error ? error.message : String(error),
          id: parsed.id,
        }),
      )
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  addEventListener?: (type: string, listener: (event: Event | ErrorEvent) => void) => void
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  target.onmessage = async (evt) => {
    let parsed: { type?: string; result?: unknown; error?: unknown; id?: number; event?: string; data?: unknown }
    try {
      parsed = JSON.parse(evt.data)
    } catch {
      rejectAll(new Error("RPC worker returned a malformed response"))
      return
    }
    if (parsed.type === "rpc.result") {
      const request = pending.get(parsed.id!)
      if (request) {
        request.resolve(parsed.result)
        pending.delete(parsed.id!)
      }
    }
    if (parsed.type === "rpc.error") {
      const request = pending.get(parsed.id!)
      if (request) {
        request.reject(new Error(typeof parsed.error === "string" ? parsed.error : "RPC worker request failed"))
        pending.delete(parsed.id!)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event!)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  target.addEventListener?.("error", (event) => {
    const message = event instanceof ErrorEvent && event.message ? event.message : "RPC worker failed"
    rejectAll(new Error(message))
  })
  target.addEventListener?.("messageerror", () => rejectAll(new Error("RPC worker message could not be decoded")))
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(error)
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
    close(error = new Error("RPC worker terminated")) {
      rejectAll(error)
      listeners.clear()
    },
  }
}

export * as Rpc from "./rpc"
