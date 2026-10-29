import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, commandTimeout } from "@mendcode/client"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { fakeComputer } from "./b29-fixtures"
import { fakeAccessibility } from "./b80-fixtures"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(enabled = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b80-rpc-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const os = fakeComputer(), ax = fakeAccessibility()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, extensionsEnabled: false, computer: { enabled, platform: "darwin", run: os.run, accessibility: ax.os }, engine: () => createNativeEngine({ provider: { id: "local", model: "local", async *stream() { yield { type: "finish", reason: "stop" } } }, tools: [], history: memoryHistory(), cwdFor: () => dir, system: () => "SYS", compactionPrompt: "C" }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b80-local-owner" })
  cleanup.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error(created.error.message)
  return { daemon, client, sessionId: created.result!.sessionId as SessionId, ax }
}

test("local typed helpers traverse daemon session, observation and code contracts, including diagnostics and stop", async () => {
  const f = await fixture(), capture = await f.client.computerCapture(f.sessionId)
  if (!capture.ok) throw new Error(capture.error.message)
  const started = await f.client.computerSession(f.sessionId, { action: "start", mode: "control", bootstrapCaptureID: capture.capture.captureID })
  if (!started.ok) throw new Error(started.error.message)
  const computerSessionID = started.session.computerSessionID
  const observed = await f.client.computerObserve(f.sessionId, { computerSessionID })
  expect(observed).toMatchObject({ ok: true, observation: { revision: 1 } })
  expect(JSON.stringify(observed)).not.toContain("SECRET")
  expect(await f.client.computerCode(f.sessionId, { computerSessionID, code: "return await tools.press({revision:1,nodeID:'0.1'})" })).toMatchObject({ ok: true, execution: { ok: true, value: { revision: 2 } } })
  expect(await f.client.computerCode(f.sessionId, { computerSessionID, code: "return process.env" })).toMatchObject({ ok: true, execution: { ok: false } })
  expect(await f.client.computerObserve(createIdFactory()("session"), { computerSessionID })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  expect(await f.client.computerSession(f.sessionId, { action: "stop", computerSessionID })).toMatchObject({ ok: true, session: { stopped: true } })
  expect(await f.client.computerObserve(f.sessionId, { computerSessionID })).toMatchObject({ ok: false })
  expect(commandTimeout({ type: "computer.code", sessionId: f.sessionId, input: { computerSessionID, code: "return 1" } }, 15000)).toBe(25000)
})

test("computer semantic RPC commands remain off by default", async () => {
  const f = await fixture(false)
  expect(await f.client.computerSession(f.sessionId, { action: "start", mode: "observe", bootstrapCaptureID: crypto.randomUUID() })).toMatchObject({ ok: false })
  expect(f.ax.calls).toEqual([])
})
