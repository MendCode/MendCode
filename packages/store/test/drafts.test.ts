import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-drafts-store-"))
  dirs.push(dir)
  return dir
}
const open = (dir: string, now: () => number) => {
  const store = openStore({ dir, now })
  stores.push(store)
  return store
}
const DAY = 86_400_000

test("drafts and prompt history are still there after the store is reopened", () => {
  const dir = temp()
  const first = open(dir, () => 1_000)
  const session = ids("session") as SessionId
  first.createSession({ id: session, directory: "/repo", title: "" })
  first.drafts.set(session, "half typed")
  first.sessionSink.append({ type: "queue.added", sessionId: session, queueId: ids("queue"), text: "sent before the crash", attachments: [] })
  first.close()
  stores.pop()
  const second = open(dir, () => 2_000)
  expect(second.drafts.get(session)?.text).toBe("half typed")
  expect(second.promptHistory("/repo")).toEqual(["sent before the crash"])
})

test("list is per project, newest first, without the session being typed in, and previews one line", () => {
  let at = 1_000
  const store = open(temp(), () => at)
  const a = ids("session") as SessionId
  const b = ids("session") as SessionId
  const c = ids("session") as SessionId
  const elsewhere = ids("session") as SessionId
  for (const id of [a, b, c]) store.createSession({ id, directory: "/repo", title: id === a ? "first" : "" })
  store.createSession({ id: elsewhere, directory: "/other", title: "" })
  store.drafts.set(a, "old\n\n  thought")
  at = 2_000
  store.drafts.set(b, "newer")
  store.drafts.set(c, "being typed")
  store.drafts.set(elsewhere, "other project")
  const listed = store.drafts.list({ directory: "/repo", excludeSessionId: c })
  expect(listed.map((draft) => draft.sessionId)).toEqual([b, a])
  expect(listed[1]).toMatchObject({ title: "first", chars: 14, attachments: 0, preview: "old thought", updatedAt: 1_000 })
  expect(store.drafts.list().map((draft) => draft.directory).sort()).toEqual(["/other", "/repo", "/repo", "/repo"])
})

test("prune deletes only drafts older than the cutoff", () => {
  let at = 2 * DAY
  const store = open(temp(), () => at)
  const old = ids("session") as SessionId
  const fresh = ids("session") as SessionId
  store.createSession({ id: old, directory: "/repo", title: "" })
  store.createSession({ id: fresh, directory: "/repo", title: "" })
  store.drafts.set(old, "stale")
  at = 20 * DAY
  store.drafts.set(fresh, "recent")
  expect(store.drafts.prune(at - 14 * DAY)).toBe(1)
  expect(store.drafts.get(old)).toBeUndefined()
  expect(store.drafts.get(fresh)?.text).toBe("recent")
})

const png = (label?: string) => ({ sha256: "1".repeat(64), bytes: 10, mime: "image/png", name: "one.png", ...(label ? { label } : {}) })

test("a prompt with nothing in it saves no draft and removes a stored one", () => {
  const store = open(temp(), () => 1_000)
  const session = ids("session") as SessionId
  store.createSession({ id: session, directory: "/repo", title: "" })
  for (const blank of ["", " ", "\n\n", " \t \r\n"]) {
    store.drafts.set(session, blank)
    expect(store.drafts.get(session)).toBeUndefined()
  }
  store.drafts.set(session, "something")
  store.drafts.set(session, "  \n ")
  expect(store.drafts.get(session)).toBeUndefined()
  expect(store.drafts.list({ directory: "/repo" })).toEqual([])
  expect(store.drafts.heads([session]).size).toBe(0)
})

test("a draft of attachments only is a draft: its size is what was typed, not the tokens", () => {
  const store = open(temp(), () => 1_000)
  const session = ids("session") as SessionId
  store.createSession({ id: session, directory: "/repo", title: "" })
  store.drafts.set(session, "[Image #1] ", [png("[Image #1]")])
  expect(store.drafts.list({ directory: "/repo" })[0]).toMatchObject({ chars: 0, attachments: 1, images: 1, preview: "" })
  expect(store.drafts.heads([session]).get(session)).toMatchObject({ chars: 0, attachments: 1, images: 1, preview: "" })
  // Chips above the prompt (no token): no text at all.
  store.drafts.set(session, "", [png()])
  expect(store.drafts.heads([session]).get(session)).toMatchObject({ chars: 0, attachments: 1, images: 1, preview: "" })
  store.drafts.set(session, "look at [Image #1] now", [png("[Image #1]")])
  expect(store.drafts.list({ directory: "/repo" })[0]).toMatchObject({ chars: 12, attachments: 1, preview: "look at now" })
  expect(store.drafts.heads([session]).get(session)).toMatchObject({ chars: 12, preview: "look at now" })
})

test("heads reads the first line with something on it, for many sessions in one query", () => {
  const store = open(temp(), () => 5_000)
  const a = ids("session") as SessionId
  const b = ids("session") as SessionId
  const none = ids("session") as SessionId
  for (const id of [a, b, none]) store.createSession({ id, directory: "/repo", title: "" })
  store.drafts.set(a, "\n\n  first   line here\nsecond line")
  store.drafts.set(b, "x".repeat(300))
  const heads = store.drafts.heads([a, b, none])
  expect(heads.get(a)).toMatchObject({ preview: "first line here", chars: "\n\n  first   line here\nsecond line".length, attachments: 0, updatedAt: 5_000 })
  expect(heads.get(b)?.preview.length).toBe(80)
  expect(heads.get(b)?.chars).toBe(300)
  expect(heads.has(none)).toBe(false)
  expect(store.drafts.heads([]).size).toBe(0)
})

test("a blank draft an earlier version stored is removed when the store opens, so its session is empty again", () => {
  const dir = temp()
  const first = open(dir, () => 1_000)
  const session = ids("session") as SessionId
  first.createSession({ id: session, directory: "/repo", title: "" })
  first.drafts.set(session, "typed")
  first.close()
  stores.pop()
  // The old behaviour: whitespace stored as a draft.
  const raw = new Database(path.join(dir, "mendd.db"))
  raw.query("UPDATE drafts SET text = '  ' WHERE session_id = ?").run(session)
  raw.close()
  const second = open(dir, () => 2_000)
  expect(second.drafts.get(session)).toBeUndefined()
})
