import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createCodec, openStore, type Store } from "../src"
import { codeText, logText, proseText } from "./synthetic-data"

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const rng = (() => {
  let state = 11
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296)
})()

function open(options: { dir?: string; compress?: boolean; pageSize?: number } = {}) {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "mend-compress-"))
  if (!options.dir) dirs.push(dir)
  const store = openStore({ dir, ...(options.compress === undefined ? {} : { compress: options.compress }), ...(options.pageSize ? { pageSize: options.pageSize } : {}) })
  stores.push(store)
  return { store, dir }
}

function rawRows<T>(dir: string, sql: string): T[] {
  const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
  try {
    return db.query<T, []>(sql).all()
  } finally {
    db.close()
  }
}

/** One tool call with `output` as its result, then the model history, the way the daemon writes them. */
function toolTurn(store: Store, sessionId: SessionId, output: string, options: { delta?: string } = {}) {
  const turnId = ids("turn")
  const item = ids("item")
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: item, kind: "tool_call", meta: { tool: "shell" } })
  if (options.delta) store.sessionSink.append({ type: "item.delta", sessionId, itemId: item, text: options.delta })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: item, status: "ok", text: output, toolInput: JSON.stringify({ command: "bun test" }) })
  store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  return { turnId, item }
}

describe("events", () => {
  test("unpaired UTF-16 surrogates remain exact JSON instead of passing through lossy UTF-8 content encoding", () => {
    const { store } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "unicode" })
    const text = "lossless text ".repeat(200) + "\ud800"
    toolTurn(store, sessionId, text)
    const history = [{ role: "tool", content: text }]
    store.engineMessages.save(sessionId, "native", history)
    expect(store.engineMessages.load(sessionId, "native")).toEqual(history)
    expect(store.readAfter(sessionId, 0).some(event => event.type === "item.completed" && event.text === text)).toBe(true)
    expect(store.storageReport().eventObjects).toBe(0)
    const codec = createCodec()
    expect(codec.unpackText(codec.packText(text))).toBe(text)
  })
  test("recall resolves shared deltas while a tool item has no completed event", () => {
    const { store } = open()
    const sessionId = ids("session")
    const turnId = ids("turn")
    const itemId = ids("item")
    store.createSession({ id: sessionId, directory: "/repo", title: "live" })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    const text = logText(rng, 8_000)
    store.sessionSink.append({ type: "item.delta", sessionId, itemId, text })
    const start = store.readAfter(sessionId, 0).find(event => event.type === "item.started")!
    if (start.type !== "item.started") throw new Error("missing start")
    expect([...store.recall.chunks(start)]).toEqual(["shell: ", text])
  })
  test("transcript and model tool content share one object, including after parent deletion and reopen", () => {
    const { store, dir } = open()
    const parent = ids("session")
    const fork = ids("session")
    store.createSession({ id: parent, directory: "/repo", title: "parent" })
    store.createSession({ id: fork, directory: "/repo", title: "fork" })
    const output = codeText(rng, 20_000) + "\n\"日本語\" 🚀"
    const { turnId } = toolTurn(store, parent, output)
    const history = [{ role: "tool", content: output, toolCallId: "exact", extra: { keep: true } }]
    store.engineMessages.save(parent, "native", history)
    expect(store.storageReport().eventObjects).toBe(1)
    expect(store.engineMessages.load(parent, "native")).toEqual(history)
    store.forkConversation(parent, fork, { throughTurnId: turnId, cuts: { native: 1 } })
    store.deleteSession(parent)
    store.collectBlobs()
    expect(store.engineMessages.load(fork, "native")).toEqual(history)
    store.close()
    const reopened = open({ dir }).store
    expect(reopened.engineMessages.first(fork, "native")).toEqual(history[0])
    expect(reopened.readAfter(fork, 0).some((event) => event.type === "item.completed" && event.text === output)).toBe(true)
    reopened.deleteSession(fork)
    expect(reopened.storageReport().eventObjects).toBe(0)
  })

  test("model-only objects survive collection and an undo stash, then are collected when unused", () => {
    const { store } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    toolTurn(store, sessionId, "short")
    const history = [{ role: "tool", content: codeText(rng, 9_000) }]
    store.engineMessages.save(sessionId, "native", history)
    const second = toolTurn(store, sessionId, "short again")
    store.engineMessages.save(sessionId, "native", [...history, { role: "tool", content: codeText(rng, 10_000) }])
    store.rewindTurns({ sessionId, turnIds: [second.turnId], cuts: { native: 1 } })
    store.collectBlobs()
    store.restoreTurns({ sessionId })
    expect(store.engineMessages.load(sessionId, "native")).toHaveLength(2)
    expect(store.engineMessages.load(sessionId, "native")[0]).toEqual(history[0])
    store.deleteSession(sessionId)
    expect(store.storageReport().eventObjects).toBe(0)
  })

  test("a large tool result is stored compressed and read back as the same event", () => {
    const { store, dir } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const output = codeText(rng, 20_000)
    const { item } = toolTurn(store, sessionId, output, { delta: logText(rng, 3_000) })
    const read = store.readAfter(sessionId, 0)
    const completed = read.find((event) => event.type === "item.completed" && event.itemId === item)
    expect(completed).toMatchObject({ text: output, toolInput: JSON.stringify({ command: "bun test" }) })
    expect(completed).not.toHaveProperty("z")
    const stored = rawRows<{ bytes: number }>(dir, "SELECT octet_length(payload) AS bytes FROM events WHERE type = 'item.completed'")[0]!.bytes
    expect(stored).toBeLessThan(output.length / 2)
    // Paging and the newest-first window decode too.
    expect(store.readBefore(sessionId, undefined, 50).some((event) => event.type === "item.completed" && event.text === output)).toBe(true)
  })

  test("what readers filter on stays plain: item id, kind and status of a compressed event", () => {
    const { store, dir } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const { item } = toolTurn(store, sessionId, codeText(rng, 10_000))
    const rows = rawRows<{ itemId: string; status: string; z: number }>(dir, "SELECT json_extract(payload, '$.itemId') AS itemId, json_extract(payload, '$.status') AS status, json_extract(payload, '$.z') AS z FROM events WHERE type = 'item.completed'")
    expect(rows).toEqual([{ itemId: item, status: "ok", z: 10_000 }])
  })

  test("recall reads a compressed tool result, and a live output delta, back as the text that was written", () => {
    const { store } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const output = logText(rng, 12_000)
    const { item } = toolTurn(store, sessionId, output)
    const start = store.recall.item(sessionId, item)!
    expect(start.kind).toBe("tool_call")
    expect([...store.recall.chunks(start)].join("")).toBe(`shell: ${output}`)

    // A tool call that never completed leaves only its deltas; they come back whole too.
    const live = ids("item")
    const turnId = ids("turn")
    const delta = codeText(rng, 4_000)
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: live, kind: "tool_call", meta: { tool: "shell" } })
    store.sessionSink.append({ type: "item.delta", sessionId, itemId: live, text: delta })
    const liveStart = store.readAfter(sessionId, 0).find((event) => event.type === "item.started" && event.itemId === live)!
    expect(liveStart.type).toBe("item.started")
    expect(store.readAfter(sessionId, 0).find((event) => event.type === "item.delta" && event.itemId === live)).toMatchObject({ text: delta })
  })

  test("user and assistant messages are never compressed (search and recall read them in SQL)", () => {
    const { store, dir } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const turnId = ids("turn")
    const item = ids("item")
    const text = proseText(rng, 6_000)
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: item, kind: "agent_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: item, status: "ok", text })
    const stored = rawRows<{ payload: string }>(dir, "SELECT payload FROM events WHERE type = 'item.completed'")[0]!.payload
    expect(JSON.parse(stored).text).toBe(text)
    expect(stored).not.toContain('"z"')
  })

  test("small values and a database written with compression off are left as they are", () => {
    const { store, dir } = open({ compress: false })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    toolTurn(store, sessionId, codeText(rng, 20_000))
    expect(rawRows<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%\"z\":%'")[0]!.n).toBe(0)
    const small = open()
    const other = ids("session")
    small.store.createSession({ id: other, directory: "/repo", title: "t" })
    toolTurn(small.store, other, "ok")
    expect(rawRows<{ n: number }>(small.dir, "SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%\"z\":%'")[0]!.n).toBe(0)
  })
})

