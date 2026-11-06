import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: Array<{ close(): void }> = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-transient-"))
  dirs.push(dir)
  const store = openStore({ dir })
  stores.push(store)
  const session = ids("session")
  store.createSession({ id: session, directory: "/probe", title: "t" })
  return { store, session }
}
const types = (store: ReturnType<typeof open>["store"], session: SessionId) => store.readAfter(session, 0, 100).map((e) => e.type + (e.type === "foreground.state" ? `:${e.state}` : ""))

test("a settled run keeps only its newest foreground state and queue snapshot", () => {
  const { store, session } = open()
  const queueId = ids("queue"), turnId = ids("turn")
  store.sessionSink.append({ type: "queue.added", sessionId: session, queueId, text: "hi", attachments: [] })
  store.sessionSink.append({ type: "queue.changed", sessionId: session, queue: [{ queueId, preview: "hi", attachments: 0, kind: "message" }] })
  store.sessionSink.append({ type: "queue.changed", sessionId: session, queue: [] })
  store.sessionSink.append({ type: "turn.started", sessionId: session, turnId, queueId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating", turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "tool", turnId })
  store.sessionSink.append({ type: "turn.completed", sessionId: session, turnId })
  expect(types(store, session)).toContain("foreground.state:tool")
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  // Settled, but a client replaying right now still sees what a streaming one saw.
  expect(types(store, session)).toContain("foreground.state:generating")
  expect(store.pruneSettledEvents()).toMatchObject({ visited: 1, removed: 3, complete: true })
  expect(types(store, session)).toEqual(["session.created", "queue.added", "queue.changed", "turn.started", "turn.completed", "foreground.state:idle"])
  const queue = store.readAfter(session, 0, 100).find((e) => e.type === "queue.changed")
  expect(queue).toMatchObject({ queue: [] })
})

test("a second run replaces the first run's settled snapshots too", () => {
  const { store, session } = open()
  for (let run = 0; run < 3; run++) {
    store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating" })
    store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  }
  store.pruneSettledEvents()
  expect(types(store, session).filter((t) => t.startsWith("foreground"))).toEqual(["foreground.state:idle"])
})

test("a run that compacted keeps every state change, because the compaction view reads the one that ended it", () => {
  const { store, session } = open()
  const turnId = ids("turn")
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating", turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "compacting", turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating", turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  store.pruneSettledEvents()
  expect(types(store, session).filter((t) => t.startsWith("foreground"))).toEqual(["foreground.state:generating", "foreground.state:compacting", "foreground.state:generating", "foreground.state:idle"])
})

test("a row another session's transcript points at stays", () => {
  const { store, session } = open()
  const fork = ids("session")
  store.createSession({ id: fork, directory: "/probe", title: "fork" })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating" })
  const pointed = store.readAfter(session, 0, 100).find((e) => e.type === "foreground.state")!
  const db = new Database(path.join(dirs[0]!, "mendd.db"))
  try { db.query("INSERT INTO transcript_prefix(session_id, seq, parent_id, parent_seq) VALUES (?, 1, ?, ?)").run(fork, session, pointed.seq) } finally { db.close() }
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  store.pruneSettledEvents()
  expect(types(store, session)).toEqual(["session.created", "foreground.state:generating", "foreground.state:idle"])
})

test("a session with a turn in progress waits, and a deleted session leaves nothing waiting", () => {
  const { store, session } = open()
  const turnId = ids("turn")
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "generating", turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  store.sessionSink.append({ type: "turn.started", sessionId: session, turnId, queueId: ids("queue") })
  expect(store.pruneSettledEvents()).toMatchObject({ removed: 0 })
  expect(types(store, session)).toContain("foreground.state:generating")
  store.sessionSink.append({ type: "turn.completed", sessionId: session, turnId })
  store.deleteSession(session)
  expect(store.pruneSettledEvents()).toMatchObject({ visited: 0, complete: true })
})
