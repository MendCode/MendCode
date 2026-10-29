import { afterEach, describe, expect, test } from "bun:test"
import { remoteTokens } from "../src/remote"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, encodeFrame, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { checkSessionLog } from "@mendcode/testkit"
import { startDaemon, type Daemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir = tempDir()) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  return daemon
}

async function connect(daemon: Daemon, name: string, events: SessionEvent[] = []) {
  const client = createClient({ socketPath: daemon.socketPath, name, onEvent: (e) => events.push(e) })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, events }
}

async function until(check: () => boolean, ms = 3_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function createSession(client: Client) {
  const reply = await client.send({ type: "session.create", directory: "/repo", title: "t" })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.sessionId as SessionId
}

describe("mendd", () => {
  test("three clients see identical event sequences, including one that disconnects and resumes (I4)", async () => {
    const daemon = await boot()
    const a = await connect(daemon, "A")
    const b = await connect(daemon, "B")
    const c = await connect(daemon, "C")
    const sessionId = await createSession(a.client)
    for (const x of [a, b, c]) await x.client.subscribe(sessionId, 0)
    await b.client.send({ type: "user.submit", sessionId, text: "uno", attachments: [] })
    await until(() => a.events.some((e) => e.type === "turn.completed"))
    a.client.dropConnection()
    await b.client.send({ type: "user.submit", sessionId, text: "dos", attachments: [] })
    await c.client.send({ type: "user.submit", sessionId, text: "/tool 20", attachments: [] })
    const total = () => daemon.store.lastSeq(sessionId) ?? 0
    await until(() => b.events.filter((e) => e.type === "turn.completed").length === 3)
    await until(() => a.events.length === total())
    const truth = daemon.store.readAfter(sessionId, 0, 10_000)
    for (const x of [a, b, c]) expect(x.events).toEqual(truth)
    expect(checkSessionLog(truth, { final: true })).toEqual([])
  })

  test("a client with another protocol version is refused before any command", async () => {
    const daemon = await boot()
    const ids = createIdFactory()
    const replies: string[] = []
    const socket = await Bun.connect({ unix: daemon.socketPath, socket: { data: (_s, d) => void replies.push(d.toString()) } })
    socket.write(encodeFrame({ v: 1, kind: "command", body: { id: ids("command"), clientId: ids("client"), type: "hello", protocolVersion: 99, client: { name: "old", version: "0" }, capabilities: [] } }))
    await until(() => replies.length > 0)
    expect(replies.join("")).toContain('"protocol_version"')
    socket.end()
  })

  test("a retried command id is answered from cache and has no second effect", async () => {
    const daemon = await boot()
    const { client } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    const ids = createIdFactory()
    const replies: string[] = []
    const socket = await Bun.connect({ unix: daemon.socketPath, socket: { data: (_s, d) => void replies.push(d.toString()) } })
    const clientId = ids("client")
    socket.write(encodeFrame({ v: 1, kind: "command", body: { id: ids("command"), clientId, type: "hello", protocolVersion: 1, client: { name: "raw", version: "0" }, capabilities: [] } }))
    const submit = encodeFrame({ v: 1, kind: "command", body: { id: ids("command"), clientId, type: "user.submit", sessionId, text: "una vez", attachments: [] } })
    socket.write(submit)
    socket.write(submit)
    await until(() => replies.join("").split('"kind":"ack"').length - 1 >= 3)
    const added = daemon.store.readAfter(sessionId, 0).filter((e) => e.type === "queue.added")
    expect(added.length).toBe(1)
    socket.end()
  })

  test("only one daemon can own a data directory", async () => {
    const dir = tempDir()
    await boot(dir)
    await expect(startDaemon({ dir, socketPath: path.join(dir, "other.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })).rejects.toThrow(/owned by running process/)
  })

  test("session.list returns titled sessions newest first with live state; usage.query returns the report", async () => {
    const daemon = await boot()
    const { client, events } = await connect(daemon, "A")
    const untitled = async () => {
      const reply = await client.send({ type: "session.create", directory: "/repo", title: "" })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.result?.sessionId as SessionId
    }
    const first = await untitled()
    const second = await untitled()
    await client.subscribe(first, 0)
    await client.subscribe(second, 0)
    await client.send({ type: "user.submit", sessionId: first, text: "old task", attachments: [] })
    await until(() => events.some((e) => e.sessionId === first && e.type === "turn.completed"))
    await client.send({ type: "user.submit", sessionId: second, text: "/tool 400", attachments: [] })
    await until(() => events.some((e) => e.type === "item.started" && e.kind === "tool_call"))
    const listed = await client.send({ type: "session.list" })
    if (!listed.ok) throw new Error(listed.error.message)
    const sessions = listed.result?.sessions as Array<{ sessionId: string; title: string; state: string }>
    expect(sessions[0]).toMatchObject({ sessionId: second, title: "/tool 400", state: "tool" })
    expect(sessions[1]).toMatchObject({ sessionId: first, title: "old task" })
    const today = new Date().toISOString().slice(0, 10)
    const usage = await client.send({ type: "usage.query", from: "2000-01-01", to: today })
    expect(usage.ok && Array.isArray(usage.result?.days) && Array.isArray(usage.result?.quotas)).toBe(true)
    // Insights ride along; without a usageProfile option there is no profile (tests never read a real login).
    const insights = usage.ok ? (usage.result?.insights as { efforts: Array<{ turns: number }>; topSessions: Array<{ sessionId: string }> }) : undefined
    expect(insights?.efforts.reduce((sum, effort) => sum + effort.turns, 0)).toBeGreaterThanOrEqual(2)
    expect(insights?.topSessions.map((s) => s.sessionId)).toContain(first)
    expect(usage.ok && usage.result?.profile).toBeUndefined()
  })

  test("usage.query carries additive response peaks and model pricing coverage over the socket", async () => {
    const daemon = await boot()
    const { client } = await connect(daemon, "UI-5")
    const sessionId = await createSession(client)
    const ids = createIdFactory()
    const turnId = ids("turn"), itemId = ids("item")
    daemon.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
    daemon.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok" })
    daemon.store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "local", model: "fixture", input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    const reply = await client.send({ type: "usage.query", from: "2000-01-01", to: "2099-12-31" })
    if (!reply.ok) throw new Error(reply.error.message)
    const activity = reply.result?.activity as Array<{ longestAiMs?: number }>
    expect(activity.some((day) => typeof day.longestAiMs === "number")).toBe(true)
    expect(reply.result?.models).toMatchObject([{ provider: "local", model: "fixture", costUnknownCalls: 1 }])
  })

  test("session.rename changes the title shown by session.list and trims it", async () => {
    const daemon = await boot()
    const { client } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    expect((await client.send({ type: "session.rename", sessionId, title: "  Release prep  " })).ok).toBe(true)
    const listed = await client.send({ type: "session.list" })
    if (!listed.ok) throw new Error(listed.error.message)
    expect((listed.result?.sessions as Array<{ sessionId: string; title: string }>).find((s) => s.sessionId === sessionId)?.title).toBe("Release prep")
  })

  test("session.rename refuses unknown sessions and empty titles", async () => {
    const daemon = await boot()
    const { client } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    expect(await client.send({ type: "session.rename", sessionId: createIdFactory()("session"), title: "x" })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    expect(await client.send({ type: "session.rename", sessionId, title: "   " })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })

  test("session.delete removes the session, its events and other clients' subscriptions", async () => {
    const daemon = await boot()
    const { client, events } = await connect(daemon, "A")
    const other = await connect(daemon, "B")
    const sessionId = await createSession(client)
    const keep = await createSession(client)
    await client.subscribe(sessionId, 0)
    await other.client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "to delete", attachments: [] })
    await until(() => events.some((e) => e.sessionId === sessionId && e.type === "turn.completed"))
    expect((await client.send({ type: "session.delete", sessionId })).ok).toBe(true)
    const listed = await client.send({ type: "session.list" })
    if (!listed.ok) throw new Error(listed.error.message)
    expect((listed.result?.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toEqual([keep])
    expect(await client.send({ type: "client.subscribe", sessionId, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    const diagnostics = await client.send({ type: "diagnostics.resources" })
    expect(diagnostics.ok && (diagnostics.result?.actors as number)).toBeLessThanOrEqual(2)
  })

  test("session.delete is refused with busy while a turn runs and works after it ends", async () => {
    const daemon = await boot()
    const { client, events } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/tool 300", attachments: [] })
    await until(() => events.some((e) => e.type === "item.started" && e.kind === "tool_call"))
    expect(await client.send({ type: "session.delete", sessionId })).toMatchObject({ ok: false, error: { code: "busy" } })
    await until(() => events.some((e) => e.type === "turn.completed"))
    expect((await client.send({ type: "session.delete", sessionId })).ok).toBe(true)
  })

  test("session.delete of an unknown session is refused with unknown_session", async () => {
    const daemon = await boot()
    const { client } = await connect(daemon, "A")
    expect(await client.send({ type: "session.delete", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("daemon.shutdown is refused while a turn runs and accepted when idle", async () => {
    const stopped: string[] = []
    const dir = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), buildId: "test-build", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), onShutdown: () => void stopped.push("done") })
    cleanups.push(() => daemon.stop())
    const { client, events } = await connect(daemon, "A")
    expect(client.daemonBuildId).toBe("test-build")
    const sessionId = await createSession(client)
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/tool 300", attachments: [] })
    await until(() => events.some((e) => e.type === "item.started" && e.kind === "tool_call"))
    const refused = await client.send({ type: "daemon.shutdown" })
    expect(refused).toMatchObject({ ok: false, error: { code: "busy" } })
    await until(() => events.some((e) => e.type === "turn.completed"))
    expect((await client.send({ type: "daemon.shutdown" })).ok).toBe(true)
    await until(() => stopped.length === 1)
  })

  test("a background agent an engine runs on its own (Claude Code's) is running work: no shutdown, counted as a job, kept on close", async () => {
    const dir = tempDir()
    let report: ((sessionId: SessionId, tasks: Array<{ id: string; description: string; kind: string }>) => void) | undefined
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock, engineBackground }) => { report = engineBackground; return createFauxEngine({ clock, deltaMs: 1 }) } })
    cleanups.push(() => daemon.stop())
    const { client } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    report!(sessionId, [{ id: "t1", description: "audit", kind: "local_agent" }])
    expect(await client.send({ type: "daemon.shutdown" })).toMatchObject({ ok: false, error: { code: "busy" } })
    const status = await client.send({ type: "daemon.status" })
    expect(status.ok && status.result).toMatchObject({ backgroundJobs: 1, keepAlive: { running: ["background agents"] } })
    report!(sessionId, [])
    const idle = await client.send({ type: "daemon.status" })
    expect(idle.ok && idle.result).toMatchObject({ backgroundJobs: 0, keepAlive: { running: [] } })
  })

  test("background.stop stops an engine's task by its listed id, says what it could not stop, and refuses an id nothing runs under", async () => {
    const dir = tempDir()
    let report: ((sessionId: SessionId, tasks: Array<{ id: string; description: string; kind: string }>, stop?: (taskId: string) => Promise<void>) => void) | undefined
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock, engineBackground }) => { report = engineBackground; return createFauxEngine({ clock, deltaMs: 1 }) } })
    cleanups.push(() => daemon.stop())
    const { client } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    const stopped: string[] = []
    report!(sessionId, [{ id: "t1", description: "audit", kind: "local_agent" }, { id: "t2", description: "stuck", kind: "local_bash" }], async (taskId) => { if (taskId === "t2") throw new Error("refused"); stopped.push(taskId) })
    expect(await client.send({ type: "background.stop", sessionId, taskId: "engine:t1" })).toMatchObject({ ok: true, result: { stopped: 1, failed: [] } })
    expect(stopped).toEqual(["t1"])
    expect(await client.send({ type: "background.stop", sessionId })).toMatchObject({ ok: true, result: { stopped: 1, failed: ["stuck"] } })
    expect(await client.send({ type: "background.stop", sessionId, taskId: "engine:none" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("a detached daemon stops itself once no client has been attached for idleExitMs, and not while one is", async () => {
    const stopped: string[] = []
    const dir = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), idleExitMs: 40, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), onShutdown: () => void stopped.push("down") })
    cleanups.push(() => daemon.stop())
    const { client } = await connect(daemon, "A")
    await Bun.sleep(200)
    expect(stopped).toEqual([])
    client.close()
    await until(() => stopped.length === 1)
  })

  test("the loopback HTTP listener does not keep a daemon resident", async () => {
    const stopped: string[] = []
    const dir = tempDir()
    remoteTokens(dir).create({ name: "web" })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true, port: 0 }, idleExitMs: 40, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), onShutdown: () => void stopped.push("down") })
    cleanups.push(() => daemon.stop())
    const { client } = await connect(daemon, "A")
    const status = await client.send({ type: "daemon.status" })
    expect(status.ok && status.result?.keepAlive).toEqual({ running: [], standing: [] })
    client.close()
    await until(() => stopped.length === 1)
  })

  test("a newly connected client receives the last known quota without waiting for a response", async () => {
    const daemon = await boot()
    daemon.store.globalSink.append({ type: "quota.snapshot", provider: "codex", windows: [{ id: "primary", label: "7d", usedPercent: 17 }], fetchedAt: 1, source: "test" })
    const globals: string[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "late", onGlobal: (e) => void globals.push(e.type === "quota.snapshot" ? `${e.provider} ${e.windows[0]?.usedPercent}` : e.type) })
    await client.connect()
    cleanups.push(() => client.close())
    await until(() => globals.length > 1)
    // The last quota, then today's usage totals (the footer's "today" segment).
    expect(globals).toEqual(["codex 17", "usage.today"])
  })

  test("memory commands: user adds are saved, updates and deletes push memory.changed to every client", async () => {
    const daemon = await boot()
    const changes: string[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "mem", onGlobal: (e) => void (e.type === "memory.changed" && changes.push(e.change)) })
    await client.connect()
    cleanups.push(() => client.close())
    const added = await client.send({ type: "memory.add", scope: "project", directory: "/repo", text: "Run bun test packages", category: "commands" })
    expect(added.ok).toBe(true)
    const memoryId = added.ok ? (added.result?.memoryId as string) : ""
    const listed = await client.send({ type: "memory.list", directory: "/repo" })
    expect(listed.ok && (listed.result?.memories as Array<{ status: string }>)[0]?.status).toBe("saved")
    const found = await client.send({ type: "memory.search", query: "bun", directory: "/repo" })
    expect(found.ok && (found.result?.memories as unknown[]).length).toBe(1)
    expect((await client.send({ type: "memory.update", memoryId: memoryId as never, status: "archived" })).ok).toBe(true)
    expect((await client.send({ type: "memory.delete", memoryId: memoryId as never })).ok).toBe(true)
    expect((await client.send({ type: "memory.add", scope: "project", text: "no dir" })).ok).toBe(false)
    await until(() => changes.length === 3)
    expect(changes).toEqual(["added", "updated", "deleted"])
  })

  test("usage recorded by the engine is available as a projection immediately", async () => {
    const daemon = await boot()
    const { client, events } = await connect(daemon, "A")
    const sessionId = await createSession(client)
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/usage", attachments: [] })
    await until(() => events.some((e) => e.type === "turn.completed"))
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
    const usage = daemon.store.usageDaily({ from: day, to: day })
    expect(usage[0]?.calls).toBe(1)
    expect(usage[0]?.sessions).toBe(1)
  })
})
