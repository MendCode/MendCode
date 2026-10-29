import { appendFileSync } from "node:fs"
import { catalogAnswer } from "./catalog-data"

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
let changed = false
let buffer = ""
async function handle(message: { id?: number; method: string; params?: Record<string, any> }) {
  if (process.env.CATALOG_LOG) appendFileSync(process.env.CATALOG_LOG, `${message.method}\n`)
  if (message.id === undefined) return
  let result: unknown
  try {
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: process.env.NO_CATALOG ? { tools: {} } : { tools: {}, resources: { listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: "catalog", version: "1" } }
    else if (message.method === "tools/list") result = { tools: [] }
    else if (message.method === process.env.FAIL_METHOD) throw new Error("catalog category unavailable")
    else if (message.method === "resources/list" && changed) result = { resources: [{ name: "Updated guide", uri: "docs://guide" }] }
    else if (message.method === "resources/read" && message.params?.uri === "docs://refresh") {
      changed = true
      write({ jsonrpc: "2.0", method: "notifications/resources/list_changed" })
      write({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" })
      result = { contents: [{ uri: "docs://refresh", text: "updated" }] }
    } else if (!(process.env.NO_TEMPLATES && message.method === "resources/templates/list")) result = catalogAnswer(message.method, message.params)
    write(result === undefined ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported method" } } : { jsonrpc: "2.0", id: message.id, result })
  } catch (error) { write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } }) }
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let end = buffer.indexOf("\n")
  while (end !== -1) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line.trim()) void handle(JSON.parse(line))
    end = buffer.indexOf("\n")
  }
})
process.stdin.on("end", () => process.exit(0))
