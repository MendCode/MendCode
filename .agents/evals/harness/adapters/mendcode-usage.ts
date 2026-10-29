import { emptyUsage, type Usage } from "../lib/types"

export type MendcodeTurnStatus = "completed" | "failed" | "cancelled" | "interrupted" | "none"

export type MendcodeParse = {
  usage: Usage
  turnStatus: MendcodeTurnStatus
  /** Error message of a failed turn, when the stream carries one. */
  error: string | null
  /** How many times the engine waited to retry a provider call. */
  retries: number
  /** Number of lines that were not JSON (progress noise); they never count toward anything. */
  skippedLines: number
}

type Event = { type?: string; at?: number; itemId?: string; kind?: string; status?: string; state?: string; [key: string]: unknown }

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)

/**
 * Folds the newline-JSON event stream of `mendcode run --json` into the kit's usage record.
 * `usage.recorded` carries uncached `input`, `cacheRead`, `cacheWrite`, `output` (reasoning included) and `reasoning` per model call,
 * so provider input = input + cacheRead + cacheWrite. A stream with no usage event reports null tokens, not zero.
 */
export function parseMendcodeEvents(lines: Iterable<string>): MendcodeParse {
  const usage = emptyUsage()
  let calls = 0
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let reasoning = 0
  const tools = new Map<string, "open" | "ok" | "failed">()
  let compactions = 0
  let startedAt: number | undefined
  let endedAt: number | undefined
  let turnStatus: MendcodeTurnStatus = "none"
  let error: string | null = null
  let retries = 0
  let skippedLines = 0
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    let event: Event
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
      event = parsed as Event
    } catch {
      skippedLines++
      continue
    }
    switch (event.type) {
      case "usage.recorded":
        calls++
        input += num(event.input)
        cacheRead += num(event.cacheRead)
        cacheWrite += num(event.cacheWrite)
        output += num(event.output)
        reasoning += num(event.reasoning)
        break
      case "item.started":
        if (event.kind === "tool_call" && typeof event.itemId === "string") tools.set(event.itemId, "open")
        break
      case "item.completed":
        if (typeof event.itemId === "string" && tools.has(event.itemId)) tools.set(event.itemId, event.status === "ok" ? "ok" : "failed")
        break
      case "compaction.updated":
        if (event.state === "packed") compactions++
        break
      case "turn.retrying":
        retries++
        break
      case "turn.started":
        startedAt ??= num(event.at)
        break
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled":
      case "turn.interrupted":
        endedAt = num(event.at)
        turnStatus = event.type.slice("turn.".length) as MendcodeTurnStatus
        if (event.type === "turn.failed") {
          const failure = event.error as { message?: unknown } | undefined
          error = typeof failure?.message === "string" ? failure.message : typeof event.message === "string" ? event.message : "turn failed"
        }
        break
    }
  }
  if (calls > 0) {
    usage.modelCalls = calls
    usage.inputTokens = input + cacheRead + cacheWrite
    usage.cachedReadTokens = cacheRead
    usage.cacheWriteTokens = cacheWrite
    usage.outputTokens = output
    usage.reasoningTokens = reasoning
  }
  // Tool and compaction counts are knowable from a complete stream even when no model call was priced.
  if (turnStatus !== "none") {
    usage.toolCalls = tools.size
    usage.failedToolCalls = [...tools.values()].filter((state) => state === "failed").length
    usage.compactions = compactions
  }
  if (startedAt !== undefined && endedAt !== undefined) usage.turnMs = Math.max(0, endedAt - startedAt)
  return { usage, turnStatus, error, retries, skippedLines }
}
