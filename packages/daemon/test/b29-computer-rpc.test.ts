import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, commandTimeout } from "@mendcode/client"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { ComputerCaptureMetadata, createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { fakeComputer } from "./b29-fixtures"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })

async function fixture(enabled: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b29-rpc-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const os = fakeComputer()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, extensionsEnabled: false, computer: { enabled, platform: "darwin", run: os.run }, engine: () => createNativeEngine({ provider: { id: "local", model: "local", async *stream() { yield { type: "finish", reason: "stop" } } }, tools: [], history: memoryHistory(), cwdFor: () => dir, system: () => "SYS", compactionPrompt: "C" }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "computer-test" })
  cleanup.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error(created.error.message)
  return { dir, os, daemon, client, sessionId: created.result!.sessionId as SessionId }
}

test("typed computer client operations share daemon lineage, image blobs and single-use session authority", async () => {
  const f = await fixture(true)
  const result = await f.client.computerCapture(f.sessionId, { region: null, windowID: null })
  if (!result.ok) throw new Error(result.error.message)
  const { image, ...metadata } = result.capture
  expect(ComputerCaptureMetadata.parse(metadata).keyboardControlAvailable).toBe(true)
  expect(image?.sha256).toBe(metadata.sha256)
  expect(readFileSync(f.daemon.store.blobPath(image!.sha256))).toEqual(readFileSync(metadata.filePath))
  const next = await f.client.computerCapture(f.sessionId, { windowID: 100 })
  expect(next).toMatchObject({ ok: true, capture: { keyboardControlAvailable: false, unchangedFrom: metadata.captureID } })
  const other = createIdFactory()("session")
  f.daemon.store.createSession({ id: other, directory: f.dir, title: "Other" })
  expect(await f.client.computerKey(other, { captureID: metadata.captureID, key: "tab" })).toMatchObject({ ok: false })
  expect(await f.client.computerKey(f.sessionId, { captureID: metadata.captureID, key: "tab" })).toMatchObject({ ok: true, key: { pressed: true, key: "tab" } })
  expect(await f.client.computerKey(f.sessionId, { captureID: metadata.captureID, key: "tab" })).toMatchObject({ ok: false })
  expect(f.os.keys).toEqual([48])
  expect(await f.client.computerCapture(createIdFactory()("session"))).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  expect(commandTimeout({ type: "computer.capture", sessionId: f.sessionId, input: {} }, 15_000)).toBe(65_000)
  expect(commandTimeout({ type: "computer.key", sessionId: f.sessionId, input: { captureID: metadata.captureID, key: "tab" } }, 15_000)).toBe(20_000)
})

test("disabled native computer commands remain unavailable even to a local full-permission client", async () => {
  const f = await fixture(false)
  await f.client.send({ type: "session.permission.set", sessionId: f.sessionId, mode: "full" })
  const reply = await f.client.computerCapture(f.sessionId)
  expect(reply).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  if (!reply.ok) expect(reply.error.message).toContain("MENDCODE_COMPUTER=1")
  expect(f.os.calls).toEqual([])
})

test("native computer opt-in refuses a non-loopback listener before opening resources", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b29-listener-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  await expect(startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "0.0.0.0:12345", computer: { enabled: true }, engine: () => { throw new Error("must not start") } })).rejects.toThrow("loopback-only")
})
