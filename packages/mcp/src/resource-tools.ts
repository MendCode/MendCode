import { z } from "zod"
import { defineTool, truncateText, type ToolResult } from "@mendcode/tools"
import type { McpManager } from "./manager"
import type { McpTool } from "./tools"

export const MCP_RESOURCE_LIST_TOOL = "mcp_resource_list"
export const MCP_RESOURCE_READ_TOOL = "mcp_resource_read"

const MAX_LISTED = 200
const DESCRIPTION_CHARS = 160

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const failure = ({ title, message }: { title: string; message: string }): ToolResult => ({ output: message, truncated: false, title, isError: true })

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/**
 * `mcp_resource_list` and `mcp_resource_read`: the model's own way to see and read what the configured MCP servers
 * expose as resources (the `@server:name` mention is the user's). Read-only by the protocol; the servers are the ones
 * the user configured and the existing per-server limits apply (1 MiB per resource, binary content labelled, never
 * inlined). The tools exist only while some server offers resources or templates.
 */
export async function mcpResourceTools({ manager, directory }: { manager: McpManager; directory: string }): Promise<McpTool[]> {
  const initial = await manager.catalog(directory).catch(() => undefined)
  if (!initial || (initial.resources.length === 0 && initial.templates.length === 0)) return []
  const list = defineTool({
    name: MCP_RESOURCE_LIST_TOOL,
    description: "List the resources (documents, files, records) the configured MCP servers expose, with their URIs, and the URI templates a server accepts. Read one with mcp_resource_read. Optionally limit to one server.",
    permission: "read",
    args: z.object({ server: z.string().min(1).max(200).optional().describe("Only this MCP server (as named in mcp.json)") }),
    async execute(args, context): Promise<ToolResult> {
      const title = args.server ? `mcp resources: ${clip(args.server, 40)}` : "mcp resources"
      if (context.signal.aborted) return failure({ title, message: "cancelled" })
      let report
      try { report = await manager.catalog(directory) } catch (error) { return failure({ title, message: error instanceof Error ? error.message : String(error) }) }
      const resources = report.resources.filter((item) => !args.server || item.server === args.server)
      const templates = report.templates.filter((item) => !args.server || item.server === args.server)
      if (args.server && !resources.length && !templates.length) {
        const known = [...new Set([...report.resources, ...report.templates].map((item) => item.server))]
        return failure({ title, message: `no resources from "${args.server}"${known.length ? `; servers with resources: ${known.join(", ")}` : ""}` })
      }
      const lines: string[] = []
      for (const item of resources.slice(0, MAX_LISTED)) lines.push(`${item.server}\t${item.uri}\t${oneLine(item.name)}${item.mimeType ? `\t${item.mimeType}` : ""}${item.description ? `\t${clip(oneLine(item.description), DESCRIPTION_CHARS)}` : ""}`)
      const room = Math.max(0, MAX_LISTED - resources.length)
      const templateLines = templates.slice(0, room).map((item) => `${item.server}\t${item.uriTemplate}\t${oneLine(item.name)} (template: fill in the placeholders, then read)${item.description ? `\t${clip(oneLine(item.description), DESCRIPTION_CHARS)}` : ""}`)
      const hidden = resources.length + templates.length - lines.length - templateLines.length
      const output = [`server\turi\tname\t[mime]\t[description]`, ...lines, ...templateLines, ...(hidden > 0 ? [`… ${hidden} more not shown; name a server to narrow the list`] : []), ...report.issues.filter((issue) => issue.server && (!args.server || issue.server === args.server)).map((issue) => `issue (${issue.server}): ${clip(oneLine(issue.message), 200)}`)].join("\n")
      return { output, truncated: hidden > 0, title: `${title} (${resources.length + templates.length})`, isError: false, meta: { resources: resources.length, templates: templates.length } }
    },
  })
  const read = defineTool({
    name: MCP_RESOURCE_READ_TOOL,
    description: "Read one resource of an MCP server by server name and URI (from mcp_resource_list). Text comes back inline, bounded; binary content is only labelled with its type and size.",
    permission: "read",
    args: z.object({ server: z.string().min(1).max(200).describe("The MCP server, as named in mcp.json"), uri: z.string().min(1).max(4096).describe("The resource URI") }),
    async execute(args, context): Promise<ToolResult> {
      const title = clip(`mcp resource: ${args.server} ${args.uri}`, 80)
      if (context.signal.aborted) return failure({ title, message: "cancelled" })
      try {
        const contents = await manager.readResource({ directory, server: args.server, uri: args.uri, signal: context.signal })
        if (!contents.length) return failure({ title, message: "the server returned no readable content" })
        const parts = contents.map((part) => {
          const head = `--- ${part.uri}${part.mimeType ? ` (${part.mimeType})` : ""} ---`
          if (part.text !== undefined) return `${head}\n${part.text}`
          return `${head}\n[binary content: ${part.mimeType ?? "unknown type"}, ${base64Bytes(part.blob ?? "")} bytes, not shown]`
        })
        const capped = truncateText({ text: parts.join("\n\n") })
        return { output: capped.text, truncated: capped.truncated, title, isError: false, meta: { server: args.server, parts: contents.length } }
      } catch (error) {
        return failure({ title, message: context.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error) })
      }
    },
  })
  return [list, read]
}
