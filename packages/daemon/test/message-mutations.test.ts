import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Command, createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createMessageMutations } from "../src/message-mutations"
import { readSessionHistory } from "../src/session-reader"
import { readEventsWindow } from "../src/events-window"
import { createSessionHistory } from "../src/session-history"
import { createTurnSnapshots } from "../src/turn-snapshots"

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn() })
const ids = createIdFactory()
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "b87-revisions-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let store = openStore({ dir })
  cleanups.push(() => store.close())
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: dir, title: "Revision test" })
  const published: SessionEvent[] = []
  let busy = false
  const mutations = () => createMessageMutations({ store, busy: () => busy, capture: (_, text) => ({ text: text.replace("test-private-value", "‹secret:1›") }), publish: (event) => published.push(event) })
  const turn = (user = "first question", answer = "first answer") => {
    const turnId = ids("turn")
    const userId = ids("item")
    const answerId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: userId, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: userId, status: "ok", text: user, authorityText: user })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: answerId, kind: "agent_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: answerId, status: "ok", text: answer })
    store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), { role: "user", content: user }, { role: "assistant", content: answer, toolCalls: [] }])
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    return { turnId, userId, answerId }
  }
  const apply = (input: Record<string, unknown>) => mutations().apply(Command.parse({ id: ids("command"), clientId: ids("client"), sessionId, ...input }) as Parameters<ReturnType<typeof mutations>["apply"]>[0])
  const history = () => createSessionHistory({ store, snapshots: createTurnSnapshots({ store }), isBusy: () => false, publish: () => {}, now: Date.now })
  return { get store() { return store }, dir, sessionId, turn, apply, published, history, setBusy: (value: boolean) => { busy = value }, reopen() { store.close(); store = openStore({ dir }) } }
}

test("edits require opt-in, idle state, an exact revision and matching part identities", () => {
  const h = setup()
  const { userId } = h.turn()
  const edit = { type: "session.part.update", messageId: userId, partId: "body", part: { id: "body", type: "text", text: "edited" } }
  expect(h.apply(edit)).toMatchObject({ ok: false, code: "forbidden" })
  h.store.settings.set({ allowMessageEdits: true })
  h.setBusy(true)
  expect(h.apply(edit)).toMatchObject({ ok: false, code: "busy" })
  h.setBusy(false)
  expect(h.apply({ ...edit, expectedRevision: 2 })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.apply({ ...edit, partId: `file:${"a".repeat(64)}` })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.apply(edit)).toMatchObject({ ok: true, result: { revision: 1 } })
  expect(h.apply(edit)).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.apply({ type: "session.message.delete", messageId: ids("item") })).toMatchObject({ ok: false, code: "target_mismatch" })
})

test("revisions survive restart and project through old pages, history, timeline, export and transcript forks", () => {
  const h = setup()
  const first = h.turn()
  const second = h.turn("second question", "second answer")
  h.store.settings.set({ allowMessageEdits: true })
  const edit = { type: "session.part.update", messageId: first.userId, partId: "body", part: { id: "body", type: "text", text: "test-private-value revised" } }
  expect(h.apply(edit).ok).toBe(true)
  const before = h.store.lastSeq(h.sessionId)!
  const old = readEventsWindow({ store: h.store, sessionId: h.sessionId, before, limit: 100 })
  expect(old.events.find((e) => e.type === "item.completed" && e.itemId === first.userId)).toMatchObject({ text: "‹secret:1› revised", authorityText: "first question" })
  expect(h.history().timeline(h.sessionId)).toMatchObject({ ok: true, result: { entries: [{ preview: "‹secret:1› revised" }, { preview: "second question" }] } })
  expect(h.apply({ type: "session.message.delete", messageId: second.answerId }).ok).toBe(true)
  const file = path.join(h.dir, "keep.txt")
  writeFileSync(file, "unchanged")
  expect(h.apply({ type: "session.part.delete", messageId: first.userId, partId: "body", expectedRevision: 1 }).ok).toBe(true)
  expect(readFileSync(file, "utf8")).toBe("unchanged")
  const report = readSessionHistory(h.store, { sessionId: h.sessionId })
  expect(report).toMatchObject({ ok: true, result: { turns: [{ items: [{ text: "" }, { text: "first answer" }] }, { items: [{ text: "second question" }] }] } })
  const exported = h.history().export({ sessionId: h.sessionId, format: "markdown" })
  expect(exported.ok && exported.result.text).not.toContain("second answer")
  const forkId = ids("session")
  h.store.createSession({ id: forkId, directory: h.dir, title: "fork" })
  h.store.forkConversation(h.sessionId, forkId, { throughTurnId: second.turnId, cuts: h.store.turns.messageCounts(h.sessionId) })
  expect(h.store.messages.read(forkId, first.userId)?.snapshot.text).toBe("")
  expect(h.store.messages.read(forkId, second.answerId)?.deleted).toBe(true)
  h.reopen()
  expect(h.store.messages.read(h.sessionId, first.userId)?.revision).toBe(2)
  expect(h.store.messages.read(h.sessionId, second.answerId)?.deleted).toBe(true)
  expect(JSON.stringify(h.store.engineMessages.load(h.sessionId, "native"))).not.toContain("second answer")
  expect(h.published).toHaveLength(3)
})

