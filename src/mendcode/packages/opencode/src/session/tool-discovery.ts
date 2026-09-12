import { asSchema, jsonSchema, tool, type Tool, type LanguageModelMiddleware } from "ai"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { MessageV2 } from "./message-v2"

const PRIMARY = new Set([
  "invalid",
  "shell",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "task",
  "task_status",
  "fetch",
  "search",
  "todo",
  "todowrite",
  "skill",
  "loop",
  "workflow",
  "review",
  "sessions",
  "tell",
  "memory",
  "memory_graph",
  "image_gen",
  "question",
  "plan_review",
  "plan_exit",
  "plan",
  "lsp",
  "StructuredOutput",
  "code",
  "tool_search",
  "tool_start",
  "tool_status",
  "tool_wait",
  "tool_cancel",
  "question_async",
  "session_search",
  "session_read",
])
const MAX_DISCOVERED = 64
const MAX_SEARCH_BYTES = 24 * 1024

// OpenAI Responses reserves tool_search for its native protocol. Keep the host
// name (including persisted history) stable, and alias only the SDK boundary.
const WIRE_SEARCH = "mendcode_tool_search"
export function discoveryWireMiddleware(): LanguageModelMiddleware {
  const aliased = new WeakSet<LanguageModelV3CallOptions>()
  return {
    specificationVersion: "v3",
    async transformParams({ params }) {
      const definition = params.tools?.find((item) => item.name === "tool_search")
      if (definition?.type === "provider") return params
      const calls = new Set(params.prompt.flatMap((message) => message.role !== "assistant" ? [] :
        message.content.flatMap((part) => part.type === "tool-call" && part.toolName === "tool_search" && !part.providerExecuted ? [part.toolCallId] : [])))
      if (!definition && calls.size === 0) return params
      for (const message of params.prompt) {
        if (message.role !== "assistant") continue
        for (const part of message.content) {
          if (part.type !== "tool-call" || !calls.has(part.toolCallId)) continue
          if (!part.input || typeof part.input !== "object" || Array.isArray(part.input)) {
            throw new Error(`Invalid stored tool_search arguments for call ${part.toolCallId}. History was preserved; fork the session before this call to recover without replaying the tool.`)
          }
        }
      }
      if (params.tools?.some((item) => item.name === WIRE_SEARCH)) {
        throw new Error("Tool discovery wire-name conflict; rename the custom mendcode_tool_search tool before retrying.")
      }
      const transformed: LanguageModelV3CallOptions = {
        ...params,
        tools: params.tools?.map((item) => item.type === "function" && item.name === "tool_search" ? { ...item, name: WIRE_SEARCH } : item),
        toolChoice: params.toolChoice?.type === "tool" && params.toolChoice.toolName === "tool_search"
          ? { ...params.toolChoice, toolName: WIRE_SEARCH } : params.toolChoice,
        prompt: params.prompt.map((message) => {
          if (message.role !== "assistant" && message.role !== "tool") return message
          return { ...message, content: message.content.map((part) =>
            (part.type === "tool-call" || part.type === "tool-result") && calls.has(part.toolCallId) && part.toolName === "tool_search"
              ? { ...part, toolName: WIRE_SEARCH } : part) } as typeof message
        }),
      }
      aliased.add(transformed)
      return transformed
    },
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate()
      if (!aliased.has(params)) return result
      return { ...result, content: result.content.map((part) =>
        part.type === "tool-call" && part.toolName === WIRE_SEARCH && !part.providerExecuted
          ? { ...part, toolName: "tool_search" } : part) }
    },
    async wrapStream({ doStream, params }) {
      const result = await doStream()
      if (!aliased.has(params)) return result
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          controller.enqueue((part.type === "tool-call" || part.type === "tool-input-start") && part.toolName === WIRE_SEARCH && !part.providerExecuted
            ? { ...part, toolName: "tool_search" } : part)
        },
      })) }
    },
  }
}

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
    description: "Discover additional tools by task, name or keyword, including built-in, package, plugin and connected MCP capabilities. Returns bounded schemas and enables matching tools for subsequent direct calls. Search before assuming a capability is unavailable. Discovery never grants permission to execute a tool.",
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
