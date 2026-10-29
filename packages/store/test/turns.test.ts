import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { historyMark, openStore, SNAPSHOT_TURNS_KEPT, type Store } from "../src"

const dirs: string[] = []
const stores: Store[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-turns-"))
  dirs.push(dir)
  return dir
}
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

function openTemp(dir = tempDir()) {
  const store = openStore({ dir })
  stores.push(store)
  return { store, dir }
}

function newSession(store: Store) {
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/repo", title: "t" })
  return sessionId
}

/** One finished turn the way the actor writes it, with the model messages the engine would have saved. */
function runTurn(store: Store, sessionId: SessionId, text: string, options: { messages?: unknown[]; meta?: Record<string, boolean>; tool?: string; compaction?: boolean; end?: "completed" | "failed" } = {}) {
  const turnId = ids("turn")
  const itemId = ids("item")
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  if (!options.compaction) {
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message", ...(options.meta ? { meta: options.meta } : {}) })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
  }
  if (options.tool) {
    const toolItem = ids("item")
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: toolItem, kind: "tool_call", meta: { tool: options.tool } })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: toolItem, status: "ok", text: "out" })
  }
  if (options.compaction) store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: ids("item"), kind: "compaction" })
  const messages = options.messages ?? [{ role: "user", content: text }, { role: "assistant", content: `re: ${text}`, toolCalls: [] }]
  store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), ...messages])
  if (options.end === "failed") store.sessionSink.append({ type: "turn.failed", sessionId, turnId, error: { code: "x", message: "boom" } })
  else store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  return { turnId, itemId }
}

describe("turn projection", () => {
  test("a notice read inside a user's turn leaves the turn the user's; a message steered into it still becomes its item", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const [turnId, asked, notice, steered] = [ids("turn"), ids("item"), ids("item"), ids("item")]
    const item = (itemId: typeof asked, text: string, meta?: Record<string, boolean>) => {
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message", ...(meta ? { meta } : {}) })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    }
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    item(asked, "run the build")
    item(notice, "[background task bg_1 exited 0]", { notice: true })
    expect(store.turns.list(sessionId)).toMatchObject([{ turnId, itemId: asked, notice: false, preview: "run the build" }])
    item(steered, "also run the tests")
    expect(store.turns.list(sessionId)).toMatchObject([{ turnId, itemId: steered, notice: false, preview: "run the build" }])
  })

  test("every event keeps one row per turn current: preview, outcome, flags and history marks", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const a = runTurn(store, sessionId, "  first\n\n   question   here  ")
    const long = "x".repeat(300)
    const b = runTurn(store, sessionId, long, { tool: "shell: ls", end: "failed" })
    const c = runTurn(store, sessionId, "git status", { meta: { shell: true } })
    const d = runTurn(store, sessionId, "a background task ended", { meta: { notice: true } })
    const e = runTurn(store, sessionId, "", { compaction: true, messages: [] })
    const turns = store.turns.list(sessionId)
    expect(turns.map((turn) => turn.turnId)).toEqual([a, b, c, d, e].map((turn) => turn.turnId))
    expect(turns.map((turn) => turn.preview)).toEqual(["first question here", "x".repeat(120), "git status", "a background task ended", ""])
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "failed", "completed", "completed", "completed"])
    expect(turns.map((turn) => [turn.shell, turn.notice, turn.compacted, turn.shellTool])).toEqual([
      [false, false, false, false],
      [false, false, false, true],
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
    ])
    expect(turns[4]!.itemId).toBeUndefined()
    // Marks: the messages each engine held when the turn began.
    expect(turns.map((turn) => historyMark(turn, "native"))).toEqual([0, 2, 4, 6, 8])
    expect(historyMark(turns[0]!, "claude")).toBe(0)
    expect(store.turns.byItem(sessionId, b.itemId)?.turnId).toBe(b.turnId)
    expect(store.turns.get(sessionId, "trn_missing")).toBeUndefined()
  })

  test("a rewritten history (compaction) drops the marks of every older turn but not of later ones", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    runTurn(store, sessionId, "one")
    runTurn(store, sessionId, "two")
    store.engineMessages.replace(sessionId, "native", [{ role: "user", content: "summary" }])
    const later = runTurn(store, sessionId, "three")
    const turns = store.turns.list(sessionId)
    expect(turns.map((turn) => historyMark(turn, "native"))).toEqual([undefined, undefined, 1])
    expect(turns[2]!.turnId).toBe(later.turnId)
    expect(turns[0]!.history).toEqual({ native: null })
  })

  test("the projection of a log written before it existed is built once when the store opens", () => {
    const { store, dir } = openTemp()
    const sessionId = newSession(store)
    const a = runTurn(store, sessionId, "before the projection")
    runTurn(store, sessionId, "second", { tool: "shell: make", end: "failed" })
    store.close()
    const raw = new Database(path.join(dir, "mendd.db"))
    raw.run("DELETE FROM turns")
    raw.run("DELETE FROM meta WHERE key = 'turns_backfill'")
    raw.close()
    const { store: reopened } = openTemp(dir)
    const turns = reopened.turns.list(sessionId)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ turnId: a.turnId, itemId: a.itemId, preview: "before the projection", status: "completed", reverted: false })
    expect(turns[1]).toMatchObject({ preview: "second", status: "failed", shellTool: true })
    // Marks never existed for that log: unknown, not zero.
    expect(turns[0]!.history).toBeUndefined()
    expect(historyMark(turns[0]!, "native")).toBeUndefined()
  })

  test("the turns covering a span of events are the one started last at or before it and every later one up to its end", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const runs = [runTurn(store, sessionId, "one"), runTurn(store, sessionId, "two"), runTurn(store, sessionId, "three")]
    const started = runs.map((turn) => store.turns.get(sessionId, turn.turnId)!)
    store.sessionSink.append({ type: "turn.reverted", sessionId, turnId: runs[1]!.turnId })
    const turns = store.turns.list(sessionId)
    const covering = (from: number, to: number) => store.turns.covering(sessionId, from, to)
    expect(covering(started[0]!.seq + 1, started[1]!.seq + 1)).toEqual([{ seq: started[0]!.seq, reverted: false }, { seq: started[1]!.seq, reverted: true }])
    expect(covering(started[2]!.seq, started[2]!.seq + 2)).toEqual([{ seq: started[2]!.seq, reverted: false }])
    // A span that starts before the first turn reads every turn up to its end; the whole log matches the full list.
    expect(covering(1, started[0]!.seq)).toEqual([{ seq: started[0]!.seq, reverted: false }])
    expect(covering(1, store.lastSeq(sessionId)!)).toEqual(turns.map((turn) => ({ seq: turn.seq, reverted: turn.reverted })))
  })
})

