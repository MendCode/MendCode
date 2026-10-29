import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createSynthetic, TYPICAL_SESSION } from "./synthetic-data"
import { timeScale } from "../../../scripts/test-budget"

const dirs: string[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MB = 1024 * 1024
type Synthetic = ReturnType<typeof createSynthetic>

function populate(options: { sessions: number; compress: boolean; pageSize?: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-budget-"))
  dirs.push(dir)
  const synthetic = createSynthetic({ dir, compress: options.compress, ...(options.pageSize ? { pageSize: options.pageSize } : {}) })
  closers.push(() => synthetic.store.close())
  for (let i = 0; i < options.sessions; i++) synthetic.session(i)
  return synthetic
}

/** Database + WAL + blob files, measured after a checkpoint so the WAL is not counted as data. */
function measure(store: Synthetic["store"]) {
  store.compactStorage({})
  const report = store.storageReport()
  return { report, total: report.dbBytes + report.walBytes + report.blobBytes }
}

describe("disk usage per kind of data (synthetic sessions, 8 turns each)", () => {
  test("compression, shared snapshot content and larger pages cut the store", () => {
    // Historical pre-compression format: plain forms and 4 KB pages.
    const legacy = measure(populate({ sessions: 60, compress: false, pageSize: 4096 }).store)
    const packed = measure(populate({ sessions: 60, compress: true }).store)
    const perSession = (bytes: number) => Math.round(bytes / 60)
    if (process.env.MEND_DISK_REPORT) {
      const { report: before } = legacy
      const { report: after } = packed
      console.log(
        [
          "bytes per synthetic session (8 turns, 3 tool calls per turn):",
          `  total          before ${perSession(legacy.total)}  after ${perSession(packed.total)}  (${((packed.total / legacy.total) * 100).toFixed(0)}%)`,
          `  per turn       before ${Math.round(perSession(legacy.total) / TYPICAL_SESSION.turns)}  after ${Math.round(perSession(packed.total) / TYPICAL_SESSION.turns)}`,
          `  event payloads before ${perSession(before.eventBytes)}  after ${perSession(after.eventBytes)}`,
          `  engine history before ${perSession(before.engineBytes)}  after ${perSession(after.engineBytes)}`,
          `  snapshots      before ${perSession(before.snapshotBytes ?? 0)}  after ${perSession(after.snapshotBytes ?? 0)}  (${after.snapshotObjects} shared objects for ${after.snapshotRefs} refs)`,
          `  saved by compression and sharing: ${perSession(after.savedBytes ?? 0)}`,
        ].join("\n"),
      )
    }
    expect(packed.total).toBeLessThan(legacy.total * 0.5)
    expect(perSession(packed.total)).toBeLessThan(210 * 1024)
    expect(packed.report.eventBytes).toBeLessThan(legacy.report.eventBytes * 0.7)
    expect(packed.report.engineBytes).toBeLessThan(legacy.report.engineBytes * 0.5)
    expect(packed.report.snapshotBytes ?? 0).toBeLessThan((legacy.report.snapshotBytes ?? 0) * 0.35)
    expect(packed.report.compressedRows ?? 0).toBeGreaterThan(0)
    expect(packed.report.savedBytes ?? 0).toBeGreaterThan(0)
    expect(legacy.report.compressedRows ?? 0).toBe(0)
  }, 60_000)
})

describe("budget", () => {
  /**
   * Generating 2,000 sessions takes about 50 s on a developer machine and more than 4 minutes on a CI runner's disk, so under
   * `MENDCODE_TEST_TIME_SCALE` (the CI workflow only) the same assertions run on 25 % of the sessions (500) with 25 % of the
   * byte budget: the bytes per session (176 KB measured against the 183 KB the budget allows, 173 KB at 2,000), the delta
   * count and the shrink on compaction are checked as before. What only the full run proves is that nothing grows faster
   * than linearly with 2,000 sessions in one database (page and WAL overheads).
   */
  const CI_SHARE = timeScale() > 1 ? 0.25 : 1
  const sessions = 2_000 * CI_SHARE
  test(`${sessions.toLocaleString("en-US")} synthetic sessions stay well under 1 GB, and dropping finished deltas shrinks them further`, () => {
    const { store } = populate({ sessions, compress: true })
    const full = measure(store)
    expect(full.report.sessions).toBe(sessions)
    if (process.env.MEND_DISK_REPORT) console.log(`${sessions} sessions: ${full.total} bytes · ${(full.total / MB).toFixed(1)} MiB on disk (${Math.round(full.total / sessions)} bytes per session)`)
    expect(full.total).toBeLessThan(350 * MB * CI_SHARE)
    const idle = store.compactStorage({ deltaIdleDays: 0 })
    expect(idle.deltaEvents).toBe(sessions * TYPICAL_SESSION.turns * TYPICAL_SESSION.deltasPerMessage)
    expect(measure(store).total).toBeLessThanOrEqual(full.total)
  }, 240_000 * timeScale())
})

/** What one session's conversation weighs on its own: its events plus its model history. */
const conversationBytes = (report: Synthetic["store"] extends { storageReport(): infer R } ? R : never) => report.eventBytes + report.engineBytes

/**
 * The cost of a fork that copies everything it starts from, which is what a fork was before sharing: the conversation of
 * `source` written again as a session of its own (every transcript event, deltas included, and the whole model history).
 */
function physicalCopy(synthetic: Synthetic, source: SessionId) {
  const { store } = synthetic
  const id = createIdFactory()("session")
  const events = store.readAfter(source, 0, 100_000).flatMap((event) => {
    if (!(event.type.startsWith("turn.") || event.type.startsWith("item."))) return []
    const { seq: _seq, ...rest } = event
    return [{ ...rest, sessionId: id }]
  })
  store.importTranscript({ id, directory: "/work/project", title: "physical copy", createdAt: 1, events: events as never, messages: store.engineMessages.load(source, "native"), origin: { sourceSessionId: source, truncated: false, sanitized: false } })
  return id
}

describe("forks of a long session", () => {
  const LONG = { ...TYPICAL_SESSION, turns: 40 }

  test("ten forks of one history cost well under ten copies, and every one still reads the whole conversation", () => {
    const shared = populate({ sessions: 0, compress: true })
    const parent = shared.session(1, LONG)
    const alone = measure(shared.store)
    const history = shared.store.engineMessages.load(parent, "native")
    const forks = Array.from({ length: 10 }, () => shared.fork(parent))
    const forked = measure(shared.store)
    const perFork = (forked.total - alone.total) / forks.length

    // The same ten, written the way a fork used to be written: every row again.
    const copying = populate({ sessions: 0, compress: true })
    const original = copying.session(1, LONG)
    const base = measure(copying.store)
    for (let i = 0; i < 10; i++) physicalCopy(copying, original)
    const copied = measure(copying.store)
    const perCopy = (copied.total - base.total) / 10

    const logical = conversationBytes(alone.report)
    if (process.env.MEND_DISK_REPORT) {
      console.log(
        [
          "10 forks of a 40-turn session (each carries the whole history):",
          `  logical size of one fork (events + model history)     ${Math.round(logical / 1024)} KB`,
          `  physical growth per fork, copying every row           ${Math.round(perCopy / 1024)} KB`,
          `  physical growth per fork, shared                      ${Math.round(perFork / 1024)} KB  (${((perFork / perCopy) * 100).toFixed(0)}% of a copy)`,
          `  model history shared by reference                     ${forked.report.sharedMessages} messages, ${Math.round((forked.report.sharedBytes ?? 0) / 1024)} KB read, stored once`,
          `  tool output shared                                    ${forked.report.eventObjects} objects, ${forked.report.eventObjectRefs} references`,
        ].join("\n"),
      )
    }
    expect(forked.report.forkRefs).toBe(10)
    expect(forked.report.sharedMessages).toBe(10 * history.length)
    expect(forked.report.engineBytes).toBe(alone.report.engineBytes)
    expect(copied.report.engineBytes).toBeGreaterThan(alone.report.engineBytes * 5)
    // Copies now deduplicate model/tool content too, so use their smaller current cost as the comparison.
    expect(perFork).toBeLessThan(perCopy * 0.25)
    // Measured 104 KiB/fork, including address indexes, model prefixes and shared-object refs.
    expect(perFork).toBeLessThan(115 * 1024)
    for (const fork of forks) expect(shared.store.engineMessages.load(fork.sessionId, "native")).toEqual(history)
  }, 60_000)

  test("a chain of forks, each cut earlier than the one before, stores the history once", () => {
    const synthetic = populate({ sessions: 0, compress: true })
    const { store } = synthetic
    const root = synthetic.session(2, LONG)
    const history = store.engineMessages.load(root, "native")
    const alone = measure(store)
    const chain = [root]
    for (let depth = 1; depth <= 6; depth++) chain.push(synthetic.fork(chain.at(-1)!, 39 - depth * 5).sessionId)
    const chained = measure(store)
    expect(chained.report.engineBytes).toBe(alone.report.engineBytes)
    chain.slice(1).forEach((sessionId, i) => expect(store.engineMessages.load(sessionId, "native")).toEqual(history.slice(0, store.turns.messageCounts(sessionId).native)))
    // Deleting from the root down moves rows to the surviving fork instead of copying them; nothing readable is lost.
    const expected = store.engineMessages.load(chain.at(-1)!, "native")
    for (const sessionId of chain.slice(0, -1)) store.deleteSession(sessionId)
    const survivor = measure(store)
    expect(store.engineMessages.load(chain.at(-1)!, "native")).toEqual(expected)
    expect(survivor.report.engineBytes).toBeLessThan(alone.report.engineBytes)
    expect(survivor.report.forkRefs).toBe(0)
    expect(survivor.total).toBeLessThan(chained.total)
  })

  test("fork-heavy store: 10 long sessions with 10 forks each, cut at different turns, then the parents are deleted", () => {
    const synthetic = populate({ sessions: 0, compress: true })
    const { store } = synthetic
    const parents = Array.from({ length: 10 }, (_, i) => synthetic.session(100 + i, LONG))
    const alone = measure(store)
    const histories = new Map(parents.map((parent) => [parent, store.engineMessages.load(parent, "native")]))
    const forks = parents.flatMap((parent) => Array.from({ length: 10 }, (_, n) => ({ parent, ...synthetic.fork(parent, 39 - n * 3) })))
    const forked = measure(store)
    const growth = (forked.total - alone.total) / forks.length
    if (process.env.MEND_DISK_REPORT) {
      console.log(`100 forks of 10 long sessions: ${(forked.total / MB).toFixed(1)} MB on disk (${Math.round(growth / 1024)} KB per fork, ${Math.round(alone.total / parents.length / 1024)} KB per parent session)`)
    }
    expect(forked.report.sessions).toBe(110)
    expect(forked.report.engineBytes).toBe(alone.report.engineBytes)
    expect(growth).toBeLessThan(conversationBytes(alone.report) / parents.length)
    expect(growth).toBeLessThan(80 * 1024)
    for (const fork of forks) expect(store.engineMessages.load(fork.sessionId, "native")).toEqual(histories.get(fork.parent)!.slice(0, fork.messages))

    // Deleting every parent loses nothing a fork reads, and the rows nobody reads any more go.
    for (const parent of parents) store.deleteSession(parent)
    const orphaned = measure(store)
    for (const fork of forks) expect(store.engineMessages.load(fork.sessionId, "native")).toEqual(histories.get(fork.parent)!.slice(0, fork.messages))
    expect(orphaned.report.sessions).toBe(100)
    expect(orphaned.report.engineBytes).toBeLessThanOrEqual(alone.report.engineBytes)
    expect(orphaned.report.forkRefs).toBeLessThanOrEqual(90)
    expect(orphaned.total).toBeLessThan(forked.total)
  }, 120_000)
})
