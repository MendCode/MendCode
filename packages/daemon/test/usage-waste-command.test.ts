import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { UsageWasteReport, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

test("usage.waste answers a report of the range's calls, in the protocol's shape, and refuses a reversed range", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-waste-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "waste", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "user.submit", sessionId, text: "/faux-usage", attachments: [] })
  await until(() => events.some((event) => event.type === "turn.completed"))

  const reply = await client.send({ type: "usage.waste", from: today(), to: today() })
  expect(reply.ok).toBe(true)
  const report = UsageWasteReport.parse(reply.ok ? reply.result : undefined)
  const recorded = events.filter((event) => event.type === "usage.recorded").length
  expect(recorded).toBeGreaterThan(0)
  expect(report.calls).toBe(recorded)
  expect(report.scope.kind).toBe("global")
  expect(report.cold.count).toBe(0)

  const reversed = await client.send({ type: "usage.waste", from: "2026-10-02", to: "2026-10-01" })
  expect(reversed.ok).toBe(false)
})
