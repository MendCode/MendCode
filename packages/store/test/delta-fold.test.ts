import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createDeltaFold } from "../src/delta-fold"
import type { SessionEvent } from "@mendcode/protocol"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

test("a length-only folded item replays exact UTF-16 fragments across a historical cut", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-length-cut-")), ids = createIdFactory()
  let store = openStore({ dir })
  const sessionId = ids("session"), itemId = ids("item"), turnId = ids("turn")
  try {
    store.createSession({ id: sessionId, directory: "/probe", title: "lengths" })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
    const chunks = ["a\ud83d", "\ude80", "\ud800", "final🚀"]
    const original = chunks.map(text => store.sessionSink.append({ type: "item.delta", sessionId, itemId, text }) as Extract<SessionEvent, { type: "item.delta" }>)
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: chunks.join("") })
    store.close()
    store = openStore({ dir })
    expect(store.readExactAfter(sessionId, original[0]!.seq - 1, 2)).toEqual(original.slice(0, 2))
    const db = new Database(path.join(dir, "mendd.db"))
    try {
      expect(createDeltaFold(db).cut(sessionId, itemId, original[2]!.seq)).toEqual(original.slice(0, 2))
      const row = db.query<{ data: Uint8Array }, []>("SELECT data FROM folded_deltas").get()!
      expect(Array.from(row.data.slice(0, 4))).toEqual([77, 68, 76, 1])
      const legacy = Bun.zstdCompressSync(Buffer.from(JSON.stringify(original.map(e => [e.seq, e.at, e.text, null, null, null]))))
      db.query("UPDATE folded_deltas SET data=?").run(legacy)
      db.run("UPDATE sessions SET active_turn=NULL")
      const fold = createDeltaFold(db)
      let complete = false
      for (let i = 0; i < 20; i++) if (fold.migrate(2).complete) { complete = true; break }
      expect(complete).toBe(true)
      expect(fold.cut(sessionId, itemId, original[2]!.seq)).toEqual(original.slice(0, 2))
    } finally { db.close() }
  } finally { store.close() }
})

test("sync paginates a folded item without losing original sequence positions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-sync-")), store = openStore({ dir })
  const ids = createIdFactory(), sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
  try {
    store.createSession({ id: sessionId, directory: "/probe", title: "sync" })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
    for (let i = 0; i < 500; i++) store.sessionSink.append({ type: "item.delta", sessionId, itemId, text: String(i) })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "final" })
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    const seen: SessionEvent[] = [], cursors: Record<string, number> = {}
    let complete = false
    for (let page = 0; page < 10; page++) {
      const result = store.projectSync.history(["/probe"], cursors)
      seen.push(...result.events)
      for (const event of result.events) cursors[event.sessionId] = event.seq - 1
      if (!result.hasMore) { complete = true; break }
      expect(result.events.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(result.events))).toBeLessThan(160_000)
    }
    expect(complete).toBe(true)
    expect(seen.map(event => event.seq)).toEqual(Array.from({ length: store.lastSeq(sessionId)! }, (_, i) => i + 1))
    expect(seen.filter(event => event.type === "item.delta")).toHaveLength(500)
  } finally { store.close() }
})

test("exact replay skips a completely empty sequence window left by old retention", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-gap-")), ids = createIdFactory()
  let store = openStore({ dir })
  const sessionId = ids("session")
  try {
    store.createSession({ id: sessionId, directory: "/probe", title: "gap" })
    const first = store.readAfter(sessionId, 0)[0]!
    store.close()
    const db = new Database(path.join(dir, "mendd.db"))
    const last = { ...first, seq: 5001 }
    db.query("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(sessionId, last.seq, last.type, last.at, JSON.stringify(last))
    db.query("UPDATE sessions SET last_seq = 5001 WHERE id = ?").run(sessionId)
    db.close()
    store = openStore({ dir })
    expect(store.readExactAfter(sessionId, 1, 1000)).toEqual([last])
    expect(store.readExactAfter(sessionId, 5001, 1000)).toEqual([])
  } finally { store.close() }
})

test("migration resumes its bounded cursor after reopen and leaves active sessions alone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-migrate-")), ids = createIdFactory()
  let store = openStore({ dir })
  const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
  try {
    store.createSession({ id: sessionId, directory: "/probe", title: "legacy" })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
    const delta = store.sessionSink.append({ type: "item.delta", sessionId, itemId, text: "partial" })
    expect(store.foldStoredDeltas(10)).toMatchObject({ visited: 0, removed: 0, complete: false })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "partial and more" })
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    store.close()
    const db = new Database(path.join(dir, "mendd.db"))
    db.run("DELETE FROM folded_deltas")
    db.query("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(sessionId, delta.seq, delta.type, delta.at, JSON.stringify(delta))
    db.close()
    store = openStore({ dir })
    expect(store.foldStoredDeltas(2)).toMatchObject({ visited: 2, removed: 0, complete: false })
    store.close()
    store = openStore({ dir })
    let removed = 0, complete = false
    for (let i = 0; i < 10; i++) {
      const result = store.foldStoredDeltas(2)
      removed += result.removed
      if (result.complete) { complete = true; break }
    }
    expect(complete).toBe(true)
    expect(removed).toBe(1)
    expect(store.readExactAfter(sessionId, delta.seq - 1, 1)).toEqual([delta])
    expect(store.readAfter(sessionId, 0).some(event => event.type === "item.delta")).toBe(false)
  } finally { store.close() }
})

