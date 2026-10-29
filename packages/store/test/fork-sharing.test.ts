import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "../src"
import { codeText } from "./synthetic-data"
import { Database } from "bun:sqlite"

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Closed by the test itself.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()

function openTemp(dir?: string) {
  const where = dir ?? mkdtempSync(path.join(tmpdir(), "mend-fork-"))
  if (!dir) dirs.push(where)
  const store = openStore({ dir: where })
  stores.push(store)
  return { store, dir: where }
}

function newSession(store: Store) {
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/repo", title: "t" })
  return sessionId
}

const rng = (() => {
  let state = 7
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
})()

/** One finished turn with a tool call whose output is large (so it is stored packed), streamed deltas and the model messages. */
function runTurn(store: Store, sessionId: SessionId, text: string, options: { output?: string } = {}) {
  const turnId = ids("turn")
  const itemId = ids("item")
  const output = options.output ?? codeText(rng, 4_000)
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
  const toolItem = ids("item")
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: toolItem, kind: "tool_call", meta: { tool: "read" } })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: toolItem, status: "ok", text: output, toolInput: JSON.stringify({ path: "a.ts" }) })
  const answer = ids("item")
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: answer, kind: "agent_message" })
  store.sessionSink.append({ type: "item.delta", sessionId, itemId: answer, text: `re: ` })
  store.sessionSink.append({ type: "item.delta", sessionId, itemId: answer, text: text })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: answer, status: "ok", text: `re: ${text}` })
  const messages = [{ role: "user", content: text }, { role: "assistant", content: "", toolCalls: [{ id: toolItem, name: "read", input: {} }] }, { role: "tool", toolCallId: toolItem, content: output }, { role: "assistant", content: `re: ${text}` }]
  store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), ...messages])
  store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  return { turnId, itemId, toolItem, output }
}

const HISTORY = (store: Store, sessionId: SessionId) => store.engineMessages.load(sessionId, "native")
const texts = (store: Store, sessionId: SessionId) => store.readAfter(sessionId, 0, 10_000).flatMap((event) => (event.type === "item.completed" && event.text !== undefined ? [event.text] : []))

/** A fork through `turn`, with the cut the daemon would compute (the marks each turn recorded when it started). */
function forkAt(store: Store, from: SessionId, through: { turnId: string }, cut: number) {
  const to = newSession(store)
  store.forkConversation(from, to, { throughTurnId: through.turnId, cuts: { native: cut } })
  return to
}

