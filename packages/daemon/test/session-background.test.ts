import { afterEach, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import { createIdFactory, type AgentCommandRecord, type SessionId, type TaskRecord, type TurnId } from "@mendcode/protocol"
import { createTaskOwnerWake } from "../src/task-owner-wake"
import { createSessionBackground } from "../src/session-background"
import { boot, hang, openSession, stop, until, type NativeHarness } from "./native-harness"

const all: NativeHarness[] = []
const ids = createIdFactory()
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const start = async (options: Parameters<typeof boot>[0] = {}) => { const h = await boot(options); all.push(h); return h }
const child = async (h: NativeHarness, parent: SessionId, background = true) => {
  const reply = await h.client.send({ type: "task.run", sessionId: parent, input: { description: "Inspect engine", prompt: "Report findings", background } })
  expect(reply.ok).toBe(true)
  return reply.ok ? reply.result?.task as TaskRecord : undefined!
}
const notices = (h: NativeHarness, id: SessionId) => h.store.readAfter(id, 0, 1000).filter((event) => event.type === "queue.added" && event.notice)

test("completed background child wakes the idle owner once and exposes the real child hierarchy", async () => {
  const h = await start({ steps: [stop("Found the native entry point"), stop("Owner incorporated the result")] })
  const parent = await openSession(h)
  const task = await child(h, parent)
  await until(() => h.requests.length === 2 && h.store.turns.list(parent)[0]?.status === "completed")
  expect(notices(h, parent)).toHaveLength(1)
  expect(notices(h, parent)[0]).toMatchObject({ text: expect.stringContaining(task.taskId) })
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Found the native entry point") })
  expect(h.store.sessionBackground.wakes.pending()).toHaveLength(0)
  const children = await h.client.sessionChildren(parent)
  expect(children.ok && children.sessions).toMatchObject([{ sessionId: task.taskId, parentId: parent }])
  const listed = await h.client.backgroundSessions(h.project)
  expect(listed.ok && listed.sessions).toMatchObject([{ sessionId: task.taskId, state: "completed", summary: "Found the native entry point", session: { parentId: parent, agent: "general" } }])
})

test("owner wake off persists and foreground completion does not enqueue a notice", async () => {
  const h = await start({ steps: [stop("background done"), stop("foreground done")] })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { subagentOwnerWake: false } })
  await child(h, parent)
  await until(() => h.store.tasks.list()[0]?.state === "completed")
  await child(h, parent, false)
  await until(() => h.store.sessionBackground.wakes.pending().length === 0)
  expect(notices(h, parent)).toEqual([])
  expect(h.requests).toHaveLength(2)
  await h.daemon.stop()
  h.client.close()
  const next = await start({ dir: h.dir, project: h.project })
  expect(next.store.settings.get().subagentOwnerWake).toBe(false)
})

test("a busy owner defers notifications; cancellation dismisses them before the next user prompt", async () => {
  const h = await start({ steps: [hang, stop("child result"), stop("resumed work")] })
  const parent = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: parent, text: "Work independently", attachments: [] })
  await until(() => h.requests.length === 1)
  await child(h, parent)
  await until(() => h.store.tasks.list()[0]?.state === "completed" && h.store.sessionBackground.wakes.pending().length === 1)
  expect(notices(h, parent)).toHaveLength(0)
  expect(h.requests).toHaveLength(2)
  const turnId = h.store.turns.list(parent)[0]!.turnId as TurnId
  await h.client.send({ type: "turn.cancel", sessionId: parent, turnId })
  await until(() => h.store.turns.list(parent)[0]?.status === "cancelled")
  expect(h.store.sessionBackground.wakes.pending()).toHaveLength(0)
  expect(h.requests).toHaveLength(2)
  await h.client.send({ type: "user.submit", sessionId: parent, text: "Resume", attachments: [] })
  await until(() => h.requests.length === 3)
  expect(notices(h, parent)).toHaveLength(0)
})

