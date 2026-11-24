import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { GlobalEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** One daemon, two terminals: `a` makes the changes, `b` only listens to the global stream, as a second window does. */
async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-sidebar-sync-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, "repo")
  const other = path.join(dir, "other")
  mkdirSync(repo)
  mkdirSync(other)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const heard: { b: GlobalEvent[] } = { b: [] }
  const connect = async (name: "a" | "b") => {
    const client = createClient({ socketPath: daemon.socketPath, name: `sidebar-sync-${name}`, onGlobal: (e) => void (name === "b" && heard.b.push(e)) })
    await client.connect()
    cleanups.push(() => client.close())
    return client
  }
  const a = await connect("a")
  await connect("b")
  const create = async (title: string, options: { reuseEmpty?: boolean } = {}) => {
    const created = await a.send({ type: "session.create", directory: repo, title, ...options })
    return (created.ok ? created.result?.sessionId : undefined) as SessionId
  }
  /** What `b` hears about one session once `a` made a change, up to the push that says it (`wanted` is a subset of that push). */
  const heardAfter = async (sessionId: SessionId, change: () => Promise<unknown>, wanted: Record<string, unknown>) => {
    heard.b.length = 0
    await change()
    const about = () => heard.b.filter((event) => "sessionId" in event && event.sessionId === sessionId)
    await until(() => about().some((event) => Object.entries(wanted).every(([key, value]) => { try { expect((event as Record<string, unknown>)[key]).toEqual(value); return true } catch { return false } })))
    return about()
  }
  return { a, heard, create, heardAfter, repo, other }
}

describe("a second terminal's session list follows the first's changes", () => {
  test("a new chat with a title is announced", async () => {
    const h = await boot()
    h.heard.b.length = 0
    const id = await h.create("fresh")
    await until(() => h.heard.b.some((e) => e.type === "session.activity" && e.sessionId === id))
    expect(h.heard.b.find((e) => e.type === "session.activity" && e.sessionId === id)).toMatchObject({ title: "fresh", directory: expect.stringContaining("repo") })
  })

  test("rename, archive and restore reach it", async () => {
    const h = await boot()
    const id = await h.create("one")
    await h.heardAfter(id, () => h.a.send({ type: "session.rename", sessionId: id, title: "renamed" }), { type: "session.activity", title: "renamed" })
    await h.heardAfter(id, () => h.a.send({ type: "session.archive", sessionId: id }), { type: "session.activity", archivedAt: expect.any(Number) })
    await h.heardAfter(id, () => h.a.send({ type: "session.archive", sessionId: id, restore: true }), { type: "session.activity", archivedAt: null })
  })

  test("pin reaches it with the session's lifecycle", async () => {
    const h = await boot()
    await h.a.send({ type: "settings.set", patch: { tier: "balanced" } })
    const id = await h.create("one")
    await h.heardAfter(id, () => h.a.send({ type: "session.meta", sessionId: id, input: { action: "pin", pinned: true } }), { type: "session.activity", lifecycle: expect.objectContaining({ pinnedAt: expect.any(Number) }) })
  })

  test("moving a session to another folder reaches it", async () => {
    const h = await boot()
    const id = await h.create("one")
    await h.heardAfter(id, () => h.a.send({ type: "session.cd", sessionId: id, path: h.other }), { type: "session.activity", directory: expect.stringContaining("other") })
  })

  test("a deleted session is announced, so the row goes", async () => {
    const h = await boot()
    const id = await h.create("one")
    const pushed = await h.heardAfter(id, () => h.a.send({ type: "session.delete", sessionId: id }), { type: "session.removed" })
    expect(pushed.at(-1)).toMatchObject({ type: "session.removed", sessionId: id })
  })

  test("a blank chat no terminal heard of is deleted without a word", async () => {
    const h = await boot()
    const id = await h.create("", { reuseEmpty: true })
    h.heard.b.length = 0
    await h.a.send({ type: "session.delete", sessionId: id })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.heard.b.filter((e) => e.type === "session.removed")).toEqual([])
  })
})