test("native deletions adjust later turn marks; compaction, ambiguous text and external bindings refuse safely", () => {
  const h = setup()
  const first = h.turn()
  const second = h.turn("second", "answer two")
  h.store.settings.set({ allowMessageEdits: true })
  expect(h.apply({ type: "session.message.delete", messageId: first.answerId }).ok).toBe(true)
  expect(h.store.turns.get(h.sessionId, second.turnId)?.history?.native).toBe(1)
  expect(h.apply({ type: "session.part.update", messageId: second.userId, partId: "body", part: { id: "body", type: "text", text: "changed second" } }).ok).toBe(true)
  h.store.engineBindings.set(h.sessionId, "codex", "external-test-thread")
  const seq = h.store.lastSeq(h.sessionId)
  expect(h.apply({ type: "session.message.delete", messageId: first.userId })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.store.lastSeq(h.sessionId)).toBe(seq)
  const other = setup()
  const item = other.turn()
  other.store.settings.set({ allowMessageEdits: true })
  other.store.engineMessages.replace(other.sessionId, "native", [{ role: "user", content: "summary" }])
  expect(other.apply({ type: "session.message.delete", messageId: item.userId })).toMatchObject({ ok: false, code: "target_mismatch" })
})

test("file parts delete/rename without touching blob bytes; native tool deletion preserves call/result pairing", () => {
  const h = setup()
  h.store.settings.set({ allowMessageEdits: true })
  const item = h.turn()
  const ref = h.store.putBlob(new TextEncoder().encode("attachment"), "text/plain")
  h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId: item.userId, status: "ok", text: "first question", attachments: [ref] })
  const messages = h.store.engineMessages.load(h.sessionId, "native") as Record<string, unknown>[]
  messages[0]!.attachments = [ref]
  h.store.engineMessages.replace(h.sessionId, "native", messages)
  h.store.turns.setHistory(h.sessionId, item.turnId, { native: 0 })
  expect(h.apply({ type: "session.part.update", messageId: item.userId, partId: `file:${ref.sha256}`, part: { id: `file:${ref.sha256}`, type: "file", attachment: { ...ref, name: "notes.txt" } } }).ok).toBe(true)
  expect(h.apply({ type: "session.part.delete", messageId: item.userId, partId: `file:${ref.sha256}`, expectedRevision: 1 }).ok).toBe(true)
  expect(readFileSync(h.store.blobPath(ref.sha256), "utf8")).toBe("attachment")
  const turnId = ids("turn")
  const toolId = ids("item")
  h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue") })
  h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId: toolId, kind: "tool_call", meta: { tool: "read" } })
  h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId: toolId, status: "ok", text: "tool output" })
  h.store.engineMessages.save(h.sessionId, "native", [...h.store.engineMessages.load(h.sessionId, "native"), { role: "assistant", content: "", toolCalls: [{ callId: "call-1", name: "read", args: {} }] }, { role: "tool", callId: "call-1", name: "read", output: "tool output", isError: false }])
  h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId })
  expect(h.apply({ type: "session.message.delete", messageId: toolId }).ok).toBe(true)
  expect(h.store.engineMessages.load(h.sessionId, "native").at(-1)).toMatchObject({ role: "assistant", toolCalls: [] })
})
