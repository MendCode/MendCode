import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient, type CommandReply } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { realClock } from "@mendcode/kernel"
import { openStore } from "@mendcode/store"
import { createIdFactory, type AgentCommandRecord, type AgentCommandRequest, type GlobalEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createAgentCommands } from "../src/agent-commands"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
const record = (reply: CommandReply): AgentCommandRecord => {
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.command as AgentCommandRecord
}
async function boot(existing?: string) {
  const dir = existing ?? mkdtempSync(path.join(tmpdir(), "mend-b31-"))
  if (!existing) cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const events: GlobalEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "B31", onGlobal: (event) => { events.push(event) } })
  cleanup.push(() => client.close())
  await client.connect()
  const create = async (title: string, directory = "/work/b31") => {
    const reply = await client.send({ type: "session.create", directory, title })
    if (!reply.ok) throw new Error(reply.error.message)
    const id = reply.result?.sessionId as SessionId
    await client.subscribe(id, 0)
    return id
  }
  const command = async (source: SessionId, target: SessionId, request: AgentCommandRequest, expiresAt?: number) => record(await client.createAgentCommand(source, target, request, expiresAt))
  const get = async (sessionId: SessionId, id: string) => {
    const reply = await client.agentCommands(sessionId)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.report.commands.find((entry) => entry.commandId === id)!
  }
  return { dir, daemon, client, events, create, command, get }
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3000
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Command did not settle")
    await Bun.sleep(5)
  }
}

test("policy matrix is queryable through the typed client without a session", async () => {
  const h = await boot()
  const reply = await h.client.agentCommandPolicy()
  expect(reply.ok).toBe(true)
  if (!reply.ok) return
  expect(reply.report.matrix).toHaveLength(7)
  expect(reply.report.matrix.find((entry) => entry.kind === "stop")).toMatchObject({ decision: "approval_required", permissions: ["session.control.stop"] })
})

test("rename/tag require target review and persist view metadata without renaming the conversation", async () => {
  const h = await boot()
  const source = await h.create("Coordinator")
  const target = await h.create("Original title")
  const rename = await h.command(source, target, { kind: "rename", title: " UI worker " })
  expect(rename.state).toBe("pending")
  expect((await h.client.reviewAgentCommand(source, rename.commandId, "accepted")).ok).toBe(false)
  expect(record(await h.client.reviewAgentCommand(target, rename.commandId, "accepted"))).toMatchObject({ state: "completed", result: "Renamed target Agent View row." })
  const tags = await h.command(source, target, { kind: "tag", tags: [" ui ", "ui", "", "review"] })
  expect(tags.request).toEqual({ kind: "tag", tags: ["ui", "review"] })
  await h.client.reviewAgentCommand(target, tags.commandId, "accepted")
  const report = await h.client.agentCommands(source)
  expect(report.ok && report.report.metadata).toEqual([{ sessionId: target, title: "UI worker", tags: ["ui", "review"] }])
  expect(h.daemon.store.sessionInfo(target)?.title).toBe("Original title")
  await until(() => h.events.some((event) => event.type === "agent-commands.changed"))
})

test("summary accepts once, waits behind active work, and records the answer from its own turn", async () => {
  const h = await boot()
  const source = await h.create("Coordinator")
  const target = await h.create("Worker")
  await h.client.send({ type: "user.submit", sessionId: target, text: "/tool 120", attachments: [] })
  const summary = await h.command(source, target, { kind: "request_summary", instructions: "Focus on remaining work" })
  expect(summary.state).toBe("pending")
  expect(record(await h.client.reviewAgentCommand(target, summary.commandId, "accepted")).state).toBe("accepted")
  await until(async () => (await h.get(source, summary.commandId)).state === "completed")
  const settled = await h.get(source, summary.commandId)
  expect(settled.result).toContain("Read-only summary requested")
  expect(settled.result).toContain("remaining work")
  expect(settled.turnId).toBeDefined()
  expect((await h.client.reviewAgentCommand(target, summary.commandId, "accepted")).ok).toBe(false)
  expect(h.daemon.store.readAfter(target, 0).filter((event) => event.type === "turn.started")).toHaveLength(2)
})

