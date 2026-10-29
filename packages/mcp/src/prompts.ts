import { isRecord, McpError } from "./client"
import { promptResult, promptText as catalogPromptText } from "./catalog"

export type McpPromptInfo = { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export type McpServerPrompt = { server: string; prompt: McpPromptInfo }

export async function listAllPrompts(request: (params?: Record<string, unknown>) => Promise<unknown>): Promise<McpPromptInfo[]> {
  const prompts: McpPromptInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    let result: unknown
    try { result = await request(cursor ? { cursor } : undefined) }
    catch (error) { if (error instanceof McpError && error.code === -32601) return []; throw error }
    if (!isRecord(result) || !Array.isArray(result.prompts)) throw new McpError("invalid prompts/list response")
    for (const prompt of result.prompts) {
      if (!isRecord(prompt) || typeof prompt.name !== "string" || !prompt.name || prompt.name.length > 200) continue
      const args = Array.isArray(prompt.arguments) ? prompt.arguments.filter(isRecord).filter((argument) => typeof argument.name === "string" && argument.name.length <= 100).slice(0, 32).map((argument) => ({ name: String(argument.name), ...(argument.required === true ? { required: true } : {}) })) : []
      prompts.push({ name: prompt.name, ...(typeof prompt.description === "string" ? { description: prompt.description.slice(0, 120) } : {}), arguments: args })
      if (prompts.length >= 200) return prompts
    }
    if (typeof result.nextCursor !== "string" || !result.nextCursor) return prompts
    if (cursors.has(result.nextCursor)) throw new McpError("repeated prompts/list cursor")
    cursor = result.nextCursor
    cursors.add(cursor)
  }
  throw new McpError("too many prompts/list pages")
}

export function promptText(result: unknown, catalog = false): string {
  if (!isRecord(result) || !Array.isArray(result.messages)) throw new McpError("invalid prompts/get response")
  const text = catalog ? catalogPromptText(promptResult(result)) : result.messages.map((message) => {
    if (!isRecord(message) || !isRecord(message.content) || message.content.type !== "text" || typeof message.content.text !== "string") throw new McpError("MCP command requires text prompt messages")
    return message.content.text
  }).join("\n\n")
  if (!text.trim() || text.length > 32_000) throw new McpError("MCP prompt must contain 1–32000 characters")
  return text
}