describe("migration: data written before compression stays readable and moves on request", () => {
  function legacySession(dir: string) {
    const { store } = open({ dir, compress: false, pageSize: 4096 })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "old" })
    const output = codeText(rng, 15_000)
    const { item } = toolTurn(store, sessionId, output)
    const history = [{ role: "user", content: "go" }, { role: "tool", content: output }]
    store.engineMessages.save(sessionId, "native", history)
    const before = encoder.encode(codeText(rng, 4_000))
    const turnId = store.turns.list(sessionId)[0]!.turnId
    store.turns.files.captureBefore(sessionId, turnId, "a.ts", { state: "content", content: before })
    store.turns.files.seal(sessionId, turnId, "a.ts", { state: "content", content: before })
    store.close()
    return { sessionId, output, item, history, before, turnId }
  }

  test("round-one compressed rows and marked events migrate losslessly on explicit compact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-compress-"))
    dirs.push(dir)
    const old = legacySession(dir)
    const db = new Database(path.join(dir, "mendd.db"))
    const codec = createCodec()
    try {
      const event = db.query<{ payload: string }, []>("SELECT payload FROM events WHERE type = 'item.completed'").all()[0]!
      const parsed = JSON.parse(event.payload)
      db.query("UPDATE events SET payload = ? WHERE type = 'item.completed'").run(codec.packEvent(parsed, event.payload, true))
      db.query("UPDATE engine_messages SET payload = ? WHERE idx = 1").run(codec.packText(JSON.stringify(old.history[1])))
      db.run("INSERT INTO storage_marks(session_id, events_seq) SELECT id, last_seq FROM sessions")
    } finally { db.close() }
    const store = open({ dir }).store
    expect(store.storageReport().eventObjects).toBe(0)
    expect(store.engineMessages.load(old.sessionId, "native")).toEqual(old.history)
    store.compactStorage({ dryRun: true })
    expect(store.storageReport().eventObjects).toBe(0)
    expect(store.compactStorage({})).toMatchObject({ engineRows: 1, eventRows: 1 })
    expect(store.storageReport().eventObjects).toBe(1)
    expect(store.engineMessages.load(old.sessionId, "native")).toEqual(old.history)
    expect(store.readAfter(old.sessionId, 0).some(event => event.type === "item.completed" && event.text === old.output)).toBe(true)
    expect(store.compactStorage({})).toMatchObject({ engineRows: 0, eventRows: 0 })
  })

  test("a new build opens an old data dir, reads every value, then compact rewrites them once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-compress-"))
    dirs.push(dir)
    const old = legacySession(dir)
    const { store } = open({ dir })
    expect(rawRows<{ page_size: number }>(dir, "PRAGMA page_size")[0]!.page_size).toBe(4096)
    // Reads work before anything is rewritten, and the old file keeps its page size.
    expect(store.readAfter(old.sessionId, 0).find((event) => event.type === "item.completed" && event.itemId === old.item)).toMatchObject({ text: old.output })
    expect(store.engineMessages.load(old.sessionId, "native")).toEqual(old.history)
    expect(store.engineMessages.first(old.sessionId, "native")).toEqual(old.history[0])
    expect(store.engineMessages.first(old.sessionId, "other")).toBeUndefined()
    expect(store.turns.files.list(old.sessionId, old.turnId)[0]).toMatchObject({ path: "a.ts", before: { state: "content" } })
    const sizeBefore = store.storageReport()

    const dry = store.compactStorage({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.engineRows + dry.eventRows + dry.snapshotRows).toBeGreaterThan(0)
    expect(store.storageReport().compressedRows).toBe(sizeBefore.compressedRows)

    const first = store.compactStorage({})
    expect(first).toMatchObject({ engineRows: 1, eventRows: 1, complete: true })
    expect(first.snapshotRows).toBeGreaterThanOrEqual(1)
    const after = store.storageReport()
    expect(after.engineBytes).toBeLessThan(sizeBefore.engineBytes)
    expect(after.eventBytes).toBeLessThan(sizeBefore.eventBytes)
    expect(after.compressedRows).toBeGreaterThanOrEqual(3)

    // Same values after the rewrite, and a second pass has nothing left to do.
    expect(store.readAfter(old.sessionId, 0).find((event) => event.type === "item.completed" && event.itemId === old.item)).toMatchObject({ text: old.output })
    expect(store.engineMessages.load(old.sessionId, "native")).toEqual(old.history)
    expect(store.engineMessages.first(old.sessionId, "native")).toEqual(old.history[0])
    expect(store.engineMessages.first(old.sessionId, "other")).toBeUndefined()
    const list = store.turns.files.list(old.sessionId, old.turnId)[0]!
    expect(list.before.state === "content" && decoder.decode(list.before.content)).toBe(decoder.decode(old.before))
    const second = store.compactStorage({})
    expect(second).toMatchObject({ engineRows: 0, eventRows: 0, snapshotRows: 0, complete: true })
  })

  test("a later pass visits only what a session gained since the last one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-compress-"))
    dirs.push(dir)
    const old = legacySession(dir)
    const { store } = open({ dir })
    expect(store.compactStorage({ deltaIdleDays: 0 })).toMatchObject({ eventRows: 1 })
    expect(rawRows<{ events_seq: number; deltas_seq: number }>(dir, "SELECT events_seq, deltas_seq FROM storage_marks")).toEqual([{ events_seq: store.lastSeq(old.sessionId)!, deltas_seq: store.lastSeq(old.sessionId)! }])
    expect(store.compactStorage({ deltaIdleDays: 0 })).toMatchObject({ eventRows: 0, deltaEvents: 0 })
    // New work in the session moves its mark past the old one and is picked up on the next pass.
    toolTurn(store, old.sessionId, codeText(rng, 9_000), { delta: "partial" })
    const next = store.compactStorage({ deltaIdleDays: 0 })
    expect(next).toMatchObject({ eventRows: 0, deltaEvents: 1 })
    expect(rawRows<{ deltas_seq: number }>(dir, "SELECT deltas_seq FROM storage_marks")[0]!.deltas_seq).toBe(store.lastSeq(old.sessionId)!)
    expect(store.readAfter(old.sessionId, 0).filter((event) => event.type === "item.completed" && event.text?.length === 9_000)).toHaveLength(1)
  })

  test("bounded shared-content migration resumes past unchanged compressed model rows, including after reopen", () => {
    const { store, dir } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "bounded" })
    const history = Array.from({ length: 5 }, (_, i) => ({ role: "assistant", content: `unchanged ${i} `.repeat(1000) }))
    store.engineMessages.save(sessionId, "native", history)
    expect(store.compactStorage({ rowLimit: 2 })).toMatchObject({ engineRows: 0, complete: false })
    store.close()
    const reopened = open({ dir }).store
    expect(reopened.compactStorage({ rowLimit: 2 })).toMatchObject({ engineRows: 0, complete: false })
    expect(reopened.compactStorage({ rowLimit: 2 })).toMatchObject({ engineRows: 0, complete: true })
    expect(reopened.compactStorage({ rowLimit: 2 })).toMatchObject({ engineRows: 0, complete: true })
    expect(reopened.engineMessages.load(sessionId, "native")).toEqual(history)
  })

  test("a row limit makes compact resumable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-compress-"))
    dirs.push(dir)
    const legacy = open({ dir, compress: false })
    for (let i = 0; i < 5; i++) {
      const sessionId = ids("session")
      legacy.store.createSession({ id: sessionId, directory: "/repo", title: `s${i}` })
      legacy.store.engineMessages.save(sessionId, "native", [{ role: "tool", content: codeText(rng, 5_000) }])
    }
    legacy.store.close()
    const { store } = open({ dir })
    const first = store.compactStorage({ rowLimit: 2 })
    expect(first.complete).toBe(false)
    let passes = 0
    while (!store.compactStorage({ rowLimit: 2 }).complete && passes++ < 10) continue
    expect(rawRows<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM engine_messages WHERE typeof(payload) = 'text'")[0]!.n).toBe(0)
  })

  test("dropping deltas keeps the final text, only for idle sessions, and never a session that is protected", () => {
    const { store } = open()
    const idle = ids("session")
    const kept = ids("session")
    for (const sessionId of [idle, kept]) {
      store.createSession({ id: sessionId, directory: "/repo", title: "t" })
      const turnId = ids("turn")
      const item = ids("item")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: item, kind: "agent_message" })
      for (const piece of ["a", "b", "c"]) store.sessionSink.append({ type: "item.delta", sessionId, itemId: item, text: piece })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: item, status: "ok", text: "abc" })
      store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    }
    const result = store.compactStorage({ deltaIdleDays: 0, protect: new Set([kept]) })
    expect(result.deltaEvents).toBe(3)
    expect(store.readAfter(idle, 0).filter((event) => event.type === "item.delta")).toHaveLength(0)
    expect(store.readAfter(idle, 0).find((event) => event.type === "item.completed")).toMatchObject({ text: "abc" })
    expect(store.readAfter(kept, 0).filter((event) => event.type === "item.delta")).toHaveLength(3)
  })
})

