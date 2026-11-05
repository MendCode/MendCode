import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: Array<{ close(): void }> = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-sealed-"))
  dirs.push(dir)
  const store = openStore({ dir })
  stores.push(store)
  const session = ids("session")
  store.createSession({ id: session, directory: "/probe", title: "t" })
  return { store, session, dir }
}
type Store = ReturnType<typeof open>["store"]

function turn(store: Store, session: SessionId, text: string, end: "turn.completed" | "turn.failed" = "turn.completed") {
  const queueId = ids("queue"), turnId = ids("turn"), user = ids("item"), agent = ids("item")
  store.sessionSink.append({ type: "queue.added", sessionId: session, queueId, text, attachments: [] })
  store.sessionSink.append({ type: "turn.started", sessionId: session, turnId, queueId })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: user, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: user, status: "ok", text })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: agent, kind: "agent_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: agent, status: "ok", text: `answer to ${text} — ñ 🎨` })
  if (end === "turn.failed") store.sessionSink.append({ type: "turn.failed", sessionId: session, turnId, error: { code: "x", message: "boom" } } as never)
  else store.sessionSink.append({ type: "turn.completed", sessionId: session, turnId })
}

const history = (store: Store, session: SessionId) => ({
  after: store.readAfter(session, 0, 1000),
  exact: store.readExactAfter(session, 0, 1000),
  newest: store.readBefore(session, undefined, 1000),
  pages: [store.readBefore(session, undefined, 3), store.readBefore(session, 9, 4), store.readAfter(session, 4, 5), store.readExactAfter(session, 6, 3)],
})

test("sealed turns read back exactly as their rows did, through every page and range", () => {
  const { store, session } = open()
  turn(store, session, "one")
  turn(store, session, "two", "turn.failed")
  turn(store, session, "three")
  const before = history(store, session)
  expect(store.sealSettledTurns()).toMatchObject({ blocks: 3 })
  expect(history(store, session)).toEqual(before)
})

test("a turn appended after sealing reads after the sealed prefix, and seals on the next pass", () => {
  const { store, session } = open()
  turn(store, session, "one")
  store.sealSettledTurns()
  turn(store, session, "two")
  const mixed = history(store, session)
  expect(mixed.after.map((event) => event.seq)).toEqual(mixed.after.map((_, i) => i + 1))
  expect(store.sealSettledTurns()).toMatchObject({ blocks: 1 })
  expect(history(store, session)).toEqual(mixed)
  expect(store.sealSettledTurns()).toMatchObject({ blocks: 0 })
})

/**
 * A turn with streamed deltas (folded at completion), reasoning whose completion has no text (its deltas are its content and
 * never fold), a tool call and usage, like a real one.
 */
