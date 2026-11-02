import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"
import { compactEnvelope, eventPayload, type EventRow } from "../src/compress"

type Store = ReturnType<typeof openStore>

function writeTurn(store: Store, ids: ReturnType<typeof createIdFactory>, sessionId: SessionId): SessionEvent[] {
  const turnId = ids("turn"), user = ids("item"), tool = ids("item"), answer = ids("item")
  return [
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") }),
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: user, kind: "user_message" }),
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: user, status: "ok", text: "list the \"colors\" 日本語" }),
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: tool, kind: "tool_call", meta: { tool: "read" } }),
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: tool, status: "ok", text: "export const colors = {}\n".repeat(400), toolInput: "{\"path\":\"a.ts\"}" }),
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: answer, kind: "agent_message" }),
    store.sessionSink.append({ type: "item.delta", sessionId, itemId: answer, text: "- back" }),
    store.sessionSink.append({ type: "item.delta", sessionId, itemId: answer, text: "ground 🚀" }),
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: answer, status: "ok", text: "- background 🚀" }),
    store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "probe", model: "offline", input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId }),
  ] as SessionEvent[]
}

const rowsOf = (dir: string) => {
  const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
  try { return db.query<EventRow, []>("SELECT session_id, seq, type, at, payload FROM events ORDER BY session_id, seq").all() } finally { db.close() }
}

/** Every read path a client or engine uses, serialized so key order counts too. */
const views = (store: Store, sessionId: SessionId) => JSON.stringify({
  after: store.readAfter(sessionId, 0, 1000),
  exact: store.readExactAfter(sessionId, 0, 1000),
  newest: store.readBefore(sessionId, undefined, 5),
  older: store.readBefore(sessionId, 6, 3),
  usage: store.recentUsage(sessionId, 10),
})

test("new rows keep their envelope only in columns and read back byte-identical, envelope keys first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-envelope-new-")), ids = createIdFactory()
  const store = openStore({ dir })
  const sessionId = ids("session")
  try {
    store.createSession({ id: sessionId, directory: "/probe", title: "envelopes" })
    writeTurn(store, ids, sessionId)
    for (const row of rowsOf(dir)) expect(row.payload.startsWith("{\"sessionId\"")).toBe(false)
    const events = store.readAfter(sessionId, 0, 1000)
    expect(events.map(event => Object.keys(event).slice(0, 4))).toEqual(events.map(() => ["sessionId", "seq", "at", "type"]))
    expect(events.every(event => event.sessionId === sessionId)).toBe(true)
    expect(events.find(event => event.type === "item.completed" && event.toolInput !== undefined)).toMatchObject({ text: "export const colors = {}\n".repeat(400) })
    expect(store.readExactAfter(sessionId, 0, 1000).filter(event => event.type === "item.delta").map(event => event.type === "item.delta" && event.text)).toEqual(["- back", "ground 🚀"])
  } finally { store.close() }
})

test("rows written with their envelope stay readable, then idle batches compact them without changing a read", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-envelope-legacy-")), ids = createIdFactory()
  let store = openStore({ dir })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/probe", title: "legacy" })
  writeTurn(store, ids, sessionId)
  writeTurn(store, ids, sessionId)
  const expected = views(store, sessionId)
  store.close()
  const original = rowsOf(dir).map(row => eventPayload(row))
  const db = new Database(path.join(dir, "mendd.db"))
  const restore = db.query("UPDATE events SET payload = ? WHERE session_id = ? AND seq = ?")
  for (const row of rowsOf(dir)) restore.run(eventPayload(row), row.session_id, row.seq)
  db.close()
  expect(rowsOf(dir).every(row => row.payload.startsWith("{\"sessionId\""))).toBe(true)
  store = openStore({ dir })
  try {
    expect(views(store, sessionId)).toBe(expected)
    let complete = false
    for (let i = 0; i < 50 && !complete; i++) complete = store.foldStoredDeltas(3).complete
    expect(complete).toBe(true)
    const migrated = rowsOf(dir)
    expect(migrated.some(row => row.payload.startsWith("{\"sessionId\""))).toBe(false)
    expect(migrated.map(row => eventPayload(row))).toEqual(original)
    expect(views(store, sessionId)).toBe(expected)
  } finally { store.close() }
})

test("a row whose payload does not start with its exact envelope is kept as written and still reads", () => {
  const payload = JSON.stringify({ type: "turn.completed", sessionId: "ses_x", seq: 4, at: 9, turnId: "trn_x" })
  expect(compactEnvelope(payload, { sessionId: "ses_x", seq: 4, at: 9, type: "turn.completed" })).toBe(payload)
  const moved = JSON.stringify({ sessionId: "ses_x", seq: 5, at: 9, type: "turn.completed", turnId: "trn_x" })
  expect(compactEnvelope(moved, { sessionId: "ses_x", seq: 4, at: 9, type: "turn.completed" })).toBe(moved)
  const bare = JSON.stringify({ sessionId: "ses_x", seq: 4, at: 9, type: "turn.completed" })
  const compact = compactEnvelope(bare, { sessionId: "ses_x", seq: 4, at: 9, type: "turn.completed" })
  expect(compact).toBe("{}")
  expect(eventPayload({ session_id: "ses_x", seq: 4, at: 9, type: "turn.completed", payload: compact })).toBe(bare)
})

test("a fork reads a compact parent with its own session and sequence, before and after the parent is deleted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-envelope-fork-")), ids = createIdFactory()
  const store = openStore({ dir })
  const parent = ids("session"), child = ids("session")
  try {
    store.createSession({ id: parent, directory: "/probe", title: "parent" })
    store.createSession({ id: child, directory: "/probe", title: "child" })
    const first = writeTurn(store, ids, parent)
    writeTurn(store, ids, parent)
    const turnId = (first[0] as Extract<SessionEvent, { type: "turn.started" }>).turnId
    store.forkConversation(parent, child, { throughTurnId: turnId, cuts: {} })
    const forked = views(store, child)
    const events = store.readAfter(child, 0, 1000)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(event => event.sessionId === child)).toBe(true)
    expect(events.map(event => event.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events.map(event => Object.keys(event).slice(0, 4))).toEqual(events.map(() => ["sessionId", "seq", "at", "type"]))
    store.deleteSession(parent)
    store.collectBlobs()
    expect(views(store, child)).toBe(forked)
  } finally { store.close() }
})
