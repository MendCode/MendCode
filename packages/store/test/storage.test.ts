import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type Loop, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"
import { budgetMs } from "../../../scripts/test-budget"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-storage-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 26, 12)

function open() {
  const dir = tempDir()
  let clock = NOW
  const store = openStore({ dir, now: () => clock })
  const at = (value: number) => void (clock = value)
  /** A session last touched `daysAgo` days ago with `messages` user messages and an optional attached blob. */
  function session(daysAgo: number, options: { messages?: number; blob?: Uint8Array; title?: string; directory?: string } = {}) {
    const id = ids("session")
    at(NOW - daysAgo * DAY)
    store.createSession({ id, directory: options.directory ?? "/repo", title: options.title ?? `s${daysAgo}` })
    for (let i = 0; i < (options.messages ?? 3); i++) {
      const itemId = ids("item")
      store.sessionSink.append({ type: "item.started", sessionId: id, turnId: ids("turn"), itemId, kind: "agent_message" })
      store.sessionSink.append({ type: "item.completed", sessionId: id, itemId, status: "ok", text: "x".repeat(200) })
    }
    if (options.blob) {
      const ref = store.putBlob(options.blob, "image/png")
      store.sessionSink.append({ type: "item.completed", sessionId: id, itemId: ids("item"), status: "ok", attachments: [ref] })
      return { id, ref }
    }
    at(NOW)
    return { id, ref: undefined }
  }
  /** A blob file no session ever referenced (an abandoned upload), backdated past the safety window. */
  function stray(bytes: Uint8Array) {
    const ref = store.putBlob(bytes, "image/png")
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(store.blobPath(ref.sha256), old, old)
    return ref
  }
  return { store, dir, at, session, stray }
}

const exists = (store: ReturnType<typeof open>["store"], id: SessionId) => store.hasSession(id)

describe("storage report", () => {
  test("counts files, blobs, orphans, sessions, events and ranks sessions by stored bytes", () => {
    const { store, session, stray } = open()
    const big = session(1, { messages: 40, blob: new Uint8Array(5_000).fill(1), title: "big" })
    const small = session(2, { messages: 2, title: "small" })
    const medium = session(3, { messages: 10, title: "medium" })
    const empty = session(4, { messages: 0 })
    stray(new Uint8Array(700).fill(9)) // never referenced: an orphan
    const report = store.storageReport()
    expect(report.sessions).toBe(4)
    expect(report.events).toBe([big, small, medium, empty].reduce((sum, s) => sum + store.lastSeq(s.id)!, 0))
    expect(report.blobs).toBe(1)
    expect(report.blobBytes).toBe(5_700)
    expect(report.orphanBlobs).toBe(1)
    expect(report.orphanBytes).toBe(700)
    expect(report.dbBytes).toBeGreaterThan(0)
    expect(report.eventBytes).toBeGreaterThan(40 * 200)
    expect(report.otherBytes).toBeGreaterThanOrEqual(0)
    expect(report.autoVacuum).toBe("incremental")
    expect(report.topSessions.map((s) => s.title)).toEqual(["big", "medium", "small", "s4"])
    expect(report.topSessions[0]).toMatchObject({ sessionId: big.id, directory: "/repo" })
    expect(report.topSessions[0]!.bytes).toBeGreaterThan(5_000 + 40 * 200)
    expect(report.topSessions.length).toBeLessThanOrEqual(10)
    store.close()
  })

  test("only the ten largest sessions are listed", () => {
    const { store, session } = open()
    for (let i = 0; i < 14; i++) session(1, { messages: i + 1 })
    const report = store.storageReport()
    expect(report.topSessions.length).toBe(10)
    const sizes = report.topSessions.map((s) => s.bytes)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    store.close()
  })

  test("engine history is reported separately from events", () => {
    const { store, session } = open()
    const { id } = session(1)
    const before = store.storageReport()
    store.engineMessages.save(id, "native", [{ role: "user", content: "y".repeat(3_000) }])
    const after = store.storageReport()
    // Repetitive text is stored compressed (see compression.test.ts); it still counts under engine history.
    expect(after.engineBytes).toBeGreaterThan(before.engineBytes)
    expect(after.eventBytes).toBe(before.eventBytes)
    store.close()
  })

  test("an empty store reports zeros", () => {
    const { store } = open()
    expect(store.storageReport()).toMatchObject({ sessions: 0, events: 0, eventBytes: 0, engineBytes: 0, blobs: 0, orphanBlobs: 0, topSessions: [] })
    store.close()
  })

  test("the report stays under 200 ms with 50k events", () => {
    const { store, session } = open()
    const many = Array.from({ length: 25 }, () => session(1, { messages: 0 }).id)
    for (let i = 0; i < 50_000; i++) {
      const sessionId = many[i % many.length]!
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: ids("item"), status: "ok", text: "payload ".repeat(20) })
    }
    store.storageReport()
    const started = performance.now()
    const report = store.storageReport()
    expect(performance.now() - started).toBeLessThan(budgetMs(200))
    expect(report.events).toBeGreaterThan(50_000)
    expect(report.topSessions.length).toBe(10)
    store.close()
  }, 60_000)
})

