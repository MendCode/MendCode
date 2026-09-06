import { asSchema, type Tool } from "ai"
import type { Result } from "./codemode"

declare const MENDCODE_CODE_WORKER_PATH: string

/** Worker isolation keeps synchronous interpreter programs off the session event loop.
 * This is a confined language, not an OS sandbox or a hard heap quota.
 * Only host-owned, permission-checked callbacks cross the boundary. */
export async function executeCode(input: {
  code: string
  tools: Record<string, Tool>
  signal?: AbortSignal
  timeoutMs?: number
  invoke(name: string, args: unknown, signal: AbortSignal): Promise<unknown>
}): Promise<Result> {
  if (Buffer.byteLength(input.code) > 32768) throw new Error("Code exceeds 32 KiB")
  input.signal?.throwIfAborted()
  const catalog = await Promise.all(Object.entries(input.tools).filter(([, tool]) => tool.execute).map(async ([name, tool]) => ({
    name, description: tool.description ?? "", schema: await asSchema(tool.inputSchema).jsonSchema,
  })))
  const worker = new Worker(typeof MENDCODE_CODE_WORKER_PATH !== "undefined" ? MENDCODE_CODE_WORKER_PATH : new URL("./worker.ts", import.meta.url).href)
  const controller = new AbortController()
  const running = new Set<Promise<void>>()
  let closed = false
  let count = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    return await new Promise<Result>((resolve, reject) => {
      const finish = (result?: Result, error?: unknown) => {
        if (closed) return
        closed = true
        controller.abort()
        worker.terminate()
        // Wait for host tool finalizers, including pending permission requests.
        void Promise.allSettled([...running]).then(() => error ? reject(error) : resolve(result!))
      }
      abort = () => finish(undefined, input.signal?.reason ?? new Error("Code execution cancelled"))
      input.signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => finish(undefined, new Error("Code execution timed out")), input.timeoutMs ?? 30000)
      worker.onerror = (event) => finish(undefined, new Error(event.message))
      worker.onmessage = (event) => {
        if (closed) return
        const message = event.data
        if (message.type === "done") return finish(message.result)
        if (message.type === "failed") return finish(undefined, new Error(message.error))
        if (message.type !== "call") return
        const call = (async () => {
          try {
            const tool = input.tools[message.name]
            if (!tool?.execute || ++count > 16) throw new Error("Unknown tool or tool-call budget exhausted")
            const schema = asSchema(tool.inputSchema)
            const validated = schema.validate ? await schema.validate(message.args) : { success: true as const, value: message.args }
            if (!validated.success) throw new Error(`Invalid tool input: ${validated.error}`)
            controller.signal.throwIfAborted()
            const value = await input.invoke(message.name, validated.value, controller.signal)
            if (!closed) worker.postMessage({ type: "result", id: message.id, value })
          } catch (error) {
            if (!closed) worker.postMessage({ type: "result", id: message.id, error: String(error) })
          }
        })()
        running.add(call)
        void call.finally(() => running.delete(call))
      }
      worker.postMessage({ type: "execute", code: input.code, tools: catalog, limits: { timeoutMs: input.timeoutMs ?? 30000, maxToolCalls: 16, maxOutputBytes: 24576 } })
      if (input.signal?.aborted) abort()
    })
  } finally {
    closed = true
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    controller.abort()
    worker.terminate()
  }
}
