import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelMessage } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { defineTool, read } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { toolProblem } from "../src/extensions/tool-adapter"
import { callTool, scriptedProvider, stop } from "../../engine-native/test/harness"
import { until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test("daemon settings, filtered MCP discovery and native receipts survive restart through the client protocol", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b26-daemon-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { provider, requests } = scriptedProvider([
    callTool("tool_search", { query: "mcp" }), stop("found"),
    callTool("mcp__local__symbols", {}), stop("used"), stop("direct catalog"),
  ])
  let calls = 0
  const extra = ["mcp__local__symbols", "mcp__private__symbols"].map((name) => defineTool({ name, description: "local fake symbol index", permission: "read", args: z.object({}), execute: async () => { calls++; return { output: "2 symbols", title: "symbols", isError: false, truncated: false } } }))
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), log: () => {}, engine: ({ store }) => createNativeEngine({
      provider, tools: [read], projectTools: async () => extra, cwdFor: () => dir,
      system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => store.settings.get(),
      history: {
        load: async (sessionId) => store.engineMessages.load(sessionId, "native") as ModelMessage[],
        save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
        replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
      },
    }) })
    const changes: unknown[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "b26", onGlobal: (event) => { if (event.type === "settings.changed") changes.push(event.settings) } })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const submit = async (sessionId: SessionId, text: string) => {
      const before = daemon.store.turns.list(sessionId).length
      expect(await client.send({ type: "user.submit", sessionId, text, attachments: [] })).toMatchObject({ ok: true })
      await until(() => daemon.store.turns.list(sessionId).length > before && daemon.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
    }
    return { daemon, client, changes, submit }
  }
  const first = await boot()
  const settings = { experimental: { tool_discovery: true, primary_tools: ["mcp__root__*"], continue_loop_on_deny: false }, tools: { "mcp__private__*": false } }
  expect(await first.client.send({ type: "settings.set", patch: settings })).toMatchObject({ ok: true, result: { settings } })
  await until(() => first.changes.length === 1)
  expect(first.changes[0]).toMatchObject(settings)
  expect(await first.client.send({ type: "settings.set", patch: { experimental: { tool_discovery: "yes" } } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  const created = await first.client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  await first.submit(sessionId, "find local MCP")
  expect(calls).toBe(0)
  expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("mcp__local__symbols")
  expect(requests[1]!.tools.map((tool) => tool.name)).toContain("mcp__local__symbols")
  expect(requests[1]!.tools.map((tool) => tool.name)).not.toContain("mcp__private__symbols")
  expect(first.daemon.store.engineMessages.load(sessionId, "native").some((message) => (message as ModelMessage).role === "tool" && (message as { discoveredTools?: string[] }).discoveredTools?.[0] === "mcp__local__symbols")).toBe(true)
  first.client.close()
  await first.daemon.stop()
  const second = await boot()
  expect(await second.client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings } })
  await second.submit(sessionId, "use the discovered tool")
  expect(calls).toBe(1)
  expect(requests[2]!.tools.map((tool) => tool.name)).toContain("mcp__local__symbols")
  expect(await second.client.send({ type: "settings.set", patch: { experimental: { ...settings.experimental, tool_discovery: false } } })).toMatchObject({ ok: true })
  const other = await second.client.send({ type: "session.create", directory: dir })
  if (!other.ok) throw new Error("session failed")
  await second.submit(other.result!.sessionId as SessionId, "catalog")
  expect(requests[4]!.tools.map((tool) => tool.name)).toContain("mcp__local__symbols")
  expect(requests[4]!.tools.map((tool) => tool.name)).not.toContain("tool_search")
})

test("extensions cannot replace host discovery or occupy its reserved wire alias", () => {
  for (const name of ["tool_search", "mendcode_tool_search"]) expect(toolProblem({ name, description: "fake", parameters: { type: "object" }, permission: "read", override: true, execute: async () => ({ output: "fake" }) })).toBe(`the name ${name} is reserved`)
})
