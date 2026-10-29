import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, HistoryReport, MAX_FRAME_BYTES } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { readSessionHistory } from "../src/session-reader"

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function history() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-history-reader-"))
  const store = openStore({ dir })
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close())
  const ids = createIdFactory()
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: dir, title: "Reader" })
  const turn = (prompt: string, response = "Answer", tool = "Tool result") => {
    const turnId = ids("turn")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    for (const [kind, text] of [["user_message", prompt], ["agent_message", response], ["tool_call", tool], ["reasoning", "private chain"]] as const) {
      const itemId = ids("item")
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind, ...(kind === "tool_call" ? { meta: { tool: "task", title: "reviewer" } } : {}) })
      store.sessionSink.append({ type: "item.delta", sessionId, itemId, text: "Draft" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    }
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    return turnId
  }
  const read = (query: Omit<Parameters<typeof readSessionHistory>[1], "sessionId"> = {}) => {
    const reply = readSessionHistory(store, { sessionId, ...query })
    if (!reply.ok) throw new Error(reply.message)
    return HistoryReport.parse(reply.result)
  }
  return { store, sessionId, ids, turn, read }
}

test("complete turns paginate in both directions and details survive beyond the prompt preview", () => {
  const h = history()
  const turns = Array.from({ length: 7 }, (_, i) => h.turn(`Prompt ${i}`, `Full answer ${i}`, `Subagent ${i}`))
  const newest = h.read({ limit: 2 })
  expect(newest.turns.map((t) => t.turnId)).toEqual(turns.slice(5))
  expect(newest.newer).toBeUndefined()
  const older = h.read({ before: newest.older, limit: 2 })
  expect(older.turns.map((t) => t.turnId)).toEqual(turns.slice(3, 5))
  expect(h.read({ after: older.newer, limit: 2 }).turns.map((t) => t.turnId)).toEqual(turns.slice(5))
  const detail = h.read({ turnId: turns[0] }).turns[0]!
  expect(detail.items.map((item) => item.text)).toEqual(["Prompt 0", "Full answer 0", "Subagent 0"])
  expect(detail.items[2]).toMatchObject({ tool: "task", title: "reviewer", status: "ok" })
})

test("undone turns and private reasoning are excluded; restored turns return", () => {
  const h = history()
  const first = h.turn("First")
  const undone = h.turn("Undone")
  h.store.sessionSink.append({ type: "turn.reverted", sessionId: h.sessionId, turnId: undone })
  expect(h.read().turns.map((t) => t.turnId)).toEqual([first])
  expect(readSessionHistory(h.store, { sessionId: h.sessionId, turnId: undone })).toMatchObject({ ok: false, code: "target_mismatch" })
  h.store.sessionSink.append({ type: "turn.restored", sessionId: h.sessionId, turnId: undone })
  expect(h.read().turns).toHaveLength(2)
  expect(JSON.stringify(h.read())).not.toContain("private chain")
  expect(readSessionHistory(h.store, { sessionId: h.ids("session") })).toMatchObject({ ok: false, code: "unknown_session" })
})

test("large outputs stay inside a wire frame, expose cut markers, and redact secrets", () => {
  const h = history()
  for (let i = 0; i < 15; i++) h.turn(`Prompt ${i}`, "x".repeat(60_000), "x".repeat(15_000))
  const reply = h.read()
  expect(reply.turns.length).toBeGreaterThan(0)
  expect(reply.turns.length).toBeLessThan(15)
  expect(reply.older).toBeDefined()
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(MAX_FRAME_BYTES - 4_096)
  expect(reply.turns[0]!.items[1]!.truncated).toBe(true)
  expect(reply.turns[0]!.items[2]!.text.length).toBeLessThanOrEqual(6_000)
  const secret = `sk-${"a".repeat(48)}`
  const id = h.turn("Secret", secret)
  expect(JSON.stringify(h.read({ turnId: id }))).not.toContain(secret)
})

test("metadata-heavy turns cannot crowd messages out of the response frame", () => {
  const h = history()
  const turnId = h.ids("turn")
  h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: h.ids("queue") })
  for (let i = 0; i < 220; i++) {
    const itemId = h.ids("item")
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId, kind: i ? "tool_call" : "user_message", meta: { tool: '"'.repeat(200), title: '"'.repeat(500) } })
    h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId, status: "ok", text: i ? "Tool" : "Prompt" })
  }
  h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId })
  const reply = h.read({ turnId })
  expect(reply.turns).toHaveLength(1)
  expect(reply.turns[0]!.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(MAX_FRAME_BYTES - 4_096)
})
