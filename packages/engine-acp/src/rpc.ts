import type { AcpTransport } from "./transport"

type Json = Record<string, unknown>

/** An error answer from the agent (or a timeout), with the JSON-RPC code when there was one. */
export class AcpRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
    this.name = "AcpRpcError"
  }
}

export type RpcHandlers = {
  /** A request from the agent (`session/request_permission`…); the returned value is the result, a throw becomes an error answer. */
  onRequest(method: string, params: Json): Promise<unknown>
  onNotification(method: string, params: Json): void
  /** The transport ended (the process exited); pending requests were rejected. */
  onClosed(): void
}

export type RpcPeer = {
  request(method: string, params: Json, options?: { timeoutMs?: number }): Promise<unknown>
  notify(method: string, params: Json): void
  close(): void
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** JSON-RPC 2.0 over an `AcpTransport`: matches answers to requests and routes the agent's own requests and notifications. */
export function createRpcPeer({ transport, handlers, trace }: { transport: AcpTransport; handlers: RpcHandlers; trace?: ((direction: "in" | "out", line: string) => void) | undefined }): RpcPeer {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>()
  let nextId = 1
  let closed = false

  const write = (message: Json) => {
    if (closed) return
    const line = JSON.stringify(message)
    trace?.("out", line)
    transport.write(line)
  }

  async function answerRequest({ id, method, params }: { id: unknown; method: string; params: Json }) {
    try {
      const result = await handlers.onRequest(method, params)
      write({ jsonrpc: "2.0", id, result: result ?? null })
    } catch (error) {
      const code = error instanceof AcpRpcError && error.code !== undefined ? error.code : -32603
      write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  function onMessage(message: Json) {
    const { id, method } = message
    if (typeof method === "string") {
      const params = isRecord(message.params) ? message.params : {}
      if (id !== undefined && id !== null) void answerRequest({ id, method, params })
      else handlers.onNotification(method, params)
      return
    }
    if (typeof id !== "number") return
    const call = pending.get(id)
    if (!call) return
    pending.delete(id)
    if (call.timer) clearTimeout(call.timer)
    if (isRecord(message.error)) call.reject(new AcpRpcError(String(message.error.message ?? "request failed"), typeof message.error.code === "number" ? message.error.code : undefined))
    else call.resolve(message.result)
  }

  function shutdown(reason: string) {
    if (closed) return
    closed = true
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(new AcpRpcError(reason))
    }
    pending.clear()
    handlers.onClosed()
  }

  void (async () => {
    try {
      for await (const line of transport.lines) {
        trace?.("in", line)
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (isRecord(message)) onMessage(message)
      }
    } catch {
      // The process went away; handled below.
    }
    shutdown("the agent process exited")
  })()

  return {
    request(method, params, options) {
      if (closed) return Promise.reject(new AcpRpcError("the agent process exited"))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const call: { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject }
        if (options?.timeoutMs) {
          call.timer = setTimeout(() => {
            pending.delete(id)
            reject(new AcpRpcError(`no answer to ${method} within ${Math.round((options.timeoutMs as number) / 1000)} s`))
          }, options.timeoutMs)
        }
        pending.set(id, call)
        write({ jsonrpc: "2.0", id, method, params })
      })
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params })
    },
    close() {
      shutdown("the connection was closed")
      transport.close()
    },
  }
}