describe("undo stack", () => {
  test("rewind takes the messages out, hides the turns and keeps everything for redo; restore puts them back", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    runTurn(store, sessionId, "keep")
    const gone = runTurn(store, sessionId, "drop")
    const before = store.engineMessages.load(sessionId, "native")
    const client = ids("client")
    const rewound = store.rewindTurns({ sessionId, turnIds: [gone.turnId], cuts: { native: 2 }, byClientId: client })
    expect(rewound.messages).toBe(2)
    expect(rewound.events).toMatchObject([{ type: "turn.reverted", turnId: gone.turnId, byClientId: client }])
    expect(store.engineMessages.load(sessionId, "native")).toEqual(before.slice(0, 2))
    expect(store.turns.get(sessionId, gone.turnId)?.reverted).toBe(true)
    expect(store.turns.undoTop(sessionId)?.turnIds).toEqual([gone.turnId])
    // Append-only: the events are still in the log.
    expect(store.readAfter(sessionId, 0, 100).some((event) => event.type === "item.completed" && event.text === "drop")).toBe(true)

    const restored = store.restoreTurns({ sessionId })
    expect(restored).toMatchObject({ messages: 2, turnIds: [gone.turnId], events: [{ type: "turn.restored", turnId: gone.turnId }] })
    expect(store.engineMessages.load(sessionId, "native")).toEqual(before)
    expect(store.turns.get(sessionId, gone.turnId)?.reverted).toBe(false)
    expect(store.turns.undoTop(sessionId)).toBeUndefined()
    expect(store.restoreTurns({ sessionId })).toBeUndefined()
  })

  test("a new turn ends redo: the stack and the stashed messages are gone", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const first = runTurn(store, sessionId, "one")
    store.rewindTurns({ sessionId, turnIds: [first.turnId], cuts: { native: 0 } })
    expect(store.turns.undoTop(sessionId)).toBeDefined()
    runTurn(store, sessionId, "two")
    expect(store.turns.undoTop(sessionId)).toBeUndefined()
    expect(store.restoreTurns({ sessionId })).toBeUndefined()
    expect(store.engineMessages.load(sessionId, "native")).toHaveLength(2)
  })

  test("redo refuses to put messages back onto a history that changed", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const first = runTurn(store, sessionId, "one")
    store.rewindTurns({ sessionId, turnIds: [first.turnId], cuts: { native: 0 } })
    store.engineMessages.save(sessionId, "native", [{ role: "user", content: "stray" }])
    expect(() => store.restoreTurns({ sessionId })).toThrow(RangeError)
    // The failed redo changed nothing: the turn is still undone and still redoable once the history is as it was.
    expect(store.turns.get(sessionId, first.turnId)?.reverted).toBe(true)
    expect(store.turns.undoTop(sessionId)).toBeDefined()
  })

  test("the stack survives a restart", () => {
    const { store, dir } = openTemp()
    const sessionId = newSession(store)
    const first = runTurn(store, sessionId, "one")
    store.rewindTurns({ sessionId, turnIds: [first.turnId], cuts: { native: 0 } })
    store.close()
    const { store: reopened } = openTemp(dir)
    expect(reopened.restoreTurns({ sessionId })).toMatchObject({ messages: 2 })
    expect(reopened.engineMessages.load(sessionId, "native")).toHaveLength(2)
  })
})

