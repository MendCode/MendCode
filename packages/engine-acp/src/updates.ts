import type { EngineEvent } from "@mendcode/kernel"
import type { ItemId } from "@mendcode/protocol"
import { acpToolText, acpToolTitle, hasInput, mergeToolCall, type AcpToolCall } from "./tool-cards"

export const MAX_TEXT = 60 * 1024
const MAX_DIFF_LINES = 40

type Json = Record<string, any>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export function clip(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text
}

/** What an ACP tool kind may do, in MendCode's permission classes. */
export function acpKindPermission(kind: unknown): "read" | "write" | "execute" {
  switch (kind) {
    case "read":
    case "search":
    case "think":
    case "fetch":
      return "read"
    case "edit":
    case "delete":
    case "move":
      return "write"
    default:
      return "execute"
  }
}

/** Text of one ACP content block (`{type:"text"}`, image, resource link…); non-text blocks become a short marker. */
export function blockText(block: unknown): string {
  if (!isRecord(block)) return ""
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : ""
    case "image":
      return "[image]"
    case "audio":
      return "[audio]"
    case "resource_link":
      return typeof block.uri === "string" ? block.uri : "[resource]"
    case "resource":
      return isRecord(block.resource) && typeof block.resource.text === "string" ? block.resource.text : "[resource]"
    default:
      return ""
  }
}

function diffText(item: Json): string {
  const lines = (text: unknown, sign: string) =>
    typeof text === "string" && text !== ""
      ? text
          .split("\n")
          .slice(0, MAX_DIFF_LINES)
          .map((line) => `${sign} ${line}`)
      : []
  return [`${String(item.path ?? "file")}`, ...lines(item.oldText, "-"), ...lines(item.newText, "+")].join("\n")
}

/** The text of a tool call's `content` array: text, diffs (path plus changed lines) and terminal references. */
export function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (!isRecord(item)) return ""
      if (item.type === "content") return blockText(item.content)
      if (item.type === "diff") return diffText(item)
      if (item.type === "terminal") return `[terminal ${String(item.terminalId ?? "")}]`
      return ""
    })
    .filter((text) => text !== "")
    .join("\n")
}

function rawText(raw: unknown): string {
  if (raw === undefined || raw === null) return ""
  if (typeof raw === "string") return raw
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return ""
  }
}

/** The plan's entries as a checklist: `[x]` done, `[~]` in progress, `[ ]` pending. */
export function planText(entries: unknown): string {
  if (!Array.isArray(entries)) return ""
  return entries
    .filter(isRecord)
    .map((entry) => `${entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[~]" : "[ ]"} ${String(entry.content ?? "")}`)
    .join("\n")
}

type OpenText = { kind: "agent_message" | "reasoning"; itemId: ItemId; text: string }

const terminal = (status: unknown) => status === "completed" || status === "failed"

/**
 * Turns the `session/update` notifications of one turn into engine events. Message and thought chunks stream as
 * items; a tool call is one item that completes when its update says completed or failed; the agent's plan is one
 * item that holds the first plan and is completed with the last one when the turn ends.
 */
export function createUpdateMapper(input: { newItemId(): ItemId; emit(event: EngineEvent): void }) {
  let open: OpenText | undefined
  // A call is announced (`item.started`) once its input is known, so its card opens with MendCode's name for it (`shell: ls`).
  const tools = new Map<string, { itemId?: ItemId; call: AcpToolCall }>()
  let plan: { itemId: ItemId; text: string } | undefined

  function closeText() {
    if (!open) return
    input.emit({ type: "item.completed", itemId: open.itemId, status: "ok", text: clip(open.text) })
    open = undefined
  }

  function chunk(kind: "agent_message" | "reasoning", block: unknown) {
    const text = blockText(block)
    if (!text) return
    if (open && open.kind !== kind) closeText()
    if (!open) {
      open = { kind, itemId: input.newItemId(), text: "" }
      input.emit({ type: "item.started", itemId: open.itemId, kind })
    }
    open.text += text
    input.emit({ type: "item.delta", itemId: open.itemId, text: text.slice(0, MAX_TEXT) })
  }

  /** Merges the update into its call; the call's card opens now when its input is known, it runs, ends, or `force` (an approval) asks. */
  function trackTool(update: Json, force = false): ItemId | undefined {
    const toolCallId = String(update.toolCallId ?? "")
    const known = tools.get(toolCallId)
    const tool = { ...known, call: mergeToolCall(known?.call ?? {}, update) }
    tools.set(toolCallId, tool)
    if (tool.itemId || !(force || hasInput(tool.call) || (update.status !== undefined && update.status !== "pending"))) return tool.itemId
    closeText()
    tool.itemId = input.newItemId()
    input.emit({ type: "item.started", itemId: tool.itemId, kind: "tool_call", meta: { tool: acpToolTitle(tool.call), ...(tool.call.kind ? { kind: tool.call.kind } : {}) } })
    return tool.itemId
  }

  function finishTool(update: Json, itemId: ItemId) {
    const toolCallId = String(update.toolCallId ?? "")
    const call = tools.get(toolCallId)?.call ?? {}
    tools.delete(toolCallId)
    const failed = update.status === "failed"
    const text = acpToolText(call, failed) ?? (toolContentText(update.content) || rawText(update.rawOutput))
    input.emit({ type: "item.completed", itemId, status: failed ? "error" : "ok", ...(text ? { text: clip(text) } : {}) })
  }

  return {
    /** The item of a tool call the agent announced, so an approval can point at it. */
    itemOf(toolCallId: unknown): ItemId | undefined {
      return tools.has(String(toolCallId)) ? trackTool({ toolCallId }, true) : undefined
    },

    accept(update: unknown) {
      if (!isRecord(update)) return
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          return chunk("agent_message", update.content)
        case "agent_thought_chunk":
          return chunk("reasoning", update.content)
        // An update for a call that was never announced still deserves a card.
        case "tool_call":
        case "tool_call_update": {
          const itemId = trackTool(update)
          if (itemId && terminal(update.status)) finishTool(update, itemId)
          return
        }
        case "plan": {
          const text = planText(update.entries)
          if (!text) return
          if (!plan) {
            closeText()
            plan = { itemId: input.newItemId(), text }
            input.emit({ type: "item.started", itemId: plan.itemId, kind: "tool_call", meta: { tool: "plan" } })
            input.emit({ type: "item.delta", itemId: plan.itemId, text })
          } else plan.text = text
          return
        }
        default:
          // user_message_chunk (history replay), available_commands_update, current_mode_update…: nothing to show.
          return
      }
    },

    /** Closes what the turn left open: streamed text and the plan end ok, tool calls without a result end interrupted (or error). */
    finish(status: "ok" | "interrupted" | "error") {
      closeText()
      for (const { itemId } of tools.values()) if (itemId) input.emit({ type: "item.completed", itemId, status: status === "error" ? "error" : "interrupted" })
      tools.clear()
      if (plan) {
        input.emit({ type: "item.completed", itemId: plan.itemId, status: "ok", text: clip(plan.text) })
        plan = undefined
      }
    },
  }
}
