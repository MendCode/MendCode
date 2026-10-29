import { estimateTokens } from "@mendcode/protocol/wire"
import type { CompactionConfig, CompactionOverride } from "@mendcode/protocol"
import { pairToolCalls } from "./history"
import type { ModelMessage } from "./provider"

export const SUMMARY_PREFIX = "Summary of the conversation so far (earlier messages were compacted):"
export type CompactionLimits = { contextWindow?: number; inputLimit?: number; outputLimit?: number; provider?: CompactionOverride; model?: CompactionOverride }
export const messageTokens = (message: ModelMessage) => estimateTokens(JSON.stringify(message.role === "user" ? { content: message.content, attachments: message.attachments } : message.role === "tool" ? { name: message.name, output: message.output } : { content: message.content, toolCalls: message.toolCalls }).length)
export const historyTokens = (messages: readonly ModelMessage[]) => messages.reduce((total, message) => total + messageTokens(message), 0)

/** The share of the window the default compaction point never passes (Codex caps its own at the same 90%). */
export const DEFAULT_COMPACTION_PERCENT = 90

export function compactionThreshold(config: CompactionConfig, limits: CompactionLimits, legacy?: number) {
  const window = limits.inputLimit ?? limits.contextWindow
  const absolute = limits.model?.token_limit ?? limits.provider?.token_limit ?? legacy ?? config.token_limit
  if (absolute !== undefined) return window ? Math.min(window, absolute) : absolute
  if (!window) return 160_000
  const percent = limits.model?.threshold ?? limits.provider?.threshold ?? config.threshold
  if (percent !== undefined) return Math.max(1, Math.floor(window * Math.max(1, Math.min(100, percent)) / 100))
  // By default the next request must still fit its reply: a context window shares its room with the output (pi keeps 16k free,
  // opencode 20k or the output limit), an input limit does not. Whichever comes first, 90% or that reserve, is the point.
  const reserve = limits.inputLimit ? 0 : config.reserved ?? Math.min(20_000, limits.outputLimit ?? 20_000)
  return Math.max(1, Math.min(Math.floor(window * DEFAULT_COMPACTION_PERCENT / 100), window - reserve))
}

export function recentBudget(config: CompactionConfig, limits: CompactionLimits) {
  const reserved = config.reserved ?? Math.min(20_000, limits.outputLimit ?? 20_000)
  const usable = Math.max(0, limits.inputLimit ? limits.inputLimit - reserved : (limits.contextWindow ?? 160_000) - (limits.outputLimit ?? 20_000))
  return config.preserve_recent_tokens ?? Math.min(8000, Math.max(2000, Math.floor(usable * .25)))
}

/** Select whole recent turns, or a suffix that starts after a complete tool-call/result group. */
export function splitCompaction(messages: ModelMessage[], config: CompactionConfig, limits: CompactionLimits) {
  const starts = messages.flatMap((message, index) => message.role === "user" && !message.content.startsWith(SUMMARY_PREFIX) ? [index] : [])
  const recent = starts.slice(-Math.min(starts.length, config.tail_turns ?? 2))
  let boundary = messages.length
  let total = 0
  const budget = recentBudget(config, limits)
  if ((config.tail_turns ?? 2) > 0) for (let i = recent.length - 1; i >= 0; i--) {
    const start = recent[i]!, end = recent[i + 1] ?? messages.length
    const size = historyTokens(messages.slice(start, end))
    if (total + size <= budget) { total += size; boundary = start; continue }
    for (let cut = start + 1; cut < end; cut++) {
      if (messages[cut]!.role === "tool") continue
      const suffix = messages.slice(cut, end)
      if (total + historyTokens(suffix) <= budget) { boundary = cut; break }
    }
    break
  }
  return { head: messages.slice(0, boundary), tail: pairToolCalls(messages.slice(boundary)), tailTurns: starts.filter((start) => start >= boundary).length }
}

/** The share of the compaction threshold from which old tool outputs are pruned. */
export const PRUNE_FROM = 0.8
/**
 * Old tool outputs are pruned only once the context has reached 80 % of the compaction threshold: below that nothing is about to
 * overflow, and a prune makes the provider re-read, uncached, everything from the first pruned result on.
 * `contextTokens` is the context as it would be without pruning (the last call's size plus what that call had pruned).
 */
export const pruneDue = (contextTokens: number, compactAt: number) => contextTokens >= compactAt * PRUNE_FROM
/** Tool output tokens that are never pruned, and the least a prune must save. */
const PRUNE_PROTECTED = 40_000, PRUNE_MINIMUM = 20_000
/** Whether a history holds enough tool output for a prune to be possible at all; cheap, so the threshold is only looked up when it is. */
export function prunable(messages: readonly ModelMessage[]) {
  let tokens = 0
  for (const message of messages) if (message.role === "tool" && (tokens += estimateTokens(message.output.length)) > PRUNE_PROTECTED + PRUNE_MINIMUM) return true
  return false
}

/** Old successful tool results only; skill and the two most recent user turns are protected. The caller decides `enabled` (`pruneDue` and the `prune` setting). */
export function pruneToolOutputs(messages: ModelMessage[], enabled = true) {
  if (!enabled) return { messages, tokens: 0 }
  const selected: number[] = []
  let turns = 0, protectedTokens = 0, tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user") {
      if (message.content.startsWith(SUMMARY_PREFIX)) break
      turns++
    }
    if (turns < 2 || message.role !== "tool" || message.isError || message.name === "skill") continue
    if (message.output === "[Old tool output pruned]") break
    const size = estimateTokens(message.output.length)
    protectedTokens += size
    if (protectedTokens > PRUNE_PROTECTED) { selected.push(i); tokens += size }
  }
  if (tokens <= PRUNE_MINIMUM) return { messages, tokens: 0 }
  const indices = new Set(selected)
  return { messages: messages.map((message, index): ModelMessage => {
    if (!indices.has(index) || message.role !== "tool") return message
    const { loadedInstructions, ...rest } = message
    return { ...rest, output: "[Old tool output pruned]" }
  }), tokens }
}
