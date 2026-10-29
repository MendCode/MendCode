import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore, PROMPT_HISTORY_LIMIT, type Store } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-prompt-history-"))
  dirs.push(dir)
  return dir
}
let clock = 1_000
const open = (dir = temp()) => {
  const store = openStore({ dir, now: () => ++clock })
  stores.push(store)
  return { store, dir }
}
const session = (store: Store, directory: string) => {
  const id = ids("session") as SessionId
  store.createSession({ id, directory, title: "" })
  return id
}
const queued = (store: Store, sessionId: SessionId, text: string, extra: Record<string, unknown> = {}) =>
  store.sessionSink.append({ type: "queue.added", sessionId, queueId: ids("queue"), text, attachments: [], ...extra } as never)

test("sent messages, shell lines and expanded commands are listed with their kind, as typed", () => {
  const { store } = open()
  const a = session(store, "/repo")
  queued(store, a, "fix the failing test")
  queued(store, a, "ls -la", { shell: true })
  queued(store, a, "git log", { shell: true, local: true })
  queued(store, a, "Expanded review prompt that the model gets", { displayText: "/review src/app.ts" })
  expect(store.promptEntries("/repo").map(({ kind, text }) => [kind, text])).toEqual([
    ["command", "/review src/app.ts"],
    ["shell", "!git log"],
    ["shell", "ls -la"],
    ["sent", "fix the failing test"],
  ])
})

test("the list is one per project, shared by its sessions, newest first, and survives a restart", () => {
  const { store, dir } = open()
  const a = session(store, "/repo")
  const b = session(store, "/repo")
  const elsewhere = session(store, "/other")
  queued(store, a, "from the first session")
  expect(store.recordPrompt(b, "/panel next", "command")).toBe("command")
  expect(store.recordPrompt(a, "a long draft that was cleared", "draft")).toBe("draft")
  queued(store, elsewhere, "another project")
  store.close()
  stores.pop()
  const reopened = open(dir).store
  expect(reopened.promptEntries("/repo").map(({ kind, text }) => [kind, text])).toEqual([
    ["draft", "a long draft that was cleared"],
    ["command", "/panel next"],
    ["sent", "from the first session"],
  ])
  expect(reopened.promptHistory("/other")).toEqual(["another project"])
})

test("entering a text again moves it to the top instead of repeating it; a draft never demotes a sent text", () => {
  const { store } = open()
  const a = session(store, "/repo")
  queued(store, a, "same text again")
  queued(store, a, "something else entirely")
  queued(store, a, "same text again")
  expect(store.promptHistory("/repo")).toEqual(["same text again", "something else entirely"])
  expect(store.recordPrompt(a, "something else entirely", "draft")).toBe("sent")
  expect(store.promptEntries("/repo").map(({ kind, text }) => [kind, text])).toEqual([["sent", "something else entirely"], ["sent", "same text again"]])
  store.recordPrompt(a, "unsent words I might need", "draft")
  queued(store, a, "unsent words I might need")
  expect(store.promptEntries("/repo").filter((entry) => entry.text === "unsent words I might need")).toEqual([expect.objectContaining({ kind: "sent" })])
  expect(store.recordPrompt(a, "unsent words I might need", "draft")).toBe("sent")
})

test("blank text and lines that are only secret markers are not stored", () => {
  const { store } = open()
  const a = session(store, "/repo")
  expect(store.recordPrompt(a, "   \n ", "draft")).toBeUndefined()
  expect(store.recordPrompt(a, "‹secret:1›", "draft")).toBeUndefined()
  expect(store.recordPrompt(a, "‹secret:1› ‹secret:2›", "command")).toBeUndefined()
  queued(store, a, "‹secret:3›")
  expect(store.promptEntries("/repo")).toEqual([])
  expect(store.recordPrompt(a, "export TOKEN=‹secret:1›", "draft")).toBe("draft")
})

test("an unknown session records nothing", () => {
  const { store } = open()
  expect(store.recordPrompt(ids("session") as SessionId, "a long draft that goes nowhere", "draft")).toBeUndefined()
})

test("a project keeps its newest entries up to the cap, the oldest go first, other projects are untouched", () => {
  const { store } = open()
  const a = session(store, "/repo")
  const other = session(store, "/other")
  store.recordPrompt(other, "other project entry", "command")
  for (let i = 0; i < PROMPT_HISTORY_LIMIT + 5; i++) store.recordPrompt(a, `entry number ${i}`, i % 2 ? "command" : "draft")
  const all = store.promptEntries("/repo", PROMPT_HISTORY_LIMIT + 100)
  expect(all).toHaveLength(PROMPT_HISTORY_LIMIT)
  expect(all[0]!.text).toBe(`entry number ${PROMPT_HISTORY_LIMIT + 4}`)
  expect(all.at(-1)!.text).toBe("entry number 5")
  expect(store.promptHistory("/other")).toEqual(["other project entry"])
})

test("one entry is deleted by id and the project's drafts are cleared, nothing else", () => {
  const { store } = open()
  const a = session(store, "/repo")
  const other = session(store, "/other")
  queued(store, a, "keep this sent one")
  store.recordPrompt(a, "/keep-this-command", "command")
  store.recordPrompt(a, "first discarded draft text", "draft")
  store.recordPrompt(a, "second discarded draft text", "draft")
  store.recordPrompt(other, "a draft in another project", "draft")
  const [newest] = store.promptEntries("/repo")
  expect(store.removePrompt("/other", newest!.id)).toBe(false)
  expect(store.removePrompt("/repo", newest!.id)).toBe(true)
  expect(store.clearPromptDrafts("/repo")).toBe(1)
  expect(store.promptHistory("/repo")).toEqual(["/keep-this-command", "keep this sent one"])
  expect(store.promptHistory("/other")).toEqual(["a draft in another project"])
})

test("a long entry is capped like a sent prompt", () => {
  const { store } = open()
  const a = session(store, "/repo")
  store.recordPrompt(a, "word ".repeat(5_000), "draft")
  const [entry] = store.promptEntries("/repo")
  expect(entry!.text.length).toBeLessThanOrEqual(16_000)
  expect(entry!.text).toMatch(/\n… \[truncated: 25000 chars, first \d+ kept\]$/)
})

test("a database from before entries had a kind opens and lists its rows as sent", () => {
  const dir = temp()
  const first = open(dir)
  const a = session(first.store, "/repo")
  first.store.close()
  stores.pop()
  const raw = new Database(path.join(dir, "mendd.db"))
  raw.run("ALTER TABLE prompt_history DROP COLUMN kind")
  raw.run("INSERT INTO prompt_history(directory, at, text) VALUES ('/repo', 1, 'an old prompt')")
  raw.close()
  const { store } = open(dir)
  expect(store.promptEntries("/repo").map(({ kind, text }) => [kind, text])).toEqual([["sent", "an old prompt"]])
  expect(store.recordPrompt(a, "/panel next", "command")).toBe("command")
})