test("same source/request deduplicates, per-target capacity rejects the fourth, reject frees capacity", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const first = await h.command(source, target, { kind: "rename", title: "one" })
  expect((await h.command(source, target, { kind: "rename", title: " one " })).commandId).toBe(first.commandId)
  await h.command(source, target, { kind: "rename", title: "two" })
  await h.command(source, target, { kind: "rename", title: "three" })
  expect(await h.command(source, target, { kind: "rename", title: "four" })).toMatchObject({ state: "rejected", error: expect.stringContaining("3 queued") })
  await h.client.reviewAgentCommand(target, first.commandId, "rejected")
  expect((await h.command(source, target, { kind: "tag", tags: [] })).state).toBe("pending")
})

test("expired requests cannot execute or occupy capacity", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const expired = await h.command(source, target, { kind: "stop" }, 0)
  expect(expired.state).toBe("expired")
  expect((await h.client.reviewAgentCommand(target, expired.commandId, "accepted")).ok).toBe(false)
  const pending = await h.command(source, target, { kind: "tag", tags: ["old"] }, Date.now() + 40)
  await Bun.sleep(45)
  expect((await h.get(source, pending.commandId)).state).toBe("expired")
  expect((await h.client.reviewAgentCommand(target, pending.commandId, "accepted")).ok).toBe(false)
  expect((await h.client.agentCommands(target)).ok).toBe(true)
})

test("pause/stop never run without the target's approval, and a rejection leaves the target untouched", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  for (const kind of ["stop", "pause_after_turn"] as const) {
    const command = await h.command(source, target, { kind })
    expect(command.state).toBe("pending")
    expect((await h.client.patchAgentCommand(target, command.commandId, { state: "completed" })).ok).toBe(false)
    expect((await h.client.patchAgentCommand(target, command.commandId, { state: "running" })).ok).toBe(false)
    expect(record(await h.client.reviewAgentCommand(target, command.commandId, "rejected")).state).toBe("rejected")
  }
  const listed = await h.client.send({ type: "session.list" })
  expect(listed.ok && (listed.result?.sessions as Array<{ sessionId: string; paused?: boolean }>).find((entry) => entry.sessionId === target)?.paused).toBeFalsy()
  expect(h.daemon.store.readAfter(target, 0).some((event) => event.type === "turn.started")).toBe(false)
})

test("an approved pause holds the target after its turn until the user resumes; an approved stop cancels the running turn", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const paused = await h.command(source, target, { kind: "pause_after_turn", reason: "review first" })
  const accepted = record(await h.client.reviewAgentCommand(target, paused.commandId, "accepted"))
  expect(accepted).toMatchObject({ state: "completed", result: expect.stringContaining("Paused target") })
  const listed = async () => {
    const reply = await h.client.send({ type: "session.list" })
    return reply.ok ? (reply.result?.sessions as Array<{ sessionId: string; paused?: boolean; state: string; queued: number }>).find((entry) => entry.sessionId === target)! : undefined
  }
  expect((await listed())?.paused).toBe(true)
  await until(() => h.events.some((event) => event.type === "session.activity" && event.sessionId === target && event.paused === true))
  await h.client.send({ type: "user.submit", sessionId: target, text: "hello", attachments: [] })
  await Bun.sleep(60)
  expect(h.daemon.store.readAfter(target, 0).some((event) => event.type === "turn.started")).toBe(false)
  expect(await listed()).toMatchObject({ paused: true, state: "queued", queued: 1 })
  expect((await h.client.send({ type: "session.control", sessionId: target, action: "resume" })).ok).toBe(true)
  await until(() => h.daemon.store.readAfter(target, 0).some((event) => event.type === "turn.completed"))
  expect((await listed())?.paused).toBeFalsy()

  await h.client.send({ type: "user.submit", sessionId: target, text: "/hang", attachments: [] })
  await until(() => h.daemon.store.readAfter(target, 0).filter((event) => event.type === "turn.started").length === 2)
  const stop = await h.command(source, target, { kind: "stop" })
  const stopped = record(await h.client.reviewAgentCommand(target, stop.commandId, "accepted"))
  expect(stopped).toMatchObject({ state: "completed", result: expect.stringContaining("Stopped target") })
  await until(() => h.daemon.store.readAfter(target, 0).some((event) => event.type === "turn.cancelled"))
})