describe("model history is shared by reference", () => {
  test("a fork reads its parent's prefix without a copy, and each side then grows on its own", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    runTurn(store, parent, "two")
    const physical = store.storageReport().engineBytes
    const fork = forkAt(store, parent, one, 4)
    const report = store.storageReport()
    expect(report.engineBytes).toBe(physical)
    expect(report).toMatchObject({ forkRefs: 1, sharedMessages: 4 })
    expect(report.sharedBytes).toBeGreaterThan(0)
    expect(HISTORY(store, fork)).toEqual(HISTORY(store, parent).slice(0, 4))
    expect(store.engineMessages.first(fork, "native")).toEqual(HISTORY(store, parent)[0])
    expect(store.turns.messageCounts(fork)).toEqual({ native: 4 })

    runTurn(store, fork, "fork only")
    runTurn(store, parent, "parent only")
    expect(HISTORY(store, fork)).toHaveLength(8)
    expect(HISTORY(store, fork)[4]).toMatchObject({ role: "user", content: "fork only" })
    expect(HISTORY(store, parent)[4]).toMatchObject({ role: "user", content: "two" })
    expect(HISTORY(store, parent)).toHaveLength(12)
    expect(HISTORY(store, parent).slice(0, 4)).toEqual(HISTORY(store, fork).slice(0, 4))
    expect(store.turns.messageCounts(fork)).toEqual({ native: 8 })
  })

  test("deleting the parent keeps every fork, chained ones included, and moves rows instead of copying them", () => {
    const { store } = openTemp()
    const root = newSession(store)
    const one = runTurn(store, root, "one")
    const two = runTurn(store, root, "two")
    runTurn(store, root, "three")
    const before = HISTORY(store, root)
    const short = forkAt(store, root, one, 4)
    const long = forkAt(store, root, two, 8)
    // A fork of a fork reads the middle one's own rows and the root's prefix.
    runTurn(store, long, "long only")
    const grandchild = forkAt(store, long, { turnId: store.turns.list(long).at(-1)!.turnId }, 12)
    const physical = store.storageReport().engineBytes
    const transcript = texts(store, grandchild)

    store.deleteSession(root)
    expect(HISTORY(store, short)).toEqual(before.slice(0, 4))
    expect(HISTORY(store, long)).toEqual([...before.slice(0, 8), ...HISTORY(store, long).slice(8)])
    expect(HISTORY(store, long)).toHaveLength(12)
    expect(HISTORY(store, grandchild)).toEqual(HISTORY(store, long))
    // Rows the forks read moved to a fork; only the part nobody reads (the root's third turn) is gone.
    const after = store.storageReport()
    expect(after.engineBytes).toBeLessThan(physical)
    expect(after.engineBytes).toBeGreaterThan(0)

    store.deleteSession(long)
    expect(HISTORY(store, short)).toEqual(before.slice(0, 4))
    expect(HISTORY(store, grandchild)).toHaveLength(12)
    store.deleteSession(short)
    expect(HISTORY(store, grandchild)).toHaveLength(12)
    expect(texts(store, grandchild)).toEqual(transcript)
    expect(HISTORY(store, grandchild).slice(0, 8)).toEqual(before.slice(0, 8))
    store.deleteSession(grandchild)
    expect(store.storageReport()).toMatchObject({ engineBytes: 0, forkRefs: 0, sharedMessages: 0 })
  })

  test("undoing the parent below the fork point hands the fork its own copy of just that tail, and redo restores the parent", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    runTurn(store, parent, "one")
    const two = runTurn(store, parent, "two")
    const marks = store.turns.messageCounts(parent)
    expect(marks).toEqual({ native: 8 })
    const fork = forkAt(store, parent, two, 8)
    const full = HISTORY(store, parent)

    store.rewindTurns({ sessionId: parent, turnIds: [two.turnId], cuts: { native: 4 } })
    expect(HISTORY(store, parent)).toEqual(full.slice(0, 4))
    expect(HISTORY(store, fork)).toEqual(full)
    expect(store.storageReport().sharedMessages).toBe(4)
    expect(store.restoreTurns({ sessionId: parent })).toMatchObject({ messages: 4 })
    expect(HISTORY(store, parent)).toEqual(full)
    expect(HISTORY(store, fork)).toEqual(full)
  })

  test("undo and redo inside a fork's shared prefix work, and the parent is untouched", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    runTurn(store, parent, "one")
    const two = runTurn(store, parent, "two")
    const full = HISTORY(store, parent)
    const fork = forkAt(store, parent, two, 8)
    expect(store.rewindTurns({ sessionId: fork, turnIds: [two.turnId], cuts: { native: 4 } })).toMatchObject({ messages: 4 })
    expect(HISTORY(store, fork)).toEqual(full.slice(0, 4))
    expect(HISTORY(store, parent)).toEqual(full)
    expect(store.restoreTurns({ sessionId: fork })).toMatchObject({ messages: 4 })
    expect(HISTORY(store, fork)).toEqual(full)
    // The fork can undo everything down to nothing and still redo.
    store.rewindTurns({ sessionId: fork, turnIds: [two.turnId], cuts: { native: 0 } })
    expect(HISTORY(store, fork)).toEqual([])
    expect(store.storageReport().forkRefs).toBe(0)
    store.restoreTurns({ sessionId: fork })
    expect(HISTORY(store, fork)).toEqual(full)
    expect(HISTORY(store, parent)).toEqual(full)
  })

  test("compaction of the parent (a rewrite of its history) leaves the fork with the history it had", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    runTurn(store, parent, "one")
    const two = runTurn(store, parent, "two")
    const full = HISTORY(store, parent)
    const fork = forkAt(store, parent, two, 8)
    store.engineMessages.replace(parent, "native", [{ role: "user", content: "summary" }])
    expect(HISTORY(store, parent)).toEqual([{ role: "user", content: "summary" }])
    expect(HISTORY(store, fork)).toEqual(full)
    // And compacting the fork leaves the parent alone.
    store.engineMessages.replace(fork, "native", [{ role: "user", content: "fork summary" }])
    expect(HISTORY(store, parent)).toEqual([{ role: "user", content: "summary" }])
    expect(HISTORY(store, fork)).toEqual([{ role: "user", content: "fork summary" }])
  })

  test("a message edit on the parent rewrites its history without touching the fork", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    const full = HISTORY(store, parent)
    const fork = forkAt(store, parent, one, 4)
    const edited = [{ role: "user", content: "edited" }, ...full.slice(1)]
    store.reviseMessage({ type: "message.revised", sessionId: parent, itemId: one.itemId, turnId: one.turnId, revision: 1, deleted: false, snapshot: { status: "ok", text: "edited" } } as never, { messages: edited, removed: [] })
    expect(HISTORY(store, parent)).toEqual(edited)
    expect(HISTORY(store, fork)).toEqual(full)
  })

  test("a stray write on a fork that does not extend its history is refused, as before", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    const fork = forkAt(store, parent, one, 4)
    runTurn(store, fork, "next")
    const history = HISTORY(store, fork)
    // save() appends only what is past the stored length: a shorter list changes nothing.
    store.engineMessages.save(fork, "native", history.slice(0, 2))
    expect(HISTORY(store, fork)).toEqual(history)
  })

  test("everything survives a restart", () => {
    const { store, dir } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    runTurn(store, parent, "two")
    const fork = forkAt(store, parent, one, 4)
    const expected = HISTORY(store, fork)
    store.close()
    const reopened = openTemp(dir).store
    expect(HISTORY(reopened, fork)).toEqual(expected)
    reopened.deleteSession(parent)
    expect(HISTORY(reopened, fork)).toEqual(expected)
  })

  test("cleaning old sessions keeps the fork of a removed parent", () => {
    let clock = 1_000_000
    const dir = mkdtempSync(path.join(tmpdir(), "mend-fork-"))
    dirs.push(dir)
    const store = openStore({ dir, now: () => clock })
    stores.push(store)
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    runTurn(store, parent, "two")
    const fork = forkAt(store, parent, one, 4)
    const expected = HISTORY(store, fork)
    clock += 40 * 86_400_000
    // Only the fork is recent: touch it.
    runTurn(store, fork, "later")
    const result = store.cleanStorage({ olderThanDays: 10, protect: new Set([fork]) })
    expect(result.sessionIds).toContain(parent)
    expect(HISTORY(store, fork).slice(0, 4)).toEqual(expected)
    expect(HISTORY(store, fork)).toHaveLength(8)
  })
})

