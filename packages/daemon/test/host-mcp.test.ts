import { describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import type { TurnInput } from "@mendcode/kernel"
import type { SessionId } from "@mendcode/protocol"
import { createHostMcp, hostInstructions, HOST_MCP_SERVER, mcpInputSchema } from "../src/host-mcp"

const SESSION = "ses_host1" as SessionId
const TOOLS = [
  { name: "graph_find", description: "Find code", parameters: { type: "object", properties: { query: { type: "string" } } } },
  { name: "computer_observe", description: "Read the screen", parameters: { type: "object", properties: {} } },
]

function bridge(input: { enabled?: () => boolean } = {}) {
  const calls: Array<{ name: string; args: unknown; turn: string }> = []
  let handler: ((request: Request) => Promise<Response>) | undefined
  const host = createHostMcp({
    enabled: input.enabled ?? (() => true),
    directory: () => "/project",
    tools: async () => TOOLS,
    call: async ({ turn, name, args }) => {
      calls.push({ name, args, turn: turn.turnId })
      return name === "computer_observe" ? { output: "window", isError: false, images: [{ mime: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) }] } : { output: `found ${JSON.stringify(args)}`, isError: false }
    },
    listen: (handle) => { handler = handle; return { url: "http://127.0.0.1:1/mcp", stop() { handler = undefined } } },
  })
  const config = () => {
    const args = host.args(SESSION)
    const file = args[1]!
    return { args, file, server: JSON.parse(readFileSync(file, "utf8")).mcpServers[HOST_MCP_SERVER] as { url: string; headers: { Authorization: string } } }
  }
  const post = async (authorization: string, body: unknown, headers: Record<string, string> = {}) => handler!(new Request("http://127.0.0.1:1/mcp", { method: "POST", headers: { "content-type": "application/json", authorization, ...headers }, body: JSON.stringify(body) }))
  const rpc = async (authorization: string, method: string, params?: unknown) => (await (await post(authorization, { jsonrpc: "2.0", id: 1, method, params })).json()) as any
  const turn = (turnId: string, signal = new AbortController().signal) => ({ sessionId: SESSION, turnId, signal }) as unknown as TurnInput
  return { host, calls, config, post, rpc, turn }
}

