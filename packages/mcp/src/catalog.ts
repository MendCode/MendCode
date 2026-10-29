export type McpResource = { name: string; uri: string; description?: string; mimeType?: string }
export type McpResourceTemplate = { name: string; uriTemplate: string; description?: string; mimeType?: string }
export type McpPrompt = { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export type McpResourceContent = { uri: string; mimeType?: string; text?: string; blob?: string }
export type McpPromptResult = { description?: string | undefined; messages: Array<{ role: "user" | "assistant"; content: Record<string, unknown> }> }
export type McpCatalog = { resources: McpResource[]; templates: McpResourceTemplate[]; prompts: McpPrompt[]; issues?: string[] }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const optionalText = (item: Record<string, unknown>, key: string) => typeof item[key] === "string" ? { [key]: item[key] } : {}
export const catalogName = (server: string, name: string) => `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}:${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`

export async function catalogList<T>(request: (params?: Record<string, unknown>) => Promise<unknown>, field: string, parse: (value: unknown) => T | undefined): Promise<T[]> {
  const items: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const result = await request(cursor ? { cursor } : undefined)
    if (!record(result) || !Array.isArray(result[field])) throw new Error(`invalid MCP ${field} list`)
    for (const value of result[field]) {
      const item = parse(value)
      if (item) items.push(item)
      if (items.length > 10_000) throw new Error(`MCP ${field} list exceeded 10000 entries`)
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) return items
    if (cursors.has(cursor)) throw new Error(`MCP ${field} list returned a duplicate cursor`)
    cursors.add(cursor)
  }
  throw new Error(`MCP ${field} list exceeded 100 pages`)
}

export function parseResource(value: unknown): McpResource | undefined {
  if (!record(value) || typeof value.name !== "string" || typeof value.uri !== "string") return undefined
  return { name: value.name, uri: value.uri, ...optionalText(value, "description"), ...optionalText(value, "mimeType") }
}

export function parseTemplate(value: unknown): McpResourceTemplate | undefined {
  if (!record(value) || typeof value.name !== "string" || typeof value.uriTemplate !== "string") return undefined
  return { name: value.name, uriTemplate: value.uriTemplate, ...optionalText(value, "description"), ...optionalText(value, "mimeType") }
}

export function parsePrompt(value: unknown): McpPrompt | undefined {
  if (!record(value) || typeof value.name !== "string") return undefined
  const args = Array.isArray(value.arguments) ? value.arguments.flatMap((argument) => record(argument) && typeof argument.name === "string" ? [{ name: argument.name, ...optionalText(argument, "description"), ...(typeof argument.required === "boolean" ? { required: argument.required } : {}) }] : []) : undefined
  return { name: value.name, ...optionalText(value, "description"), ...(args ? { arguments: args } : {}) }
}

export function resourceContents(result: unknown): McpResourceContent[] {
  if (!record(result) || !Array.isArray(result.contents)) throw new Error("invalid MCP resource contents")
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576) throw new Error("MCP resource exceeds 1 MiB")
  return result.contents.flatMap((item) => record(item) && typeof item.uri === "string" && (typeof item.text === "string" || typeof item.blob === "string") ? [{ uri: item.uri, ...optionalText(item, "mimeType"), ...optionalText(item, "text"), ...optionalText(item, "blob") }] : [])
}

export function promptResult(result: unknown): McpPromptResult {
  if (!record(result) || !Array.isArray(result.messages)) throw new Error("invalid MCP prompt result")
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262_144) throw new Error("MCP prompt exceeds 256 KiB")
  return { ...optionalText(result, "description"), messages: result.messages.flatMap((message) => record(message) && (message.role === "user" || message.role === "assistant") && record(message.content) ? [{ role: message.role, content: message.content }] : []) }
}

export function promptText(result: McpPromptResult): string {
  return result.messages.map(({ content }) => content.type === "text" && typeof content.text === "string" ? content.text : content.type === "resource" && record(content.resource) && typeof content.resource.text === "string" ? content.resource.text : "").filter(Boolean).join("\n")
}
