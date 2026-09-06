import { asSchema, jsonSchema, tool, type Tool } from "ai"
import type { MessageV2 } from "./message-v2"

const PRIMARY = new Set([
  "invalid", "shell", "bash", "read", "glob", "grep", "edit", "write", "apply_patch", "task", "task_status",
  "todowrite", "skill", "question", "plan_review", "plan_exit", "StructuredOutput", "tool_search", "code",
  "tool_start", "tool_status", "tool_wait", "tool_cancel", "question_async", "session_search", "session_read",
])
const MAX_DISCOVERED = 64
const MAX_SEARCH_BYTES = 24 * 1024

export async function searchTools(tools: Record<string, Tool>, query: string, limit = 5) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) ?? []
  const matches = Object.entries(tools)
    .filter(([name]) => name !== "invalid" && name !== "tool_search")
    .map(([name, value]) => {
      const title = name.toLowerCase()
      const description = (value.description ?? "").toLowerCase()
      return { name, value, score: words.reduce((sum, word) => sum + (title === word ? 20 : title.includes(word) ? 8 : description.includes(word) ? 1 : 0), 0) }
    })
    .filter((item) => words.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.min(8, Math.max(1, limit)))
  const items: Array<{ name: string; description: string; inputSchema: unknown }> = []
  let bytes = 0
  for (const item of matches) {
    const entry = {
      name: item.name,
      description: (item.value.description ?? "").slice(0, 3000),
      inputSchema: await asSchema(item.value.inputSchema).jsonSchema,
    }
    const size = Buffer.byteLength(JSON.stringify(entry))
    if (bytes + size > MAX_SEARCH_BYTES) continue
    items.push(entry)
    bytes += size
  }
  return { tools: items, omitted: matches.length - items.length }
}

/** Discovery is monotonic within retained history. Every selected tool is still permission-filtered by the host. */
export function activeToolNames(messages: MessageV2.WithParts[]) {
  const names = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (!PRIMARY.has(part.tool) && names.size < MAX_DISCOVERED) names.add(part.tool)
      if (part.tool !== "tool_search" || part.state.status !== "completed") continue
      const found = part.state.metadata.discoveredTools
      if (!Array.isArray(found)) continue
      for (const name of found) if (typeof name === "string" && !PRIMARY.has(name) && names.size < MAX_DISCOVERED) names.add(name)
    }
  }
  return names
}

export function withToolDiscovery(tools: Record<string, Tool>, messages: MessageV2.WithParts[]) {
  const active = activeToolNames(messages)
  const selected = Object.fromEntries(Object.entries(tools).filter(([name]) => PRIMARY.has(name) || active.has(name)))
  const discoverable = Object.keys(tools).filter((name) => !PRIMARY.has(name))
  if (!discoverable.length) return selected
  selected.tool_search = tool({
    description: "Discover additional tools by task, name or keyword, including memory, workflows, computer screenshots/control, browser tools and connected MCP services. Returns bounded schemas and enables matching tools for subsequent direct calls. Search before assuming a capability is unavailable. Discovery never grants permission to execute a tool.",
    inputSchema: jsonSchema<{ query: string; limit?: number }>({
      type: "object", properties: { query: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 8 } },
      required: ["query"], additionalProperties: false,
    }),
    async execute(args) {
      if (typeof args.query !== "string" || args.query.length > 500) throw new Error("query must be a string of at most 500 characters")
      const result = await searchTools(tools, args.query, args.limit)
      let slots = MAX_DISCOVERED - active.size
      result.tools = result.tools.filter((item) => {
        if (PRIMARY.has(item.name) || active.has(item.name)) return true
        if (slots <= 0) { result.omitted++; return false }
        slots--
        return true
      })
      const names = result.tools.map((item) => item.name)
      return {
        title: "Tool discovery",
        output: JSON.stringify(result),
        metadata: { discoveredTools: names, truncated: false },
      }
    },
  })
  return selected
}