describe("native tools bridge for another harness", () => {
  test("a session's process gets one private config file and the same flags every time", () => {
    const { config } = bridge()
    const first = config()
    expect(first.args[0]).toBe("--mcp-config")
    expect(statSync(first.file).mode & 0o777).toBe(0o600)
    expect(first.server.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
    expect(config().args).toEqual(first.args)
    expect(config().server.headers.Authorization).toBe(first.server.headers.Authorization)
  })

  test("the feature off gives no flags and refuses a bearer that was good", async () => {
    let on = true
    const { config, post, host } = bridge({ enabled: () => on })
    const { server } = config()
    on = false
    expect(host.args(SESSION)).toEqual([])
    expect((await post(server.headers.Authorization, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401)
  })

  test("a wrong bearer and a browser origin are refused", async () => {
    const { config, post } = bridge()
    const { server } = config()
    expect((await post("Bearer nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401)
    expect((await post(server.headers.Authorization, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://evil.test" })).status).toBe(403)
  })

  test("the tools listed are the session's, and the instructions name only what it has", async () => {
    const { config, rpc } = bridge()
    const auth = config().server.headers.Authorization
    const listed = await rpc(auth, "tools/list")
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["graph_find", "computer_observe"])
    expect(listed.result.tools[0].inputSchema.properties.query.type).toBe("string")
    const hello = await rpc(auth, "initialize", { protocolVersion: "2025-06-18" })
    expect(hello.result.serverInfo.name).toBe("mendcode")
    expect(hello.result.instructions).toContain("graph_find")
    expect(hello.result.instructions).toContain("computer_observe")
    expect(hostInstructions([TOOLS[0]!])).not.toContain("computer_")
    expect(hostInstructions([])).not.toContain("graph_")
  })

  test("a session with MendCode's web tools is told to use them when its own fetch or search refuses a site", () => {
    const fetch = { name: "webfetch", description: "Fetch a page", parameters: { type: "object", properties: {} } }
    expect(hostInstructions([fetch])).toContain("mcp__mendcode__webfetch")
    expect(hostInstructions(TOOLS)).not.toContain("mcp__mendcode__webfetch")
  })

  test("a session with image_gen is told it can make images, one without it is not", () => {
    const image = { name: "image_gen", description: "Generate an image", parameters: { type: "object", properties: {} } }
    expect(hostInstructions([image])).toContain("mcp__mendcode__image_gen")
    expect(hostInstructions(TOOLS)).not.toContain("image_gen")
  })

  test("a call runs as a call of the session's running turn, and only while one runs", async () => {
    const { config, rpc, host, calls, turn } = bridge()
    const auth = config().server.headers.Authorization
    const idle = await rpc(auth, "tools/call", { name: "graph_find", arguments: { query: "x" } })
    expect(idle.result).toEqual({ content: [{ type: "text", text: "No turn is running in this session" }], isError: true })
    expect(calls).toEqual([])
    const leave = host.enter(turn("turn_1"))
    const found = await rpc(auth, "tools/call", { name: "graph_find", arguments: { query: "x" } })
    expect(found.result).toEqual({ content: [{ type: "text", text: 'found {"query":"x"}' }], isError: false })
    expect(calls).toEqual([{ name: "graph_find", args: { query: "x" }, turn: "turn_1" }])
    const seen = await rpc(auth, "tools/call", { name: "computer_observe", arguments: {} })
    expect(seen.result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "AQID" })
    leave()
    expect((await rpc(auth, "tools/call", { name: "graph_find", arguments: {} })).result.isError).toBe(true)
  })

  test("a cancelled turn takes no more calls; an older turn's end does not close a newer one", async () => {
    const { config, rpc, host, calls, turn } = bridge()
    const auth = config().server.headers.Authorization
    const cancel = new AbortController()
    const leaveOld = host.enter(turn("turn_1", cancel.signal))
    cancel.abort()
    expect((await rpc(auth, "tools/call", { name: "graph_find", arguments: {} })).result.isError).toBe(true)
    host.enter(turn("turn_2"))
    leaveOld()
    expect((await rpc(auth, "tools/call", { name: "graph_find", arguments: {} })).result.isError).toBe(false)
    expect(calls.map((call) => call.turn)).toEqual(["turn_2"])
  })
})

describe("tool schemas Claude Code accepts", () => {
  test("a root oneOf of actions becomes one object schema: the actions as an enum, required only what every action needs", () => {
    const settings = { oneOf: [
      { type: "object", properties: { action: { type: "string", const: "get" }, keys: { type: "array", items: { type: "string" } } }, required: ["action"] },
      { type: "object", properties: { action: { type: "string", const: "propose" }, patch: { type: "object" }, reason: { type: "string" } }, required: ["action", "patch"] },
    ] }
    expect(mcpInputSchema(settings)).toEqual({ type: "object", properties: {
      action: { type: "string", enum: ["get", "propose"] },
      keys: { type: "array", items: { type: "string" } },
      patch: { type: "object" },
      reason: { type: "string" },
    }, required: ["action"] })
  })

  test("a property that differs beyond its const keeps each shape under anyOf; an object schema passes unchanged", () => {
    const union = { anyOf: [
      { type: "object", properties: { scope: { type: "string", enum: ["user"] } } },
      { type: "object", properties: { scope: { type: "number" } } },
    ] }
    expect(mcpInputSchema(union)).toEqual({ type: "object", properties: { scope: { anyOf: [{ type: "string", enum: ["user"] }, { type: "number" }] } } })
    expect(mcpInputSchema(TOOLS[0]!.parameters)).toBe(TOOLS[0]!.parameters)
    expect(mcpInputSchema(undefined)).toEqual({ type: "object" })
  })

  test("tools/list serves every tool with an object inputSchema, so one union tool does not hide the others", async () => {
    const bridge = createHostMcp({
      enabled: () => true,
      directory: () => "/project",
      tools: async () => [...TOOLS, { name: "mendcode_settings", description: "Settings", parameters: { oneOf: [{ type: "object", properties: { action: { type: "string", const: "get" } }, required: ["action"] }] } }],
      call: async () => ({ output: "", isError: false }),
      listen: () => ({ url: "http://127.0.0.1:1/mcp", stop() {} }),
    })
    const server = JSON.parse(readFileSync(bridge.args(SESSION)[1]!, "utf8")).mcpServers[HOST_MCP_SERVER]
    const response = await bridge.handle(new Request(server.url, { method: "POST", headers: { authorization: server.headers.Authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }))
    const tools = ((await response.json()) as { result: { tools: Array<{ name: string; inputSchema: { type?: string; oneOf?: unknown } }> } }).result.tools
    expect(tools.map((tool) => [tool.name, tool.inputSchema.type, tool.inputSchema.oneOf])).toEqual([["graph_find", "object", undefined], ["computer_observe", "object", undefined], ["mendcode_settings", "object", undefined]])
    bridge.stop()
  })
})