describe("storage clean", () => {
  test("removes only sessions older than the cutoff, with their events, and reports the counts", () => {
    const { store, session } = open()
    const old = session(120, { messages: 5 })
    const recent = session(10, { messages: 5 })
    const events = store.lastSeq(old.id)!
    const result = store.cleanStorage({ olderThanDays: 90 })
    expect(result).toMatchObject({ dryRun: false, olderThanDays: 90, sessionsRemoved: 1, eventsRemoved: events, protectedSessions: 0 })
    expect(result.sessionIds).toEqual([old.id])
    expect(exists(store, old.id)).toBe(false)
    expect(exists(store, recent.id)).toBe(true)
    expect(store.readAfter(old.id, 0)).toEqual([])
    expect(store.storageReport().sessions).toBe(1)
    store.close()
  })

  test("a dry run reports the same counts and an estimate but changes nothing", () => {
    const { store, session } = open()
    const old = session(200, { messages: 20, blob: new Uint8Array(4_000).fill(3) })
    session(5)
    const before = store.storageReport()
    const dry = store.cleanStorage({ olderThanDays: 90, dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, sessionsRemoved: 1, blobsRemoved: 1, vacuumed: false })
    expect(dry.bytesReclaimed).toBeGreaterThan(4_000)
    expect(exists(store, old.id)).toBe(true)
    expect(existsSync(store.blobPath(old.ref!.sha256))).toBe(true)
    const after = store.storageReport()
    expect({ ...after, walBytes: 0, dbBytes: 0 }).toEqual({ ...before, walBytes: 0, dbBytes: 0 })
    const real = store.cleanStorage({ olderThanDays: 90 })
    expect(real).toMatchObject({ sessionsRemoved: dry.sessionsRemoved, eventsRemoved: dry.eventsRemoved, blobsRemoved: dry.blobsRemoved })
    store.close()
  })

  test("never removes a session with an active turn", () => {
    const { store, session, at } = open()
    const { id } = session(300)
    at(NOW - 300 * DAY)
    store.sessionSink.append({ type: "turn.started", sessionId: id, turnId: ids("turn"), queueId: ids("queue") })
    at(NOW)
    const result = store.cleanStorage({ olderThanDays: 90 })
    expect(result).toMatchObject({ sessionsRemoved: 0, protectedSessions: 1 })
    expect(exists(store, id)).toBe(true)
    store.close()
  })

  test("never removes an old session whose draft was saved since the cutoff; an old draft does not keep it", () => {
    const { store, session, at } = open()
    const kept = session(300).id
    const gone = session(300).id
    at(NOW - 200 * DAY)
    store.drafts.set(gone, "an old thought")
    at(NOW)
    store.drafts.set(kept, "what I was about to send")
    expect(store.cleanStorage({ olderThanDays: 90 })).toMatchObject({ sessionsRemoved: 1, protectedSessions: 1 })
    expect(exists(store, kept)).toBe(true)
    expect(exists(store, gone)).toBe(false)
    store.close()
  })

  test("global events older than the cutoff go, except the settings history and the newest one", () => {
    const { store, dir, at } = open()
    at(NOW - 200 * DAY)
    for (let revision = 0; revision < 5; revision++) store.globalSink.append({ type: "extensions.changed", revision })
    const settings = store.globalSink.append({ type: "settings.changed", settings: store.settings.get() })
    const newest = store.globalSink.append({ type: "extensions.changed", revision: 9 })
    at(NOW)
    store.cleanStorage({ olderThanDays: 90 })
    const next = store.globalSink.append({ type: "extensions.changed", revision: 10 })
    expect(next.gseq).toBe(newest.gseq + 1)
    store.close()
    const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
    expect(db.query<{ gseq: number }, []>("SELECT gseq FROM global_events ORDER BY gseq").all().map((row) => row.gseq)).toEqual([settings.gseq, newest.gseq, next.gseq])
    db.close()
  })

  test("never removes a session with a queued message", () => {
    const { store, session, at } = open()
    const { id } = session(300)
    at(NOW - 300 * DAY)
    store.sessionSink.append({ type: "queue.added", sessionId: id, queueId: ids("queue"), text: "later", attachments: [] })
    at(NOW)
    expect(store.cleanStorage({ olderThanDays: 90 })).toMatchObject({ sessionsRemoved: 0, protectedSessions: 1 })
    expect(exists(store, id)).toBe(true)
    store.close()
  })

  test("keeps the root session of a loop that is not stopped or completed", () => {
    const { store, session } = open()
    const live = session(300, { title: "loop · live" })
    const finished = session(300, { title: "loop · done" })
    const loop = (sessionId: SessionId, state: Loop["state"]): Loop => ({
      loopId: ids("loop"), name: "l", directory: "/repo", objective: "o", trigger: { kind: "manual" }, budget: { mode: "monitor" }, state, sessionId, runs: 0, history: [], createdAt: 1, updatedAt: 1,
    })
    store.loops.save(loop(live.id, "paused"))
    store.loops.save(loop(finished.id, "completed"))
    const result = store.cleanStorage({ olderThanDays: 90 })
    expect(result).toMatchObject({ sessionsRemoved: 1, protectedSessions: 1 })
    expect(exists(store, live.id)).toBe(true)
    expect(exists(store, finished.id)).toBe(false)
    store.close()
  })

  test("sessions in the protect set (open in a terminal) are kept", () => {
    const { store, session } = open()
    const open1 = session(300)
    const other = session(300)
    const result = store.cleanStorage({ olderThanDays: 90, protect: new Set([open1.id]) })
    expect(result).toMatchObject({ sessionsRemoved: 1, protectedSessions: 1 })
    expect(exists(store, open1.id)).toBe(true)
    expect(exists(store, other.id)).toBe(false)
    store.close()
  })

  test("blobs shared with a kept session survive, exclusive ones and orphans are deleted with their files", () => {
    const { store, session, at, stray } = open()
    const shared = new Uint8Array(1_000).fill(5)
    const old = session(200, { blob: shared })
    const keep = session(5, { blob: shared })
    const exclusive = session(200, { blob: new Uint8Array(2_000).fill(6) })
    const orphan = stray(new Uint8Array(300).fill(7))
    at(NOW)
    expect(old.ref!.sha256).toBe(keep.ref!.sha256)
    const result = store.cleanStorage({ olderThanDays: 90 })
    expect(result.sessionsRemoved).toBe(2)
    expect(result.blobsRemoved).toBe(2)
    expect(existsSync(store.blobPath(shared ? keep.ref!.sha256 : ""))).toBe(true)
    expect(existsSync(store.blobPath(exclusive.ref!.sha256))).toBe(false)
    expect(existsSync(store.blobPath(orphan.sha256))).toBe(false)
    expect(store.storageReport()).toMatchObject({ blobs: 1, orphanBlobs: 0, blobBytes: 1_000 })
    store.close()
  })

  test("a fresh unreferenced upload is not touched (an attachment may be about to be sent)", () => {
    const { store } = open()
    const fresh = store.putBlob(new Uint8Array(50).fill(2), "image/png")
    expect(store.storageReport().orphanBlobs).toBe(0)
    expect(store.cleanStorage({ olderThanDays: 0 }).blobsRemoved).toBe(0)
    expect(existsSync(store.blobPath(fresh.sha256))).toBe(true)
    store.close()
  })

  test("olderThanDays 0 removes no sessions but still collects orphan blobs", () => {
    const { store, session, stray } = open()
    const old = session(500)
    const orphan = stray(new Uint8Array(100).fill(1))
    const result = store.cleanStorage({ olderThanDays: 0 })
    expect(result).toMatchObject({ sessionsRemoved: 0, blobsRemoved: 1 })
    expect(exists(store, old.id)).toBe(true)
    expect(existsSync(store.blobPath(orphan.sha256))).toBe(false)
    store.close()
  })

  test("an image attached to an unsent draft survives cleaning until the draft lets it go", () => {
    const { store, session, stray } = open()
    const live = session(1)
    const attached = stray(new Uint8Array(100).fill(3))
    store.drafts.set(live.id, "look at this", [attached])
    expect(store.cleanStorage({ olderThanDays: 0 })).toMatchObject({ blobsRemoved: 0 })
    expect(existsSync(store.blobPath(attached.sha256))).toBe(true)
    store.drafts.set(live.id, "")
    expect(store.cleanStorage({ olderThanDays: 0 })).toMatchObject({ blobsRemoved: 1 })
    expect(existsSync(store.blobPath(attached.sha256))).toBe(false)
    store.close()
  })

  test("measured bytes reclaimed shrink the files on disk and the WAL is truncated", () => {
    const { store, session, dir } = open()
    for (let i = 0; i < 30; i++) session(200, { messages: 60, blob: new Uint8Array(20_000).fill(i + 1) })
    session(1)
    const before = store.storageReport()
    const result = store.cleanStorage({ olderThanDays: 90 })
    const after = store.storageReport()
    expect(result.sessionsRemoved).toBe(30)
    expect(result.bytesReclaimed).toBeGreaterThanOrEqual(600_000)
    expect(after.blobBytes).toBe(0)
    expect(after.dbBytes).toBeLessThan(before.dbBytes)
    expect(after.walBytes).toBe(0)
    expect(Bun.file(path.join(dir, "mendd.db")).size).toBe(after.dbBytes)
    store.close()
  })

  test("vacuum runs only when asked and reports it", () => {
    const { store, session } = open()
    for (let i = 0; i < 5; i++) session(200, { messages: 30 })
    expect(store.cleanStorage({ olderThanDays: 90 }).vacuumed).toBe(false)
    expect(store.cleanStorage({ olderThanDays: 0, vacuum: true }).vacuumed).toBe(true)
    expect(store.storageReport().freeBytes).toBe(0)
    store.close()
  })

  test("usage projections survive a clean (they are aggregates)", () => {
    const { store, session, at } = open()
    const { id } = session(200)
    at(NOW - 200 * DAY)
    store.sessionSink.append({ type: "usage.recorded", sessionId: id, turnId: ids("turn"), provider: "p", model: "m", input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    at(NOW)
    store.cleanStorage({ olderThanDays: 90 })
    expect(store.usageByModel({ from: "2000-01-01", to: "2100-01-01" })[0]).toMatchObject({ input: 10 })
    store.close()
  })
})

test("objective cleanup counts orphans and deleted sessions, preserving live, protected and historical goals", () => {
  const { store, dir, session } = open()
  const { mkdirSync, writeFileSync, symlinkSync } = require("node:fs") as typeof import("node:fs")
  const root = path.join(dir, "goals")
  mkdirSync(root)
  const orphan = path.join(root, `${ids("goal")}.md`)
  writeFileSync(orphan, "orphan objective")
  const kept = session(1)
  const old = session(200)
  const protectedSession = session(200)
  function objective(sessionId: SessionId) {
    const goalId = ids("goal")
    const file = path.join(root, `${goalId}.md`)
    writeFileSync(file, "live objective")
    const goal = store.goals.insert({ goalId, sessionId, objective: "read file", objectiveFile: file }).created.goal
    if (sessionId === kept.id) store.sessionSink.append({ type: "goal.changed", sessionId, change: "created", goal })
    return file
  }
  const liveFile = objective(kept.id)
  const oldFile = objective(old.id)
  const protectedFile = objective(protectedSession.id)
  // A file belonging to a historical goal whose row was pruned is still owned by its live session event.
  const historicalId = ids("goal")
  const historicalFile = path.join(root, `${historicalId}.md`)
  writeFileSync(historicalFile, "historical")
  const historicalGoal = store.goals.insert({ goalId: historicalId, sessionId: kept.id, objective: "old", objectiveFile: historicalFile }).created.goal
  store.sessionSink.append({ type: "goal.changed", sessionId: kept.id, change: "created", goal: historicalGoal })
  for (let i = 0; i < 21; i++) store.goals.insert({ goalId: ids("goal"), sessionId: kept.id, objective: "later" })
  expect(store.goals.get(historicalId)).toBeUndefined()
  const unrelated = path.join(root, "README.md")
  writeFileSync(unrelated, "leave alone")
  const linked = path.join(root, `${ids("goal")}.md`)
  symlinkSync(liveFile, linked)
  const report = store.storageReport()
  expect(report).toMatchObject({ goalFiles: 5, orphanGoalFiles: 1, orphanGoalBytes: 16, goalBytes: 68 })
  const options = { olderThanDays: 90, protect: new Set([protectedSession.id]) }
  const dry = store.cleanStorage({ ...options, dryRun: true })
  expect(dry).toMatchObject({ goalFilesRemoved: 2, sessionsRemoved: 1 })
  expect(dry.bytesReclaimed).toBeGreaterThanOrEqual(30)
  for (const file of [orphan, oldFile, liveFile, protectedFile, historicalFile]) expect(existsSync(file)).toBe(true)
  const real = store.cleanStorage(options)
  expect(real).toMatchObject({ goalFilesRemoved: 2, sessionsRemoved: 1 })
  expect(existsSync(orphan)).toBe(false)
  expect(existsSync(oldFile)).toBe(false)
  for (const file of [liveFile, protectedFile, historicalFile, unrelated, linked]) expect(existsSync(file)).toBe(true)
  expect(store.storageReport()).toMatchObject({ goalFiles: 3, orphanGoalFiles: 0, orphanGoalBytes: 0 })
  expect(store.cleanStorage({ olderThanDays: 0 }).goalFilesRemoved).toBe(0)
  store.close()
})
