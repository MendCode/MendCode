import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createIdFactory, MAX_FRAME_BYTES, SessionSummary, type SessionId } from "@mendcode/protocol"
import { boot, stop, openSession, say, until, type NativeHarness } from "./native-harness"
import { createSessionAutomation } from "../src/session-automation"

const ids = createIdFactory()
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function native(options: Parameters<typeof boot>[0] = {}) {
  const h = await boot(options)
  cleanup.push(() => h.cleanup())
  return h
}
async function create(h: NativeHarness, input: { title?: string; parentId?: SessionId; directory?: string; agent?: string } = {}) {
  const reply = await h.client.send({ type: "session.create", directory: input.directory ?? h.project, ...input })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result!.sessionId as SessionId
}

test("metadata includes parent, model, agent, timestamps; unknown queries and invalid parents fail", async () => {
  const h = await native()
  const root = await create(h, { title: "Root" })
  const child = await create(h, { title: "Child", parentId: root, agent: "plan" })
  const known = await h.client.getSession(child)
  expect(known).toMatchObject({ ok: true, session: { parentId: root, permission: "plan", status: "idle", title: "Child" } })
  if (known.ok) expect(SessionSummary.safeParse(known.session).success).toBe(true)
  expect(await h.client.send({ type: "session.list", roots: false, agent: "plan" })).toMatchObject({ ok: true, result: { sessions: [{ sessionId: child }] } })
  expect(await h.client.getSession(ids("session"))).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  const count = h.store.listSessions({ roots: false }).length
  expect(await h.client.send({ type: "session.create", directory: h.project, parentId: ids("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  expect(h.store.listSessions({ roots: false }).length).toBe(count)
})

test("list filters roots, project, literal title search, since, agent, model and derived state before applying limit", async () => {
  const h = await native({ steps: [stop("done")] })
  const old = await create(h, { title: "Literal 100% client" })
  await h.client.send({ type: "session.model.set", sessionId: old, choice: { model: "gpt-6-luna" } })
  await h.client.subscribe(old)
  await say(h, old, "finish")
  const child = await create(h, { title: "Child", parentId: old })
  await create(h, { title: "Other project", directory: "/other-project" })
  for (let i = 0; i < 501; i++) h.store.createSession({ id: ids("session"), directory: h.project, title: `New ${i}` })
  const filtered = await h.client.send({ type: "session.list", directory: h.project, limit: 1, state: "completed" })
  expect(filtered).toMatchObject({ ok: true, result: { sessions: [{ sessionId: old, status: "completed" }] } })
  const search = await h.client.send({ type: "session.list", search: "100%", model: "gpt-6", agent: "build", since: 0 })
  expect(search).toMatchObject({ ok: true, result: { sessions: [{ sessionId: old }] } })
  const scoped = await h.client.send({ type: "session.list", project: "/other-project" })
  expect(scoped).toMatchObject({ ok: true, result: { sessions: [{ title: "Other project" }] } })
  const children = await h.client.send({ type: "session.list", directory: h.project, roots: false, search: "Child" })
  expect(children).toMatchObject({ ok: true, result: { sessions: [{ sessionId: child, parentId: old }] } })
  const active = await h.client.send({ type: "session.list", active: true })
  expect(active).toMatchObject({ ok: true, result: { sessions: [] } })
})

test("inspect reports finished conversation, children and pending requests; historical text and metadata are sanitized", async () => {
  const h = await native({ steps: [stop("answer")] })
  const root = await openSession(h)
  await say(h, root, "first")
  const child = await create(h, { parentId: root })
  const secret = `sk-proj-${"A".repeat(40)}`
  h.store.renameSession(root, secret)
  const turnId = ids("turn")
  const requestId = ids("request")
  h.store.sessionSink.append({ type: "turn.started", sessionId: root, turnId, queueId: ids("queue") })
  h.store.sessionSink.append({ type: "server.request", sessionId: root, turnId, requestId, kind: "question", title: "Choose", detail: `api_key=${secret}` })
  const pending = await h.client.inspectSession(root)
  expect(pending).toMatchObject({ ok: true, snapshot: { state: "waiting_for_input", children: [{ sessionId: child }], pending: { questions: [{ requestId }] } } })
  expect(JSON.stringify(pending)).not.toContain(secret)
  h.store.sessionSink.append({ type: "server.request.resolved", sessionId: root, requestId, resolution: "answered" })
  h.store.sessionSink.append({ type: "turn.failed", sessionId: root, turnId, error: { code: "test", message: "failure" } })
  const failed = await h.client.inspectSession(root)
  expect(failed).toMatchObject({ ok: true, snapshot: { state: "failed", pending: { questions: [] }, messages: { turns: [{ preview: "first" }] } } })
})

test("per-turn model, variant and agent reach the provider without changing the saved selection", async () => {
  const h = await native({ steps: [stop("override"), stop("default")] })
  mkdirSync(path.join(h.dir, "agents"))
  writeFileSync(path.join(h.dir, "agents", "review.md"), "---\ndescription: Reviews changes\nmode: primary\nmodel: gpt-6-sol\n---\nInspect the changes only.")
  const root = await openSession(h)
  await h.client.send({ type: "session.model.set", sessionId: root, choice: { model: "script-1" } })
  expect(await h.client.send({ type: "user.submit", sessionId: root, text: "override", attachments: [], selection: { model: { model: "gpt-6-luna", variant: "high" }, agent: "review" } })).toMatchObject({ ok: true })
  await until(() => h.store.lastTurnStatus(root) === "completed")
  await say(h, root, "default")
  expect(h.requests[0]).toMatchObject({ model: "gpt-6-luna", effort: "high", system: expect.stringContaining("Inspect the changes only.") })
  expect(h.requests[1]).toMatchObject({ model: "script-1", system: "BASE" })
  expect(h.store.sessionModel(root)).toEqual({ model: "script-1" })
  expect(h.store.sessionAgent(root)).toBeUndefined()
  expect(await h.client.send({ type: "user.submit", sessionId: root, text: "bad", attachments: [], selection: { agent: "missing" } })).toMatchObject({ ok: false })
  expect(await h.client.send({ type: "user.submit", sessionId: root, text: "bad", attachments: [], selection: { model: { model: "gpt-6-luna", variant: "missing" } } })).toMatchObject({ ok: false })
})

test("queue selection survives a daemon restart and applies only to that queued turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "b15-restart-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const h = await native({ dir, project: dir, steps: [(request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }))] })
  const root = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: root, text: "running", attachments: [] })
  await until(() => h.requests.length === 1)
  await h.client.send({ type: "user.submit", sessionId: root, text: "queued", attachments: [], selection: { model: { model: "gpt-6-luna", variant: "high" }, agent: "plan" } })
  await h.daemon.stop()
  h.client.close()
  const resumed = await native({ dir, project: dir, steps: [stop("resumed"), stop("new turn")] })
  expect(resumed.store.queueOf(root)[0]?.selection).toMatchObject({ model: { model: "gpt-6-luna", variant: "high", effort: "high" }, agent: "plan" })
  await resumed.client.send({ type: "user.submit", sessionId: root, text: "resume", attachments: [] })
  await until(() => resumed.store.lastTurnStatus(root) === "completed" && resumed.requests.length === 2)
  expect(resumed.requests[0]).toMatchObject({ model: "gpt-6-luna", effort: "high" })
  expect(resumed.requests[1]?.model).toBeUndefined()
})

