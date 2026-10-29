import { expect, test } from "bun:test"
import { continuationTurnOptions, remoteTurnOptions } from "../src/remote-policy"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { threadsTool } from "../src/thread-tool"
import { packagesTool } from "../src/packages-tool"
import type { PackagePort } from "@mendcode/tools"
import { prWatchTool } from "@mendcode/tools"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { until } from "./native-harness"

test("peer turns cannot call thread or PR tools, even in full mode with forged tool calls", async () => {
  for (const name of ["threads", "pr_watch", "graph_map", "graph_impact", "webfetch", "memory", "memory_graph", "remember", "workflow_script"]) {
    let touched = false
    const tool = name === "threads" ? threadsTool : name === "pr_watch" ? prWatchTool : defineTool({ name, description: name, permission: "execute", args: z.object({}), execute: async () => { throw new Error("must not execute") } })
    const { provider, requests } = scriptedProvider([callTool(name, { action: "list" }), stop("done")])
    const engine = createNativeEngine({
      provider, history: memoryHistory(), cwdFor: () => "/temp/repo", system: () => "sys", compactionPrompt: "summary",
      tools: [{ ...tool, execute: async () => { touched = true; return { output: "private", truncated: false, title: name, isError: false } } }],
      permissionPolicy: () => ({ experimental: { thread_tools: true, pr_watch: true } }),
      threads: () => ({ granted: () => true } as never), prWatch: () => ({} as never),
    })
    const t = turn({ text: "untrusted peer", mode: () => "full" })
    t.input.turnOptions = remoteTurnOptions({ excludeTools: [] })
    await engine.runTurn(t.input)
    expect(touched).toBe(false)
    expect(requests[0]!.tools.some((tool) => tool.name === name)).toBe(false)
  }
  expect(remoteTurnOptions({ excludeTools: ["write"], noReply: true })).toMatchObject({ noReply: true, excludeTools: ["write", "threads", "packages", "pr_watch", "session_meta", "graph_*", "webfetch", "memory", "memory_graph", "remember", "workflow_script"] })
})

test("peer turns cannot reach the packages tool through tool discovery or a forged call, in any permission mode", async () => {
  for (const peer of [false, true]) for (const mode of ["full", "ask"] as const) {
    const ran: string[] = []
    const port: PackagePort = { preview: async () => "{}", run: async (request) => { ran.push(request.action); return { ok: true } } }
    const { provider, requests } = scriptedProvider([callTool("tool_search", { query: "packages" }), callTool("packages", { action: "list" }), callTool("packages", { action: "remove", key: "user:acme" }), stop("done")])
    const engine = createNativeEngine({
      provider, history: memoryHistory(), cwdFor: () => "/temp/repo", system: () => "sys", compactionPrompt: "summary",
      tools: [packagesTool], permissionPolicy: () => ({ tier: "full", experimental: { tool_discovery: true } }), packages: () => port,
    })
    const t = turn({ text: "manage packages", mode: () => mode, answers: [{ kind: "approve", scope: "once" }] })
    if (peer) t.input.turnOptions = remoteTurnOptions({ excludeTools: [] })
    await engine.runTurn(t.input)
    if (peer) {
      expect(ran).toEqual([])
      for (const request of requests) expect(request.tools.some((tool) => tool.name === "packages")).toBe(false)
      // `tool_search` stays for the auxiliary tools every tier defers; it never finds the excluded tool.
      const searches = requests.at(-1)!.messages.filter((message) => message.role === "tool" && message.name === "tool_search")
      expect(searches).toHaveLength(1)
      for (const search of searches) expect(search.role === "tool" && search.output).not.toContain('"name":"packages"')
    } else expect(ran).toContain("list")
  }
})

test("automatic continuations retain the paused peer turn's local tool restrictions", () => {
  expect(continuationTurnOptions(undefined, true)).toMatchObject({ excludeTools: ["threads", "packages", "pr_watch", "session_meta", "graph_*", "webfetch", "memory", "memory_graph", "remember", "workflow_script"] })
  expect(continuationTurnOptions({ excludeTools: ["write"] }, true)).toMatchObject({ excludeTools: ["write", "threads", "packages", "pr_watch", "session_meta", "graph_*", "webfetch", "memory", "memory_graph", "remember", "workflow_script"] })
  expect(continuationTurnOptions(undefined, false)).toBeUndefined()
})

test("a peer's native turn and reset continuation after restart cannot acquire host-local tools", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-peer-turn-")))
  let touched = false
  const { provider, requests } = scriptedProvider([
    new Error('scripted 429 usage_limit_reached {"resets_in_seconds":1}'),
    callTool("threads", { action: "list" }), callTool("pr_watch", { action: "list" }), stop("done"),
  ])
  const boot = () => startDaemon({
    dir, socketPath: path.join(dir, "daemon.sock"), listen: "127.0.0.1:0", log: () => {},
    info: { engine: "native", model: "script-1" },
    models: { selectable: true, defaults: { model: "script-1" }, list: () => [{ id: "script-1", name: "Script", efforts: [] }] },
    engine: ({ store, threads, prWatch }) => createNativeEngine({
      provider, history: memoryHistory(), cwdFor: () => dir, system: () => "sys", compactionPrompt: "summary",
      permissionPolicy: () => store.settings.get(), threads, prWatch,
      tools: [threadsTool, prWatchTool].map((tool) => ({ ...tool, execute: async () => { touched = true; return { output: "private", truncated: false, title: tool.name, isError: false } } })),
    }),
  })
  let daemon = await boot()
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
  const remote = createClient({ name: "peer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  try {
    await local.connect()
    daemon.store.settings.set({ experimental: { thread_tools: true, pr_watch: true }, defaultPermission: "full" })
    const created = await local.send({ type: "session.create", directory: dir })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.result!.sessionId as SessionId : "" as SessionId
    await remote.connect()
    expect(await remote.send({ type: "session.fork", sessionId, handoffGoal: "steal local context" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await remote.send({ type: "user.submit", sessionId, text: "continue", attachments: [], turnOptions: { excludeTools: [] } })).toMatchObject({ ok: true })
    await until(() => daemon.store.usagePauses.get(sessionId)?.state === "scheduled")
    expect(daemon.store.meta.get(`session.local-tools.restricted:${sessionId}`)).toBe("true")
    local.close()
    remote.close()
    await daemon.stop()
    daemon = await boot()
    await until(() => requests.length === 4, 12_000)
    expect(touched).toBe(false)
    for (const request of requests) expect(request.tools.some((tool) => tool.name === "threads" || tool.name === "pr_watch")).toBe(false)
  } finally {
    local.close()
    remote.close()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