function richTurn(store: Store, session: SessionId, text: string) {
  const queueId = ids("queue"), turnId = ids("turn"), user = ids("item"), agent = ids("item"), tool = ids("item"), thought = ids("item")
  store.sessionSink.append({ type: "queue.added", sessionId: session, queueId, text, attachments: [] })
  store.sessionSink.append({ type: "turn.started", sessionId: session, turnId, queueId })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: user, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: user, status: "ok", text })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: thought, kind: "reasoning" } as never)
  for (const part of ["Reading ", "the css"]) store.sessionSink.append({ type: "item.delta", sessionId: session, itemId: thought, text: part })
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: thought, status: "ok" })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: tool, kind: "tool_call", meta: { tool: "read: a.css" } } as never)
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: tool, status: "ok", text: "1\t:root { --bg: #1a1d23 }" })
  store.sessionSink.append({ type: "usage.recorded", sessionId: session, turnId, provider: "probe", model: "offline", input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  store.sessionSink.append({ type: "item.started", sessionId: session, turnId, itemId: agent, kind: "agent_message" })
  for (const part of ["The ", "answer ", `to ${text}`]) store.sessionSink.append({ type: "item.delta", sessionId: session, itemId: agent, text: part })
  store.sessionSink.append({ type: "item.completed", sessionId: session, itemId: agent, status: "ok", text: `The answer to ${text}` })
  store.sessionSink.append({ type: "turn.completed", sessionId: session, turnId })
  store.sessionSink.append({ type: "foreground.state", sessionId: session, state: "idle" })
  return { user, agent, tool }
}

/** What every reader that once queried `events` directly answers for the session. */
function readers(store: Store, session: SessionId, items: { user: string; agent: string; tool: string }) {
  return {
    history: history(store, session),
    stats: store.sessionStats.get(session, 2_000_000_000_000),
    recallTurns: store.recall.turns(session, Number.MAX_SAFE_INTEGER),
    recallPage: store.recall.page(session, Number.MAX_SAFE_INTEGER, 10),
    recallItem: store.recall.item(session, items.agent as never),
    recallChunks: [...store.recall.chunks(store.recall.item(session, items.agent as never)!)],
    search: store.sessionSearch.search({ text: "answer to two" }),
    searchUser: store.sessionSearch.search({ text: "three" }),
    itemStart: store.itemStart(session, items.tool),
    agentIds: store.agentMessageIds(session, 0),
    usage: store.recentUsage(session, 10),
    message: store.messages.read(session, items.agent as never),
    has: store.messages.has(session, items.user as never),
    sync: store.projectSync.history(["/probe"], {}),
    anchors: store.permissionRecords.authorityAnchors(session),
  }
}

test("every reader answers the same for a sealed session as it did from rows", () => {
  const { store, session, dir } = open()
  richTurn(store, session, "one")
  richTurn(store, session, "two")
  const items = richTurn(store, session, "three")
  store.pruneSettledEvents()
  const before = readers(store, session, items)
  expect(before.search).toHaveLength(1)
  expect(before.recallTurns).toHaveLength(3)
  expect(store.sealSettledTurns()).toMatchObject({ blocks: 3 })
  expect(store.readAfter(session, 0, 1000).length).toBe(before.history.after.length)
  expect(readers(store, session, items)).toEqual(before)
  // The reasoning deltas, which no completion text can stand for, moved into the blocks with their turns.
  const deltas = (events: Array<{ type: string }>) => events.filter((event) => event.type === "item.delta").length
  expect(deltas(before.history.after)).toBe(6)
  expect(deltas(store.readAfter(session, 0, 1000))).toBe(6)
  const raw = new Database(path.join(dir, "mendd.db"), { readonly: true })
  expect(raw.query("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'item.delta'").get(session)).toEqual({ n: 0 })
  raw.close()
})

test("a fork of a sealed session copies its transcript and both read as before", () => {
  const { store, session } = open()
  richTurn(store, session, "one")
  richTurn(store, session, "two")
  store.sealSettledTurns()
  const parent = store.readAfter(session, 0, 1000)
  const turns = store.turns.list(session)
  const child = ids("session")
  store.createSession({ id: child, directory: "/probe", title: "fork", parentId: session } as never)
  store.forkConversation(session, child, { throughTurnId: turns.at(-1)!.turnId, cuts: { native: 0 } })
  expect(store.readAfter(session, 0, 1000)).toEqual(parent)
  expect(store.readAfter(child, 0, 1000).filter((event) => event.type === "item.completed").map((event) => (event as { text?: string }).text))
    .toEqual(parent.filter((event) => event.type === "item.completed").map((event) => (event as { text?: string }).text))
})

test("a running turn is never sealed", () => {
  const { store, session } = open()
  turn(store, session, "one")
  const turnId = ids("turn")
  store.sessionSink.append({ type: "turn.started", sessionId: session, turnId, queueId: ids("queue") })
  const before = history(store, session)
  store.sealSettledTurns()
  expect(history(store, session)).toEqual(before)
  expect(store.readAfter(session, 0, 1000).at(-1)).toMatchObject({ type: "turn.started", turnId })
})

test("sealing hands the freed pages back to the file system in bounded idle steps", () => {
  const { store, session, dir } = open()
  const raw = new Database(path.join(dir, "mendd.db"), { readonly: true })
  const free = () => (raw.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
  // About 8 MB of rows that compress well, so sealing frees far more pages than a fixed handful per step would return.
  for (let i = 0; i < 400; i++) richTurn(store, session, `turn ${i} ${"lorem ipsum ".repeat(1_700)}`)
  store.pruneSettledEvents()
  let steps = 0
  for (let result = store.sealSettledTurns(50); !result.complete; result = store.sealSettledTurns(50)) steps++
  expect(steps).toBeGreaterThan(1)
  expect(free()).toBe(0)
  raw.close()
})
