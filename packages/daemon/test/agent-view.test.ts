import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { BackgroundTaskEntry, GlobalEvent, SessionId, SessionSummary } from "@mendcode/protocol"
import { startDaemon } from "../src"

type Activity = Extract<GlobalEvent, { type: "session.activity" }>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-agents-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let port!: (sessionId: SessionId) => ReturnType<Parameters<typeof startDaemon>[0]["engine"] extends (i: infer I) => unknown ? I extends { background(s: SessionId): infer P } ? () => P : never : never>
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock, background }) => {
      port = ((sessionId: SessionId) => () => background(sessionId)) as never
      return createFauxEngine({ clock, deltaMs: 1 })
    },
  })
  cleanups.push(() => daemon.stop())
  const activity: Activity[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "agents", onGlobal: (e) => void (e.type === "session.activity" && activity.push(e)) })
  await client.connect()
  cleanups.push(() => client.close())
  const create = async (title = "") => {
    const created = await client.send({ type: "session.create", directory: "/repo", title })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    return sessionId
  }
  const submit = (sessionId: SessionId, text: string) => client.send({ type: "user.submit", sessionId, text, attachments: [] })
  const last = (sessionId: SessionId) => activity.filter((a) => a.sessionId === sessionId).at(-1)
  const list = async () => {
    const reply = await client.send({ type: "session.list", limit: 50 })
    return (reply.ok ? (reply.result?.sessions as SessionSummary[]) : []) ?? []
  }
  return { daemon, client, create, submit, activity, last, list, port: (sessionId: SessionId) => (port as unknown as (s: SessionId) => () => { start(input: { command: string; cwd: string }): unknown })(sessionId)() }
}

describe("agent view data in the daemon", () => {
  test("a running tool shows in session.activity with its title and when the turn started, and clears when it ends", async () => {
    const h = await boot()
    const id = await h.create("tool session")
    const before = Date.now()
    await h.submit(id, "/tool 300")
    await until(() => h.last(id)?.tool === "faux")
    expect(h.last(id)).toMatchObject({ state: "tool", tool: "faux", title: "tool session", directory: "/repo" })
    expect(h.last(id)!.since!).toBeGreaterThanOrEqual(before - 5)
    await until(() => h.last(id)?.state === "idle")
    expect(h.last(id)!.tool).toBeUndefined()
    expect(h.last(id)!.since).toBeUndefined()
  })

  test("a session waiting for approval reports the request title, then clears it once answered", async () => {
    const h = await boot()
    const id = await h.create("approval")
    await h.submit(id, "/ask")
    await until(() => h.last(id)?.state === "waiting_approval")
    await until(() => h.last(id)?.pending === "faux tool")
    const listed = (await h.list()).find((s) => s.sessionId === id)!
    expect(listed).toMatchObject({ state: "waiting_approval", pending: "faux tool" })
    expect(typeof listed.since).toBe("number")
    const request = h.daemon.store.readAfter(id, 0).find((e) => e.type === "server.request")
    if (request?.type !== "server.request") throw new Error("no request")
    await h.client.send({ type: "request.resolve", sessionId: id, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
    await until(() => h.last(id)?.state === "idle")
    expect(h.last(id)!.pending).toBeUndefined()
  })

  test("a sub-agent is heard of only once it waits for approval, then until it ends", async () => {
    const h = await boot()
    const parent = await h.create("parent")
    const created = await h.client.send({ type: "session.create", directory: "/repo", title: "child", parentId: parent })
    const child = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(child, 0)
    await h.submit(child, "/tool 50")
    await until(() => h.daemon.store.readAfter(child, 0).some((e) => e.type === "turn.completed"))
    expect(h.last(child)).toBeUndefined()
    await h.submit(child, "/ask")
    await until(() => h.last(child)?.pending === "faux tool")
    expect(h.last(child)).toMatchObject({ state: "waiting_approval", title: "child" })
    const request = h.daemon.store.readAfter(child, 0).find((e) => e.type === "server.request")
    if (request?.type !== "server.request") throw new Error("no request")
    await h.client.send({ type: "request.resolve", sessionId: child, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
    await until(() => h.last(child)?.state === "idle")
  })

  test("queued messages are counted in the activity and in the list", async () => {
    const h = await boot()
    const id = await h.create("queue")
    await h.submit(id, "/hang")
    await until(() => h.last(id)?.tool === "faux")
    await h.submit(id, "second")
    await h.submit(id, "third")
    await until(() => h.last(id)?.queued === 2)
    expect((await h.list()).find((s) => s.sessionId === id)).toMatchObject({ queued: 2, tool: "faux" })
    const turn = h.daemon.store.readAfter(id, 0).find((e) => e.type === "turn.started")
    if (turn?.type !== "turn.started") throw new Error("no turn")
    await h.client.send({ type: "turn.cancel", sessionId: id, turnId: turn.turnId })
  })

  test("two sessions can be busy at once and each reports its own tool", async () => {
    const h = await boot()
    const a = await h.create("a")
    const b = await h.create("b")
    await h.submit(a, "/tool 400")
    await h.submit(b, "/ask")
    await until(() => h.last(a)?.tool === "faux" && h.last(b)?.pending === "faux tool")
    expect(h.last(b)!.tool).toBeUndefined()
    expect(h.last(a)!.pending).toBeUndefined()
  })

  test("idle sessions carry no live fields in the list", async () => {
    const h = await boot()
    const id = await h.create("idle")
    const summary = (await h.list()).find((s) => s.sessionId === id)!
    expect(summary.state).toBe("idle")
    expect(summary.tool).toBeUndefined()
    expect(summary.since).toBeUndefined()
    expect(summary.pending).toBeUndefined()
  })
})

describe("background.list", () => {
  test("is empty until something runs, then lists tasks of all sessions or one", async () => {
    const h = await boot()
    const empty = await h.client.send({ type: "background.list" })
    expect(empty).toMatchObject({ ok: true, result: { tasks: [] } })
    const a = await h.create("a")
    const b = await h.create("b")
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-bg-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    expect(h.port(a).start({ command: "sleep 5", cwd: dir })).toMatchObject({ ok: true })
    expect(h.port(b).start({ command: "sleep 5", cwd: dir })).toMatchObject({ ok: true })
    const all = await h.client.send({ type: "background.list" })
    const tasks = (all.ok ? all.result?.tasks : []) as BackgroundTaskEntry[]
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.sessionId).sort()).toEqual([a, b].sort())
    expect(tasks.every((t) => t.status === "running" && t.command === "sleep 5" && typeof t.startedAt === "number")).toBe(true)
    const one = await h.client.send({ type: "background.list", sessionId: a })
    expect((one.ok ? (one.result?.tasks as BackgroundTaskEntry[]) : []).map((t) => t.sessionId)).toEqual([a])
  })
})
