import { createHash } from "node:crypto"
import type { ModelMessage, ModelProvider, ModelRequest } from "./provider"
import { pairToolCalls } from "./history"

export type CompactionCheckpoint = {
  version: 1
  generation: number
  method: "legacy" | "incremental" | "native"
  tailTurns: number
  /** Exact retained message count, so side checkpoints can detect intervening work. */
  tailMessages?: number
  native?: { binding: string; fingerprint: string; output: Record<string, unknown>[]; source: ModelMessage[]; requestId?: string }
  previous?: { binding: string; fingerprint: string; output: Record<string, unknown>[] }
}

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")
export const checkpointOf = (messages: readonly ModelMessage[]) => messages[0]?.role === "user" && messages[0].compaction?.version === 1 ? messages[0].compaction : undefined

/** The portable projection stays local, allowing a model/transport change without losing prior context. */
export function portableHistory(messages: ModelMessage[]): ModelMessage[] {
  const checkpoint = checkpointOf(messages)
  if (checkpoint?.native) return [...portableHistory(checkpoint.native.source), ...messages.slice(1)]
  return messages.map((message) => {
    if (message.role !== "user" || !message.compaction) return message
    const { compaction, ...rest } = message
    return rest
  })
}

export async function checkpointContext(provider: ModelProvider, request: Pick<ModelRequest, "system" | "messages" | "tools" | "parameters" | "effort"> & { model?: string | undefined }) {
  const checkpoint = checkpointOf(request.messages)
  const native = checkpoint?.native
  if (!native) return { messages: pairToolCalls(portableHistory(request.messages)) }
  const binding = await provider.nativeBinding?.(request.model)
  const contract = fingerprint({ system: request.system, tools: request.tools, model: request.model ?? provider.model, parameters: request.parameters, effort: request.effort })
  if (binding !== native.binding || contract !== native.fingerprint) return { messages: pairToolCalls(portableHistory(request.messages)) }
  return { messages: pairToolCalls(request.messages.slice(1)), nativeContext: native.output }
}

export class NativeCompactionError extends Error {
  constructor(readonly kind: "unsupported" | "cancelled" | "timeout" | "http" | "malformed" | "oversized" | "stale", message: string, readonly status?: number) {
    super(message)
    this.name = "NativeCompactionError"
  }
}

/** A deadline also settles adapters/fakes that ignore abort; late results can never install a checkpoint. */
export async function compactionDeadline<T>(signal: AbortSignal, milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { scope.abort(); reject(new NativeCompactionError("cancelled", "Compaction cancelled")) }
    signal.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => { scope.abort(); reject(new NativeCompactionError("timeout", "Compaction timed out")) }, milliseconds)
  })
  try {
    if (signal.aborted) throw new NativeCompactionError("cancelled", "Compaction cancelled")
    return await Promise.race([work(scope.signal), stopped])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}
