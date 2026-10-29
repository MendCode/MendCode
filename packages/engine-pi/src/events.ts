import type { EngineEvent } from "@mendcode/kernel"
import type { ItemId } from "@mendcode/protocol"

export const MAX_TEXT = 60 * 1024

type Json = Record<string, any>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export function clip(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text
}

/** The text of a pi content array (`[{type:"text",text}, {type:"image"}…]`); other blocks become a short marker. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (isRecord(block) ? (block.type === "text" && typeof block.text === "string" ? block.text : block.type === "image" ? "[image]" : "") : ""))
    .filter((text) => text !== "")
    .join("\n")
}

type OpenText = { kind: "agent_message" | "reasoning"; itemId: ItemId; text: string }

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/**
 * Turns the events of one pi run into engine events. Text and thinking stream as items, one tool execution is one
 * card, compaction is a card, a retry is reported as a `retrying` event, and each assistant message reports its usage
 * (and the cost pi computed). Control events (`agent_start`, `agent_end`, `agent_settled`, `queue_update`) belong to the engine.
 */
export function createPiMapper(input: { newItemId(): ItemId; emit(event: EngineEvent): void }) {
  const open = new Map<string, OpenText>()
  const tools = new Map<string, { itemId: ItemId; name: string; args?: unknown }>()
  let compaction: ItemId | undefined
  let last: { stopReason?: string; errorMessage?: string } = {}
  let retryFailure: string | undefined

  function close(key: string, status: "ok" | "interrupted" = "ok") {
    const block = open.get(key)
    if (!block) return
    open.delete(key)
    input.emit({ type: "item.completed", itemId: block.itemId, status, text: clip(block.text) })
  }

  function closeText(status: "ok" | "interrupted" = "ok") {
    for (const key of [...open.keys()]) close(key, status)
  }

  function delta(kind: "agent_message" | "reasoning", index: unknown, text: string) {
    const key = `${kind}:${String(index ?? 0)}`
    // A new kind of block closes the others (text, then thinking, then text again are separate cards).
    for (const other of [...open.keys()]) if (other !== key) close(other)
    let block = open.get(key)
    if (!block) {
      block = { kind, itemId: input.newItemId(), text: "" }
      open.set(key, block)
      input.emit({ type: "item.started", itemId: block.itemId, kind })
    }
    if (!text) return
    block.text += text
    input.emit({ type: "item.delta", itemId: block.itemId, text: text.slice(0, MAX_TEXT) })
  }

  function startTool(id: string, name: string, args?: unknown) {
    closeText()
    const itemId = input.newItemId()
    tools.set(id, { itemId, name, ...(args === undefined ? {} : { args }) })
    input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: name.slice(0, 200) } })
    return itemId
  }

  function usage(message: Json) {
    const raw = message.usage
    if (!isRecord(raw)) return
    const inputTokens = number(raw.input)
    const output = number(raw.output)
    const cacheRead = number(raw.cacheRead)
    const cacheWrite = number(raw.cacheWrite)
    if (inputTokens + output + cacheRead + cacheWrite === 0) return
    const cost = isRecord(raw.cost) ? number(raw.cost.total) : 0
    input.emit({
      type: "usage",
      provider: typeof message.provider === "string" ? message.provider : "pi",
      model: typeof message.model === "string" ? message.model : "pi",
      input: inputTokens,
      output,
      reasoning: 0,
      cacheRead,
      cacheWrite,
      ...(cost > 0 ? { costMicros: Math.round(cost * 1_000_000) } : {}),
    })
  }

  return {
    /** The item of a tool call pi announced, so an approval can point at it. */
    itemOf(toolCallId: unknown): ItemId | undefined {
      return tools.get(String(toolCallId))?.itemId
    },

    /** How the last assistant message ended (`stop`, `length`, `toolUse`, `error`, `aborted`) and its error text. */
    lastMessage: () => last,
    /** Why pi gave up retrying, when `auto_retry_end` said so. */
    retryFailure: () => retryFailure,

    accept(event: Json) {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent
          if (!isRecord(update)) return
          const index = update.contentIndex
          switch (update.type) {
            case "text_start":
              return delta("agent_message", index, "")
            case "text_delta":
              return delta("agent_message", index, typeof update.delta === "string" ? update.delta : "")
            case "text_end": {
              const key = `agent_message:${String(index ?? 0)}`
              if (!open.get(key)?.text && typeof update.content === "string" && update.content) delta("agent_message", index, update.content)
              return close(key)
            }
            case "thinking_start":
              return delta("reasoning", index, "")
            case "thinking_delta":
              return delta("reasoning", index, typeof update.delta === "string" ? update.delta : "")
            case "thinking_end": {
              const key = `reasoning:${String(index ?? 0)}`
              if (!open.get(key)?.text && typeof update.content === "string" && update.content) delta("reasoning", index, update.content)
              return close(key)
            }
            default:
              // toolcall_*: the card starts with tool_execution_start, which carries the finished arguments.
              return
          }
        }
        case "message_end": {
          const message = event.message
          if (!isRecord(message) || message.role !== "assistant") return
          closeText()
          usage(message)
          last = { ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}), ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}) }
          return
        }
        case "tool_execution_start": {
          const id = String(event.toolCallId ?? "")
          if (tools.has(id)) return
          startTool(id, String(event.toolName ?? "tool"), event.args)
          return
        }
        case "tool_execution_end": {
          const id = String(event.toolCallId ?? "")
          const known = tools.get(id)
          const itemId = known?.itemId ?? startTool(id, String(event.toolName ?? "tool"))
          tools.delete(id)
          const result = isRecord(event.result) ? event.result : {}
          const text = contentText(result.content)
          const raw = event.args ?? known?.args
          const args = raw === undefined ? undefined : JSON.stringify(raw)
          input.emit({ type: "item.completed", itemId, status: event.isError === true ? "error" : "ok", ...(text ? { text: clip(text) } : {}), ...(args ? { toolInput: clip(args) } : {}) })
          return
        }
        case "compaction_start": {
          closeText()
          compaction = input.newItemId()
          input.emit({ type: "item.started", itemId: compaction, kind: "compaction", meta: { engine: "pi", ...(typeof event.reason === "string" ? { reason: event.reason } : {}) } })
          return
        }
        case "compaction_end": {
          if (!compaction) return
          const itemId = compaction
          compaction = undefined
          const result = isRecord(event.result) ? event.result : undefined
          if (event.aborted === true) return void input.emit({ type: "item.completed", itemId, status: "interrupted" })
          if (!result) return void input.emit({ type: "item.completed", itemId, status: "error", text: clip(String(event.errorMessage ?? "compaction failed")) })
          const tokens = number(result.tokensBefore) && number(result.estimatedTokensAfter) ? ` (${number(result.tokensBefore)} → ${number(result.estimatedTokensAfter)} tokens)` : ""
          input.emit({ type: "item.completed", itemId, status: "ok", text: clip(`${typeof result.summary === "string" ? result.summary : ""}${tokens}`.trim()) })
          return
        }
        case "auto_retry_start":
          input.emit({ type: "retrying", attempt: number(event.attempt) || 1, delayMs: number(event.delayMs), message: String(event.errorMessage ?? "retrying").slice(0, 300) })
          return
        case "auto_retry_end":
          retryFailure = event.success === false ? String(event.finalError ?? "retries exhausted") : undefined
          return
        default:
          return
      }
    },

    /** Closes what the turn left open: text ends ok, tool calls and compaction without a result end interrupted (or error). */
    finish(status: "ok" | "interrupted" | "error") {
      closeText()
      for (const { itemId } of tools.values()) input.emit({ type: "item.completed", itemId, status: status === "error" ? "error" : "interrupted" })
      tools.clear()
      if (compaction) {
        input.emit({ type: "item.completed", itemId: compaction, status: status === "error" ? "error" : "interrupted" })
        compaction = undefined
      }
    },
  }
}
