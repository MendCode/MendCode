import type { ItemId, ItemKind, SessionEvent } from "@mendcode/protocol"

type Item = { kind: ItemKind; text: string; title?: string; status?: string }

const TOOL_OUTPUT_LINES = 200

function fence(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = "`".repeat(longest + 1)
  return `${ticks}\n${text.replace(/\s+$/, "")}\n${ticks}`
}

function clipLines(text: string, max: number) {
  const lines = text.replace(/\s+$/, "").split("\n")
  return lines.length <= max ? lines.join("\n") : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`
}

/**
 * A session's event log as a readable Markdown document: prompts, answers, tool calls with their
 * output (bounded), compactions and failures. Reasoning is left out unless asked for.
 */
export function sessionToMarkdown(events: SessionEvent[], options: { title?: string; directory?: string; reasoning?: boolean } = {}) {
  const items = new Map<ItemId, Item>()
  const order: Array<{ item?: ItemId; note?: string }> = []
  let directory = options.directory
  for (const event of events) {
    switch (event.type) {
      case "session.created":
        directory ??= event.directory
        break
      case "item.started": {
        const title = typeof event.meta?.tool === "string" ? event.meta.tool : undefined
        items.set(event.itemId, { kind: event.kind, text: "", ...(title ? { title } : {}) })
        order.push({ item: event.itemId })
        break
      }
      case "item.delta": {
        const item = items.get(event.itemId)
        if (item) item.text += event.text
        break
      }
      case "item.completed": {
        const item = items.get(event.itemId)
        if (!item) break
        if (event.text !== undefined && (item.kind !== "tool_call" || event.text || !item.text)) item.text = event.text
        item.status = event.status
        break
      }
      case "turn.failed":
        order.push({ note: `> **Turn failed** (${event.error.code}): ${event.error.message}` })
        break
      case "turn.cancelled":
        order.push({ note: "> Turn cancelled." })
        break
      case "turn.interrupted":
        order.push({ note: `> Turn interrupted (${event.reason}).` })
        break
    }
  }

  const out: string[] = [`# ${options.title?.trim() || "MendCode session"}`]
  if (directory) out.push(`\`${directory}\``)
  for (const entry of order) {
    if (entry.note) {
      out.push(entry.note)
      continue
    }
    const item = items.get(entry.item!)!
    switch (item.kind) {
      case "user_message":
        out.push(`## User\n\n${item.text.trim()}`)
        break
      case "agent_message":
        if (item.text.trim()) out.push(`## Assistant\n\n${item.text.trim()}`)
        break
      case "reasoning":
        if (options.reasoning && item.text.trim()) out.push(`<details><summary>Reasoning</summary>\n\n${item.text.trim()}\n\n</details>`)
        break
      case "tool_call": {
        const status = item.status && item.status !== "ok" ? ` (${item.status})` : ""
        const output = item.text.trim() ? `\n\n${fence(clipLines(item.text, TOOL_OUTPUT_LINES))}` : ""
        out.push(`**Tool:** \`${item.title ?? "tool"}\`${status}${output}`)
        break
      }
      case "compaction":
        out.push(`> Context compacted.${item.text.trim() ? `\n\n<details><summary>Summary</summary>\n\n${item.text.trim()}\n\n</details>` : ""}`)
        break
      default:
        if (item.text.trim()) out.push(item.text.trim())
    }
  }
  return `${out.join("\n\n")}\n`
}
