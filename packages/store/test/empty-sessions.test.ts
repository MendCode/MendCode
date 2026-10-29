import { afterEach, describe, expect, test } from "bun:test"
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
function open() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-empty-store-"))
  dirs.push(dir)
  let at = 1_000
  const store = openStore({ dir, now: () => (at += 10) })
  stores.push(store)
  return store
}
function chat(store: ReturnType<typeof openStore>, directory = "/project", title = "") {
  const id = ids("session")
  store.createSession({ id, directory, title })
  return id
}

describe("empty sessions", () => {
  test("a fresh chat is empty, with or without the default permission mode recorded after it", () => {
    const store = open()
    const plain = chat(store)
    const moded = chat(store)
    store.sessionSink.append({ type: "session.permission", sessionId: moded, mode: "edits" } as never)
    expect(store.emptySessions.has(plain)).toBe(true)
    expect(store.emptySessions.has(moded)).toBe(true)
    expect(store.emptySessions.list({ directory: "/project" }).map((entry) => entry.sessionId).sort()).toEqual([plain, moded].sort())
    expect(store.emptySessions.list({ directory: "/other" })).toEqual([])
  })

  test("each thing a person can leave in a chat keeps it: title, draft, queue entry, goal, setting, turn, child, archive, pin, explicit mark", () => {
    const store = open()
    const kept: Record<string, SessionId> = {}
    const make = (name: string, setup: (id: SessionId) => void) => {
      const id = chat(store)
      setup(id)
      kept[name] = id
    }
    make("title", (id) => store.renameSession(id, "Fix the build"))
    make("draft", (id) => store.drafts.set(id, "half a thought", []))
    make("queue", (id) => void store.sessionSink.append({ type: "queue.added", sessionId: id, queueId: ids("queue"), text: "later", attachments: [] } as never))
    make("goal", (id) => void store.goals.insert({ goalId: ids("goal"), sessionId: id, objective: "ship it" }))
    make("model", (id) => store.setSessionModel(id, { model: "faux:m" } as never))
    make("agent", (id) => store.setSessionAgent(id, "reviewer"))
    make("turn", (id) => {
      const turnId = ids("turn")
      store.sessionSink.append({ type: "turn.started", sessionId: id, turnId, queueId: ids("queue") } as never)
    })
    make("child", (id) => store.createSession({ id: ids("session"), directory: "/project", title: "", parentId: id }))
    make("archived", (id) => store.setSessionArchived(id, true))
    make("explicit", (id) => store.emptySessions.markExplicit(id))
    make("second permission change", (id) => {
      store.sessionSink.append({ type: "session.permission", sessionId: id, mode: "edits" } as never)
      store.sessionSink.append({ type: "session.permission", sessionId: id, mode: "full" } as never)
    })
    const lonely = chat(store)
    for (const [name, id] of Object.entries(kept)) expect(`${name}:${store.emptySessions.has(id)}`).toBe(`${name}:false`)
    expect(store.emptySessions.list().map((entry) => entry.sessionId)).toEqual([lonely])
  })

  test("the project's default agent is not a setting; another agent is", () => {
    const store = open()
    store.settings.set({ defaultAgent: "reviewer" })
    const onDefault = chat(store)
    store.setSessionAgent(onDefault, "reviewer")
    const other = chat(store)
    store.setSessionAgent(other, "tester")
    expect(store.emptySessions.has(onDefault)).toBe(true)
    expect(store.emptySessions.has(other)).toBe(false)
  })

  test("hideEmpty leaves them out of a listing and keeps the rest, before the limit applies", () => {
    const store = open()
    const empties = Array.from({ length: 5 }, () => chat(store))
    const real = chat(store, "/project", "A real chat")
    const drafted = chat(store)
    store.drafts.set(drafted, "typed", [])
    const shown = store.listSessions({ hideEmpty: true, limit: 2 }).map((entry) => entry.sessionId)
    expect(shown.sort()).toEqual([real, drafted].sort())
    expect(store.listSessions({}).map((entry) => entry.sessionId).sort()).toEqual([...empties, real, drafted].sort())
  })

  test("removing an empty chat leaves nothing of it behind", () => {
    const store = open()
    const gone = chat(store)
    const kept = chat(store, "/project", "Kept")
    expect(store.deleteSession(gone)).toBe(true)
    expect(store.hasSession(gone)).toBe(false)
    expect(store.readAfter(gone, 0)).toEqual([])
    expect(store.hasSession(kept)).toBe(true)
  })
})
