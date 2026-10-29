import { emptyUsage, type Usage } from "../lib/types"

export type CodexParse = {
  usage: Usage
  threadId: string | null
  /** `completed` when a turn finished, `failed` on a turn failure or fatal error, `none` when neither was seen. */
  status: "completed" | "failed" | "none"
  error: string | null
  skippedLines: number
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
const NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "error", "user_message", "todo_list"])

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Folds the JSONL of `codex exec --json`: `thread.started`, `item.completed` (command_execution, file_change,
 * mcp_tool_call, web_search, ...), `turn.completed` with a `usage` object and `turn.failed` / `error`.
 * `input_tokens` already contains `cached_input_tokens`; `output_tokens` contains reasoning (`reasoning_output_tokens`).
 * Compactions are not part of this stream: the caller supplies them from the session file or leaves them null.
 */
export function parseCodexEvents(lines: Iterable<string>): CodexParse {
  const usage = emptyUsage()
  let threadId: string | null = null
  let status: CodexParse["status"] = "none"
  let error: string | null = null
  let skippedLines = 0
  let turns = 0
  let input = 0
  let cached = 0
  let output = 0
  let reasoning = 0
  let sawReasoningField = false
  const tools = new Map<string, boolean>()
  let anonymous = 0
  let sawItems = false
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    let event: Obj
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isObj(parsed)) throw new Error("not an object")
      event = parsed
    } catch {
      skippedLines++
      continue
    }
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") threadId = event.thread_id
        break
      case "item.completed": {
        sawItems = true
        const item = event.item
        if (!isObj(item) || typeof item.type !== "string" || NON_TOOL_ITEMS.has(item.type)) break
        const key = typeof item.id === "string" ? item.id : `anonymous-${anonymous++}`
        const failedStatus = item.status === "failed" || item.status === "error" || item.status === "declined"
        const failedExit = typeof item.exit_code === "number" && item.exit_code !== 0
        tools.set(key, failedStatus || failedExit)
        break
      }
      case "turn.completed": {
        if (status === "none") status = "completed"
        turns++
        const used = event.usage
        if (isObj(used)) {
          input += num(used.input_tokens)
          cached += num(used.cached_input_tokens)
          output += num(used.output_tokens)
          if (used.reasoning_output_tokens !== undefined) {
            sawReasoningField = true
            reasoning += num(used.reasoning_output_tokens)
          }
        }
        break
      }
      case "turn.failed":
        status = "failed"
        error = isObj(event.error) && typeof event.error.message === "string" ? event.error.message : "turn failed"
        break
      case "error":
        if (status !== "completed") status = "failed"
        error ??= typeof event.message === "string" ? event.message : "error"
        break
    }
  }
  if (turns > 0) {
    usage.inputTokens = input
    usage.cachedReadTokens = cached
    usage.outputTokens = output
    usage.reasoningTokens = sawReasoningField ? reasoning : null
    // Codex reports no cache-write counter and no per-call count in the exec stream.
  }
  if (sawItems || turns > 0) {
    usage.toolCalls = tools.size
    usage.failedToolCalls = [...tools.values()].filter(Boolean).length
  }
  return { usage, threadId, status, error, skippedLines }
}

export type CodexSessionFacts = {
  /** Last cumulative `total_token_usage` of the session, when present. */
  totals: { input: number; cached: number; output: number; reasoning: number | null } | null
  /** Records of type `compacted` (auto or manual context compaction). */
  compactions: number
}

/** Reads the facts the exec stream lacks from a Codex rollout file (`$CODEX_HOME/sessions/**\/rollout-*.jsonl`). */
export function parseCodexSession(lines: Iterable<string>): CodexSessionFacts {
  let totals: CodexSessionFacts["totals"] = null
  let compactions = 0
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    let record: Obj
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isObj(parsed)) continue
      record = parsed
    } catch {
      continue
    }
    if (record.type === "compacted") compactions++
    if (record.type !== "event_msg" || !isObj(record.payload) || record.payload.type !== "token_count") continue
    const info = record.payload.info
    const total = isObj(info) ? info.total_token_usage : undefined
    if (!isObj(total)) continue
    totals = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      output: num(total.output_tokens),
      reasoning: total.reasoning_output_tokens === undefined ? null : num(total.reasoning_output_tokens),
    }
  }
  return { totals, compactions }
}

/** Fills what the exec stream could not say (reasoning, compactions) from the session file, never overriding counted values. */
export function mergeSessionFacts(usage: Usage, session: CodexSessionFacts | null): Usage {
  if (!session) return usage
  const merged: Usage = { ...usage, compactions: session.compactions }
  if (merged.reasoningTokens === null && session.totals?.reasoning !== null && session.totals?.reasoning !== undefined) merged.reasoningTokens = session.totals.reasoning
  if (merged.inputTokens === null && session.totals) {
    merged.inputTokens = session.totals.input
    merged.cachedReadTokens = session.totals.cached
    merged.outputTokens = session.totals.output
  }
  return merged
}
