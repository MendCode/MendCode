/**
 * The process a workflow script runs in. The daemon starts it (under an OS sandbox when the platform has one), sends one
 * `init` line with the script body and then answers its `call` lines; the script never touches the daemon's memory, files or
 * network. Before the first line of the script runs, this file captures what it needs from the runtime and then deletes the
 * powerful globals and the Function constructors, so a script sees only the API of script-runtime.ts.
 *
 * Protocol: newline-delimited JSON on stdin/stdout. In: `{t:"init",body,meta,args,seed,now}` and `{t:"reply",id,ok,value|error,at}`.
 * Out: `{t:"call",id,kind,...}`, `{t:"phase"}`, `{t:"log"}`, `{t:"hb"}`, then `{t:"done",result}` or `{t:"error",message}`.
 * Imports only the runtime and the lexer, which import nothing: the sandbox profile can leave the rest of the disk unreadable.
 */
import { runScriptBody, type CallReply } from "./script-runtime"
import { scanForbidden } from "./script-source"

type Out = Record<string, unknown>
const HEARTBEAT_MS = 1_000

/** Removes what a script must never reach. Everything the host still needs was captured by the caller before this ran. */
export function stripGlobals(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>) {
  for (const name of ["process", "Bun", "fetch", "WebSocket", "Worker", "XMLHttpRequest", "EventSource", "BroadcastChannel", "MessageChannel", "MessagePort", "Response", "Request", "Headers", "navigator", "performance", "crypto", "eval", "setInterval", "setImmediate", "clearInterval", "clearImmediate", "queueMicrotask", "Atomics", "SharedArrayBuffer", "WebAssembly", "Intl", "console", "postMessage", "onmessage", "addEventListener", "removeEventListener", "dispatchEvent", "alert", "prompt", "confirm", "Buffer", "require", "module", "exports", "__dirname", "__filename", "FinalizationRegistry", "WeakRef", "Blob", "File", "ReadableStream", "WritableStream", "TransformStream", "AbortController", "AbortSignal", "Event", "EventTarget", "reportError"]) {
    try {
      delete scope[name]
    } catch {}
    if (name in scope) {
      try {
        Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false })
      } catch {}
    }
  }
  const dead = function disabled() {
    throw new TypeError("dynamic code evaluation is not available in a workflow script")
  }
  const functionProtos = [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]
  for (const proto of functionProtos) {
    try {
      Object.defineProperty(proto, "constructor", { value: dead, configurable: false, writable: false })
    } catch {}
  }
  try {
    Object.defineProperty(scope, "Function", { value: dead, configurable: false, writable: false })
  } catch {}
}

/** Runs the host loop until the script ends. Call once per process. */
export async function runScriptHost(): Promise<void> {
  // Captured before the strip: the only handles to the outside this process keeps.
  const proc = process
  const stdout = proc.stdout
  const exit = proc.exit.bind(proc)
  const stdinStream = Bun.stdin.stream()
  const setHeartbeat = setInterval
  const decoder = new TextDecoder()
  const write = (message: Out) => void stdout.write(`${JSON.stringify(message)}\n`)

  const pending = new Map<number, (reply: CallReply) => void>()
  let initial: ((message: Out) => void) | undefined
  const first = new Promise<Out>((resolve) => (initial = resolve))

  void (async () => {
    let buffer = ""
    for await (const chunk of stdinStream) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: Out
        try {
          message = JSON.parse(line) as Out
        } catch {
          continue
        }
        if (message.t === "init") initial?.(message)
        else if (message.t === "reply" && typeof message.id === "number") {
          const resolve = pending.get(message.id)
          pending.delete(message.id)
          resolve?.(message.ok ? { ok: true, value: message.value, at: Number(message.at) } : { ok: false, error: String(message.error ?? "failed"), at: Number(message.at) })
        }
      }
    }
    exit(0)
  })()

  const init = await first
  const body = String(init.body ?? "")
  const forbidden = scanForbidden(body)
  if (forbidden) {
    write({ t: "error", message: forbidden })
    exit(0)
    return
  }
  setHeartbeat(() => write({ t: "hb" }), HEARTBEAT_MS)

  stripGlobals()

  try {
    const result = await runScriptBody({
      body,
      meta: init.meta,
      args: init.args,
      seed: Number(init.seed) || 1,
      now: Number(init.now) || 0,
      transport: {
        call: (message) =>
          new Promise<CallReply>((resolve) => {
            pending.set(message.id as number, resolve)
            write({ t: "call", ...message })
          }),
        post: (message) => write(message),
      },
    })
    let encoded: string | undefined
    try {
      encoded = result === undefined ? undefined : JSON.stringify(result)
    } catch {
      write({ t: "error", message: "the script returned a value that is not plain JSON" })
      exit(0)
      return
    }
    write({ t: "done", ...(encoded !== undefined ? { result: JSON.parse(encoded) } : {}) })
  } catch (error) {
    write({ t: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  }
  // Let the pipe drain, then end: the daemon also kills this process when it has what it needs.
  setTimeout(() => exit(0), 50)
}

if (import.meta.main) void runScriptHost()
