import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { isReadOnlyCommand, StorageCleanResult, StorageReport, StorageWorktreesReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-disk-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "disk" })
  await client.connect()
  cleanups.push(() => client.close())
  async function remote(readOnly: boolean) {
    const token = remoteTokens(dir).create({ name: readOnly ? "ro" : "full", readOnly }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  return { daemon, client, dir, remote }
}

describe("storage over the wire", () => {
  test("the report carries the per-kind breakdown and what compression saves", async () => {
    const { client, daemon } = await boot()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "t" })
    const sessionId = created.ok ? (created.result?.sessionId as SessionId) : undefined
    expect(sessionId).toBeDefined()
    const history = [{ role: "tool", content: "line of output\n".repeat(400) }]
    daemon.store.engineMessages.save(sessionId!, "native", history)
    const reply = await client.send({ type: "storage.report" })
    const report = StorageReport.parse(reply.ok ? reply.result : {})
    // The compact model envelope and its shared tool-content object are separate stored rows.
    expect(report).toMatchObject({ turns: 0, snapshotObjects: 0, compressedRows: 2, eventObjects: 1, trashBytes: 0 })
    expect(daemon.store.engineMessages.load(sessionId!, "native")).toEqual(history)
    expect(report.savedBytes).toBeGreaterThan(4000)
    expect(report.eventTypes).toBeDefined()
  })

  test("clean with compact reports the rows it moved and keeps the data readable", async () => {
    const { client, daemon } = await boot()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "t" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    const history = [{ role: "tool", content: "line of output\n".repeat(400) }]
    daemon.store.engineMessages.save(sessionId, "native", history)
    const dry = await client.send({ type: "storage.clean", olderThanDays: 0, dryRun: true, compact: true })
    expect(dry.ok && StorageCleanResult.parse(dry.result)).toMatchObject({ dryRun: true, sessionsRemoved: 0 })
    const real = await client.send({ type: "storage.clean", olderThanDays: 0, compact: true, vacuum: true })
    expect(real.ok && StorageCleanResult.parse(real.result)).toMatchObject({ dryRun: false, vacuumed: true, compactComplete: true, sessionsRemoved: 0 })
    expect(daemon.store.engineMessages.load(sessionId, "native")).toEqual(history)
  })

  test("the worktree report is local only and is not a read-only command", async () => {
    const { client, remote } = await boot()
    expect(isReadOnlyCommand("storage.worktrees")).toBe(false)
    expect(isReadOnlyCommand("storage.clean")).toBe(false)
    const local = await client.send({ type: "storage.worktrees" })
    expect(StorageWorktreesReport.parse(local.ok ? local.result : {})).toMatchObject({ worktrees: [], totalBytes: 0, trashBytes: 0 })
    for (const peer of [await remote(false), await remote(true)]) {
      expect(await peer.send({ type: "storage.worktrees" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
      expect(await peer.send({ type: "storage.clean", olderThanDays: 0, worktrees: true, dryRun: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
  })

  test("worktreeGcDays is a local setting between 1 and 3650 days, cleared with null", async () => {
    const { client, remote } = await boot()
    expect((await client.send({ type: "settings.set", patch: { worktreeGcDays: 0 } })).ok).toBe(false)
    expect((await client.send({ type: "settings.set", patch: { worktreeGcDays: 14 } })).ok).toBe(true)
    const read = await client.send({ type: "settings.get" })
    expect(read.ok && (read.result?.settings as { worktreeGcDays?: number }).worktreeGcDays).toBe(14)
    expect((await client.send({ type: "settings.set", patch: { worktreeGcDays: null } as never })).ok).toBe(true)
    const cleared = await client.send({ type: "settings.get" })
    expect(cleared.ok && (cleared.result?.settings as { worktreeGcDays?: number }).worktreeGcDays).toBeUndefined()
    expect(await (await remote(false)).send({ type: "settings.set", patch: { worktreeGcDays: 14 } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  })
})