test("restart delivers an undelivered outbox entry once and resume keeps the same task_id", async () => {
  const h = await start({ steps: [stop("saved child result")] })
  const parent = await openSession(h)
  const task = await child(h, parent)
  await until(() => h.store.tasks.list()[0]?.state === "completed")
  await h.daemon.stop()
  h.client.close()
  const next = await start({ dir: h.dir, project: h.project, steps: [stop("owner resumed"), stop("child continued")] })
  await until(() => notices(next, parent).length === 1 && next.requests.length === 1)
  const reply = await next.client.send({ type: "task.run", sessionId: parent, input: { description: "Continue inspection", prompt: "Continue", task_id: task.taskId } })
  expect(reply.ok && reply.result?.task).toMatchObject({ taskId: task.taskId, generation: 2, state: "completed" })
  expect(next.requests[1]!.messages.some((message) => message.role === "assistant" && message.content === "saved child result")).toBe(true)
  expect(notices(next, parent)).toHaveLength(1)
})

test("outbox recovery detects queue.added after a crash before ack and never resolves child secret markers in the owner", async () => {
  const h = await start()
  const parent = await openSession(h)
  const taskId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { subagentOwnerWake: false } })
  const task: TaskRecord = { taskId, parentId: parent, rootId: parent, depth: 1, generation: 1, description: "Inspect", agent: "general", background: true, state: "completed", result: "secret ‹secret:1›", createdAt: Date.now(), updatedAt: Date.now() }
  const queueId = ids("queue")
  h.store.sessionBackground.wakes.finish(task, queueId)
  h.store.sessionSink.append({ type: "queue.added", sessionId: parent, queueId, text: "already queued", notice: true, attachments: [] })
  await h.client.send({ type: "settings.set", patch: { subagentOwnerWake: true } })
  let called = 0
  const wake = createTaskOwnerWake({ store: h.store, mask: (_id, text) => text, notify: async () => { called++; return queueId } })
  await wake.drain()
  expect(called).toBe(0)
  h.store.sessionBackground.wakes.finish({ ...task, generation: 2 }, ids("queue"))
  let text = ""
  const second = createTaskOwnerWake({ store: h.store, mask: (_id, value) => value, notify: async (_id, value, id) => { text = value; return id } })
  await second.drain()
  expect(text).toContain("[redacted:child-secret]")
  expect(text).not.toContain("‹secret:1›")
  wake.stop()
  second.stop()
})

test("writer presence is nonexclusive, release belongs to the current client, and terminal state clears the lease", async () => {
  const h = await start()
  const id = await openSession(h)
  const other = createClient({ socketPath: h.daemon.socketPath, name: "second writer" })
  await other.connect()
  try {
    expect(await h.client.acquireBackgroundWriter(id)).toMatchObject({ ok: true, result: { acquired: false } })
    await h.client.registerBackground(id, { state: "working", pinned: true, summary: "Review local changes" })
    const a = await h.client.acquireBackgroundWriter(id)
    const b = await other.acquireBackgroundWriter(id)
    expect(a.ok && a.result?.acquired).toBe(true)
    expect(b.ok && b.result?.acquired).toBe(true)
    const first = a.ok && a.result?.info as { writer: { clientId: string } }
    const second = b.ok && b.result?.info as { writer: { clientId: string } }
    expect(first && second && first.writer.clientId).not.toBe(second && second.writer.clientId)
    expect(await h.client.releaseBackgroundWriter(id)).toMatchObject({ ok: true, result: { info: null } })
    expect(await other.releaseBackgroundWriter(id)).toMatchObject({ ok: true, result: { info: { sessionId: id } } })
    await h.client.acquireBackgroundWriter(id)
    await h.client.registerBackground(id, { state: "completed" })
    expect(h.store.sessionBackground.get(id)?.writer).toBeUndefined()
    expect(await h.client.removeBackground(id)).toMatchObject({ ok: true, result: { removed: true } })
    expect(await h.client.removeBackground(id)).toMatchObject({ ok: true, result: { removed: false } })
    expect(h.store.hasSession(id)).toBe(true)
    expect(h.store.detached.has(id)).toBe(false)
  } finally { other.close() }
})

