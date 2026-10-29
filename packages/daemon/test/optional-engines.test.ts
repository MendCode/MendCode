import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
test("withdrawn adapters cannot register, enable or select models locally or remotely", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-optional-engine-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const token = remoteTokens(dir).create({ name: "fixture" }).token
  let creates = 0
  const retiredHostOptions = { optionalEngines: Object.fromEntries(["opencode", "cursor"].map((name) => [name, {
    models: ["configured"],
    create: async () => {
      creates++
      throw new Error("must not load")
    },
  }])) }
  const daemon = await startDaemon({ dir, defaultDirectory: dir, socketPath: path.join(dir, "d.sock"), info: { engine: "native" }, extensionsEnabled: false, shellHooksEnabled: false, http: { enabled: true }, httpListen: false,
    models: { selectable: true, defaults: { model: "native" }, list: () => [{ id: "native", name: "Native", efforts: [] }] },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
    ...retiredHostOptions,
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "test" })
  await client.connect()
  cleanups.push(() => client.close())
  await client.send({ type: "settings.set", patch: { tier: "full" } })
  const reply = await client.send({ type: "session.create", directory: dir, choice: { model: "native" } })
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error(reply.error.message)
  const sessionId = reply.result!.sessionId as SessionId
  expect(creates).toBe(0)
  const ids = createIdFactory()
  for (const name of ["opencode", "cursor"]) {
    expect((await client.send({ type: "settings.set", patch: { features: { [name]: true } } })).ok).toBe(false)
    const choice = { model: `${name}:configured` }
    expect((await client.send({ type: "session.create", directory: dir, choice })).ok).toBe(false)
    expect((await client.send({ type: "session.model.set", sessionId, choice })).ok).toBe(false)
    expect((await client.send({ type: "user.submit", sessionId, text: "work", attachments: [], selection: { model: choice } })).ok).toBe(false)
    const remote = await daemon.httpAdapter!.fetch(new Request("http://127.0.0.1/command", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: ids("command"), clientId: ids("client"), type: "session.create", directory: dir, choice }) }))
    expect(await remote!.json()).toMatchObject({ error: { code: "forbidden" } })
  }
  const listed = await client.send({ type: "models.list" })
  expect(listed.ok).toBe(true)
  if (!listed.ok) throw new Error(listed.error.message)
  // A native model whose window nobody states compacts at the 160k default, and the list says so.
  expect(listed.result!.models).toEqual([{ id: "native", name: "Native", efforts: [], compactAtTokens: 160_000 }])
  expect(daemon.store.turns.list(sessionId)).toEqual([])
  expect(creates).toBe(0)
})

test("saved adapter choices fail closed for turns and compaction; catalogued OpenCode Zen still runs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-retired-engine-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let runs = 0, compactions = 0
  const daemon = await startDaemon({ dir, defaultDirectory: dir, socketPath: path.join(dir, "d.sock"), info: { engine: "native" }, extensionsEnabled: false, shellHooksEnabled: false,
    models: { selectable: true, defaults: { model: "native" }, list: () => [{ id: "native", name: "Native", efforts: [] }, { id: "opencode:zen-fixture", name: "Zen fixture", efforts: [] }] },
    engine: ({ clock }) => {
      const base = createFauxEngine({ clock, deltaMs: 1 })
      return {
        ...base,
        runTurn: async (turn) => {
          runs++
          return base.runTurn(turn)
        },
        compact: async (turn) => {
          compactions++
          return base.compact(turn)
        },
      }
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "test" })
  await client.connect()
  cleanups.push(() => client.close())
  for (const name of ["opencode", "cursor"]) {
    const before = runs
    const reply = await client.send({ type: "session.create", directory: dir })
    if (!reply.ok) throw new Error(reply.error.message)
    const sessionId = reply.result!.sessionId as SessionId
    // A session restored from the removed host adapter has a model absent from the current catalog.
    daemon.store.setSessionModel(sessionId, { model: `${name}:configured` })
    await client.send({ type: "user.submit", sessionId, text: "work", attachments: [] })
    await until(() => daemon.store.turns.list(sessionId).at(-1)?.status === "failed")
    expect(runs).toBe(before)
    const turns = daemon.store.turns.list(sessionId).length
    await client.send({ type: "session.compact", sessionId })
    await until(() => daemon.store.turns.list(sessionId).length > turns && daemon.store.turns.list(sessionId).at(-1)?.status === "failed")
    expect(compactions).toBe(0)
    expect(daemon.store.readAfter(sessionId, 0, 100).some((event) => event.type === "turn.failed" && event.error.code === "engine_unavailable")).toBe(true)
    await client.send({ type: "session.model.set", sessionId, choice: { model: "opencode:zen-fixture" } })
    await client.send({ type: "user.submit", sessionId, text: "explicit switch", attachments: [] })
    await until(() => daemon.store.turns.list(sessionId).at(-1)?.status === "completed")
    expect(runs).toBe(before + 1)
  }
})
