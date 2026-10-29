import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type GlobalEvent, type SessionId, type SessionSummary } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { startDaemon } from "../src"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PROJECT = "/repo"

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-empty-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A daemon over `dir` and any number of terminals attached to it (each with the activity it was pushed). */
async function boot(dir = tempDir()) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  async function terminal(name: string) {
    const heard: SessionId[] = []
    const client = createClient({ socketPath: daemon.socketPath, name, onGlobal: (event: GlobalEvent) => void (event.type === "session.activity" && heard.push(event.sessionId)) })
    await client.connect()
    cleanups.push(() => client.close())
    const send = client.send
    /** What a terminal's "new chat" asks for. */
    const newChat = async (directory = PROJECT) => {
      const reply = await send({ type: "session.create", directory, title: "", reuseEmpty: true })
      if (!reply.ok) throw new Error(reply.error.message)
      const sessionId = reply.result?.sessionId as SessionId
      await client.subscribe(sessionId, 0)
      return { sessionId, reused: reply.result?.reused === true }
    }
    /** What the REST, app-server and CLI `session create` ask for. */
    const apiCreate = async (title = "", directory = PROJECT) => {
      const reply = await send({ type: "session.create", directory, title })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.result?.sessionId as SessionId
    }
    const list = async (options: { hideEmpty?: boolean; archived?: boolean } = {}) => {
      const reply = await send({ type: "session.list", limit: 100, ...options })
      return ((reply.ok ? reply.result?.sessions : []) as SessionSummary[]).map((session) => session.sessionId)
    }
    const type = (sessionId: SessionId, text: string) => send({ type: "user.submit", sessionId, text, attachments: [] })
    return { client, heard, newChat, apiCreate, list, type, send }
  }
  return { daemon, dir, terminal }
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("new chats from a terminal", () => {
  test("every new chat answers with the same empty session, which no list shows and the disk holds once", async () => {
    const { terminal, daemon, dir } = await boot()
    const a = await terminal("a")
    const first = await a.newChat()
    expect(first.reused).toBe(false)
    for (let i = 0; i < 5; i++) expect(await a.newChat()).toEqual({ sessionId: first.sessionId, reused: true })
    // People's lists never show it; the API's unfiltered listing still does, so nothing is hidden from a script.
    expect(await a.list({ hideEmpty: true })).toEqual([])
    expect(await a.list()).toEqual([first.sessionId])
    await daemon.stop()
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    expect(store.listSessions({}).map((session) => session.sessionId)).toEqual([first.sessionId])
  })

  test("a second terminal on the same daemon gets the same chat and is told of nothing until something is typed", async () => {
    const { terminal } = await boot()
    const a = await terminal("a")
    const b = await terminal("b")
    const mine = await a.newChat()
    const theirs = await b.newChat()
    expect(theirs).toEqual({ sessionId: mine.sessionId, reused: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(b.heard).not.toContain(mine.sessionId)
    expect(await b.list({ hideEmpty: true })).toEqual([])
    await a.type(mine.sessionId, "hello there")
    await until(() => b.heard.includes(mine.sessionId))
    expect(await b.list({ hideEmpty: true })).toEqual([mine.sessionId])
  })

  test("once something was typed the chat is a session like any other and the next new chat is a new one", async () => {
    const { terminal } = await boot()
    const a = await terminal("a")
    const used = await a.newChat()
    await a.type(used.sessionId, "first question")
    const next = await a.newChat()
    expect(next.sessionId).not.toBe(used.sessionId)
    expect(next.reused).toBe(false)
    expect(await a.newChat()).toEqual({ sessionId: next.sessionId, reused: true })
    expect(await a.list({ hideEmpty: true })).toEqual([used.sessionId])
    expect(new Set(await a.list())).toEqual(new Set([used.sessionId, next.sessionId]))
  })

  test("a draft, a title or a setting keeps the chat out of reuse and in the lists", async () => {
    const { terminal } = await boot()
    const a = await terminal("a")
    const drafted = await a.newChat()
    await a.send({ type: "draft.set", sessionId: drafted.sessionId, text: "half a thought", attachments: [] })
    expect(await a.list({ hideEmpty: true })).toEqual([drafted.sessionId])
    const next = await a.newChat()
    expect(next.sessionId).not.toBe(drafted.sessionId)
    await a.send({ type: "session.rename", sessionId: next.sessionId, title: "Named" })
    const third = await a.newChat()
    expect(third.sessionId).not.toBe(next.sessionId)
    expect(new Set(await a.list({ hideEmpty: true }))).toEqual(new Set([drafted.sessionId, next.sessionId]))
  })

  test("another project has its own empty chat", async () => {
    const { terminal } = await boot()
    const a = await terminal("a")
    const here = await a.newChat("/repo")
    const there = await a.newChat("/other")
    expect(there.sessionId).not.toBe(here.sessionId)
    expect((await a.newChat("/repo")).sessionId).toBe(here.sessionId)
  })
})

describe("sessions created through the API stay explicit", () => {
  test("each create is a new session, listed with or without hideEmpty, and kept across a restart", async () => {
    const first = await boot()
    const a = await first.terminal("api")
    const one = await a.apiCreate()
    const two = await a.apiCreate()
    expect(one).not.toBe(two)
    expect(new Set(await a.list({ hideEmpty: true }))).toEqual(new Set([one, two]))
    // A terminal's new chat never takes an API session.
    const chat = await a.newChat()
    expect([one, two]).not.toContain(chat.sessionId)
    await first.daemon.stop()
    const again = await boot(first.dir)
    const b = await again.terminal("api2")
    expect(new Set(await b.list())).toEqual(new Set([one, two]))
  })
})

describe("empty sessions left on disk", () => {
  test("starting the daemon removes the empty ones and keeps a draft, a title, a queue entry, a goal, a setting and a turn", async () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const make = (setup?: (id: SessionId) => void, directory = PROJECT) => {
      const id = ids("session")
      store.createSession({ id, directory, title: "" })
      setup?.(id)
      return id
    }
    const empties = [make(), make(), make(undefined, "/other"), make()]
    const drafted = make((id) => store.drafts.set(id, "unsent", []))
    const titled = make((id) => store.renameSession(id, "Real work"))
    const queued = make((id) => void store.sessionSink.append({ type: "queue.added", sessionId: id, queueId: ids("queue"), text: "later", attachments: [] } as never))
    const goal = make((id) => void store.goals.insert({ goalId: ids("goal"), sessionId: id, objective: "ship it" }))
    const modeled = make((id) => store.setSessionModel(id, { model: "faux:m" } as never))
    const turned = make((id) => void store.sessionSink.append({ type: "turn.started", sessionId: id, turnId: ids("turn"), queueId: ids("queue") } as never))
    store.close()
    const { terminal } = await boot(dir)
    const a = await terminal("a")
    const left = new Set(await a.list())
    for (const id of empties) expect(left.has(id)).toBe(false)
    expect(left).toEqual(new Set([drafted, titled, queued, goal, modeled, turned]))
  })

  test("the empty chat of a stopped run goes with the restart, and the first new chat after it makes the only blank session", async () => {
    const dir = tempDir()
    const first = await boot(dir)
    const a = await first.terminal("a")
    const before = await a.newChat()
    await first.daemon.stop()
    const second = await boot(dir)
    const b = await second.terminal("b")
    expect(await b.list()).toEqual([])
    const chat = await b.newChat()
    expect(chat.sessionId).not.toBe(before.sessionId)
    expect(chat.reused).toBe(false)
    expect(await b.list()).toEqual([chat.sessionId])
  })
})
