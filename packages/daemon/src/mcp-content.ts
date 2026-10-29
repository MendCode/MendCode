import type { McpCatalogReport, McpPromptResult, McpResourceContent } from "@mendcode/protocol"
import { promptText } from "@mendcode/mcp"

export type McpContentPort = {
  catalog?(directory: string): Promise<McpCatalogReport>
  readResource?(input: { directory: string; server: string; uri: string }): Promise<McpResourceContent[]>
  getPromptResult?(input: { directory: string; server: string; name: string; args: Record<string, string> }): Promise<McpPromptResult>
  getPrompt?(input: { directory: string; server: string; name: string; args: Record<string, string> }): Promise<McpPromptResult | string>
}

export function mcpCommandArguments(args: string): string[] {
  const values: string[] = []
  const expression = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (const match of args.matchAll(expression)) values.push(match[1]?.replace(/\\(["\\])/g, "$1") ?? match[2] ?? match[3]!)
  return values
}

export async function expandMcpPrompt(port: McpContentPort, directory: string, name: string, args: string): Promise<string | undefined> {
  if (!port.catalog || !port.getPrompt && !port.getPromptResult) return undefined
  const matches = (await port.catalog(directory)).prompts.filter((entry) => entry.id.toLowerCase() === name.toLowerCase())
  if (!matches.length) return undefined
  if (matches.length > 1) throw new Error(`ambiguous MCP prompt /${name}`)
  const prompt = matches[0]!
  const values = mcpCommandArguments(args)
  const inputs: Record<string, string> = {}
  for (const [index, argument] of (prompt.arguments ?? []).entries()) {
    if (values[index] !== undefined) inputs[argument.name] = index === prompt.arguments!.length - 1 ? values.slice(index).join(" ") : values[index]!
    else if (argument.required) throw new Error(`/${name} needs <${argument.name}>`)
  }
  const input = { directory, server: prompt.server, name: prompt.name, args: inputs }
  const text = promptText(await (port.getPromptResult?.(input) ?? port.getPrompt!(input)))
  if (!text.trim()) throw new Error(`MCP prompt /${name} returned no text`)
  return prompt.arguments?.length || !args.trim() ? text : `${text}\n\n${args}`
}

export async function expandMcpMentions(port: McpContentPort, directory: string, text: string, mentionSource = text): Promise<string> {
  const tokens = [...new Set([...mentionSource.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)(?=\s|$)/g)].map((match) => match[1]!).filter((token) => !token.startsWith("thread:")))]
  if (!tokens.length || !port.catalog || !port.readResource) return text
  const catalog = await port.catalog(directory)
  const blocks: string[] = []
  let budget = 128_000
  for (const token of tokens.slice(0, 16)) {
    const matches = catalog.resources.filter((entry) => entry.id === token)
    if (matches.length > 1) throw new Error(`ambiguous MCP resource @${token}`)
    const resource = matches[0]
    if (!resource) throw new Error(`unknown MCP resource @${token}`)
    const contents = await port.readResource({ directory, server: resource.server, uri: resource.uri })
    const body = contents.map((content) => content.text ?? `[binary resource: ${content.mimeType ?? "application/octet-stream"}]`).join("\n")
    const shown = body.slice(0, Math.max(0, budget))
    budget -= shown.length
    blocks.push(`<mcp-resource name="${token}">\n${shown}${shown.length < body.length ? "\n[resource truncated]" : ""}\n</mcp-resource>`)
  }
  if (tokens.length > 16) blocks.push(`[${tokens.length - 16} MCP mentions skipped: limit 16]`)
  return `${text}\n\n${blocks.join("\n\n")}`
}
