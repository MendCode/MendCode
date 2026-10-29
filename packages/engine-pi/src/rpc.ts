import type { PiTransport } from "./transport"
import { redactSecrets } from "@mendcode/protocol/wire"
import { GATE_STATUS_KEY } from "./gate"

type Json = Record<string, any>

/** A command that pi answered with `success: false`, that timed out, or that was cut off by the process ending. */
export class PiRpcError extends Error {
  constructor(message: string, readonly command?: string) {
    super(message)
    this.name = "PiRpcError"
  }
}

export type PiHandlers = {
  /** Every line that is not the answer to one of our commands: agent events and `extension_ui_request`. */
  onEvent(event: Json): void
  /** The transport ended (the process exited); pending commands were rejected. */
  onClosed(): void
}

export type PiPeer = {
  /** Sends one command and resolves with its `data` once the response with the same id arrives. */
  command(type: string, fields?: Json, options?: { timeoutMs?: number }): Promise<any>
  /** Writes a message that expects no response (`extension_ui_response`). */
  send(message: Json): void
  close(): void
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

function traceLine(line: string): string {
  let message: unknown
  try { message = JSON.parse(line) } catch { return JSON.stringify({ type: "invalid_json" }) }
  // The handshake challenge is process-private; it must not enter a trace file.
  if (isRecord(message) && message.type === "extension_ui_request" && message.method === "setStatus" && message.statusKey === GATE_STATUS_KEY) {
    return JSON.stringify({ type: "extension_ui_request", method: "setStatus", statusKey: GATE_STATUS_KEY })
  }
  // A credential may span multiple delta frames. Trace framing, never their partial text.
  if (isRecord(message) && message.type === "message_update") {
    const update = message.assistantMessageEvent
    return JSON.stringify({ type: "message_update", ...(isRecord(update) && typeof update.type === "string" ? { event: redactSecrets(update.type).text } : {}) })
  }
  return redactSecrets(line).text
}

/** pi's RPC framing over a `PiTransport`: commands carry an `id`, responses echo it, everything else is an event. */
export function createPiPeer({ transport, handlers, trace }: { transport: PiTransport; handlers: PiHandlers; trace?: ((direction: "in" | "out", line: string) => void) | undefined }): PiPeer {
  const pending = new Map<string, { type: string; resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>()
  let nextId = 1
  let closed = false

  const write = (message: Json) => {
    if (closed) return
    const line = JSON.stringify(message)
    trace?.("out", redactSecrets(line).text)
    transport.write(line)
  }

  function shutdown(reason: string) {
    if (closed) return
    closed = true
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(new PiRpcError(reason, call.type))
    }
    pending.clear()
    handlers.onClosed()
  }

  function onMessage(message: Json) {
    if (message.type === "response" && typeof message.id === "string") {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      if (call.timer) clearTimeout(call.timer)
      if (message.success === false) call.reject(new PiRpcError(String(message.error ?? "command failed"), call.type))
      else call.resolve(message.data)
      return
    }
    handlers.onEvent(message)
  }

  void (async () => {
    try {
      for await (const line of transport.lines) {
        if (trace) trace("in", traceLine(line))
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
    shutdown("the pi process exited")
  })()

  return {
    command(type, fields = {}, options) {
      if (closed) return Promise.reject(new PiRpcError("the pi process exited", type))
      const id = `mend-${nextId++}`
      return new Promise((resolve, reject) => {
        const call: { type: string; resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> } = { type, resolve, reject }
        if (options?.timeoutMs) {
          call.timer = setTimeout(() => {
            pending.delete(id)
            reject(new PiRpcError(`no answer to ${type} within ${Math.round((options.timeoutMs as number) / 1000)} s`, type))
          }, options.timeoutMs)
        }
        pending.set(id, call)
        write({ ...fields, id, type })
      })
    },
    send: write,
    close() {
      shutdown("the connection was closed")
      transport.close()
    },
  }
}
