import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import type { TaskPort, TurnInput, TurnOutcome } from "@mendcode/kernel"
import { createAcpEngine } from "@mendcode/engine-acp"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function boot(fakeAcp = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "thread-bridge-daemon-"))
  const project = path.join(dir, "project")
  mkdirSync(project)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const token = remoteTokens(dir).create({ name: "test-peer" }).token
  let handler: (request: Request) => Promise<Response>
  let run: (turn: TurnInput) => Promise<TurnOutcome> = async () => ({ status: "ok" })
  const seen: TurnInput[] = []
  let opened = 0
  let stopped = 0
  let tasks: TaskPort
  let acpTurn: TurnInput
  let injectedServers: NonNullable<TurnInput["externalMcp"]>["servers"]
  let acpClosed = 0
  let acpOpened = 0
  const bindings = new Map<string, string>()
  const acp = createAcpEngine({
    agents: { get: () => ({ command: "fake-acp", args: [] }) }, agentFor: () => "demo", cwdFor: () => project,
    bindings: { get: (id) => bindings.get(id), set: (id, _agent, session) => { bindings.set(id, session) } },
    transportFactory: () => {
      acpOpened++
      const lines: string[] = []
      let wake: (() => void) | undefined
      let closed = false
      let exit: (code: number) => void
      const exited = new Promise<number>((resolve) => { exit = resolve })
      const send = (message: unknown) => { lines.push(JSON.stringify(message)); wake?.() }
      return {
        lines: (async function* () { while (!closed) { if (!lines.length) await new Promise<void>((resolve) => { wake = resolve }); while (lines.length) yield lines.shift()! } })(),
        exited, stderrTail: () => "",
        close: () => { if (closed) return; closed = true; acpClosed++; wake?.(); exit(0) },
        write: (line) => {
          const message = JSON.parse(line)
          const answer = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
          if (message.method === "initialize") answer({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } })
          else if (message.method === "session/new" || message.method === "session/load") {
            injectedServers = message.params.mcpServers
            answer(message.method === "session/new" ? { sessionId: "fake-session" } : null)
          } else if (message.method === "session/prompt") void run(acpTurn).then(() => answer({ stopReason: "end_turn" }))
        },
      }
    },
  })
  cleanups.push(() => acp.stop())
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true }, httpListen: false, defaultDirectory: project, extensionsEnabled: false, shellHooksEnabled: false, info: { engine: "native" },
    models: { selectable: true, defaults: { model: "configured-native" }, list: () => [
      { id: "configured-native", name: "native", efforts: [] },
      { id: "vendor:configured", name: "provider", efforts: [] },
      { id: "claude-sonnet", name: "Claude", engine: "claude", efforts: ["low"] },
      { id: "codex:configured", name: "Codex", engine: "codex", efforts: ["low"] },
      { id: "acp:demo", name: "ACP", efforts: [] },
      { id: "pi:configured", name: "pi", engine: "pi", efforts: [] },
    ] },
    threadMcpListener: (fetch) => { handler = fetch; opened++; return { url: "http://127.0.0.1:12345/mcp", stop: () => { stopped++ } } },
    engine: (ports) => { tasks = ports.tasks; return { needsCompaction: () => false, compact: async () => ({ status: "ok" }), runTurn: async (turn) => {
      seen.push(turn)
      if (fakeAcp && (turn.selection?.model ?? daemon.store.sessionModel(turn.sessionId))?.model.startsWith("acp:")) {
        acpTurn = turn
        return acp.runTurn(turn)
      }
      if (turn.text === "bridge") return run(turn)
      const itemId = turn.newItemId()
      turn.emit({ type: "item.started", itemId, kind: "agent_message" })
      turn.emit({ type: "item.completed", itemId, status: "ok", text: "child result" })
      return { status: "ok" }
    } } },
  })
  cleanups.push(() => daemon.stop())
  const globals: any[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "bridge-test", onGlobal: (event) => { globals.push(event) } })
  await client.connect()
  cleanups.push(() => client.close())
  const create = async (model = "claude-sonnet", directory = project) => {
    const result = await client.send({ type: "session.create", directory, choice: { model } })
    if (!result.ok) throw new Error(result.error.message)
    const id = result.result!.sessionId as SessionId
    await client.send({ type: "session.permission.set", sessionId: id, mode: "full" })
    return id
  }
  const invoke = (turn: TurnInput, name: string, args: unknown = {}) => {
    const flags = turn.externalMcp!.args
    const injected = fakeAcp ? injectedServers?.[0] : undefined
    const server = injected ? { url: injected.url, headers: { Authorization: injected.headers[0]!.value } } : JSON.parse(readFileSync(flags[1]!, "utf8")).mcpServers.mendcode_threads
    return handler(new Request(server.url, { method: "POST", headers: { authorization: server.headers.Authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).then((response) => response.json())
  }
  const say = async (id: SessionId) => {
    const before = seen.length
    await client.send({ type: "user.submit", sessionId: id, text: "bridge", attachments: [] })
    await until(() => seen.length > before && daemon.store.turns.list(id).at(-1)?.status === "completed")
  }
  const ids = createIdFactory()
  const remote = async (command: object) => {
    const response = await daemon.httpAdapter!.fetch(new Request("http://127.0.0.1:4096/command", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: ids("command"), clientId: ids("client"), ...command }) }))
    if (!response) throw new Error("missing HTTP response")
    return response.json()
  }
  return { daemon, client, project, create, invoke, say, seen, remote, globals, tasks: () => tasks, run: (callback: typeof run) => { run = callback }, listeners: () => ({ opened, stopped }), acpProcesses: () => ({ opened: acpOpened, closed: acpClosed }) }
}

