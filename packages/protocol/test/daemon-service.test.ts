import { expect, test } from "bun:test"
import { Command, DaemonLogsReport, DaemonStatusReport, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }

test("daemon service commands are additive and strictly bounded", () => {
  for (const command of [{ type: "daemon.status" }, { type: "daemon.logs", lines: 1000 }, { type: "daemon.tick", scheduler: "dream", execute: false }, { type: "daemon.tick", scheduler: "loops", execute: true, limit: 100 }]) expect(Command.safeParse({ ...base, ...command }).success).toBe(true)
  for (const command of [{ type: "daemon.logs", lines: 0 }, { type: "daemon.logs", lines: 1001 }, { type: "daemon.logs", path: "/private/file" }, { type: "daemon.tick", scheduler: "other" }, { type: "daemon.tick", scheduler: "loops", limit: 101 }]) expect(Command.safeParse({ ...base, ...command }).success).toBe(false)
  expect(isReadOnlyCommand("daemon.status")).toBe(true)
  expect(isReadOnlyCommand("daemon.logs")).toBe(false)
  expect(isReadOnlyCommand("daemon.tick")).toBe(false)
  expect(isReadOnlyCommand("daemon.shutdown")).toBe(false)
})

test("health reports reject content and log reports bound payloads", () => {
  const report = { running: true, pid: 1, dataDir: "/tmp/data", engine: "faux", activeTurns: 0, backgroundJobs: 0, loops: { total: 0, active: 0, running: 0 }, dream: { configured: false, enabled: false, at: null, handled: null } }
  expect(DaemonStatusReport.safeParse(report).success).toBe(true)
  expect(DaemonStatusReport.safeParse({ ...report, transcript: "content" }).success).toBe(false)
  expect(DaemonLogsReport.safeParse({ logs: [{ stream: "stdout", path: "/tmp/log", text: "x".repeat(160_001), missing: false, truncated: true }] }).success).toBe(false)
})