test("a turn the daemon restart interrupted reads as interrupted, a user cancel as cancelled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "status-restart-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const hang = (request: { signal: AbortSignal }) => new Promise<never>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }))
  const h = await native({ dir, project: dir, steps: [hang] })
  const root = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: root, text: "running", attachments: [] })
  await until(() => h.requests.length === 1)
  await h.daemon.stop()
  h.client.close()
  const resumed = await native({ dir, project: dir, steps: [hang] })
  await until(() => resumed.store.lastTurnStatus(root) === "interrupted")
  expect(await resumed.client.getSession(root)).toMatchObject({ ok: true, session: { status: "interrupted" } })
  expect(await resumed.client.send({ type: "session.inspect", sessionId: root, limit: 1 })).toMatchObject({ ok: true, result: { state: "interrupted" } })
  expect(await resumed.client.send({ type: "session.list", directory: dir, state: "interrupted" })).toMatchObject({ ok: true, result: { sessions: [{ sessionId: root }] } })
  expect(await resumed.client.send({ type: "session.list", directory: dir, state: "cancelled" })).toMatchObject({ ok: true, result: { sessions: [] } })
  const other = await openSession(resumed)
  await resumed.client.send({ type: "user.submit", sessionId: other, text: "running", attachments: [] })
  await until(() => resumed.requests.length === 1)
  const turn = resumed.store.readAfter(other, 0).find((event) => event.type === "turn.started")
  if (turn?.type !== "turn.started") throw new Error("no turn")
  await resumed.client.send({ type: "turn.cancel", sessionId: other, turnId: turn.turnId })
  await until(() => resumed.store.lastTurnStatus(other) === "cancelled")
  expect(await resumed.client.getSession(other)).toMatchObject({ ok: true, session: { status: "cancelled" } })
})

