import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
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

test("an idle session is released to its engine when its last client stops showing it, not while one still does", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-release-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const released: SessionId[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock }) => ({ ...createFauxEngine({ clock, deltaMs: 1 }), release: (sessionId: SessionId) => void released.push(sessionId) }),
  })
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "release", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "user.submit", sessionId, text: "hello", attachments: [] })
  await until(() => events.some((event) => event.type === "turn.completed"))
  await new Promise((r) => setTimeout(r, 100))
  expect(released).toEqual([])
  expect((await client.send({ type: "client.unsubscribe", sessionId })).ok).toBe(true)
  await until(() => released.length > 0)
  expect(released).toEqual([sessionId])
})