test("writer expiry is a read projection and background restart stops an unfinished registered child", async () => {
  const h = await start({ steps: [hang] })
  const parent = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { subagentOwnerWake: false } })
  const task = await child(h, parent)
  await until(() => h.requests.length === 1)
  await h.client.acquireBackgroundWriter(task.taskId, 1)
  await Bun.sleep(5)
  const list = await h.client.backgroundSessions()
  expect(list.ok && list.sessions[0]?.writer).toBeUndefined()
  expect(h.store.sessionBackground.get(task.taskId)?.writer).toBeDefined()
  await h.daemon.stop()
  h.client.close()
  const next = await start({ dir: h.dir, project: h.project })
  const after = await next.client.backgroundSessions()
  expect(after.ok && after.sessions[0]).toMatchObject({ sessionId: task.taskId, state: "stopped" })
  expect(next.store.tasks.list()[0]?.state).toBe("interrupted")
})

test("Agent View metadata normalizes, persists and resets without touching transcript or session archive", async () => {
  const h = await start()
  const sessionId = await openSession(h)
  const before = h.store.sessionSummary(sessionId)
  expect(await h.client.agentViewMetadata(sessionId)).toMatchObject({ ok: true, metadata: null })
  await h.client.patchAgentViewMetadata(sessionId, { title: " Inspection ", tags: [" audit ", "audit", ""], group: " Backend ", priority: "high", notes: " Read results ", pinned: true, archived: true })
  const meta = await h.client.agentViewMetadata(sessionId)
  expect(meta).toMatchObject({ ok: true, metadata: { title: "Inspection", tags: ["audit"], group: "Backend", priority: "high", notes: "Read results", pinned: true, archived: true } })
  expect(h.store.sessionSummary(sessionId)).toEqual(before)
  await h.daemon.stop()
  h.client.close()
  const next = await start({ dir: h.dir, project: h.project })
  expect(await next.client.agentViewMetadata(sessionId)).toMatchObject(meta)
  await next.client.patchAgentViewMetadata(sessionId, { title: null, tags: null, group: null, priority: null, notes: null, pinned: null, archived: null })
  expect(await next.client.agentViewMetadata(sessionId)).toMatchObject({ ok: true, metadata: null })
  const unknown = await next.client.patchAgentViewMetadata(ids("session"), { tags: ["bad"] })
  expect(unknown.ok).toBe(false)
})

test("global and per-target command inboxes support target-owned result patches and reject invalid transitions", async () => {
  const h = await start()
  const source = await openSession(h)
  const target = await openSession(h)
  await h.client.subscribe(target)
  const reply = await h.client.createAgentCommand(source, target, { kind: "tag", tags: ["audit"] })
  const command = reply.ok && reply.result?.command as AgentCommandRecord
  expect(command).toBeTruthy()
  const global = await h.client.send({ type: "session.agent-command.list" })
  expect(global.ok && global.result?.commands).toMatchObject([{ commandId: command && command.commandId }])
  const incoming = await h.client.send({ type: "session.agent-command.list-by-session", sessionId: target })
  expect(incoming.ok && incoming.result?.commands).toMatchObject([{ commandId: command && command.commandId }])
  if (!command) return
  expect((await h.client.send({ type: "session.agent-command.patch", sessionId: source, commandId: command.commandId, state: "running" })).ok).toBe(false)
  expect((await h.client.send({ type: "session.agent-command.patch", sessionId: target, commandId: command.commandId, state: "running" })).ok).toBe(true)
  const done = await h.client.send({ type: "session.agent-command.patch", sessionId: target, commandId: command.commandId, state: "completed", result: "Tagged" })
  expect(done.ok && done.result?.command).toMatchObject({ state: "completed", result: "Tagged" })
  expect((await h.client.send({ type: "session.agent-command.patch", sessionId: target, commandId: command.commandId, state: "pending" })).ok).toBe(false)
  const cleared = await h.client.send({ type: "session.agent-command.patch", sessionId: target, commandId: command.commandId, result: null })
  expect(cleared.ok && (cleared.result?.command as AgentCommandRecord).result).toBeUndefined()
})

