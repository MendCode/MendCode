import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { openStore } from "@mendcode/store"
import { SessionNotesReport, SessionRecallMessage, SessionRecallPage } from "@mendcode/protocol"
import { createSessionRecall, localTime } from "../src/session-recall"
import { recallFixture } from "./session-recall-fixture"

const cleanup: Array<() => void> = []
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run() })
function fixture() {
  const value = recallFixture()
  cleanup.push(() => rmSync(value.dir, { recursive: true, force: true }), () => value.store.close())
  return value
}

test("recall is opt-in and disabling it revokes existing ports", () => {
  const history = fixture()
  expect(history.store.settings.get().experimental?.session_recall).toBeUndefined()
  expect(() => history.port.read({})).toThrow("disabled")
  expect(() => history.port.notes({ action: "write", version: 0, text: "Private" })).toThrow("disabled")
  history.enabled()
  expect(history.port.read({})).toMatchObject({ messages: [], more: false })
  history.enabled(false)
  expect(() => history.port.search({ query: "Private" })).toThrow("disabled")
})

test("only current and linked descendants in the same project are accessible", () => {
  const history = fixture()
  history.enabled()
  const child = history.session(history.sessionId)
  const grandchild = history.session(child)
  const sibling = history.session()
  const outside = history.session(history.sessionId, `${history.dir}/other`)
  const returned = history.session(outside)
  history.message("Child result", { sessionId: grandchild })
  expect(history.port.read({ session_id: grandchild })).toMatchObject({ messages: [{ text: "Child result" }] })
  for (const session_id of [sibling, outside, returned, history.ids("session")]) expect(() => history.port.read({ session_id })).toThrow("outside")
  expect(() => history.recall.port(child).read({ session_id: history.sessionId })).toThrow("outside")
  const cycle = history.ids("session")
  history.store.createSession({ id: cycle, parentId: cycle, directory: history.dir, title: "Cycle" })
  expect(() => history.port.read({ session_id: cycle })).toThrow("outside")
  expect(() => history.recall.port(history.ids("session")).read({})).toThrow("Unknown session")
})