test("a folded compressed tool delta survives a historical fork and parent deletion", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-tool-")), ids = createIdFactory()
  const store = openStore({ dir })
  const parent = ids("session"), child = ids("session"), turnId = ids("turn"), itemId = ids("item")
  const partial = "streamed 日本語 output\n".repeat(300)
  try {
    store.createSession({ id: parent, directory: "/probe", title: "tool" })
    store.createSession({ id: child, directory: "/probe", title: "cut" })
    store.sessionSink.append({ type: "turn.started", sessionId: parent, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: parent, turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    const cut = store.sessionSink.append({ type: "item.delta", sessionId: parent, itemId, text: partial }).seq + 1
    store.sessionSink.append({ type: "item.completed", sessionId: parent, itemId, status: "ok", text: partial + "done", toolInput: "{}" })
    store.sessionSink.append({ type: "turn.completed", sessionId: parent, turnId })
    store.forkConversation(parent, child, { throughTurnId: turnId, cuts: {}, beforeSeq: cut })
    store.deleteSession(parent)
    store.collectBlobs()
    expect(store.readAfter(child, 0).filter(e => e.type === "item.delta").map(e => e.text)).toEqual([partial])
  } finally { store.close() }
})

test("a normal completed fork survives parent deletion, reopen and a new cut in the child", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-descendant-")), ids = createIdFactory()
  let store = openStore({ dir })
  const parent = ids("session"), child = ids("session"), grandchild = ids("session")
  const turnId = ids("turn"), first = ids("item"), second = ids("item")
  try {
    for (const id of [parent, child, grandchild]) store.createSession({ id, directory: "/probe", title: "fork" })
    store.sessionSink.append({ type: "turn.started", sessionId: parent, turnId, queueId: ids("queue") })
    for (const [itemId, text] of [[first, "first 日本語"], [second, "second 🚀"]] as const) {
      store.sessionSink.append({ type: "item.started", sessionId: parent, turnId, itemId, kind: "agent_message" })
      store.sessionSink.append({ type: "item.delta", sessionId: parent, itemId, text })
      store.sessionSink.append({ type: "item.completed", sessionId: parent, itemId, status: "ok", text: text + " final" })
    }
    store.sessionSink.append({ type: "turn.completed", sessionId: parent, turnId })
    store.forkConversation(parent, child, { throughTurnId: turnId, cuts: {} })
    const before = store.readAfter(child, 0)
    expect(before.filter(e => e.type === "item.delta")).toEqual([])
    const cut = before.find(e => e.type === "item.started" && e.itemId === second)!.seq
    store.deleteSession(parent)
    store.collectBlobs()
    store.close()
    store = openStore({ dir })
    expect(store.readAfter(child, 0)).toEqual(before)
    store.forkConversation(child, grandchild, { throughTurnId: turnId, cuts: {}, beforeSeq: cut })
    const copied = store.readAfter(grandchild, 0)
    expect(copied.filter(e => e.type === "item.completed").map(e => e.text)).toEqual(["first 日本語 final"])
    expect(copied.some(e => "itemId" in e && e.itemId === second)).toBe(false)
    expect(copied.map(e => e.seq)).toEqual(Array.from({ length: copied.length }, (_, i) => i + 1))
  } finally { store.close() }
})

test("an existing mid-item fork remains readable after the parent completes and is deleted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-existing-")), ids = createIdFactory()
  const store = openStore({ dir }), parent = ids("session"), child = ids("session"), turnId = ids("turn"), itemId = ids("item")
  try {
    for (const id of [parent, child]) store.createSession({ id, directory: "/probe", title: "fork" })
    store.sessionSink.append({ type: "turn.started", sessionId: parent, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: parent, turnId, itemId, kind: "agent_message" })
    const delta = store.sessionSink.append({ type: "item.delta", sessionId: parent, itemId, text: "partial" })
    store.forkConversation(parent, child, { throughTurnId: turnId, cuts: {}, beforeSeq: delta.seq + 1 })
    const before = store.readAfter(child, 0)
    store.sessionSink.append({ type: "item.completed", sessionId: parent, itemId, status: "ok", text: "partial and more" })
    store.sessionSink.append({ type: "turn.completed", sessionId: parent, turnId })
    store.deleteSession(parent)
    expect(store.readAfter(child, 0)).toEqual(before)
  } finally { store.close() }
})