describe("screenshots and other blobs", () => {
  test("forks reference the one stored blob; it stays until the last session that holds it goes", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const shot = store.putBlob(new Uint8Array(4096).fill(9), "image/png")
    store.refBlob(shot, parent)
    const one = runTurn(store, parent, "one")
    const forks = [forkAt(store, parent, one, 4), forkAt(store, parent, one, 4), forkAt(store, parent, one, 4)]
    expect(store.storageReport()).toMatchObject({ blobs: 1, blobBytes: 4096 })
    store.deleteSession(parent)
    expect(store.collectBlobs()).toEqual({ removed: 0, freedBytes: 0 })
    for (const fork of forks.slice(0, 2)) store.deleteSession(fork)
    expect(store.collectBlobs()).toEqual({ removed: 0, freedBytes: 0 })
    store.deleteSession(forks[2]!)
    expect(store.collectBlobs()).toEqual({ removed: 1, freedBytes: 4096 })
  })
})

describe("large tool output and finished deltas in a fork's transcript", () => {
  test("old physical transcript copies open unchanged and can become a shared parent", () => {
    const { store, dir } = openTemp()
    const root = newSession(store)
    const turn = runTurn(store, root, "legacy")
    const legacy = ids("session")
    const drafts = store.readAfter(root, 0, 100).filter((event) => event.type.startsWith("turn.") || event.type.startsWith("item.")).map(({ seq: _, ...event }) => ({ ...event, sessionId: legacy }))
    store.importTranscript({ id: legacy, directory: "/repo", title: "legacy fork", createdAt: 1, events: drafts, messages: HISTORY(store, root), origin: { sourceSessionId: root, truncated: false, sanitized: false } })
    const expected = texts(store, legacy)
    store.close()
    // An older database has neither the address tables nor views. Opening adds them without rewriting its rows.
    const db = new Database(path.join(dir, "mendd.db"))
    db.run("DROP VIEW events_read")
    db.run("DROP VIEW turns_read")
    db.run("DROP TABLE transcript_prefix")
    db.run("DROP TABLE turn_prefix")
    db.close()
    const reopened = openTemp(dir).store
    expect(texts(reopened, legacy)).toEqual(expected)
    const fork = forkAt(reopened, legacy, turn, 4)
    reopened.deleteSession(legacy)
    expect(texts(reopened, fork)).toEqual(expected)
  })

  test("compaction keeps a mid-turn fork's inherited deltas and registers newly shared objects", () => {
    const { store, dir } = openTemp()
    const parent = newSession(store)
    const turn = runTurn(store, parent, "original")
    const db = new Database(path.join(dir, "mendd.db"))
    // A legacy plain output is packed only by explicit compaction, after the fork already exists.
    const row = db.query<{ seq: number; payload: string }, [string, string]>("SELECT seq, payload FROM events WHERE session_id = ? AND type = 'item.completed' AND json_extract(payload, '$.itemId') = ?").get(parent, turn.toolItem)!
    const event = JSON.parse(row.payload)
    delete event.z
    delete event.zref
    event.text = turn.output
    db.run("UPDATE events SET payload = ? WHERE session_id = ? AND seq = ?", [JSON.stringify(event), parent, row.seq])
    db.close()
    const fork = forkAt(store, parent, turn, 4)
    const expected = texts(store, fork)
    store.compactStorage({})
    store.deleteSession(parent)
    store.collectBlobs()
    expect(texts(store, fork)).toEqual(expected)
  })

  test("forks store addresses only; SQL readers, projection edits and restart preserve the branch", () => {
    const { store, dir } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "authority one")
    const two = runTurn(store, parent, "authority two")
    const fork = forkAt(store, parent, two, 8)
    const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
    try {
      // Only session.created is physical. Neither inherited event nor turn rows are copied.
      expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(fork)?.n).toBe(1)
      expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(fork)?.n).toBe(0)
    } finally { db.close() }
    const expected = texts(store, fork)
    expect(store.sessionSearch.search({ text: "authority two", sessionIds: [fork] })).toHaveLength(1)
    expect(store.permissionRecords.authorityAnchors(fork).map((entry) => entry.text)).toEqual(["authority one", "authority two"])
    expect(store.turns.byItem(fork, two.itemId)?.turnId).toBe(two.turnId)
    store.rewindTurns({ sessionId: parent, turnIds: [two.turnId], cuts: { native: 4 } })
    expect(store.turns.get(fork, two.turnId)?.reverted).toBe(false)
    store.turns.setHistory(fork, one.turnId, { native: 99 })
    expect(store.turns.get(parent, one.turnId)?.history).toEqual({})
    store.rewindTurns({ sessionId: fork, turnIds: [two.turnId], cuts: { native: 4 } })
    expect(store.turns.get(parent, two.turnId)?.reverted).toBe(true)
    expect(store.recall.page(fork, 10_000, 100).every((event) => event.turnId !== two.turnId)).toBe(true)
    store.restoreTurns({ sessionId: fork })
    expect(store.turns.get(fork, two.turnId)?.reverted).toBe(false)
    store.close()
    const reopened = openTemp(dir).store
    reopened.deleteSession(parent)
    reopened.collectBlobs()
    expect(texts(reopened, fork)).toEqual(expected)
    expect(reopened.permissionRecords.authorityAnchors(fork).map((entry) => entry.text)).toEqual(["authority one", "authority two"])
  })

  test("the output is stored once, reads the same from parent and fork, and goes with the last session that holds it", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    const two = runTurn(store, parent, "two")
    const lone = store.storageReport()
    expect(lone.eventObjects).toBe(2)
    const fork = forkAt(store, parent, two, 8)
    const other = forkAt(store, parent, one, 4)
    const report = store.storageReport()
    // Two tool outputs in the first fork, one in the second: each distinct output is one object.
    expect(report.eventObjects).toBe(2)
    expect(report.eventObjectRefs).toBe(2 + 2 + 1)

    const expected = [one.output, two.output]
    const outputs = (sessionId: SessionId) => store.readAfter(sessionId, 0, 10_000).flatMap((event) => (event.type === "item.completed" && event.toolInput !== undefined ? [event.text] : []))
    expect(outputs(parent)).toEqual(expected)
    expect(outputs(fork)).toEqual(expected)
    expect(outputs(other)).toEqual([one.output])

    store.deleteSession(parent)
    expect(outputs(fork)).toEqual(expected)
    expect(store.storageReport().eventObjects).toBe(2)
    store.deleteSession(fork)
    expect(outputs(other)).toEqual([one.output])
    expect(store.storageReport().eventObjects).toBe(1)
    store.deleteSession(other)
    expect(store.storageReport()).toMatchObject({ eventObjects: 0, eventObjectRefs: 0 })
  })

  test("the transcript of the fork is complete: messages, tool items and turn rows; finished deltas are not repeated", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    runTurn(store, parent, "one")
    const two = runTurn(store, parent, "two")
    const fork = forkAt(store, parent, two, 8)
    expect(texts(store, fork).filter((text) => text.length < 100)).toEqual(texts(store, parent).filter((text) => text.length < 100))
    const forkEvents = store.readAfter(fork, 0, 10_000)
    expect(forkEvents.some((event) => event.type === "item.delta")).toBe(false)
    expect(store.readAfter(parent, 0, 10_000).filter((event) => event.type === "item.delta")).toHaveLength(4)
    expect(forkEvents.map((event) => event.seq)).toEqual(forkEvents.map((_, i) => i + 1))
    expect(store.turns.list(fork).map((turn) => turn.turnId)).toEqual(store.turns.list(parent).map((turn) => turn.turnId))
    // The tool call kept its shape for the queries that read it in SQL.
    const call = forkEvents.find((event) => event.type === "item.completed" && event.toolInput !== undefined)
    expect(call).toMatchObject({ sessionId: fork, status: "ok" })
  })

  test("recall and message reads resolve shared output in the parent and the fork", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const one = runTurn(store, parent, "one")
    const fork = forkAt(store, parent, one, 4)
    for (const sessionId of [parent, fork]) {
      const tool = store.readAfter(sessionId, 0, 100).find((event) => event.type === "item.started" && event.kind === "tool_call")
      if (tool?.type !== "item.started") throw new Error("no tool call")
      const read = store.messages.read(sessionId, tool.itemId)
      expect(read?.snapshot.text).toBe(one.output)
      expect([...store.recall.chunks(tool)].join("")).toContain(one.output.slice(0, 200))
    }
  })

  test("the open item of a mid-turn fork keeps its deltas", () => {
    const { store } = openTemp()
    const parent = newSession(store)
    const turnId = ids("turn")
    const item = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId: parent, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: parent, turnId, itemId: item, kind: "agent_message" })
    store.sessionSink.append({ type: "item.delta", sessionId: parent, itemId: item, text: "partial" })
    const cutAt = (store.lastSeq(parent) ?? 0) + 1
    store.sessionSink.append({ type: "item.completed", sessionId: parent, itemId: item, status: "ok", text: "partial and more" })
    store.sessionSink.append({ type: "turn.completed", sessionId: parent, turnId })
    const fork = newSession(store)
    store.forkConversation(parent, fork, { throughTurnId: turnId, cuts: {}, beforeSeq: cutAt })
    store.compactStorage({ deltaIdleDays: 0 })
    store.deleteSession(parent)
    const events = store.readAfter(fork, 0, 100)
    expect(events.filter((event) => event.type === "item.delta")).toHaveLength(1)
    expect(events.some((event) => event.type === "item.completed" && event.status === "interrupted")).toBe(true)
  })
})
