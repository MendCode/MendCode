import type { BlobRef } from "@mendcode/protocol"
import { MAX_CONTEXT_MESSAGES, MAX_CONTEXT_TOOL_CHARS, OMITTED_NOTE, SUMMARY_PREFIX } from "./settings"

/** The native engine's stored message shape (engine-native `ModelMessage`; a test keeps the two assignable). */
export type NativeMessage =
  | { role: "user"; content: string; attachments?: BlobRef[] }
  | { role: "assistant"; content: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> }
  | { role: "tool"; callId: string; name: string; output: string; isError: boolean }

export type ContextToolCall = { callId: string; name: string; args: unknown; output: string; isError: boolean }

const truncate = (text: string) => (text.length > MAX_CONTEXT_TOOL_CHARS ? `${text.slice(0, MAX_CONTEXT_TOOL_CHARS)}\n[output shortened by the legacy MendCode import]` : text)

/**
 * Builds the native engine's history for one imported session while its items are mapped: user text, assistant
 * text, and each tool call with its result (no reasoning). A compaction summary replaces everything before it, so
 * only what follows the last compaction is kept, and at most MAX_CONTEXT_MESSAGES messages.
 */
export function createContextBuilder() {
  let summary: NativeMessage | undefined
  let messages: NativeMessage[] = []
  /** The assistant step being assembled: its text (if any) and the tool calls that follow it. */
  let step: { text: string; calls: ContextToolCall[] } | undefined

  function flush() {
    if (!step) return
    messages.push({ role: "assistant", content: step.text, toolCalls: step.calls.map((call) => ({ callId: call.callId, name: call.name, args: call.args })) })
    for (const call of step.calls) messages.push({ role: "tool", callId: call.callId, name: call.name, output: truncate(call.output), isError: call.isError })
    step = undefined
    // Bounded while mapping: a session with no compaction never holds more than a few windows.
    if (messages.length > MAX_CONTEXT_MESSAGES * 3) messages = messages.slice(-MAX_CONTEXT_MESSAGES * 2)
  }

  return {
    user(text: string, attachments: BlobRef[]) {
      flush()
      if (!text.trim() && attachments.length === 0) return
      messages.push({ role: "user", content: text, ...(attachments.length ? { attachments } : {}) })
    },
    assistantText(text: string) {
      flush()
      if (text.trim()) step = { text, calls: [] }
    },
    tool(call: ContextToolCall) {
      step ??= { text: "", calls: [] }
      step.calls.push(call)
    },
    /** A compaction with a summary is a boundary: the model history restarts from that summary. */
    compaction(summaryText: string) {
      flush()
      if (!summaryText.trim()) return
      summary = { role: "user", content: `${SUMMARY_PREFIX}\n\n${summaryText.trim()}` }
      messages = []
    },
    /** The history to store; empty when the session produced nothing the model could use. */
    build(): NativeMessage[] {
      flush()
      const room = MAX_CONTEXT_MESSAGES - (summary ? 1 : 0)
      let tail = messages.slice(-room)
      // A tool result without its call (cut at the window edge) is not valid history.
      let start = 0
      while (tail[start]?.role === "tool") start++
      tail = tail.slice(start)
      const head: NativeMessage[] = summary ? [summary] : tail[0]?.role === "assistant" ? [{ role: "user", content: OMITTED_NOTE }] : []
      return [...head, ...tail]
    },
  }
}
export type ContextBuilder = ReturnType<typeof createContextBuilder>
