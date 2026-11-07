import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"
import { FIND_BUDGET_MS, FIND_LIMIT, FIND_SCAN, snippetAround } from "../src/session-search"

const ids = createIdFactory()
const dirs: string[] = []
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const open = (dir = mkdtempSync(path.join(tmpdir(), "mend-search-store-"))) => {
  if (!dirs.includes(dir)) dirs.push(dir)
  const store = openStore({ dir, now: () => 1_000 })
  stores.push(store)
  return { store, dir }
}

test("the metadata keeps a color beside the tags, persists it and is removed with its last field", () => {
  const { store, dir } = open()
  const id = ids("session")
  store.createSession({ id, title: "marked", directory: "/p" })
  store.agentCommands.patchMetadata(id, { tags: ["b", "a"], color: "purple" })
  expect(store.agentCommands.getMetadata(id)).toMatchObject({ tags: ["b", "a"], color: "purple" })
  store.agentCommands.patchMetadata(id, { color: "green" })
  store.close()
  stores.pop()
  const again = open(dir).store
  expect(again.agentCommands.getMetadata(id)).toMatchObject({ tags: ["b", "a"], color: "green" })
  again.agentCommands.patchMetadata(id, { color: null })
  expect(again.agentCommands.getMetadata(id)).not.toHaveProperty("color")
  again.agentCommands.patchMetadata(id, { tags: [] })
  expect(again.agentCommands.getMetadata(id)).toBeUndefined()
  again.agentCommands.patchMetadata(id, { color: "red" })
  expect(again.agentCommands.getMetadata(id)).toMatchObject({ tags: [], color: "red" })
})

test("search reads user and assistant messages, newest first within a bounded window, and never tool output", () => {
  const { store } = open()
  const id = ids("session")
  store.createSession({ id, title: "chat", directory: "/p" })
  const turn = ids("turn")
  const add = (kind: string, text: string) => {
    const itemId = ids("item")
    store.sessionSink.append({ sessionId: id, type: "item.started", turnId: turn, itemId, kind } as never)
    store.sessionSink.append({ sessionId: id, type: "item.completed", itemId, status: "ok", text } as never)
  }
  add("user_message", "How do I rotate the API keys?")
  add("tool_call", "grep output mentions rotate-secret-token")
  add("agent_message", "Use the rotate command, then restart.")
  const hit = (text: string, extra: Record<string, unknown> = {}) => store.sessionSearch.search({ text, ...extra })
  expect(hit("rotate")).toEqual([{ sessionId: id, snippet: "Use the rotate command, then restart." }])
  expect(hit("API KEYS")).toEqual([{ sessionId: id, snippet: "How do I rotate the API keys?" }])
  expect(hit("rotate-secret-token")).toEqual([])
  expect(hit("rota(te|ting) the", { regex: true })).toHaveLength(1)
  expect(hit("rotate", { sessionIds: [ids("session")] })).toEqual([])
  expect(hit("rotate", { directory: "/elsewhere" })).toEqual([])
  expect(hit("rotate", { directory: "/p" })).toHaveLength(1)
  expect(hit("a.b")).toEqual([])
  expect(() => hit("(", { regex: true })).toThrow("invalid regular expression")
  store.setSessionArchived(id, true)
  expect(hit("rotate")).toEqual([])
  expect(hit("rotate", { sessionIds: [id] })).toHaveLength(1)
})

test("search reads a message as it reads now: its edited text, and nothing of a deleted one", () => {
  const { store } = open()
  const id = ids("session")
  store.createSession({ id, title: "chat", directory: "/p" })
  const turnId = ids("turn")
  const add = (text: string) => {
    const itemId = ids("item")
    store.sessionSink.append({ sessionId: id, type: "item.started", turnId, itemId, kind: "user_message" } as never)
    store.sessionSink.append({ sessionId: id, type: "item.completed", itemId, status: "ok", text } as never)
    return itemId
  }
  const edited = add("alpha plan ".repeat(300))
  const deleted = add("gamma secret plan ".repeat(300))
  expect(store.sessionSearch.search({ text: "alpha" })).toHaveLength(1)
  expect(store.sessionSearch.search({ text: "gamma" })).toHaveLength(1)
  store.reviseMessage({ type: "message.revised", sessionId: id, itemId: edited, turnId, revision: 1, deleted: false, snapshot: { status: "ok", text: "beta plan" } } as never)
  store.reviseMessage({ type: "message.revised", sessionId: id, itemId: deleted, turnId, revision: 1, deleted: true, snapshot: { status: "ok", text: "gamma secret plan" } } as never)
  const hit = (text: string) => store.sessionSearch.search({ text })
  expect(hit("alpha")).toEqual([])
  expect(hit("beta")).toEqual([{ sessionId: id, snippet: "beta plan" }])
  expect(hit("gamma")).toEqual([])
})

test("a snippet is one line around the match with ellipses where it was cut", () => {
  const long = `${"word ".repeat(60)}NEEDLE${" tail".repeat(60)}`
  const snippet = snippetAround(long, long.indexOf("NEEDLE"), 6)
  expect(snippet).toContain("NEEDLE")
  expect(snippet.startsWith("…")).toBe(true)
  expect(snippet.endsWith("…")).toBe(true)
  expect(snippet.length).toBeLessThanOrEqual(124)
  expect(snippetAround("short\ntext", 0, 5)).toBe("short text")
})