describe("snapshots: content is stored once", () => {
  test("two sessions that snapshot the same file share one object, and it goes with the last reference", () => {
    const { store } = open()
    const content = encoder.encode(codeText(rng, 6_000))
    const touched: Array<{ sessionId: SessionId; turnId: string }> = []
    for (let i = 0; i < 2; i++) {
      const sessionId = ids("session")
      store.createSession({ id: sessionId, directory: "/repo", title: "t" })
      const { turnId } = toolTurn(store, sessionId, "ok")
      store.turns.files.captureBefore(sessionId, turnId, "src/a.ts", { state: "content", content })
      store.turns.files.seal(sessionId, turnId, "src/a.ts", { state: "content", content })
      touched.push({ sessionId, turnId })
    }
    const report = store.storageReport()
    expect(report.snapshotObjects).toBe(1)
    expect(report.snapshotRefs).toBe(4)
    for (const { sessionId, turnId } of touched) {
      const file = store.turns.files.list(sessionId, turnId)[0]!
      expect(file.before.state === "content" && file.before.content).toEqual(content)
      expect(file.after?.state === "content" && file.after.content).toEqual(content)
    }
    store.deleteSession(touched[0]!.sessionId)
    store.collectBlobs()
    expect(store.storageReport().snapshotObjects).toBe(1)
    store.deleteSession(touched[1]!.sessionId)
    store.collectBlobs()
    expect(store.storageReport().snapshotObjects).toBe(0)
  })

  test("small and binary-looking content, modes and absent files round-trip exactly", () => {
    const { store } = open()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const { turnId } = toolTurn(store, sessionId, "ok")
    const magicLike = Uint8Array.from([0x00, 0x4d, 0x5a, 0x31, 0x5a, 1, 2, 3, 4, 5, 6])
    store.turns.files.captureBefore(sessionId, turnId, "tiny", { state: "content", content: encoder.encode("x"), mode: 0o755 })
    store.turns.files.captureBefore(sessionId, turnId, "magic", { state: "content", content: magicLike })
    store.turns.files.captureBefore(sessionId, turnId, "new", { state: "absent" })
    store.turns.files.captureBefore(sessionId, turnId, "empty", { state: "content", content: new Uint8Array() })
    const byPath = new Map(store.turns.files.list(sessionId, turnId).map((file) => [file.path, file.before]))
    expect(byPath.get("tiny")).toEqual({ state: "content", content: encoder.encode("x"), mode: 0o755 })
    expect(byPath.get("magic")).toEqual({ state: "content", content: magicLike })
    expect(byPath.get("new")).toEqual({ state: "absent" })
    expect(byPath.get("empty")).toEqual({ state: "content", content: new Uint8Array() })
    // The budget of a turn counts what the files weigh, not what they take on disk.
    expect(store.turns.files.usedBytes(sessionId, turnId)).toBe(1 + magicLike.byteLength)
  })
})

describe("codec", () => {
  test("text shorter than the threshold stays plain; compressible text comes back identical", () => {
    const codec = createCodec()
    expect(codec.packText("short")).toBe("short")
    const big = codeText(rng, 5_000)
    const packed = codec.packText(big)
    expect(packed).toBeInstanceOf(Uint8Array)
    expect((packed as Uint8Array).byteLength).toBeLessThan(big.length)
    expect(codec.unpackText(packed)).toBe(big)
    expect(codec.textBytes(packed as Uint8Array)).toBe(big.length)
    expect(createCodec({ enabled: false }).packText(big)).toBe(big)
  })

  test("text that does not compress is kept as it is", () => {
    const codec = createCodec()
    const noise = Array.from({ length: 3_000 }, () => String.fromCharCode(33 + Math.floor(rng() * 90))).join("")
    const packed = codec.packText(noise)
    expect(codec.unpackText(packed)).toBe(noise)
  })
})
