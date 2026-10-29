// Tiny MCP server over stdio for tests. FAKE_LOG=<file> records received notifications.
import { appendFileSync } from "node:fs"

const log = (entry: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`)
}
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const schema = { type: "object", properties: { text: { type: "string" } } }

const pages: Record<string, unknown[]> = {
  first: [
    { name: "echo", description: "Echo text", inputSchema: schema },
    { name: "fail", description: "Always errors", inputSchema: schema },
  ],
  p2: [
    { name: "slow", inputSchema: schema },
    { name: "crash", inputSchema: schema },
    { name: "media", inputSchema: schema },
    { name: "spam", inputSchema: schema },
    { name: "pid", inputSchema: schema },
    { name: "spawn", inputSchema: schema },
  ],
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }, { type: "text", text: "second" }] }
    case "fail":
      return { isError: true, content: [{ type: "text", text: "tool failed" }] }
    case "slow":
      await Bun.sleep(Number(args.ms ?? 5000))
      return { content: [{ type: "text", text: "slow done" }] }
    case "crash":
      process.stderr.write("boom\n")
      process.exit(1)
      return undefined
    case "media":
      return {
        content: [
          { type: "image", mimeType: "image/png", data: Buffer.from("12345678").toString("base64") },
          { type: "resource", resource: { uri: "file:///a.txt", text: "resource text" } },
          { type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA" } },
        ],
      }
    case "spam": {
      for (let i = 0; i < 300; i++) process.stderr.write(`${"x".repeat(999)}\n`)
      process.stderr.write("END-MARKER\n")
      return { content: [{ type: "text", text: "spammed" }] }
    }
    case "pid":
      return { content: [{ type: "text", text: String(process.pid) }] }
    case "spawn": {
      const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
      return { content: [{ type: "text", text: `${process.pid},${child.pid}` }] }
    }
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] }
  }
}

async function handle(message: { id?: number; method: string; params?: Record<string, any> }): Promise<void> {
  const { id, method, params } = message
  if (id === undefined) {
    log({ method, params })
    return
  }
  switch (method) {
    case "initialize":
      log({ method, params })
      write({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } })
      return
    case "tools/list": {
      const cursor = params?.cursor as string | undefined
      const page = cursor === "p2" ? "p2" : "first"
      write({ jsonrpc: "2.0", id, result: { tools: pages[page], ...(page === "first" ? { nextCursor: "p2" } : {}) } })
      return
    }
    case "tools/call":
      write({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments ?? {}) })
      return
    case "prompts/list":
      write({ jsonrpc: "2.0", id, result: params?.cursor === "next" ? { prompts: [{ name: "explain" }] } : { prompts: [{ name: "audit", description: "Inspect code", arguments: [{ name: "scope", required: true }] }], nextCursor: "next" } })
      return
    case "prompts/get":
      write({ jsonrpc: "2.0", id, result: { messages: [{ role: "user", content: { type: "text", text: `Inspect ${params?.arguments?.scope ?? "code"}` } }] } })
      return
    default:
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${method}` } })
  }
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