test("an opted-in fake ACP agent creates and delegates children visible from parent and child lineage", async () => {
  const h = await boot(true)
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { acp: { demo: true } } } })
  const parent = await h.create("acp:demo")
  const results: any[] = []
  h.run(async (turn) => {
    results.push(await h.invoke(turn, "thread_create", { title: "idle ACP child", clientRequestId: "idle-once" }))
    results.push(await h.invoke(turn, "delegate_task", { description: "native child", prompt: "check", engine: "native", model: "configured-native", background: false, clientRequestId: "delegate-once" }))
    return { status: "ok" }
  })
  await h.say(parent)
  await h.say(parent)
  expect(results.every((result) => !result.result.isError)).toBe(true)
  expect(h.acpProcesses()).toEqual({ opened: 2, closed: 2 })
  expect(h.listeners()).toEqual({ opened: 2, stopped: 2 })
  const task = h.daemon.store.tasks.list()[0]!
  const idle = h.daemon.store.sessionChildren(parent).find((id) => id !== task.taskId)!
  for (const sessionId of [parent, task.taskId, idle]) {
    const tree = await h.client.send({ type: "session.tree", sessionId })
    if (!tree.ok) throw new Error(tree.error.message)
    const nodes = tree.result!.nodes as any[]
    expect(nodes.find((node) => node.sessionId === task.taskId)).toMatchObject({ parentId: parent, kind: "task", model: "configured-native", state: "completed", headline: "child result" })
    expect(nodes.find((node) => node.sessionId === idle)).toMatchObject({ parentId: parent, kind: "task", model: "acp:demo", state: "idle" })
    expect(new Set(nodes.map((node) => node.sessionId)).size).toBe(nodes.length)
  }
  expect(h.globals.some((event) => event.type === "task.changed" && event.sessionId === idle)).toBe(true)
  // Start the idle bridge child on the native fake to prove its persisted result and state projection.
  await h.client.send({ type: "user.submit", sessionId: idle, text: "check", attachments: [], selection: { model: { model: "configured-native" } } })
  await until(() => h.daemon.store.lastTurnStatus(idle) === "completed")
  const tree = await h.client.send({ type: "session.tree", sessionId: parent })
  if (!tree.ok) throw new Error(tree.error.message)
  expect((tree.result!.nodes as any[]).find((node) => node.sessionId === idle)).toMatchObject({ state: "completed", headline: "child result" })
  expect((await h.remote({ type: "user.submit", sessionId: parent, text: "bridge", attachments: [] })).error.code).toBe("forbidden")
})

