import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import type { DreamRun, MemoryEntry, SessionId } from "@mendcode/protocol"
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

describe("dream in the daemon", () => {
  test("a run reads the project's conversations, stores proposals as pending memories and records the run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    let prompt = ""
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
      dream: {
        complete: async (p) => {
          prompt = p
          await gate
          return JSON.stringify({ proposals: [{ text: "Releases are cut with bun run release", scope: "project", category: "commands", why: "s1" }], notes: "" })
        },
      },
    })
    cleanups.push(() => daemon.stop())
    const runs: DreamRun[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "dream", onGlobal: (e) => void (e.type === "dream.changed" && runs.push(e.run)) })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: "/repo", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "how do we release?", attachments: [] })
    await until(() => daemon.store.readAfter(sessionId, 0).some((e) => e.type === "turn.completed"))
    expect(await client.send({ type: "dream.run", directory: "/repo" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "dream.run", directory: "/repo" })).toMatchObject({ ok: false, error: { code: "busy" } })
    release()
    await until(() => runs.some((r) => r.status === "done"))
    expect(prompt).toContain("user: how do we release?")
    expect(runs.at(-1)).toMatchObject({ status: "done", proposed: 1, directory: "/repo" })
    const listed = await client.send({ type: "memory.list", directory: "/repo", status: "pending" })
    expect((listed.ok ? (listed.result?.memories as MemoryEntry[]) : [])[0]).toMatchObject({ text: "Releases are cut with bun run release", source: "agent", status: "pending" })
    const ledger = await client.send({ type: "dream.list", directory: "/repo" })
    expect(ledger.ok && (ledger.result?.runs as DreamRun[])[0]).toMatchObject({ status: "done", proposed: 1 })
  })

  test("settings.dreamAt schedules one daily run per recently active project; unset means no timer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const start = new Date(2026, 8, 27, 2, 58, 0).getTime()
    const clock = createVirtualClock(start)
    const directories: string[] = []
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      clock,
      engine: ({ clock: c }) => createFauxEngine({ clock: c, deltaMs: 1 }),
      dream: { complete: async (p) => (directories.push(/working in (\S+)\./.exec(p)?.[1] ?? "?"), '{"proposals":[],"notes":""}') },
    })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "sched" })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: "/active", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.send({ type: "user.submit", sessionId, text: "remember the deploy command", attachments: [] })
    for (let i = 0; i < 50 && !daemon.store.readAfter(sessionId, 0).some((e) => e.type === "turn.completed"); i++) {
      clock.advance(10)
      await new Promise((r) => setTimeout(r, 5))
    }
    clock.advance(120_000)
    expect(directories).toEqual([])
    await client.send({ type: "settings.set", patch: { dreamAt: "03:10" } })
    clock.advance(10 * 60_000)
    await until(() => directories.length === 1)
    expect(directories).toEqual(["/active"])
  })

  test("without a model the command is refused, and a project without conversations is skipped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "d" })
    await client.connect()
    cleanups.push(() => client.close())
    expect(await client.send({ type: "dream.run", directory: "/empty" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})

describe("dream revisions in the daemon", () => {
  async function boot(complete: (prompt: string) => string) {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-dream-rev-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const changes: Array<{ memoryId: string; change: string }> = []
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
      dream: { complete: async (p) => complete(p) },
    })
    cleanups.push(() => daemon.stop())
    const runs: DreamRun[] = []
    const client = createClient({
      socketPath: daemon.socketPath,
      name: "rev",
      onGlobal: (e) => {
        if (e.type === "dream.changed") runs.push(e.run)
        if (e.type === "memory.changed") changes.push({ memoryId: e.memoryId, change: e.change })
      },
    })
    await client.connect()
    cleanups.push(() => client.close())
    const add = async (text: string) => {
      const reply = await client.send({ type: "memory.add", scope: "project", directory: "/repo", text, category: "commands" })
      return (reply.ok ? reply.result?.memoryId : "") as string
    }
    const created = await client.send({ type: "session.create", directory: "/repo", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "we moved to pnpm", attachments: [] })
    await until(() => daemon.store.readAfter(sessionId, 0).some((e) => e.type === "turn.completed"))
    const dream = async () => {
      const before = runs.filter((r) => r.status === "done").length
      await client.send({ type: "dream.run", directory: "/repo" })
      await until(() => runs.filter((r) => r.status === "done").length > before)
    }
    const list = async (status: "pending" | "saved" | "archived") => {
      const reply = await client.send({ type: "memory.list", directory: "/repo", status })
      return (reply.ok ? (reply.result?.memories as MemoryEntry[]) : []) ?? []
    }
    return { client, add, dream, list, changes, runs, prompts: () => prompts }
  }
  let prompts: string[] = []

  test("a run stores update and archive proposals as pending rows without touching the saved memories", async () => {
    let npm = ""
    let stale = ""
    prompts = []
    const h = await boot((prompt) => {
      prompts.push(prompt)
      return JSON.stringify({
        proposals: [],
        updates: [{ id: npm, text: "Package manager is pnpm", why: "user switched" }, { id: "memory_unknown", text: "Ghost memory text here" }],
        archives: [{ id: stale, why: "no longer true" }],
        notes: "",
      })
    })
    npm = await h.add("Package manager is npm")
    stale = await h.add("Deploys go through Heroku")
    await h.dream()
    expect(prompts[0]).toContain(`${npm} [project/commands] Package manager is npm`)
    expect(h.runs.at(-1)).toMatchObject({ status: "done", proposed: 2 })
    const pending = await h.list("pending")
    expect(pending).toHaveLength(2)
    expect(pending.find((m) => m.kind === "update")).toMatchObject({ targetId: npm, text: "Package manager is pnpm", reason: "user switched", source: "agent", scope: "project", directory: "/repo", category: "commands" })
    expect(pending.find((m) => m.kind === "archive")).toMatchObject({ targetId: stale, text: "Deploys go through Heroku", reason: "no longer true" })
    const saved = await h.list("saved")
    expect(saved.map((m) => m.text).sort()).toEqual(["Deploys go through Heroku", "Package manager is npm"])
    expect(h.changes.filter((c) => c.change === "added")).toHaveLength(4)
  })

  test("accepting an update rewrites the saved memory and accepting an archive retires it; both emit memory.changed", async () => {
    let npm = ""
    let stale = ""
    const h = await boot(() => JSON.stringify({ updates: [{ id: npm, text: "Package manager is pnpm", why: "w" }], archives: [{ id: stale, why: "w" }] }))
    npm = await h.add("Package manager is npm")
    stale = await h.add("Deploys go through Heroku")
    await h.dream()
    const [update, archive] = [(await h.list("pending")).find((m) => m.kind === "update")!, (await h.list("pending")).find((m) => m.kind === "archive")!]
    h.changes.length = 0
    expect(await h.client.send({ type: "memory.update", memoryId: update.memoryId, status: "saved" })).toMatchObject({ ok: true, result: { revision: "applied", targetId: npm } })
    await until(() => h.changes.length >= 2)
    expect(h.changes).toEqual([{ memoryId: update.memoryId, change: "deleted" }, { memoryId: npm, change: "updated" }])
    expect(await h.client.send({ type: "memory.update", memoryId: archive.memoryId, status: "saved" })).toMatchObject({ ok: true, result: { revision: "applied", targetId: stale } })
    expect(await h.list("pending")).toEqual([])
    expect((await h.list("saved")).map((m) => m.text)).toEqual(["Package manager is pnpm"])
    expect((await h.list("archived")).map((m) => m.text)).toEqual(["Deploys go through Heroku"])
    // Restore from the archive is the ordinary status change.
    expect(await h.client.send({ type: "memory.update", memoryId: stale as never, status: "saved" })).toMatchObject({ ok: true })
    expect((await h.list("saved")).map((m) => m.text).sort()).toEqual(["Deploys go through Heroku", "Package manager is pnpm"])
  })

  test("rejecting a revision drops it and leaves the target; a second run may propose it again", async () => {
    let npm = ""
    const h = await boot(() => JSON.stringify({ updates: [{ id: npm, text: "Package manager is pnpm", why: "w" }] }))
    npm = await h.add("Package manager is npm")
    await h.dream()
    const proposal = (await h.list("pending"))[0]!
    h.changes.length = 0
    expect(await h.client.send({ type: "memory.update", memoryId: proposal.memoryId, status: "archived" })).toMatchObject({ ok: true, result: { revision: "rejected" } })
    await until(() => h.changes.length >= 1)
    expect(h.changes).toEqual([{ memoryId: proposal.memoryId, change: "deleted" }])
    expect(await h.list("pending")).toEqual([])
    expect((await h.list("archived"))).toEqual([])
    expect((await h.list("saved"))[0]).toMatchObject({ text: "Package manager is npm" })
    await h.dream()
    expect(await h.list("pending")).toHaveLength(1)
  })

  test("a pending revision blocks a duplicate from the next run", async () => {
    let npm = ""
    const h = await boot(() => JSON.stringify({ updates: [{ id: npm, text: "Package manager is pnpm", why: "w" }] }))
    npm = await h.add("Package manager is npm")
    await h.dream()
    await h.dream()
    expect(await h.list("pending")).toHaveLength(1)
  })

  test("a proposal whose target changed meanwhile is dropped with an error and nothing is applied", async () => {
    let npm = ""
    const h = await boot(() => JSON.stringify({ updates: [{ id: npm, text: "Package manager is pnpm", why: "w" }] }))
    npm = await h.add("Package manager is npm")
    await h.dream()
    const proposal = (await h.list("pending"))[0]!
    await h.client.send({ type: "memory.update", memoryId: npm as never, status: "archived" })
    const reply = await h.client.send({ type: "memory.update", memoryId: proposal.memoryId, status: "saved" })
    expect(reply).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.list("pending")).toEqual([])
    expect((await h.list("archived"))[0]).toMatchObject({ text: "Package manager is npm" })
  })

  test("ordinary pending proposals and edits keep working", async () => {
    const h = await boot(() => JSON.stringify({ proposals: [{ text: "Releases are cut with bun run release", scope: "project", category: "commands", why: "s" }] }))
    await h.add("Package manager is npm")
    await h.dream()
    const pending = (await h.list("pending"))[0]!
    expect(pending.kind).toBeUndefined()
    expect(await h.client.send({ type: "memory.update", memoryId: pending.memoryId, status: "saved" })).toMatchObject({ ok: true })
    expect(await h.list("pending")).toEqual([])
    expect((await h.list("saved")).map((m) => m.text)).toContain("Releases are cut with bun run release")
  })
})
