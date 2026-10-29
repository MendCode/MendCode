import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { StorageCleanResult, StorageReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const DAY = 86_400_000
/** 2026-09-26 12:00 local: the next 03:30 window is 15.5 h away. */
const NOW = new Date(2026, 8, 26, 12).getTime()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-storage-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const clock = createVirtualClock(NOW - 200 * DAY)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), clock, engine: ({ clock: engineClock }) => createFauxEngine({ clock: engineClock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "A", onEvent: () => {} })
  await client.connect()
  cleanups.push(() => client.close())
  /** Creates a session as if `daysAgo` days before NOW (the virtual clock moves to that time first). */
  async function session(daysAgo: number, title: string) {
    clock.advance(Math.max(0, NOW - daysAgo * DAY - clock.now()))
    const reply = await client.send({ type: "session.create", directory: "/repo", title })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result?.sessionId as SessionId
  }
  const titles = async () => {
    const listed = await client.send({ type: "session.list", limit: 100 })
    return listed.ok ? (listed.result?.sessions as Array<{ title: string }>).map((s) => s.title).sort() : []
  }
  return { client, clock, session, titles }
}

describe("storage.report", () => {
  test("returns a valid report with the session listed among the top sessions", async () => {
    const { client, session } = await boot()
    const id = await session(1, "recent")
    const reply = await client.send({ type: "storage.report" })
    expect(reply.ok).toBe(true)
    const report = StorageReport.parse(reply.ok ? reply.result : {})
    expect(report.sessions).toBe(1)
    expect(report.topSessions[0]).toMatchObject({ sessionId: id, title: "recent" })
    expect(report.dbBytes).toBeGreaterThan(0)
  })
})

describe("storage.clean", () => {
  test("a dry run counts what would go and removes nothing, then the real clean removes it", async () => {
    const { client, session, titles, clock } = await boot()
    await session(150, "old")
    await session(10, "recent")
    clock.advance(NOW - clock.now())
    const dry = await client.send({ type: "storage.clean", olderThanDays: 90, dryRun: true })
    expect(dry.ok && StorageCleanResult.parse(dry.result)).toMatchObject({ dryRun: true, sessionsRemoved: 1, olderThanDays: 90 })
    expect(await titles()).toEqual(["old", "recent"])
    const real = await client.send({ type: "storage.clean", olderThanDays: 90 })
    expect(real.ok && StorageCleanResult.parse(real.result)).toMatchObject({ dryRun: false, sessionsRemoved: 1, vacuumed: false })
    expect(await titles()).toEqual(["recent"])
  })

  test("without an age it uses the retentionDays setting, then 90", async () => {
    const { client, session, titles, clock } = await boot()
    await session(120, "very old")
    await session(45, "old")
    await session(5, "recent")
    clock.advance(NOW - clock.now())
    await client.send({ type: "settings.set", patch: { retentionDays: 30 } })
    const first = await client.send({ type: "storage.clean", dryRun: true })
    expect(first.ok && first.result?.olderThanDays).toBe(30)
    expect(first.ok && first.result?.sessionsRemoved).toBe(2)
    await client.send({ type: "settings.set", patch: { retentionDays: null } as never })
    const fallback = await client.send({ type: "storage.clean", dryRun: true })
    expect(fallback.ok && fallback.result?.olderThanDays).toBe(90)
    expect(fallback.ok && fallback.result?.sessionsRemoved).toBe(1)
    expect(await titles()).toEqual(["old", "recent", "very old"])
  })

  test("a session open in a terminal is protected", async () => {
    const { client, session, titles, clock } = await boot()
    const open = await session(300, "open in a terminal")
    await session(300, "forgotten")
    clock.advance(NOW - clock.now())
    await client.subscribe(open, 0)
    const reply = await client.send({ type: "storage.clean", olderThanDays: 90 })
    expect(reply.ok && reply.result).toMatchObject({ sessionsRemoved: 1, protectedSessions: 1 })
    expect(await titles()).toEqual(["open in a terminal"])
  })

  test("olderThanDays 0 keeps every session", async () => {
    const { client, session, titles, clock } = await boot()
    await session(400, "ancient")
    clock.advance(NOW - clock.now())
    const reply = await client.send({ type: "storage.clean", olderThanDays: 0 })
    expect(reply.ok && reply.result?.sessionsRemoved).toBe(0)
    expect(await titles()).toEqual(["ancient"])
  })

  test("a session removed by clean is unknown afterwards", async () => {
    const { client, session, clock } = await boot()
    const id = await session(200, "gone")
    clock.advance(NOW - clock.now())
    await client.send({ type: "storage.clean", olderThanDays: 90 })
    expect(await client.send({ type: "client.subscribe", sessionId: id, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})

describe("retentionDays", () => {
  test("must be at least 7", async () => {
    const { client } = await boot()
    expect((await client.send({ type: "settings.set", patch: { retentionDays: 3 } })).ok).toBe(false)
    expect((await client.send({ type: "settings.set", patch: { retentionDays: 7 } })).ok).toBe(true)
  })

  test("the daily 03:30 timer cleans only while retentionDays is set", async () => {
    const { client, session, titles, clock } = await boot()
    await session(100, "old")
    await session(1, "recent")
    clock.advance(NOW - clock.now())
    clock.advance(24 * 3_600_000)
    expect(await titles()).toEqual(["old", "recent"])
    await client.send({ type: "settings.set", patch: { retentionDays: 30 } })
    clock.advance(16 * 3_600_000)
    expect(await titles()).toEqual(["recent"])
  })

  test("clearing the setting cancels the timer", async () => {
    const { client, session, titles, clock } = await boot()
    await session(100, "old")
    clock.advance(NOW - clock.now())
    await client.send({ type: "settings.set", patch: { retentionDays: 30 } })
    await client.send({ type: "settings.set", patch: { retentionDays: null } as never })
    clock.advance(3 * 24 * 3_600_000)
    expect(await titles()).toEqual(["old"])
  })
})

test("storage report and clean expose objective counts over the wire, including orphan-only cleanup", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs")
  const { createIdFactory } = await import("@mendcode/protocol")
  const ids = createIdFactory()
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-goal-clean-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "goal-clean" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: dir, title: "keep" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  const goalId = ids("goal")
  const root = path.join(dir, "goals")
  mkdirSync(root)
  const live = path.join(root, `${goalId}.md`)
  const orphan = path.join(root, `${ids("goal")}.md`)
  writeFileSync(live, "live")
  writeFileSync(orphan, "orphan")
  daemon.store.goals.insert({ goalId, sessionId, objective: "read", objectiveFile: live })
  expect(await client.send({ type: "storage.report" })).toMatchObject({ ok: true, result: { goalFiles: 2, goalBytes: 10, orphanGoalFiles: 1, orphanGoalBytes: 6 } })
  expect(await client.send({ type: "storage.clean", olderThanDays: 0, dryRun: true })).toMatchObject({ ok: true, result: { goalFilesRemoved: 1, bytesReclaimed: 6, sessionsRemoved: 0 } })
  expect(existsSync(orphan)).toBe(true)
  expect(await client.send({ type: "storage.clean", olderThanDays: 0 })).toMatchObject({ ok: true, result: { goalFilesRemoved: 1, sessionsRemoved: 0 } })
  expect(existsSync(orphan)).toBe(false)
  expect(existsSync(live)).toBe(true)
})