test("cross-project, self, unknown targets and unbound reviewers are refused", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const other = await h.create("Other", "/work/other")
  for (const id of [source, other, createIdFactory()("session")]) expect((await h.client.createAgentCommand(source, id, { kind: "request_summary" })).ok).toBe(false)
  const command = await h.command(source, target, { kind: "tag", tags: [] })
  const unbound = createClient({ socketPath: h.daemon.socketPath, name: "unbound" })
  cleanup.push(() => unbound.close())
  await unbound.connect()
  expect((await unbound.reviewAgentCommand(target, command.commandId, "accepted")).ok).toBe(false)
})

test("cancelled message fails its lifecycle and a peer reply never bounces", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const message = await h.command(source, target, { kind: "send_message", text: "/hang" })
  await h.client.reviewAgentCommand(target, message.commandId, "accepted")
  await until(async () => (await h.get(source, message.commandId)).state === "running")
  const active = await h.get(source, message.commandId)
  await h.client.send({ type: "turn.cancel", sessionId: target, turnId: active.turnId! })
  await until(async () => (await h.get(source, message.commandId)).state === "failed")
  const peer = await h.command(source, target, { kind: "peer_message", text: "Status?" })
  // Cancelled targets hold notices until the user acts.
  await h.client.send({ type: "user.submit", sessionId: target, text: "Resume", attachments: [] })
  await until(async () => (await h.get(source, peer.commandId)).state === "completed")
  await until(() => h.daemon.store.readAfter(source, 0).some((event) => event.type === "queue.added" && event.notice))
  const targetNotices = h.daemon.store.readAfter(target, 0).filter((event) => event.type === "queue.added" && event.notice)
  expect(targetNotices).toHaveLength(1)
})

test("restart preserves pending/history/metadata and fails an in-flight exchange without replaying it", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const rename = await h.command(source, target, { kind: "rename", title: "Worker" })
  await h.client.reviewAgentCommand(target, rename.commandId, "accepted")
  const pending = await h.command(source, target, { kind: "tag", tags: ["review"] })
  const running = await h.command(source, target, { kind: "send_message", text: "/hang" })
  await h.client.reviewAgentCommand(target, running.commandId, "accepted")
  h.client.close()
  await h.daemon.stop()
  const next = await boot(h.dir)
  const listed = await next.client.agentCommands(target)
  expect(listed.ok).toBe(true)
  if (!listed.ok) return
  expect(listed.report.commands.find((entry) => entry.commandId === rename.commandId)?.state).toBe("completed")
  expect(listed.report.commands.find((entry) => entry.commandId === pending.commandId)?.state).toBe("pending")
  expect(listed.report.commands.find((entry) => entry.commandId === running.commandId)).toMatchObject({ state: "failed", error: expect.stringMatching(/interrupted|restarted/) })
  expect(listed.report.metadata[0]?.title).toBe("Worker")
})

test("restart reattaches summary and peer commands to their persisted queue without duplicate delivery", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  await h.client.send({ type: "user.submit", sessionId: target, text: "/hang", attachments: [] })
  const summary = await h.command(source, target, { kind: "request_summary" })
  await h.client.reviewAgentCommand(target, summary.commandId, "accepted")
  const peer = await h.command(source, target, { kind: "peer_message", text: "Status?" })
  h.client.close()
  await h.daemon.stop()
  const next = await boot(h.dir)
  expect((await next.get(target, summary.commandId)).state).toBe("accepted")
  expect((await next.get(target, peer.commandId)).queueId).toBe(peer.queueId)
  await next.client.send({ type: "user.submit", sessionId: target, text: "Resume", attachments: [] })
  await until(async () => (await next.get(source, summary.commandId)).state === "completed" && (await next.get(source, peer.commandId)).state === "completed")
  const notices = next.daemon.store.readAfter(target, 0).filter((event) => event.type === "queue.added" && event.notice)
  expect(notices).toHaveLength(2)
  await until(() => next.daemon.store.readAfter(source, 0).some((event) => event.type === "queue.added" && event.notice))
  expect(next.daemon.store.readAfter(source, 0).filter((event) => event.type === "queue.added" && event.notice)).toHaveLength(1)
})

test("recovery settles a finished turn from its projection and answer events without running it again", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const summary = await h.command(source, target, { kind: "request_summary" })
  await h.client.reviewAgentCommand(target, summary.commandId, "accepted")
  await until(async () => (await h.get(source, summary.commandId)).state === "completed")
  const complete = await h.get(source, summary.commandId)
  h.daemon.store.agentCommands.put({ ...complete, state: "running", result: undefined })
  h.client.close()
  await h.daemon.stop()
  const next = await boot(h.dir)
  expect(await next.get(source, summary.commandId)).toMatchObject({ state: "completed", result: complete.result, turnId: complete.turnId })
  expect(next.daemon.store.readAfter(target, 0).filter((event) => event.type === "turn.started")).toHaveLength(1)
})