test("mutation receipts survive process leases and retries recheck permission", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { claude: true } } })
  const parent = await h.create()
  const results: any[] = []
  h.run(async (turn) => { results.push(await h.invoke(turn, "thread_create", { title: "One", clientRequestId: "same" })); return { status: "ok" } })
  await h.say(parent)
  await h.say(parent)
  expect(results[1].result).toEqual(results[0].result)
  expect(h.daemon.store.listSessions({ directory: h.project, roots: false }).filter((session) => session.parentId === parent)).toHaveLength(1)
  await h.client.send({ type: "session.permission.set", sessionId: parent, mode: "plan" })
  await h.say(parent)
  expect(results[2].result.isError).toBe(true)
})

test("idle bridge children share the cumulative spawn and depth budget", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { claude: true }, subagentDepth: 1 } })
  const parent = await h.create()
  const results: any[] = []
  h.run(async (turn) => { results.push(await h.invoke(turn, "thread_create", { title: "idle" })); return { status: "ok" } })
  await h.say(parent)
  const child = h.daemon.store.listSessions({ directory: h.project, roots: false }).find((session) => session.parentId === parent)!
  await h.say(child.sessionId)
  expect(results[1].result.isError).toBe(true)
  expect(results[1].result.content[0].text).toContain("depth limit")
  h.daemon.store.meta.set(`orchestration.spawns:${parent}`, "256")
  await h.say(parent)
  expect(results[2].result.isError).toBe(true)
  expect(results[2].result.content[0].text).toContain("accumulated-spawn")
})

test("daemon bridge creates project children and delegates across configured engines with lineage and permission ceilings", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { claude: true, codex: true } } })
  const parent = await h.create()
  const other = await h.create("configured-native", path.join(h.project, "elsewhere"))
  const results: any[] = []
  h.run(async (turn) => {
    results.push(await h.invoke(turn, "thread_create", { title: "idle child" }))
    results.push(await h.invoke(turn, "thread_read", { sessionId: other }))
    for (const [engine, model] of [["native", "vendor:configured"], ["claude", "claude-sonnet"], ["codex", "codex:configured"], ["acp:demo", "acp:demo"], ["pi", "pi:configured"]]) {
      results.push(await h.invoke(turn, "delegate_task", { description: "child", prompt: "check", engine, model, background: false }))
    }
    return { status: "ok" }
  })
  const completed = h.say(parent)
  await until(() => h.daemon.store.pendingRequestsOf(parent).length === 1)
  const request = h.daemon.store.pendingRequestsOf(parent)[0]!
  expect(request).toMatchObject({ kind: "approval", title: "thread_read", detail: expect.stringContaining(other) })
  expect((await h.client.send({ type: "request.resolve", sessionId: parent, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })).ok).toBe(true)
  await completed
  expect(results[0].result.content[0].text).toContain("state=idle")
  expect(results[1].result.isError).toBe(true)
  for (const result of results.slice(2)) expect(result.result.content[0].text).toContain("state: completed")
  const tasks = h.daemon.store.tasks.list().filter((task) => task.parentId === parent)
  expect(tasks).toHaveLength(5)
  expect(tasks.every((task) => h.daemon.store.sessionInfo(task.taskId)?.directory === h.project)).toBe(true)
  expect(tasks.every((task) => h.daemon.store.permissionModeOf(task.taskId) === "full")).toBe(true)
  expect(h.listeners().opened).toBe(h.listeners().stopped)
  const children = h.seen.filter((turn) => turn.sessionId !== parent)
  expect(children.every((turn) => turn.text === "check")).toBe(true)
  expect(children.some((turn) => turn.externalMcp?.args[0] === "-c")).toBe(true)
  expect(children.some((turn) => turn.externalMcp?.args[0] === "--mcp-config")).toBe(true)
})

test("a delegation that fails says why to the engine that called, and names the engine's models when one is missing", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { claude: true, codex: true } } })
  const parent = await h.create()
  const results: any[] = []
  h.run(async (turn) => {
    results.push(await h.invoke(turn, "delegate_task", { description: "child", prompt: "check", engine: "codex", background: false }))
    results.push(await h.invoke(turn, "delegate_task", { description: "child", prompt: "check", engine: "codex", model: "claude-sonnet", background: false }))
    return { status: "ok" }
  })
  await h.say(parent)
  expect(results[0].result).toMatchObject({ isError: true })
  expect(results[0].result.content[0].text).toBe("Thread operation failed: engine delegation needs an exact model; codex models: codex:configured")
  expect(results[1].result.content[0].text).toBe("Thread operation failed: model claude-sonnet does not run on the codex engine; its models: codex:configured")
  expect(h.daemon.store.tasks.list()).toHaveLength(0)
})

