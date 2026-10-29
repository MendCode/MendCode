import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import type { TurnInput, TurnOutcome } from "@mendcode/kernel"
import { startDaemon } from "../src"
import { until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "host-bridge-daemon-"))
  const project = path.join(dir, "project")
  mkdirSync(project)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let handler: ((request: Request) => Promise<Response>) | undefined
  let harness: { args(sessionId: SessionId): string[]; waiting(): boolean }
  let run: (turn: TurnInput) => Promise<TurnOutcome> = async () => ({ status: "ok" })
  const hostCalls: Array<{ turnId: string; sessionId: string; name: string; args: unknown }> = []
  const listed: Array<{ directory: string; sessionId: string }> = []
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, extensionsEnabled: false, shellHooksEnabled: false, info: { engine: "native" },
    models: { selectable: true, defaults: { model: "configured-native" }, list: () => [
      { id: "configured-native", name: "native", efforts: [] },
      { id: "claude-sonnet", name: "Claude", engine: "claude", efforts: ["low"] },
    ] },
    hostMcpListener: (fetch) => { handler = fetch; return { url: "http://127.0.0.1:23456/mcp", stop: () => { handler = undefined } } },
    engine: (ports) => {
      harness = ports.harness
      return {
        needsCompaction: () => false, compact: async () => ({ status: "ok" }), runTurn: (turn) => run(turn),
        hostTools: async (input) => { listed.push(input); return [{ name: "graph_find", description: "Find code", parameters: { type: "object", properties: {} } }] },
        hostCall: async ({ turn, name, args }) => {
          hostCalls.push({ turnId: turn.turnId, sessionId: turn.sessionId, name, args })
          return { output: "router.ts:10", isError: false }
        },
      }
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "host-bridge-test" })
  await client.connect()
  cleanups.push(() => client.close())
  const create = async (model: string) => {
    const result = await client.send({ type: "session.create", directory: project, choice: { model } })
    if (!result.ok) throw new Error(result.error.message)
    return result.result!.sessionId as SessionId
  }
  const rpc = async (sessionId: SessionId, method: string, params?: unknown) => {
    const server = JSON.parse(readFileSync(harness.args(sessionId)[1]!, "utf8")).mcpServers.mendcode
    const response = await handler!(new Request(server.url, { method: "POST", headers: { authorization: server.headers.Authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }))
    return response.status === 200 ? ((await response.json()) as any) : { status: response.status }
  }
  const say = async (id: SessionId) => {
    await client.send({ type: "user.submit", sessionId: id, text: "go", attachments: [] })
    await until(() => daemon.store.turns.list(id).at(-1)?.status === "completed")
  }
  return { daemon, client, project, create, rpc, say, hostCalls, listed, harness: () => harness, run: (callback: typeof run) => { run = callback } }
}

test("a Claude Code turn calls a native tool through the bridge: it runs as a call of that turn", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const session = await h.create("claude-sonnet")
  const replies: any[] = []
  let turnId = ""
  h.run(async (turn) => {
    turnId = turn.turnId
    replies.push(await h.rpc(turn.sessionId, "tools/list"))
    replies.push(await h.rpc(turn.sessionId, "tools/call", { name: "graph_find", arguments: { query: "router" } }))
    return { status: "ok" }
  })
  await h.say(session)
  expect(replies[0].result.tools.map((tool: any) => tool.name)).toEqual(["graph_find"])
  expect(h.listed.at(-1)).toEqual({ directory: h.project, sessionId: session })
  expect(replies[1].result).toEqual({ content: [{ type: "text", text: "router.ts:10" }], isError: false })
  expect(h.hostCalls).toEqual([{ turnId, sessionId: session, name: "graph_find", args: { query: "router" } }])
  // The turn is over: the same bearer runs nothing more.
  expect((await h.rpc(session, "tools/call", { name: "graph_find", arguments: {} })).result.isError).toBe(true)
  expect(h.hostCalls).toHaveLength(1)
})

test("minimalist and installs without a tier give Claude Code no bridge; /tier harness_tools on does", async () => {
  const h = await boot()
  const session = await h.create("claude-sonnet")
  expect(h.harness().args(session)).toEqual([])
  await h.client.send({ type: "settings.set", patch: { tier: "minimalist" } })
  expect(h.harness().args(session)).toEqual([])
  await h.client.send({ type: "settings.set", patch: { features: { harness_tools: true } } })
  expect(h.harness().args(session)[0]).toBe("--mcp-config")
  await h.client.send({ type: "settings.set", patch: { tier: "full", features: null } })
  expect(h.harness().args(session)[0]).toBe("--mcp-config")
})

test("a native session's turn is not a turn the bridge serves", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  const session = await h.create("configured-native")
  let reply: any
  h.run(async (turn) => { reply = await h.rpc(turn.sessionId, "tools/call", { name: "graph_find", arguments: {} }); return { status: "ok" } })
  await h.say(session)
  expect(reply.result.isError).toBe(true)
  expect(h.hostCalls).toEqual([])
})
