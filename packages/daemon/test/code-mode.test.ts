import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelMessage } from "@mendcode/engine-native"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { toolProblem } from "../src/extensions/tool-adapter"
import { callTool, scriptedProvider, stop } from "../../engine-native/test/harness"
import { until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test("daemon persists opt-in settings, masked nested audit and selected code history across restart", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b71-daemon-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { provider, requests } = scriptedProvider([
    callTool("code", { code: 'const found = search({query: "symbols"}); const value = await tools[found.tools[0].name]({}); return JSON.parse(value.output).count' }), stop("2 symbols"),
    callTool("code", { code: "return 7" }), stop("7"),
    callTool("code", { code: "return 8" }), stop("disabled"),
  ])
  let calls = 0
  const tool = defineTool({ name: "mcp__local__symbols", description: "local symbols", permission: "read", args: z.strictObject({}), execute: async () => {
    calls++
    return { output: JSON.stringify({ count: 2, intermediate: "unselected symbol data" }), title: "symbols", isError: false, truncated: false }
  } })
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), log: () => {}, engine: ({ store }) => createNativeEngine({
      provider, tools: [], projectTools: async () => [tool], cwdFor: () => dir,
      system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => store.settings.get(),
      history: {
        load: async (sessionId) => store.engineMessages.load(sessionId, "native") as ModelMessage[],
        save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
        replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
      },
    }) })
    const events: SessionEvent[] = [], changes: unknown[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "b71", onEvent: (event) => { events.push(event) }, onGlobal: (event) => { if (event.type === "settings.changed") changes.push(event.settings) } })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const submit = async (sessionId: SessionId) => {
      const before = daemon.store.turns.list(sessionId).length
      expect(await client.send({ type: "user.submit", sessionId, text: "orchestrate", attachments: [] })).toMatchObject({ ok: true })
      await until(() => daemon.store.turns.list(sessionId).length > before && daemon.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
    }
    return { daemon, client, events, changes, submit }
  }
  const first = await boot()
  const settings = { experimental: { code_mode: true, tool_discovery: true } }
  expect(await first.client.send({ type: "settings.set", patch: settings })).toMatchObject({ ok: true, result: { settings } })
  await until(() => first.changes.length === 1)
  expect(first.changes[0]).toEqual(settings)
  expect(await first.client.send({ type: "settings.set", patch: { experimental: { code_mode: "yes" } } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  const created = await first.client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  await first.submit(sessionId)
  expect(calls).toBe(1)
  const events = first.daemon.store.readAfter(sessionId, 0, 1000)
  expect(events.some((event) => event.type === "item.completed" && event.text?.includes("unselected symbol data"))).toBe(true)
  expect(events.some((event) => event.type === "item.completed" && event.meta?.parentItemId !== undefined)).toBe(true)
  const history = first.daemon.store.engineMessages.load(sessionId, "native") as ModelMessage[]
  expect(JSON.stringify(history)).not.toContain("unselected symbol data")
  expect(history.find((message) => message.role === "tool" && message.name === "code")).toMatchObject({ discoveredTools: [tool.name], output: '{"ok":true,"value":2,"toolCalls":[{"name":"mcp__local__symbols"}]}' })
  first.client.close()
  await first.daemon.stop()
  const second = await boot()
  expect(await second.client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings } })
  await second.submit(sessionId)
  expect(requests[2]!.tools.map((tool) => tool.name)).toContain("code")
  expect(requests[2]!.tools.map((tool) => tool.name)).toContain(tool.name)
  expect(await second.client.send({ type: "settings.set", patch: { experimental: { ...settings.experimental, code_mode: false } } })).toMatchObject({ ok: true })
  await second.submit(sessionId)
  expect(requests[4]!.tools.map((tool) => tool.name)).not.toContain("code")
  expect(calls).toBe(1)
}, 15_000)

test("extensions cannot register or override the host interpreter even while it is disabled", () => {
  expect(toolProblem({ name: "code", description: "fake", parameters: { type: "object" }, permission: "read", override: true, execute: async () => ({ output: "fake" }) })).toBe("the name code is reserved")
})