test("scanned pages are bounded, chronological and preserve empty search cursors", () => {
  const history = fixture()
  history.enabled()
  const items = Array.from({ length: 13 }, (_, index) => history.message(index === 0 ? "Needle" : `Message ${index}`).itemId)
  const newest = SessionRecallPage.parse(history.port.read({ limit: 500 }))
  expect(newest.messages.map((message) => message.message_id)).toEqual(items.slice(3))
  expect(newest.next_cursor).toBe(items[3])
  // Every message says when it was sent, as local time with its offset, so a model can answer "when did I ask that?".
  for (const message of newest.messages) expect(message.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  const empty = history.port.search({ query: "needle", limit: 10 })
  expect(empty.messages).toEqual([])
  expect(empty.more).toBe(true)
  const older = history.port.search({ query: "NEEDLE", before: empty.next_cursor })
  expect(older.messages).toMatchObject([{ message_id: items[0], text: "Needle" }])
  expect(older.more).toBe(false)
  expect(SessionRecallPage.parse(history.port.read({ limit: -1 })).messages).toHaveLength(1)
  expect(SessionRecallPage.parse(history.port.read({ limit: 2.9 })).messages).toHaveLength(2)
  const foreign = history.message("Foreign", { sessionId: history.session() }).itemId
  expect(() => history.port.read({ before: foreign })).toThrow("cursor")
  expect(() => history.port.read({ message_id: foreign })).toThrow("Unknown message")
})

test("search spans deltas, previews and single-message reads stay bounded", () => {
  const history = fixture()
  history.enabled()
  const prefix = "a".repeat(2200)
  const body = prefix + "MATCH" + "z".repeat(32_000)
  const { itemId } = history.message(body, { final: false, deltas: [prefix + "MA", "TCH" + "z".repeat(32_000)] })
  const page = history.port.search({ query: "match" })
  expect(page.messages[0]).toMatchObject({ text: "a".repeat(200) + "MATCH" + "z".repeat(1795), truncated: true })
  const first = SessionRecallMessage.parse(history.port.read({ message_id: itemId, offset: -1 }))
  expect(first.text).toBe(body.slice(0, 16_000))
  expect(first.next_offset).toBe(16_000)
  const second = SessionRecallMessage.parse(history.port.read({ message_id: itemId, offset: first.next_offset }))
  const last = SessionRecallMessage.parse(history.port.read({ message_id: itemId, offset: second.next_offset }))
  expect(first.text + second.text + last.text).toBe(body)
  expect(last.next_offset).toBeUndefined()
  expect(SessionRecallMessage.parse(history.port.read({ message_id: itemId, offset: 100_000 })).text).toBe("")
  const final = history.message("Authoritative", { deltas: ["Progress"] }).itemId
  expect(SessionRecallMessage.parse(history.port.read({ message_id: final })).text).toBe("Authoritative")
})

test("reasoning, failed tools, notices and reverted turns are not recalled", () => {
  const history = fixture()
  history.enabled()
  history.message("Private reasoning", { kind: "reasoning" })
  history.message("Failed output", { kind: "tool_call", status: "error" })
  history.message("Notice", { kind: "user_message", notice: true })
  const reverted = history.message("Undone")
  history.store.sessionSink.append({ type: "turn.reverted", sessionId: history.sessionId, turnId: reverted.turnId })
  history.message("Visible tool", { kind: "tool_call" })
  const page = SessionRecallPage.parse(history.port.read({}))
  expect(page.messages.map((message) => message.text)).toEqual(["read: Visible tool"])
  expect(() => history.port.read({ message_id: reverted.itemId })).toThrow("Unknown message")
  history.store.sessionSink.append({ type: "turn.restored", sessionId: history.sessionId, turnId: reverted.turnId })
  expect(SessionRecallPage.parse(history.port.read({})).messages).toHaveLength(2)
})

test("historical events survive model compaction and mask recognizable credentials", () => {
  const history = fixture()
  history.enabled()
  const { itemId } = history.message(`Decision before compaction: sk-${"a".repeat(48)}`)
  history.store.engineMessages.replace(history.sessionId, "native", [{ role: "user", content: "Summary only" }])
  const text = SessionRecallMessage.parse(history.port.read({ message_id: itemId })).text
  expect(text).toContain("Decision before compaction")
  expect(text).not.toContain(`sk-${"a".repeat(48)}`)
})

test("notes have immutable revisions, compare-and-swap writes and session isolation", () => {
  const history = fixture()
  history.enabled()
  expect(history.port.notes({ action: "read" })).toEqual({ version: 0, current_version: 0, text: "" })
  expect(() => history.port.notes({ action: "write", text: "Missing version" })).toThrow("version")
  expect(history.port.notes({ action: "write", version: 0, text: "First" })).toEqual({ version: 1, current_version: 1, text: "First" })
  expect(() => history.port.notes({ action: "write", version: 0, text: "Stale" })).toThrow("current version 1")
  expect(history.port.notes({ action: "write", version: 1, text: "x".repeat(16_000) }).version).toBe(2)
  expect(history.port.notes({ action: "read", version: 1 })).toEqual({ version: 1, current_version: 2, text: "First" })
  expect(history.port.notes({ action: "read", version: 0 }).text).toBe("")
  expect(() => history.port.notes({ action: "read", version: 9 })).toThrow("Unknown note version")
  expect(() => history.port.notes({ action: "write", version: 2, text: "x".repeat(16_001) })).toThrow("16,000")
  expect(() => history.port.notes({ action: "write", version: 2 })).toThrow("16,000")
  expect(SessionNotesReport.parse(history.port.notes({ action: "read" })).version).toBe(2)
  expect(history.recall.port(history.session(history.sessionId)).notes({ action: "read" }).version).toBe(0)
})

test("notes and recall persist on reopen and note revisions cascade on deletion", () => {
  const history = recallFixture()
  cleanup.push(() => rmSync(history.dir, { recursive: true, force: true }))
  history.enabled()
  const { itemId } = history.message("Persisted history")
  history.port.notes({ action: "write", version: 0, text: "Persisted notes" })
  history.store.close()
  const reopened = openStore({ dir: history.dir })
  cleanup.push(() => reopened.close())
  const port = createSessionRecall(reopened).port(history.sessionId)
  expect(port.notes({ action: "read" }).text).toBe("Persisted notes")
  expect(SessionRecallMessage.parse(port.read({ message_id: itemId })).text).toBe("Persisted history")
  reopened.deleteSession(history.sessionId)
  reopened.createSession({ id: history.sessionId, directory: history.dir, title: "Recreated" })
  expect(port.notes({ action: "read" }).version).toBe(0)
})

test("localTime writes the wall clock of the machine's zone with its offset", () => {
  const at = Date.UTC(2026, 9, 28, 22, 25, 3)
  const offset = -new Date(at).getTimezoneOffset()
  const expected = new Date(at + offset * 60_000).toISOString().slice(0, 19)
  expect(localTime(at).slice(0, 19)).toBe(expected)
  expect(new Date(localTime(at)).getTime()).toBe(at)
})
