import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent } from "@mendcode/protocol"
import { createAcpAgent, promptText, toolKind } from "../src/acp"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A real daemon with the faux engine, an ACP agent on top, and the agent's stdout as parsed messages. */
async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-acp-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  let handler: ((event: SessionEvent) => void) | undefined
  const client = createClient({ socketPath: daemon.socketPath, name: "acp", reconnect: false, onEvent: (event) => handler?.(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const out: Array<Record<string, any>> = []
  const agent = createAcpAgent({ client, listen: (h) => void (handler = h), write: (line) => void out.push(JSON.parse(line)), version: "0.0.1-test" })
  let id = 0
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const rpcId = ++id
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }))
    await until(() => out.some((m) => m.id === rpcId))
    return out.find((m) => m.id === rpcId)!
  }
  return { agent, out, call, dir }
}

describe("ACP agent", () => {
  test("initialize advertises protocol 1, session loading and embedded context", async () => {
    const { call } = await boot()
    const reply = await call("initialize", { protocolVersion: 1, clientCapabilities: {} })
    expect(reply.result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }, agentInfo: { name: "MendCode" } })
  })

  test("a prompt streams the answer as agent_message_chunk updates and ends with end_turn", async () => {
    const { call, out } = await boot()
    const created = await call("session/new", { cwd: "/repo", mcpServers: [] })
    const sessionId = created.result.sessionId
    expect(created.result.modes.availableModes.map((m: { id: string }) => m.id)).toEqual(["ask", "edits", "full", "plan"])
    const reply = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hola" }] })
    expect(reply.result).toEqual({ stopReason: "end_turn" })
    const chunks = out.filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk")
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((m) => m.params.sessionId === sessionId)).toBe(true)
  })

  test("a tool call becomes tool_call then tool_call_update; loading the session replays the history", async () => {
    const { call, out } = await boot()
    const { result } = await call("session/new", { cwd: "/repo", mcpServers: [] })
    await call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "/tool 2" }] })
    const updates = out.filter((m) => m.method === "session/update").map((m) => m.params.update)
    const started = updates.find((u) => u.sessionUpdate === "tool_call")
    expect(started).toMatchObject({ status: "in_progress" })
    expect(updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === started.toolCallId)).toMatchObject({ status: "completed" })

    // Loading the session again (as a new editor window would) replays its history as updates.
    out.length = 0
    await call("session/load", { sessionId: result.sessionId, cwd: "/repo", mcpServers: [] })
    const replayed = out.filter((m) => m.method === "session/update").map((m) => m.params.update.sessionUpdate)
    expect(replayed).toContain("user_message_chunk")
  })

  test("unknown methods and bad JSON get JSON-RPC errors; set_mode changes the permission mode", async () => {
    const { call, agent, out } = await boot()
    expect((await call("session/fly")).error).toMatchObject({ code: -32601 })
    await agent.handleLine("{not json")
    expect(out.at(-1)).toMatchObject({ id: null, error: { code: -32700 } })
    const { result } = await call("session/new", { cwd: "/repo", mcpServers: [] })
    expect((await call("session/set_mode", { sessionId: result.sessionId, modeId: "plan" })).result).toEqual({})
    expect((await call("session/set_mode", { sessionId: result.sessionId, modeId: "wild" })).error).toMatchObject({ code: -32602 })
  })

  test("prompt blocks: text, linked files as @paths, embedded resources fenced; tool kinds", () => {
    expect(promptText([{ type: "text", text: "fix it" }, { type: "resource_link", uri: "file:///repo/a%20b.ts", name: "a b.ts" }, { type: "resource", resource: { uri: "file:///x.md", text: "notes" } }, { type: "image", data: "…" }])).toBe(
      "fix it\n\n@/repo/a b.ts\n\n[file:///x.md]\n```\nnotes\n```",
    )
    expect([toolKind("read"), toolKind("grep"), toolKind("edit"), toolKind("shell"), toolKind("webfetch"), toolKind("task"), toolKind("mcp__x__y")]).toEqual(["read", "search", "edit", "execute", "fetch", "think", "other"])
  })
})