test("failed background children wake once; an unavailable actor retains its outbox entry for retry", async () => {
  const h = await start({ steps: [() => { throw new Error("Provider failed locally") }, stop("Owner saw the failure")] })
  const parent = await openSession(h)
  const task = await child(h, parent)
  await until(() => h.store.tasks.list()[0]?.state === "failed" && h.requests.length === 2)
  expect(notices(h, parent)).toHaveLength(1)
  expect(notices(h, parent)[0]).toMatchObject({ text: expect.stringContaining("subagent failed") })
  expect(await h.client.backgroundSessions()).toMatchObject({ ok: true, sessions: [{ state: "failed" }] })
  const next = { ...task, generation: 2, state: "failed" as const, result: "Saved failure" }
  h.store.sessionBackground.wakes.finish(next, ids("queue"))
  let available = false, delivered = 0
  const wake = createTaskOwnerWake({ store: h.store, mask: (_id, text) => text, notify: async (_id, _text, id) => { if (!available) return; delivered++; return id } })
  try {
    await wake.drain()
    expect(h.store.sessionBackground.wakes.pending()).toHaveLength(1)
    available = true
    await wake.drain()
    await wake.drain()
    expect(delivered).toBe(1)
    expect(h.store.sessionBackground.wakes.pending()).toHaveLength(0)
  } finally { wake.stop() }
})

test("masked metadata and summaries respect their size limits after redaction expands text", async () => {
  const h = await start()
  const sessionId = await openSession(h)
  const background = createSessionBackground({ store: h.store, now: Date.now, mask: (_id, text) => text.replaceAll("x", "[redacted:session-secret]"), changed() {}, metadataChanged() {} })
  const info = background.register(sessionId, { summary: "x".repeat(4000), error: "x".repeat(4000) })
  expect(info.summary).toHaveLength(4000)
  expect(info.error).toHaveLength(4000)
  const metadata = background.handle({ type: "session.agent-view.metadata.patch", id: ids("command"), clientId: ids("client"), sessionId, patch: { title: "x".repeat(120), group: "x".repeat(80), notes: "x".repeat(4000), tags: ["x".repeat(40)], priority: "high" } })!.metadata as import("@mendcode/protocol").AgentViewMetadata
  expect(metadata.title).toHaveLength(120)
  expect(metadata.group).toHaveLength(80)
  expect(metadata.notes).toHaveLength(4000)
  expect(metadata.tags[0]).toHaveLength(40)
  expect(metadata.priority).toBe("high")
  expect(await h.client.agentViewMetadataList(h.project)).toMatchObject({ ok: true, metadata: [{ sessionId }] })
})

test("manual terminal inbox patches are retained when the linked target turn later ends", async () => {
  const h = await start({ steps: [hang] })
  const source = await openSession(h), target = await openSession(h)
  const reply = await h.client.createAgentCommand(source, target, { kind: "request_summary" })
  const command = reply.ok ? reply.result?.command as AgentCommandRecord : undefined!
  await h.client.reviewAgentCommand(target, command.commandId, "accepted")
  await until(() => h.store.agentCommands.get(command.commandId)?.state === "running")
  await h.client.patchAgentCommand(target, command.commandId, { state: "failed", error: "Target rejected the request" })
  await h.client.send({ type: "turn.cancel", sessionId: target, turnId: h.store.turns.list(target)[0]!.turnId as TurnId })
  await until(() => h.store.turns.list(target)[0]?.status === "cancelled")
  expect(await h.client.incomingAgentCommands(target)).toMatchObject({ ok: true, commands: [{ state: "failed", error: "Target rejected the request" }] })
})

