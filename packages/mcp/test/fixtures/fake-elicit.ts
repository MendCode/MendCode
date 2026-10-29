// Stdio MCP server whose `ask` tool asks the client a question mid-call (elicitation/create) and reports the answer.
// ELICIT_LOG=<file> records the initialize params.
import { appendFileSync } from "node:fs"

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
let waiting: ((message: Record<string, any>) => void) | undefined

const schemas: Record<string, unknown> = {
  profile: {
    type: "object",
    properties: {
      name: { type: "string", title: "Name", minLength: 2 },
      age: { type: "integer", title: "Age", minimum: 18 },
      subscribe: { type: "boolean", title: "Subscribe" },
      color: { type: "string", title: "Color", oneOf: [{ const: "r", title: "Red" }, { const: "g", title: "Green" }] },
      tags: { type: "array", title: "Tags", items: { type: "string", enum: ["a", "b", "c"] } },
    },
    required: ["name", "age"],
  },
  credential: { type: "object", properties: { apiKey: { type: "string", title: "API key" } }, required: ["apiKey"] },
  none: { type: "object", properties: {} },
}

async function handle(message: Record<string, any>) {
  const { id, method, params } = message
  if (method === undefined && id !== undefined) return waiting?.(message)
  if (id === undefined) return
  if (method === "initialize") {
    if (process.env.ELICIT_LOG) appendFileSync(process.env.ELICIT_LOG, `${JSON.stringify(params)}\n`)
    return write({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "elicit", version: "1" } } })
  }
  if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools: [{ name: "ask", inputSchema: { type: "object" } }] } })
  if (method === "tools/call") {
    const schema = String(params?.arguments?.schema ?? "profile")
    const reply = new Promise<Record<string, any>>((resolve) => (waiting = resolve))
    write({ jsonrpc: "2.0", id: "elicit-1", method: "elicitation/create", params: { message: "Tell me about you", requestedSchema: schemas[schema] } })
    const response = await reply
    return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(response.result ?? response.error) }] } })
  }
  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${method}` } })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) void handle(JSON.parse(line))
    newline = buffer.indexOf("\n")
  }
})
process.stdin.on("end", () => process.exit(0))
