import { Effect, Schema } from "effect"
import * as CodeMode from "./codemode"
import * as Tool from "./tool"

declare const self: Worker
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let sequence = 0
self.onmessage = async (event: MessageEvent) => {
  const message = event.data
  if (message.type === "result") {
    const call = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) call?.reject(new Error(message.error))
    else call?.resolve(message.value)
    return
  }
  if (message.type !== "execute") return
  const tools: Record<string, Tool.Tool<never>> = Object.fromEntries(message.tools.map((item: { name: string; description: string; schema: Tool.JsonSchema }) => [item.name, Tool.make({
    description: item.description,
    input: item.schema,
    output: Schema.Unknown,
    execute: (args) => Effect.tryPromise(() => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      self.postMessage({ type: "call", id, name: item.name, args })
    })),
  })]))
  try {
    const result = await Effect.runPromise(CodeMode.execute({ code: message.code, tools, limits: message.limits }))
    self.postMessage({ type: "done", result })
  } catch (error) {
    self.postMessage({ type: "failed", error: String(error) })
  }
}