test("fork before a user message excludes that turn, including the first message, and normal CLI fork carries its transcript", async () => {
  const h = await native({ steps: [stop("one"), stop("two")] })
  const root = await openSession(h)
  await say(h, root, "first")
  await say(h, root, "second")
  const turns = h.store.turns.list(root)
  const fork = await h.client.send({ type: "session.fork", sessionId: root, beforeItemId: turns[1]!.itemId as import("@mendcode/protocol").ItemId })
  if (!fork.ok) throw new Error(fork.error.message)
  const snapshot = await h.client.inspectSession(fork.result!.sessionId as SessionId)
  expect(snapshot).toMatchObject({ ok: true, snapshot: { messages: { turns: [{ preview: "first" }] } } })
  expect(JSON.stringify(snapshot)).not.toContain("second")
  const empty = await h.client.send({ type: "session.fork", sessionId: root, beforeItemId: turns[0]!.itemId as import("@mendcode/protocol").ItemId })
  expect(empty).toMatchObject({ ok: true, result: { copied: 0 } })
  const full = await h.client.send({ type: "session.fork", sessionId: root, transcript: true })
  expect(full).toMatchObject({ ok: true, result: { copied: 4 } })
})

test("large inspect results stay below the wire limit and report truncation", async () => {
  const h = await native()
  const root = await create(h)
  for (let i = 0; i < 15; i++) {
    const turnId = ids("turn")
    const itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId: root, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: root, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId: root, itemId, status: "ok", text: "長".repeat(20_000) })
    h.store.sessionSink.append({ type: "turn.completed", sessionId: root, turnId })
  }
  const service = createSessionAutomation({ store: h.store, foreground: () => undefined, loops: () => [], tasks: () => [] })
  const result = service.inspect(root, 0)!
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_FRAME_BYTES - 4_096)
  expect(result.truncated).toBe(true)
})

test("fork before a native assistant keeps its prompt and earlier answers without copying the selected answer", async () => {
  const h = await native({ steps: [stop("first answer"), stop("excluded answer"), stop("branch answer")] })
  const root = await openSession(h)
  await say(h, root, "first prompt")
  await say(h, root, "second prompt")
  const assistant = h.events.filter((event) => event.type === "item.started" && event.kind === "agent_message").at(-1)!
  if (assistant.type !== "item.started") throw new Error("missing assistant")
  const fork = await h.client.send({ type: "session.fork", sessionId: root, beforeItemId: assistant.itemId })
  if (!fork.ok) throw new Error(fork.error.message)
  const forkId = fork.result!.sessionId as SessionId
  expect(fork.result!.copied).toBe(3)
  const snapshot = await h.client.inspectSession(forkId)
  expect(JSON.stringify(snapshot)).toContain("second prompt")
  expect(JSON.stringify(snapshot)).toContain("first answer")
  expect(JSON.stringify(snapshot)).not.toContain("excluded answer")
  expect(h.store.lastTurnStatus(forkId)).toBe("completed")
  await say(h, forkId, "continue the branch")
  expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("excluded answer")
  expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("second prompt")
})