test("nearby child completions batch into one owner turn with both durable task ids", async () => {
  const h = await start({ steps: [stop("First finding"), stop("Second finding"), stop("Owner collected both results")] })
  const parent = await openSession(h)
  const first = await child(h, parent), second = await child(h, parent)
  await until(() => h.requests.length === 3 && h.store.sessionBackground.wakes.pending().length === 0)
  expect(notices(h, parent)).toHaveLength(1)
  expect(notices(h, parent)[0]).toMatchObject({ text: expect.stringContaining(first.taskId) })
  expect(notices(h, parent)[0]).toMatchObject({ text: expect.stringContaining(second.taskId) })
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("untrusted evidence") })
})

test("a batched notice survives a crash before acknowledgement without redelivering any child", async () => {
  const h = await start()
  const parent = await openSession(h), first = await openSession(h), second = await openSession(h)
  const task = (taskId: SessionId): TaskRecord => ({ taskId, parentId: parent, rootId: parent, depth: 1, generation: 1, description: "Inspect", agent: "general", background: true, state: "completed", result: "Saved finding", createdAt: Date.now(), updatedAt: Date.now() })
  h.store.sessionBackground.wakes.finish(task(first), ids("queue"))
  h.store.sessionBackground.wakes.finish(task(second), ids("queue"))
  const crash = createTaskOwnerWake({ store: h.store, mask: (_id, text) => text, notify: async (_id, text, queueId) => {
    h.store.sessionSink.append({ type: "queue.added", sessionId: parent, queueId, text, notice: true, attachments: [] })
    throw new Error("Crash before ack")
  } })
  await crash.drain()
  crash.stop()
  expect(h.store.sessionBackground.wakes.pending()).toHaveLength(2)
  expect(new Set(h.store.sessionBackground.wakes.pending().map((entry) => entry.queueId)).size).toBe(1)
  let redelivered = 0
  const recovered = createTaskOwnerWake({ store: h.store, mask: (_id, text) => text, notify: async (_id, _text, id) => { redelivered++; return id } })
  await recovered.drain()
  recovered.stop()
  expect(redelivered).toBe(0)
  expect(h.store.sessionBackground.wakes.pending()).toHaveLength(0)
})

test("late child completion after owner cancellation never starts a fresh owner turn", async () => {
  const h = await start({ steps: [hang, hang] })
  const parent = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: parent, text: "Inspect", attachments: [] })
  await until(() => h.requests.length === 1)
  const task = await child(h, parent)
  await until(() => h.requests.length === 2)
  await h.client.send({ type: "turn.cancel", sessionId: parent, turnId: h.store.turns.list(parent)[0]!.turnId as TurnId })
  await h.client.send({ type: "task.status", sessionId: parent, taskId: task.taskId, action: "cancel" })
  await until(() => h.store.tasks.list()[0]?.state === "cancelled" && h.store.sessionBackground.wakes.pending().length === 0)
  expect(h.requests).toHaveLength(2)
  expect(notices(h, parent)).toHaveLength(0)
})

test("a busy owner's batch does not block another owner's ready notifications", async () => {
  const h = await start()
  const busy = await openSession(h), ready = await openSession(h)
  const children: SessionId[] = []
  for (let i = 0; i < 17; i++) children.push(await openSession(h))
  // No await between filling the outbox and draining it: the daemon's own drain timer must not run in between.
  for (const [i, taskId] of children.entries()) {
    h.store.sessionBackground.wakes.finish({ taskId, parentId: i < 16 ? busy : ready, rootId: i < 16 ? busy : ready, depth: 1, generation: 1, description: "Inspect", agent: "general", background: true, state: "completed", result: "Finding", createdAt: Date.now(), updatedAt: Date.now() }, ids("queue"))
  }
  const received: SessionId[] = []
  const wake = createTaskOwnerWake({ store: h.store, mask: (_id, text) => text, state: (id) => id === busy ? "busy" : "ready", notify: async (id, _text, queueId) => { received.push(id); return queueId } })
  try {
    await wake.drain()
    expect(received).toEqual([ready])
    expect(h.store.sessionBackground.wakes.pending(100)).toHaveLength(16)
  } finally { wake.stop() }
})
