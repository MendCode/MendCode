import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"
import { snippetAround } from "../src/session-search"

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
  const edited = add("alpha plan")
  const deleted = add("gamma secret plan")
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