test("opt-in off keeps the bridge unloaded; invalid engine/model and tier rejection precede child creation", async () => {
  const h = await boot()
  const parent = await h.create()
  h.run(async (turn) => { expect(turn.externalMcp).toBeUndefined(); return { status: "ok" } })
  await h.say(parent)
  expect(h.listeners()).toEqual({ opened: 0, stopped: 0 })
  const input = { description: "check", prompt: "check", engine: "claude", model: "claude-sonnet" }
  expect((await h.client.send({ type: "task.run", sessionId: parent, input })).ok).toBe(false)
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  for (const patch of [{ engine: "codex" }, { model: "missing" }, { variant: "invalid" }]) expect((await h.client.send({ type: "task.run", sessionId: parent, input: { ...input, ...patch } })).ok).toBe(false)
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { description: "no implicit model", prompt: "check", engine: "claude" } })).ok).toBe(false)
  expect(h.daemon.store.tasks.list()).toHaveLength(0)
  expect((await h.client.send({ type: "task.run", sessionId: parent, input: { ...input, agent: "explore" } })).ok).toBe(false)
  await h.client.send({ type: "settings.set", patch: { agent: { general: { permission: "plan" } } } })
  const task = await h.client.send({ type: "task.run", sessionId: parent, input })
  expect(task.ok).toBe(true)
  const child = task.ok ? (task.result!.task as any).taskId as SessionId : parent
  expect(h.seen.find((turn) => turn.sessionId === child)!.permissionMode()).toBe("plan")
})

test("bridge mutating calls in plan mode are denied even with a host allow rule", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full", threadMcp: { claude: true }, permission: "allow" } })
  const parent = await h.create()
  await h.client.send({ type: "session.permission.set", sessionId: parent, mode: "plan" })
  h.run(async (turn) => {
    expect((await h.invoke(turn, "thread_create", { title: "not allowed" })).result.isError).toBe(true)
    expect((await h.invoke(turn, "delegate_task", { description: "no", prompt: "no", engine: "native" })).result.isError).toBe(true)
    return { status: "ok" }
  })
  await h.say(parent)
  expect(h.daemon.store.tasks.list()).toHaveLength(0)
  expect(h.daemon.store.listSessions({ directory: h.project })).toHaveLength(1)
})

test("peer commands cannot enable a bridge, submit a bridge turn or delegate through a native turn", async () => {
  const h = await boot()
  const settings = { tier: "full", threadMcp: { claude: true, codex: true } }
  expect((await h.remote({ type: "settings.set", patch: settings })).error.code).toBe("forbidden")
  await h.client.send({ type: "settings.set", patch: settings })
  for (const model of ["claude-sonnet", "codex:configured"]) {
    const parent = await h.create(model)
    expect((await h.remote({ type: "user.submit", sessionId: parent, text: "bridge", attachments: [] })).error.code).toBe("forbidden")
    expect((await h.remote({ type: "task.run", sessionId: parent, input: { description: "check", prompt: "check", engine: "native" } })).error.code).toBe("forbidden")
  }
  const native = await h.create("configured-native")
  let refused = false
  h.run(async (turn) => {
    expect(turn.externalMcp).toBeUndefined()
    try { await h.tasks().run(native, { description: "escape", prompt: "escape", engine: "claude" }, turn.signal) }
    catch (error) { refused = String(error).includes("local only") }
    return { status: "ok" }
  })
  await h.remote({ type: "user.submit", sessionId: native, text: "bridge", attachments: [] })
  await until(() => refused)
  expect(h.daemon.store.tasks.list()).toHaveLength(0)
})

test("an external peer turn without the bridge retains its local-data restriction for future synthetic wakes", async () => {
  const h = await boot()
  const parent = await h.create()
  h.run(async (turn) => { expect(turn.externalMcp).toBeUndefined(); expect(turn.turnOptions).toBeUndefined(); return { status: "ok" } })
  await h.remote({ type: "user.submit", sessionId: parent, text: "bridge", attachments: [] })
  await until(() => h.daemon.store.turns.list(parent).at(-1)?.status === "completed")
  expect(h.daemon.store.meta.get(`session.local-tools.restricted:${parent}`)).toBe("true")
})
