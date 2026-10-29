import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, MAX_PINNED_MEMORIES, type MemoryEntry, type MemoryGraphReport, type MemoryId, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot() {
  const dir = temp("mendd-memscope-")
  const project = temp("memscope-project-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "memscope" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const add = async (text: string, scope: "user" | "project" = "project") => {
    const reply = await client.send({ type: "memory.add", scope, directory: project, text })
    return (reply.ok ? reply.result?.memoryId : undefined) as MemoryId
  }
  const session = async (directory = project) => {
    const reply = await client.send({ type: "session.create", directory })
    return (reply.ok ? reply.result?.sessionId : undefined) as SessionId
  }
  const get = (memoryId: MemoryId) => daemon.store.memories.get(memoryId) as MemoryEntry
  const graph = async () => {
    const reply = await client.send({ type: "memory.graph", directory: project })
    return (reply.ok ? reply.result : undefined) as MemoryGraphReport
  }
  return { daemon, client, project, add, session, get, graph }
}

describe("memory.update scope", () => {
  test("changing scope keeps the id, the text and the graph links", async () => {
    const { client, project, add, session, get, graph } = await boot()
    const a = await add("tests run with bun test")
    const b = await add("CI uses bun test --bail")
    await client.send({ type: "memory.link", from: a, to: b, kind: "supports" })
    const before = await graph()
    expect(before.links).toHaveLength(1)

    // project -> user
    expect(await client.send({ type: "memory.update", memoryId: a, scope: "user" })).toMatchObject({ ok: true })
    expect(get(a)).toMatchObject({ memoryId: a, scope: "user", text: "tests run with bun test", status: "saved" })
    expect(get(a).directory).toBeUndefined()
    expect(get(a).sessionId).toBeUndefined()
    // user -> session (the session's project becomes the directory)
    const sessionId = await session()
    expect(await client.send({ type: "memory.update", memoryId: a, scope: "session", sessionId })).toMatchObject({ ok: true })
    expect(get(a)).toMatchObject({ scope: "session", sessionId, directory: project })
    // session -> project, with new text in the same call
    expect(await client.send({ type: "memory.update", memoryId: a, scope: "project", directory: project, text: "tests run with bun test --bail" })).toMatchObject({ ok: true })
    expect(get(a)).toMatchObject({ scope: "project", directory: project, text: "tests run with bun test --bail" })
    expect(get(a).sessionId).toBeUndefined()

    const after = await graph()
    expect(after.links).toHaveLength(1)
    expect(after.links[0]).toMatchObject({ from: a, to: b, kind: "supports" })
    expect(after.nodes.map((node) => node.memoryId)).toContain(a)
  })

  test("a moved memory is found in its new scope only, and moving within a scope changes the project", async () => {
    const { client, daemon, project, add, get } = await boot()
    const other = temp("memscope-other-")
    const id = await add("only for the first project")
    expect(await client.send({ type: "memory.update", memoryId: id, scope: "project", directory: other })).toMatchObject({ ok: true })
    expect(get(id).directory).toBe(other)
    expect(daemon.store.memories.list({ directory: project }).map((memory) => memory.memoryId)).not.toContain(id)
    expect(daemon.store.memories.list({ directory: other }).map((memory) => memory.memoryId)).toContain(id)
  })

  test("invalid moves are refused and change nothing", async () => {
    const { client, daemon, add, get } = await boot()
    const id = await add("stay put")
    // The wire schema rejects a scope without what it needs, and a directory without a scope.
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client"), type: "memory.update", memoryId: id }
    expect(Command.safeParse({ ...base, scope: "project" }).success).toBe(false)
    expect(Command.safeParse({ ...base, scope: "session" }).success).toBe(false)
    expect(Command.safeParse({ ...base, directory: "/x" }).success).toBe(false)
    expect(Command.safeParse({ ...base, scope: "user", directory: "/x" }).success).toBe(false)
    expect(Command.safeParse({ ...base, scope: "project", directory: "/x" }).success).toBe(true)
    // The daemon refuses an unknown session and a pending revision.
    expect(await client.send({ type: "memory.update", memoryId: id, scope: "session", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    const revision = createIdFactory()("memory")
    daemon.store.memories.add({ memoryId: revision, scope: "project", directory: "/x", text: "rev", category: "", status: "pending", source: "agent", kind: "update", targetId: id })
    expect(await client.send({ type: "memory.update", memoryId: revision, scope: "user", text: "rev2" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(get(id)).toMatchObject({ scope: "project", text: "stay put" })
    expect(await client.send({ type: "memory.update", memoryId: createIdFactory()("memory"), scope: "user" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("a pinned memory only moves where the pin cap has room", async () => {
    const { client, project, add, get } = await boot()
    const target = temp("memscope-full-")
    for (let i = 0; i < MAX_PINNED_MEMORIES; i++) {
      const id = await client.send({ type: "memory.add", scope: "project", directory: target, text: `pinned ${i}`, pinned: true })
      expect(id.ok).toBe(true)
    }
    const pinned = await add("pinned here")
    expect(await client.send({ type: "memory.update", memoryId: pinned, pinned: true })).toMatchObject({ ok: true })
    const refused = await client.send({ type: "memory.update", memoryId: pinned, scope: "project", directory: target })
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(get(pinned)).toMatchObject({ directory: project, pinned: true })
    // Unpinned, it moves.
    expect(await client.send({ type: "memory.update", memoryId: pinned, scope: "project", directory: target, pinned: false })).toMatchObject({ ok: true })
    expect(get(pinned)).toMatchObject({ directory: target })
  })
})
