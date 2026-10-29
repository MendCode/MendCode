import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { DaemonStatusReport, DaemonLogsReport, type SessionId } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"
import { daemonLogPaths } from "../src/daemon-logs"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b68-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "faux" }, ...extra })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b68", reconnect: false })
  cleanups.push(() => client.close())
  await client.connect()
  return { dir, daemon, client }
}

test("health and typed log helpers use the real daemon and never probe credentials", async () => {
  let probes = 0
  const h = await boot({ buildId: "service-build", info: { engine: "native", login: async () => { probes++; throw new Error("must not probe") } } })
  const status = await h.client.daemonStatus()
  expect(status.ok).toBe(true)
  if (!status.ok) throw new Error(status.error.message)
  expect(DaemonStatusReport.parse(status.report)).toMatchObject({ running: true, dataDir: h.dir, pid: process.pid, buildId: "service-build", activeTurns: 0, backgroundJobs: 0, loops: { total: 0, active: 0, running: 0 }, dream: { configured: false, enabled: false } })
  expect(probes).toBe(0)
  const logs = daemonLogPaths(h.dir)
  mkdirSync(path.dirname(logs.stdout))
  writeFileSync(logs.stdout, "first\nsecond\nthird\n")
  const report = await h.client.daemonLogs(2)
  expect(report.ok).toBe(true)
  if (!report.ok) throw new Error(report.error.message)
  expect(DaemonLogsReport.parse(report.report).logs[0]).toMatchObject({ text: "second\nthird", truncated: true, missing: false })
  expect(report.report.logs[1]!.missing).toBe(true)
})

test("a loop tick previews without dispatch and explicit execute starts only due active loops", async () => {
  let now = Date.UTC(2026, 9, 1)
  // Hold timers to model a sleeping host; the control tick is the only dispatch here.
  const h = await boot({ clock: { now: () => now, setTimer: () => ({ cancel() {} }) } })
  const create = async (name: string, trigger: { kind: "interval"; everyMs: number } | { kind: "manual" }) => {
    const reply = await h.client.send({ type: "loop.create", name, objective: "Observe checks", directory: h.dir, trigger, budget: { mode: "monitor" }, reportOnly: true })
    expect(reply.ok).toBe(true)
    return reply.ok ? (reply.result!.loop as { loopId: string }).loopId : ""
  }
  const due = await create("Due", { kind: "interval", everyMs: 60_000 })
  const manual = await create("Manual", { kind: "manual" })
  now += 60_001
  const preview = await h.client.send({ type: "daemon.tick", scheduler: "loops" })
  expect(preview.ok ? preview.result : undefined).toEqual({ scheduler: "loops", execute: false, due: [due], started: [] })
  const execute = await h.client.send({ type: "daemon.tick", scheduler: "loops", execute: true, limit: 1 })
  expect(execute.ok ? execute.result?.started : undefined).toEqual([due])
  const again = await h.client.send({ type: "daemon.tick", scheduler: "loops", execute: true })
  expect(again.ok ? again.result?.started : undefined).toEqual([])
  expect(h.daemon.store.loops.all().find((loop) => loop.loopId === manual)?.runs).toBe(0)
})

test("Dream once uses the persisted window and stopping refuses foreground work", async () => {
  let now = new Date(2026, 9, 1, 4).getTime()
  const h = await boot({ clock: { now: () => now, setTimer: (ms, callback) => {
    // Agent deltas need short timers; daily scheduler timers stay held.
    if (ms < 1000) { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } }
    return { cancel() {} }
  } }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 100 }), dream: { complete: async () => '{"memories":[]}' } })
  await h.client.send({ type: "settings.set", patch: { dreamAt: "03:00" } })
  const before = h.daemon.store.meta.get("dream.window")
  now += 86_400_000
  const preview = await h.client.send({ type: "daemon.tick", scheduler: "dream" })
  expect(preview.ok ? preview.result?.execute : undefined).toBe(false)
  expect(h.daemon.store.meta.get("dream.window")).toBe(before)
  await h.client.send({ type: "daemon.tick", scheduler: "dream", execute: true })
  expect(h.daemon.store.meta.get("dream.window")).not.toBe(before)
  const again = await h.client.send({ type: "daemon.tick", scheduler: "dream", execute: true })
  expect(again.ok ? again.result?.runs : undefined).toEqual([])
  const created = await h.client.send({ type: "session.create", directory: h.dir })
  const sessionId = (created.ok ? created.result?.sessionId : "") as SessionId
  await h.client.send({ type: "user.submit", sessionId, text: "Observe service status", attachments: [] })
  const stop = await h.client.send({ type: "daemon.shutdown" })
  expect(stop.ok).toBe(false)
  expect(!stop.ok && stop.error.code).toBe("busy")
})

test("a restart asked while a turn runs waits for it: the daemon says so in its status, then stops once the work ends", async () => {
  let shutdowns = 0
  const h = await boot({ engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 50 }), onShutdown: () => void shutdowns++ })
  const created = await h.client.send({ type: "session.create", directory: h.dir })
  const sessionId = (created.ok ? created.result?.sessionId : "") as SessionId
  await h.client.send({ type: "user.submit", sessionId, text: "Observe service status", attachments: [] })
  const stop = await h.client.send({ type: "daemon.shutdown", whenIdle: true })
  expect(stop).toMatchObject({ ok: true, result: { pending: true } })
  const status = await h.client.daemonStatus()
  expect(status.ok && DaemonStatusReport.parse(status.report).restartPending).toBe(true)
  expect(shutdowns).toBe(0)
  const deadline = Date.now() + 15_000
  while (shutdowns === 0 && Date.now() < deadline) await Bun.sleep(50)
  expect(shutdowns).toBe(1)
}, 20_000)
