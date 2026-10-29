import { createHash } from "node:crypto"
import { z } from "zod"
import { truncateText, type Tool, type ToolResult } from "@mendcode/tools"
import type { McpIssue } from "./config"
import { userElicitation } from "./elicitation"
import type { McpManager } from "./manager"

/** A Tool plus the server's original JSON Schema, so the engine can show the model the real argument shape. */
export interface McpTool extends Tool {
  jsonSchema?: Record<string, unknown>
}

const MAX_TOOL_NAME = 64

const sanitize = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_")
const shortHash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 8)

/** `mcp__<server>__<tool>`, restricted to [a-zA-Z0-9_-] and at most 64 chars (overflow is cut and hash-suffixed). */
export function mcpToolName({ server, tool }: { server: string; tool: string }): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`
  if (name.length <= MAX_TOOL_NAME) return name
  return `${name.slice(0, MAX_TOOL_NAME - 9)}_${shortHash(`${server}\0${tool}`)}`
}

const argsSchema = z.record(z.string(), z.unknown())

function clipTitle(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export async function discoverMcpTools({
  manager,
  directory,
}: {
  manager: McpManager
  directory: string
}): Promise<{ tools: McpTool[]; issues: McpIssue[] }> {
  const { tools: found, issues } = await manager.listTools(directory)
  const used = new Set<string>()
  const tools: McpTool[] = []
  for (const { server, tool } of found) {
    let name = mcpToolName({ server, tool: tool.name })
    if (used.has(name)) name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${shortHash(`${server}\0${tool.name}`)}`
    if (used.has(name)) continue
    used.add(name)
    tools.push({
      name,
      description: `[mcp:${server}] ${tool.description ?? tool.name}`,
      permission: "execute",
      args: argsSchema,
      jsonSchema: tool.inputSchema,
      async execute(args, context): Promise<ToolResult> {
        const title = clipTitle(`${server}: ${tool.name}`)
        if (context.signal.aborted) return { output: "cancelled", truncated: false, title, isError: true }
        try {
          const result = await manager.callTool({
            directory,
            server,
            tool: tool.name,
            args: (args ?? {}) as Record<string, unknown>,
            signal: context.signal,
            ...(context.ask ? { elicit: userElicitation({ ask: context.ask }) } : {}),
          })
          const capped = truncateText({ text: result.text })
          return { output: capped.text, truncated: capped.truncated, title, isError: result.isError, meta: { server, tool: tool.name } }
        } catch (error) {
          const message = context.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error)
          return { output: message, truncated: false, title, isError: true, meta: { server, tool: tool.name } }
        }
      },
    })
  }
  return { tools, issues }
}

export async function mcpTools(manager: McpManager, directory: string): Promise<McpTool[]> {
  return (await discoverMcpTools({ manager, directory })).tools
}
