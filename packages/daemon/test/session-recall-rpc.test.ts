import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "@mendcode/engine-native"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { startDaemon } from "../src"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })

test("client, daemon and native model recall share persisted session notes and history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-recall-rpc-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ids = createIdFactory()
  const steps: ModelEvent[][] = [
    [{ type: "tool_call", call: { callId: ids("item"), name: "session_read", args: { limit: 1 } } }, { type: "finish", reason: "tool_calls" }],
    [{ type: "tool_call", call: { callId: ids("item"), name: "session_notes", args: { action: "write", version: 1, text: "Model revision" } } }, { type: "finish", reason: "tool_calls" }],
    [{ type: "text", delta: "Recalled and saved" }, { type: "finish", reason: "stop" }],
  ]
  const requests: ModelRequest[] = []
  const events: SessionEvent[] = []
  let store!: Store
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), log: () => {},
    engine: ({ store: current, recall }) => {
      store = current
      return createNativeEngine({
        provider: { id: "scripted", model: "local-fake", async *stream(request) { requests.push(request); yield* steps.shift() ?? [] } },
        tools: [], history: memoryHistory(), cwdFor: (id) => store.sessionDirectory(id) ?? dir,
        system: () => "SYS", compactionPrompt: "C", recall, permissionPolicy: () => store.settings.get(),
      })
    },
  })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "recall-test", onEvent: (event) => events.push(event) })
  cleanup.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  expect(await client.readSession(sessionId)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await client.send({ type: "settings.set", patch: { experimental: { session_recall: true } } })).toMatchObject({ ok: true })
  expect(await client.sessionNotes(sessionId)).toMatchObject({ ok: true, notes: { version: 0 } })
  expect(await client.sessionNotes(sessionId, { action: "write", version: 0, text: "Client revision" })).toMatchObject({ ok: true, notes: { version: 1 } })
  expect(await client.sessionNotes(sessionId, { action: "write", version: 0, text: "Stale" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  const turnId = ids("turn")
  const itemId = ids("item")
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
  store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "Decision before compaction" })
  store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  expect(await client.searchSession(sessionId, { query: "compaction" })).toMatchObject({ ok: true, page: { messages: [{ message_id: itemId }] } })
  expect(await client.readSession(sessionId, { message_id: itemId })).toMatchObject({ ok: true, recall: { text: "Decision before compaction" } })
  const other = ids("session")
  store.createSession({ id: other, directory: dir, title: "Sibling" })
  expect(await client.readSession(sessionId, { session_id: other })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  await client.subscribe(sessionId, store.lastSeq(sessionId))
  await client.send({ type: "session.permission.set", sessionId, mode: "full" })
  expect(await client.send({ type: "user.submit", sessionId, text: "Recall and save notes", attachments: [] })).toMatchObject({ ok: true })
  const deadline = Date.now() + 2000
  while (!events.some((event) => event.type === "turn.completed")) {
    if (Date.now() >= deadline) throw new Error("Model recall turn did not finish")
    await Bun.sleep(5)
  }
  expect(requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["session_search", "session_read", "session_notes"]))
  expect(await client.sessionNotes(sessionId)).toMatchObject({ ok: true, notes: { version: 2, text: "Model revision" } })
  expect(await client.sessionNotes(sessionId, { action: "read", version: 1 })).toMatchObject({ ok: true, notes: { version: 1, current_version: 2, text: "Client revision" } })
  expect(events.filter((event) => event.type === "item.completed" && event.status === "ok" && event.text?.includes("Model revision"))).toHaveLength(1)
  await client.send({ type: "settings.set", patch: { experimental: { session_recall: false } } })
  expect(await client.sessionNotes(sessionId)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})