test("reopening a completed item preserves exact late forks at each original chunk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fold-cuts-"))
  let store = openStore({ dir })
  const ids = createIdFactory(), parent = ids("session"), turnId = ids("turn"), itemId = ids("item")
  try {
    store.createSession({ id: parent, directory: "/probe", title: "parent" })
    store.sessionSink.append({ type: "turn.started", sessionId: parent, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: parent, turnId, itemId, kind: "agent_message" })
    const chunks = ["partial", " 日本語", " 🚀"]
    const cuts = chunks.map(text => store.sessionSink.append({ type: "item.delta", sessionId: parent, itemId, text }).seq + 1)
    store.sessionSink.append({ type: "item.completed", sessionId: parent, itemId, status: "ok", text: chunks.join("") + " and more" })
    store.sessionSink.append({ type: "turn.completed", sessionId: parent, turnId })
    store.close()
    store = openStore({ dir })
    expect(store.readAfter(parent, 0).filter(e => e.type === "item.delta")).toHaveLength(0)
    for (const [index, beforeSeq] of cuts.entries()) {
      const child = ids("session")
      store.createSession({ id: child, directory: "/probe", title: "cut" })
      store.forkConversation(parent, child, { throughTurnId: turnId, cuts: {}, beforeSeq })
      const deltas = store.readAfter(child, 0).filter(e => e.type === "item.delta")
      expect(deltas.map(e => e.text)).toEqual(chunks.slice(0, index + 1))
    }
  } finally { store.close() }
})

test("folded item retains exact sequences, times, Unicode and input progress for every historical cut", () => {
  const db = new Database(":memory:")
  try {
    db.run("PRAGMA foreign_keys=ON")
    db.run("CREATE TABLE sessions(id TEXT PRIMARY KEY)")
    db.run("CREATE TABLE events(session_id TEXT, seq INTEGER, type TEXT, at INTEGER, payload TEXT)")
    db.run("CREATE INDEX events_message_item ON events(session_id, json_extract(payload, '$.itemId'), seq) WHERE type IN ('item.started', 'item.delta', 'item.completed')")
    db.run("CREATE TABLE transcript_prefix(parent_id TEXT, parent_seq INTEGER)")
    db.run("INSERT INTO sessions VALUES ('session')")
    const fold = createDeltaFold(db)
    const events = [
      { type: "item.delta", sessionId: "session", itemId: "item", seq: 3, at: 100, text: "partial" },
      { type: "item.delta", sessionId: "session", itemId: "item", seq: 7, at: 105, text: " 日本語 🚀", input: { chars: 20, lines: 2 } },
      { type: "item.delta", sessionId: "session", itemId: "item", seq: 9, at: 110, text: "\ud800" },
    ] as Extract<SessionEvent, { type: "item.delta" }>[]
    for (const e of events) db.run("INSERT INTO events VALUES (?, ?, ?, ?, ?)", [e.sessionId, e.seq, e.type, e.at, JSON.stringify(e)])
    const completed = { type: "item.completed", sessionId: "session", itemId: "item", seq: 10, at: 120, status: "ok", text: "final differs from stream" } as SessionEvent
    // A fork already referencing seq 7 must keep its physical source row.
    db.run("INSERT INTO transcript_prefix VALUES ('session', 7)")
    expect(db.transaction(() => fold.fold(completed))()).toBe(2)
    for (const cut of [0, 3, 4, 7, 8, 9, 10, 11]) expect(fold.cut("session", "item", cut)).toEqual(events.filter(e => e.seq < cut))
    expect(db.query("SELECT seq FROM events").all()).toEqual([{ seq: 7 }])
    expect(fold.fold(completed)).toBe(0)
    expect(fold.cut("session", "unknown", 100)).toEqual([])
    db.run("DELETE FROM sessions")
    expect(db.query("SELECT count(*) AS n FROM folded_deltas").get()).toEqual({ n: 0 })
  } finally { db.close() }
})

test("completion and folded deltas roll back together", () => {
  const db = new Database(":memory:")
  try {
    db.run("CREATE TABLE sessions(id TEXT PRIMARY KEY)")
    db.run("CREATE TABLE events(session_id TEXT, seq INTEGER, type TEXT, at INTEGER, payload TEXT)")
    db.run("CREATE INDEX events_message_item ON events(session_id, json_extract(payload, '$.itemId'), seq) WHERE type IN ('item.started', 'item.delta', 'item.completed')")
    db.run("CREATE TABLE transcript_prefix(parent_id TEXT, parent_seq INTEGER)")
    db.run("INSERT INTO sessions VALUES ('session')")
    const fold = createDeltaFold(db)
    const delta = { type: "item.delta", sessionId: "session", itemId: "item", seq: 1, at: 1, text: "partial" }
    db.run("INSERT INTO events VALUES ('session', 1, 'item.delta', 1, ?)", [JSON.stringify(delta)])
    const done = { ...delta, type: "item.completed", status: "ok", seq: 2 } as SessionEvent
    expect(fold.fold({ ...done, text: "" } as SessionEvent)).toBe(0)
    expect(() => db.transaction(() => { fold.fold(done); throw new Error("abort") })()).toThrow("abort")
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 })
    expect(fold.cut("session", "item", 3)).toEqual([])
  } finally { db.close() }
})
