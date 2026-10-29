// A scripted ACP agent over stdio for tests. The prompt text picks the behaviour.
// FAKE_ACP_LOG=<file> records every message received; FAKE_ACP_LOAD=1 advertises loadSession; FAKE_ACP_AUTH=1 makes session/new ask for sign-in.
// FAKE_ACP_MODELS=1 offers a `model` config option (one value inside a group); "which model" answers the value in force.
import { appendFileSync } from "node:fs"

const log = (entry: unknown) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`)
}
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const update = (sessionId: string, body: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } })
const text = (value: string) => ({ type: "text", text: value })

let counter = 0
let nextRequest = 1000
const waiting = new Map<number, (message: any) => void>()
const cancelled = new Set<string>()
let cancelWaiter: ((sessionId: string) => void) | undefined
let mcpServers: any[] = []
let currentModel = "vendor/small"
// FAKE_ACP_EFFORT=1: like OpenCode, an `effort` select (category thought_level) for the model that has levels (vendor/big), none for the other; a model switch picks its first level.
let currentEffort = "low"
const EFFORTS = ["low", "high", "max", "default"]
const configOptions = () => [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: [{ value: "vendor/small", name: "Small (free)" }, { group: "big", name: "Big", options: [{ value: "vendor/big", name: "Big" }] }] },
  ...(process.env.FAKE_ACP_EFFORT === "1" && currentModel === "vendor/big" ? [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: currentEffort, options: EFFORTS.map((value) => ({ value, name: value })) }] : []),
]

/** A request to the client; resolves with the whole answer message. */
function ask(method: string, params: unknown): Promise<any> {
  const id = nextRequest++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })
}

async function prompt(id: number, params: any) {
  const sessionId: string = params.sessionId
  const blocks: any[] = params.prompt ?? []
  const said: string = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
  const done = (stopReason: string) => send({ jsonrpc: "2.0", id, result: { stopReason } })
  const reply = (chunk: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(chunk) })
  if (said.startsWith("mcp echo")) {
    const bearer = mcpServers[0]?.headers?.[0]?.value ?? "none"
    reply(bearer.slice(0, 12))
    reply(bearer.slice(12))
    return done("end_turn")
  }

  if (said.startsWith("which model")) {
    reply(currentModel)
    return done("end_turn")
  }
  if (said.startsWith("which effort")) {
    reply(`${currentModel}@${currentEffort}`)
    return done("end_turn")
  }
  if (said.startsWith("hello")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("think") })
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("ing") })
    reply("Hel")
    reply("lo ")
    reply("there")
    return done("end_turn")
  }
  if (said.startsWith("tool")) {
    const kind = said.includes("edit") ? "edit" : said.includes("read") ? "read" : "execute"
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: kind === "execute" ? "Run ls -la" : `${kind} a.txt`, kind, status: "pending", rawInput: { command: "ls -la" } })
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", title: kind === "execute" ? "Run ls -la" : `${kind} a.txt`, kind, status: "pending", rawInput: { command: "ls -la" }, content: [{ type: "content", content: text("about to run") }] },
      options: [
        { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-all", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" },
      ],
    })
    const outcome = answer.result?.outcome
    const picked = outcome?.outcome === "selected" ? String(outcome.optionId) : "cancelled"
    if (picked.startsWith("allow")) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: text("file-list") }] })
    else update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: text("not permitted") }] })
    reply(`picked:${picked}`)
    return done("end_turn")
  }
  if (said.startsWith("plan")) {
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "write code", priority: "high", status: "in_progress" }, { content: "test it", priority: "medium", status: "pending" }] })
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "write code", priority: "high", status: "completed" }, { content: "test it", priority: "medium", status: "in_progress" }] })
    reply("planned")
    return done("end_turn")
  }
  if (said.startsWith("diff")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "d1", title: "Edit b.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: "b.ts", oldText: "const a = 1", newText: "const a = 2" }] })
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "orphan", status: "completed", title: "Orphan", rawOutput: { ok: true } })
    return done("end_turn")
  }
  if (said.startsWith("slow")) {
    reply("working")
    if (!cancelled.has(sessionId)) await new Promise<void>((resolve) => (cancelWaiter = () => resolve()))
    return done("cancelled")
  }
  if (said.startsWith("silent")) {
    // Never answers, even to a cancel: the engine must end the turn itself.
    return
  }
  if (said.startsWith("refuse")) return done("refusal")
  if (said.startsWith("limit")) return done("max_tokens")
  if (said.startsWith("crash")) {
    process.stderr.write("boom: the agent crashed\n")
    process.exit(3)
  }
  if (said.startsWith("fs")) {
    const answer = await ask("fs/read_text_file", { sessionId, path: "/etc/hosts" })
    reply(`fs:${answer.error?.code ?? "ok"}`)
    return done("end_turn")
  }
  if (said.includes("image please")) {
    reply(`blocks:${blocks.map((block) => block.type).join(",")}`)
    return done("end_turn")
  }
  if (said.startsWith("error")) return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "the model exploded" } })
  reply(`echo:${said}`)
  return done("end_turn")
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (!line.trim()) continue
    const message = JSON.parse(line)
    log(message)
    if (message.method === undefined) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
      continue
    }
    const { id, method, params } = message
    if (method === "initialize") {
      if (process.env.FAKE_ACP_SLOW_INIT === "1") continue
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD === "1", promptCapabilities: { image: process.env.FAKE_ACP_IMAGE === "1" }, mcpCapabilities: { http: process.env.FAKE_ACP_HTTP === "1" } },
          authMethods: process.env.FAKE_ACP_AUTH === "1" ? [{ id: "login", name: "Sign in" }] : [],
        },
      })
    } else if (method === "session/new") {
      mcpServers = params.mcpServers ?? []
      if (process.env.FAKE_ACP_AUTH === "1") send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } })
      else send({ jsonrpc: "2.0", id, result: { sessionId: `sess-${++counter}`, ...(process.env.FAKE_ACP_MODELS === "1" ? { configOptions: configOptions() } : {}) } })
    } else if (method === "session/set_config_option") {
      if (params.configId === "effort" && process.env.FAKE_ACP_EFFORT === "1" && currentModel === "vendor/big" && EFFORTS.includes(params.value)) {
        currentEffort = params.value
        send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } })
      } else if (params.configId !== "model" || params.value === "vendor/missing") send({ jsonrpc: "2.0", id, error: { code: -32602, message: `no such model: ${params.value}` } })
      else {
        if (params.value !== currentModel) currentEffort = "low"
        currentModel = params.value
        send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } })
      }
    } else if (method === "session/load") {
      mcpServers = params.mcpServers ?? []
      update(params.sessionId, { sessionUpdate: "user_message_chunk", content: text("old question") })
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: text("old answer") })
      send({ jsonrpc: "2.0", id, result: null })
    } else if (method === "session/prompt") {
      void prompt(id, params)
    } else if (method === "session/cancel") {
      cancelled.add(params.sessionId)
      cancelWaiter?.(params.sessionId)
    } else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } })
  }
}