describe("project search (find)", () => {
  /** A session in `directory` holding one user message. */
  function seed(store: ReturnType<typeof openStore>, input: { directory: string; title: string; text: string; parentId?: string }) {
    const id = ids("session")
    store.createSession({ id, title: input.title, directory: input.directory, ...(input.parentId ? { parentId: input.parentId as never } : {}) })
    const itemId = ids("item")
    store.sessionSink.append({ sessionId: id, type: "item.started", turnId: ids("turn"), itemId, kind: "user_message" } as never)
    store.sessionSink.append({ sessionId: id, type: "item.completed", itemId, status: "ok", text: input.text } as never)
    return id
  }

  test("finds a phrase in the messages or title of the folder's other sessions, children and archived ones too, never another folder's", () => {
    const { store } = open()
    const current = seed(store, { directory: "/p", title: "now", text: "where did we migrate the billing tables?" })
    const done = seed(store, { directory: "/p", title: "db work", text: "We migrated the billing tables to v2 today." })
    const child = seed(store, { directory: "/p", title: "sub", text: "the billing tables migration needs a lock", parentId: done })
    const titled = seed(store, { directory: "/p", title: "Billing tables cleanup", text: "nothing here" })
    store.setSessionArchived(titled, true)
    seed(store, { directory: "/other", title: "x", text: "billing tables in another project" })
    seed(store, { directory: "/p/inner", title: "y", text: "billing tables in a folder inside" })
    const page = store.sessionSearch.find({ text: "BILLING TABLES", directory: "/p", exclude: current })
    expect(page.hits.map((hit) => hit.sessionId).sort()).toEqual([done, child, titled].sort())
    expect(page.next).toBeUndefined()
    expect(page.hits.find((hit) => hit.sessionId === titled)?.snippet).toBe("Billing tables cleanup")
    expect(page.hits.find((hit) => hit.sessionId === done)).toMatchObject({ title: "db work", snippet: "We migrated the billing tables to v2 today." })
    expect(store.sessionSearch.find({ text: "billing tables", directory: "/p" }).hits.map((hit) => hit.sessionId)).toContain(current)
    expect(store.sessionSearch.find({ text: "a.b", directory: "/p" }).hits).toEqual([])
  })

  test("a page holds at most ten hits, reads at most FIND_SCAN sessions and its cursor continues where it stopped", () => {
    const { store } = open()
    for (let i = 0; i < 25; i++) seed(store, { directory: "/p", title: `s${i}`, text: `needle ${i}` })
    const first = store.sessionSearch.find({ text: "needle", directory: "/p" })
    expect(first.hits).toHaveLength(FIND_LIMIT)
    expect(first.next).toBe(FIND_LIMIT)
    expect(store.sessionSearch.find({ text: "needle", directory: "/p", limit: 500 }).hits).toHaveLength(FIND_LIMIT)
    const seen = new Set(first.hits.map((hit) => hit.sessionId))
    let next = first.next
    while (next !== undefined) {
      const page = store.sessionSearch.find({ text: "needle", directory: "/p", offset: next })
      for (const hit of page.hits) seen.add(hit.sessionId)
      next = page.next
    }
    expect(seen.size).toBe(25)
    for (let i = 0; i < FIND_SCAN + 5; i++) seed(store, { directory: "/q", title: `q${i}`, text: "nothing" })
    expect(store.sessionSearch.find({ text: "needle", directory: "/q" })).toEqual({ hits: [], next: FIND_SCAN })
    expect(store.sessionSearch.find({ text: "needle", directory: "/q", offset: FIND_SCAN })).toEqual({ hits: [] })
  })

  test("the time budget ends a page early and leaves a cursor to the next session", () => {
    const { store } = open()
    for (let i = 0; i < 5; i++) seed(store, { directory: "/p", title: `s${i}`, text: "nothing" })
    let tick = 0
    const page = store.sessionSearch.find({ text: "needle", directory: "/p", clock: () => (tick++ === 0 ? 0 : FIND_BUDGET_MS + 1) })
    expect(page).toEqual({ hits: [], next: 1 })
  })

  test("a page over a folder of many sessions reads only its bounded share of them", () => {
    const { store } = open()
    for (let i = 0; i < FIND_SCAN * 3; i++) {
      const id = ids("session")
      store.createSession({ id, title: `session ${i}`, directory: "/work/project" })
      const turnId = ids("turn")
      for (let m = 0; m < 12; m++) {
        const itemId = ids("item")
        store.sessionSink.append({ sessionId: id, type: "item.started", turnId, itemId, kind: m % 2 ? "agent_message" : "user_message" } as never)
        store.sessionSink.append({ sessionId: id, type: "item.completed", itemId, status: "ok", text: `message ${m} of session ${i} about the store and its events `.repeat(20) } as never)
      }
    }
    const started = performance.now()
    const page = store.sessionSearch.find({ text: "a phrase nobody wrote", directory: "/work/project" })
    const elapsed = performance.now() - started
    expect(page).toEqual({ hits: [], next: FIND_SCAN })
    // Bounded by FIND_SCAN sessions and FIND_BUDGET_MS whatever the folder holds; generous for a slow machine.
    expect(elapsed).toBeLessThan(FIND_BUDGET_MS * 4)
    if (process.env.MEND_FIND_REPORT) console.log(`find: ${FIND_SCAN} of ${FIND_SCAN * 3} sessions scanned in ${elapsed.toFixed(1)} ms`)
  })
})
