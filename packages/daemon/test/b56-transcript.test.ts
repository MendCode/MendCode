import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, HistoryReport, MAX_FRAME_BYTES, type BlobRef } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createSessionHistory } from "../src/session-history"
import { createTurnSnapshots } from "../src/turn-snapshots"
import { readSessionHistory } from "../src/session-reader"

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "b56-transcript-"))
  const ids = createIdFactory()
  const store = openStore({ dir })
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close())
  const sessionId = ids("session")
  store.createSession({ id: sessionId, title: "Transcript", directory: dir })
  let busy = false
  const snapshots = createTurnSnapshots({ store })
  const history = createSessionHistory({ store, snapshots, publish: () => {}, now: () => 1234, isBusy: () => busy })
  const turn = (n: number, options: { secret?: string; size?: number; file?: string; attachments?: BlobRef[] } = {}) => {
    const turnId = ids("turn")
    const itemId = ids("item")
    const mark = store.engineMessages.load(sessionId, "native").length
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.turns.setHistory(sessionId, turnId, { native: mark })
    const item = (kind: "user_message" | "agent_message" | "tool_call" | "reasoning", text: string, id = ids("item")) => {
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: id, kind, ...(kind === "tool_call" ? { meta: { tool: "probe" } } : {}) })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: id, status: "ok", text, ...(kind === "tool_call" ? { toolInput: JSON.stringify({ path: "src/a.ts", key: options.secret }) } : {}), ...(kind === "user_message" && options.attachments ? { attachments: options.attachments } : {}) })
    }
    item("user_message", `Prompt ${n}`, itemId)
    item("reasoning", `Thinking ${n} ${options.secret ?? ""}`)
    item("tool_call", `Tool output ${n} ${options.secret ?? ""}`)
    item("agent_message", options.size ? "x".repeat(options.size) : `Answer ${n}`)
    if (options.file) { snapshots.capture({ sessionId, turnId, cwd: dir, tool: "write", args: { path: options.file } }); writeFileSync(options.file, `Turn ${n}`); snapshots.seal(sessionId, turnId) }
    store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "fake", model: "test", input: 10, output: 4, reasoning: 2, cacheRead: 0, cacheWrite: 0 })
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), { role: "user", content: `Prompt ${n}` }, { role: "assistant", content: `Answer ${n}` }])
    return { turnId, itemId }
  }
  return { dir, ids, store, sessionId, history, turn, busy: (value: boolean) => { busy = value } }
}

test("message history keeps redacted image references for restoring a submitted prompt", () => {
  const h = harness()
  const secret = "sk-K9mPx8BvQ3rTc7NdY2fHj6LaW0eSg4Uz"
  h.turn(1, { attachments: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 12, name: `${secret}.png` }] })
  const reply = readSessionHistory(h.store, { sessionId: h.sessionId })
  if (!reply.ok) throw new Error(reply.message)
  const item = HistoryReport.parse(reply.result).turns[0]!.items[0]!
  expect(item.attachmentRefs?.[0]).toMatchObject({ sha256: "a".repeat(64), mime: "image/png", bytes: 12 })
  expect(item.attachments).toEqual(item.attachmentRefs?.map((ref) => ref.name ?? ref.sha256.slice(0, 12)))
  expect(JSON.stringify(reply.result)).not.toContain(secret)
})

test("export defaults preserve old output; switches apply to Markdown and JSON with redaction", () => {
  const h = harness()
  const secret = "sk-K9mPx8BvQ3rTc7NdY2fHj6LaW0eSg4Uz"
  h.turn(1, { secret })
  const defaults = h.history.export({ sessionId: h.sessionId, format: "markdown" })
  expect(defaults.ok).toBe(true)
  if (!defaults.ok) return
  expect(defaults.result.text).toContain("Tool output 1")
  expect(defaults.result.text).not.toContain("Thinking")
  const detailed = h.history.export({ sessionId: h.sessionId, format: "markdown", reasoning: true, toolDetails: true, assistantMetadata: true, timestamps: true })
  if (!detailed.ok) throw new Error(detailed.message)
  expect(detailed.result.text).toContain("_Thinking:_")
  expect(detailed.result.text).toContain("**Input:**")
  expect(detailed.result.text).toContain("test · fake · 16 tokens")
  expect(detailed.result.text).toMatch(/> \d{4}-\d\d-\d\dT/)
  expect(detailed.result.text).not.toContain(secret)
  const minimal = h.history.export({ sessionId: h.sessionId, format: "json", toolDetails: false })
  if (!minimal.ok) throw new Error(minimal.message)
  const tool = JSON.parse(minimal.result.text).turns[0].items.find((item: { kind: string }) => item.kind === "tool_call")
  expect(tool.text).toBe("")
  expect(tool).not.toHaveProperty("input")
  expect(minimal.result.text).not.toContain("Thinking")
})

test("targeted undo rewinds all later turns together, restores files, and redo restores that whole group", () => {
  const h = harness()
  const file = path.join(h.dir, "file.txt")
  writeFileSync(file, "Before")
  h.turn(1)
  const second = h.turn(2, { file })
  const third = h.turn(3, { file })
  const reply = h.history.undo({ sessionId: h.sessionId, atItemId: second.itemId })
  if (!reply.ok) throw new Error(reply.message)
  expect(reply.result.turnIds).toEqual([second.turnId, third.turnId])
  expect(readFileSync(file, "utf8")).toBe("Before")
  expect(h.store.engineMessages.load(h.sessionId, "native")).toHaveLength(2)
  expect(h.history.redo({ sessionId: h.sessionId }).ok).toBe(true)
  expect(readFileSync(file, "utf8")).toBe("Turn 3")
  expect(h.store.engineMessages.load(h.sessionId, "native")).toHaveLength(6)
})

test("busy, invalid targets and file conflicts reject targeted undo without losing history or files", () => {
  const h = harness()
  const file = path.join(h.dir, "file.txt")
  writeFileSync(file, "Before")
  const first = h.turn(1, { file })
  h.turn(2, { file })
  writeFileSync(file, "Hand edit")
  h.busy(true)
  expect(h.history.undo({ sessionId: h.sessionId, atItemId: first.itemId })).toMatchObject({ ok: false, code: "busy" })
  h.busy(false)
  expect(h.history.undo({ sessionId: h.sessionId, atItemId: h.ids("item") })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.history.undo({ sessionId: h.sessionId, atItemId: first.itemId })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(readFileSync(file, "utf8")).toBe("Hand edit")
  expect(h.store.turns.list(h.sessionId).every((turn) => !turn.reverted)).toBe(true)
  expect(h.history.undo({ sessionId: h.sessionId, atItemId: first.itemId, force: true }).ok).toBe(true)
})

test("opt-in reasoning and metadata remain inside a wire frame; undone turns stay excluded", () => {
  const h = harness()
  h.turn(1, { size: 60_000 })
  const second = h.turn(2)
  expect(h.history.undo({ sessionId: h.sessionId, atItemId: second.itemId }).ok).toBe(true)
  for (const format of ["markdown", "json"] as const) {
    const reply = h.history.export({ sessionId: h.sessionId, format, reasoning: true, timestamps: true, assistantMetadata: true })
    if (!reply.ok) throw new Error(reply.message)
    expect(reply.result.text).not.toContain("Prompt 2")
    expect(Buffer.byteLength(JSON.stringify(reply.result))).toBeLessThan(MAX_FRAME_BYTES)
    if (format === "json") expect(JSON.parse(reply.result.text).turns).toHaveLength(1)
  }
})