test("dropping an accepted queued command fails it and frees target capacity", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  await h.client.send({ type: "user.submit", sessionId: target, text: "/hang", attachments: [] })
  const command = await h.command(source, target, { kind: "send_message", text: "Later" })
  const accepted = record(await h.client.reviewAgentCommand(target, command.commandId, "accepted"))
  expect((await h.client.send({ type: "queue.remove", sessionId: target, queueId: accepted.queueId! })).ok).toBe(true)
  await until(async () => (await h.get(source, command.commandId)).state === "failed")
  expect((await h.get(source, command.commandId)).error).toContain("removed the queued command")
})

test("secret input and output are masked without forwarding session-local markers", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const secret = "ghp_" + "a".repeat(36)
  const command = await h.command(source, target, { kind: "request_summary", instructions: secret })
  expect(JSON.stringify(command)).not.toContain(secret)
  await h.client.reviewAgentCommand(target, command.commandId, "accepted")
  await until(async () => (await h.get(source, command.commandId)).state === "completed")
  expect(JSON.stringify(await h.client.agentCommands(source))).not.toContain(secret)
  expect(JSON.stringify(h.daemon.store.agentCommands.get(command.commandId))).not.toContain(secret)
  expect((await h.get(source, command.commandId)).result).not.toContain("‹secret:")
})

test("existing secret markers cannot resolve a different session's secrets", async () => {
  const h = await boot()
  const source = await h.create("Source")
  const target = await h.create("Target")
  const command = await h.command(source, target, { kind: "peer_message", text: "Read ‹secret:1›" })
  await until(async () => (await h.get(source, command.commandId)).state === "completed")
  const notices = h.daemon.store.readAfter(target, 0).filter((event) => event.type === "queue.added" && event.notice)
  expect(JSON.stringify(notices)).toContain("[redacted:peer-secret]")
  expect(JSON.stringify(notices)).not.toContain("‹secret:")
  expect((await h.get(source, command.commandId)).result).not.toContain("‹secret:")
})

test("a long-running command keeps its answer while other sessions finish hundreds of turns", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b31-pressure-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir })
  cleanup.push(() => store.close())
  const ids = createIdFactory()
  const source = ids("session")
  const target = ids("session")
  store.createSession({ id: source, directory: "/work/b31", title: "Source" })
  store.createSession({ id: target, directory: "/work/b31", title: "Target" })
  const queueId = ids("queue")
  const commands = createAgentCommands({ store, clock: realClock, control: async () => ({ paused: false, cancelledTurn: false, cancelledChildren: 0 }), id: () => ids("command"), changed: () => {}, mask: (_id, text) => text, notify: async () => queueId, submit: async () => queueId })
  const command = await commands.create(source, target, { kind: "request_summary" })
  await commands.review(target, command.commandId, "accepted")
  const turnId = ids("turn")
  const itemId = ids("item")
  const base = { sessionId: target, seq: 1, at: Date.now() }
  commands.observe({ ...base, type: "turn.started", turnId, queueId })
  commands.observe({ ...base, type: "item.started", turnId, itemId, kind: "agent_message" })
  for (let index = 0; index < 201; index++) {
    const otherTurn = ids("turn")
    const otherItem = ids("item")
    commands.observe({ ...base, sessionId: source, type: "turn.started", turnId: otherTurn, queueId: ids("queue") })
    commands.observe({ ...base, sessionId: source, type: "item.started", turnId: otherTurn, itemId: otherItem, kind: "agent_message" })
    commands.observe({ ...base, sessionId: source, type: "item.completed", itemId: otherItem, status: "ok", text: "Other answer" })
    commands.observe({ ...base, sessionId: source, type: "turn.completed", turnId: otherTurn })
  }
  commands.observe({ ...base, type: "item.completed", itemId, status: "ok", text: "Long-running answer" })
  commands.observe({ ...base, type: "turn.completed", turnId })
  expect(commands.list(source).commands[0]).toMatchObject({ state: "completed", result: "Long-running answer" })
})