describe("fork at a turn", () => {
  test("copies the transcript events of the turns up to it, renumbered, without undone turns, and the history cut", () => {
    const { store } = openTemp()
    const source = newSession(store)
    const one = runTurn(store, source, "one")
    const two = runTurn(store, source, "two")
    store.rewindTurns({ sessionId: source, turnIds: [two.turnId], cuts: { native: 2 } })
    const three = runTurn(store, source, "three")
    runTurn(store, source, "four")
    const fork = newSession(store)
    const copied = store.forkConversation(source, fork, { throughTurnId: three.turnId, cuts: { native: 4 } })
    expect(copied.messages).toBe(4)
    const events = store.readAfter(fork, 0, 1000)
    expect(events[0]).toMatchObject({ type: "session.created" })
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    expect(events.every((event) => event.sessionId === fork)).toBe(true)
    expect(copied.events).toBe(events.length - 1)
    const texts = events.flatMap((event) => (event.type === "item.completed" && event.text ? [event.text] : []))
    expect(texts).toEqual(["one", "three"])
    expect(events.map((event) => event.type).filter((type) => type.startsWith("queue") || type === "usage.recorded" || type === "foreground.state")).toEqual([])
    const turns = store.turns.list(fork)
    expect(turns.map((turn) => turn.turnId)).toEqual([one.turnId, three.turnId])
    // The copied rows point at the fork's own events.
    for (const turn of turns) expect(events.find((event) => event.seq === turn.seq)).toMatchObject({ type: "turn.started", turnId: turn.turnId })
    expect(store.lastSeq(fork)).toBe(events.length)
    // Appending continues from there.
    store.sessionSink.append({ type: "turn.completed", sessionId: fork, turnId: ids("turn") })
    expect(store.lastSeq(fork)).toBe(events.length + 1)
  })

  test("refuses an engine it has no cut for, and an unknown turn, leaving no partial copy", () => {
    const { store } = openTemp()
    const source = newSession(store)
    const one = runTurn(store, source, "one")
    const fork = newSession(store)
    expect(() => store.forkConversation(source, fork, { throughTurnId: one.turnId, cuts: {} })).toThrow(RangeError)
    expect(() => store.forkConversation(source, fork, { throughTurnId: "trn_missing", cuts: { native: 2 } })).toThrow(RangeError)
    expect(store.engineMessages.load(fork, "native")).toEqual([])
    expect(store.readAfter(fork, 0, 10)).toHaveLength(1)
  })
})

describe("file snapshots", () => {
  test("the first state of a path in a turn is kept, the budget counts content, and the end state is sealed once", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const turn = runTurn(store, sessionId, "edit")
    const files = store.turns.files
    expect(files.captureBefore(sessionId, turn.turnId, "/repo/a.txt", { state: "content", content: new TextEncoder().encode("original"), mode: 0o644 })).toBe(true)
    expect(files.captureBefore(sessionId, turn.turnId, "/repo/a.txt", { state: "content", content: new TextEncoder().encode("second"), mode: 0o644 })).toBe(false)
    files.captureBefore(sessionId, turn.turnId, "/repo/new.txt", { state: "absent" })
    files.captureBefore(sessionId, turn.turnId, "/repo/img.png", { state: "skipped", reason: "binary" })
    expect(files.has(sessionId, turn.turnId, "/repo/new.txt")).toBe(true)
    expect(files.has(sessionId, turn.turnId, "/repo/other.txt")).toBe(false)
    expect(files.usedBytes(sessionId, turn.turnId)).toBe("original".length)
    files.seal(sessionId, turn.turnId, "/repo/a.txt", { state: "content", content: new TextEncoder().encode("after") })
    files.seal(sessionId, turn.turnId, "/repo/a.txt", { state: "content", content: new TextEncoder().encode("again") })
    const list = files.list(sessionId, turn.turnId)
    expect(list.map((entry) => entry.path)).toEqual(["/repo/a.txt", "/repo/img.png", "/repo/new.txt"])
    expect(list[0]).toMatchObject({ before: { state: "content", mode: 0o644 }, after: { state: "content" } })
    expect(Buffer.from((list[0]!.after as { content: Uint8Array }).content).toString()).toBe("after")
    expect(list[1]).toMatchObject({ before: { state: "skipped", reason: "binary" } })
    expect(list[1]!.after).toBeUndefined()
    expect(list[2]).toMatchObject({ before: { state: "absent" } })
  })

  test("only the newest turns keep snapshots, and the snapshots of undone turns go when something new happens", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const turns = Array.from({ length: SNAPSHOT_TURNS_KEPT + 3 }, (_, i) => runTurn(store, sessionId, `turn ${i}`))
    for (const turn of turns) store.turns.files.captureBefore(sessionId, turn.turnId, "/repo/f.txt", { state: "absent" })
    const undone = turns.at(-1)!
    store.rewindTurns({ sessionId, turnIds: [undone.turnId], cuts: { native: SNAPSHOT_TURNS_KEPT * 2 + 4 } })
    runTurn(store, sessionId, "next")
    const held = turns.filter((turn) => store.turns.files.list(sessionId, turn.turnId).length > 0).map((turn) => turn.turnId)
    // The 20 newest turns once `next` started (itself included), minus the undone one; older ones and the undone one were dropped.
    expect(held).toEqual(turns.slice(4, -1).map((turn) => turn.turnId))
    expect(held.length).toBe(SNAPSHOT_TURNS_KEPT - 2)
  })

  test("per-call snapshots keep each call's before state, count their own bytes, and follow the turn's retention", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const turns = Array.from({ length: SNAPSHOT_TURNS_KEPT + 2 }, (_, i) => runTurn(store, sessionId, `turn ${i}`))
    const first = ids("item"), second = ids("item")
    const content = (text: string) => ({ state: "content" as const, content: new TextEncoder().encode(text) })
    for (const turn of turns) {
      store.turns.calls.capture(sessionId, turn.turnId, first, "/repo/f.txt", content("one"))
      store.turns.calls.capture(sessionId, turn.turnId, first, "/repo/f.txt", content("ignored"))
      store.turns.calls.capture(sessionId, turn.turnId, second, "/repo/f.txt", { state: "absent" })
    }
    const last = turns.at(-1)!
    expect(store.turns.calls.usedBytes(sessionId, last.turnId)).toBe(3)
    expect(store.turns.calls.list(sessionId, last.turnId).map((call) => call.before.state).sort()).toEqual(["absent", "content"])
    runTurn(store, sessionId, "next")
    expect(store.turns.calls.list(sessionId, turns[0]!.turnId)).toEqual([])
    expect(store.turns.calls.list(sessionId, last.turnId)).toHaveLength(2)
  })

  test("an undo entry can hold a part-level revert; a new turn clears it", () => {
    const { store } = openTemp()
    const sessionId = newSession(store)
    const turn = runTurn(store, sessionId, "one")
    const itemId = ids("item")
    store.rewindPartial({ sessionId, partial: { turnId: turn.turnId, itemId, paths: ["/repo/a"] } })
    store.rewindTurns({ sessionId, turnIds: [turn.turnId], cuts: { native: 0 } })
    expect(store.turns.undoDepth(sessionId)).toBe(2)
    expect(store.turns.undoTop(sessionId)?.partial).toBeUndefined()
    expect(store.restoreTurns({ sessionId })?.turnIds).toEqual([turn.turnId])
    expect(store.turns.undoTop(sessionId)).toMatchObject({ turnIds: [], partial: { turnId: turn.turnId, itemId, paths: ["/repo/a"] } })
    runTurn(store, sessionId, "next")
    expect(store.turns.undoDepth(sessionId)).toBe(0)
  })

  test("deleting the session deletes its turns, snapshots and undo stack", () => {
    const { store, dir } = openTemp()
    const sessionId = newSession(store)
    const turn = runTurn(store, sessionId, "one")
    store.turns.files.captureBefore(sessionId, turn.turnId, "/repo/a", { state: "absent" })
    store.turns.calls.capture(sessionId, turn.turnId, ids("item"), "/repo/a", { state: "absent" })
    store.rewindTurns({ sessionId, turnIds: [turn.turnId], cuts: { native: 0 } })
    expect(store.deleteSession(sessionId)).toBe(true)
    store.close()
    const raw = new Database(path.join(dir, "mendd.db"))
    for (const table of ["turns", "turn_files", "turn_call_files", "undo_stack", "undone_messages"]) expect(raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    raw.close()
  })
})
