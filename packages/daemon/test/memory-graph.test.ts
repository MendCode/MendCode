import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createMemoryGraphTool } from "@mendcode/engine-native"
import { createIdFactory, type MemoryGraphReport, type MemoryId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { graphHealth, memoryGraph } from "../src/memory-graph"

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
  const dir = temp("mendd-graph-")
  const project = temp("graph-project-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "graph" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const add = async (text: string, scope: "user" | "project" = "project") => {
    const reply = await client.send({ type: "memory.add", scope, directory: project, text })
    return (reply.ok ? reply.result?.memoryId : undefined) as MemoryId
  }
  const graph = async () => {
    const reply = await client.send({ type: "memory.graph", directory: project })
    return (reply.ok ? reply.result : undefined) as MemoryGraphReport
  }
  return { daemon, client, project, add, graph }
}

describe("memory graph", () => {
  test("links join saved memories; symmetric links are stored once; deleting a memory drops its links", async () => {
    const { client, add, graph } = await boot()
    const a = await add("tests run with bun test")
    const b = await add("CI uses bun test --bail")
    const c = await add("use pnpm for installs", "user")
    expect((await graph()).health).toMatchObject({ nodes: 3, links: 0, state: "disconnected" })
    expect(await client.send({ type: "memory.link", from: b, to: a, kind: "related" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "memory.link", from: a, to: b, kind: "related" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "memory.link", from: c, to: a, kind: "supports" })).toMatchObject({ ok: true, result: { link: { from: c, to: a, kind: "supports" } } })
    const linked = await graph()
    expect(linked.links).toHaveLength(2)
    expect(linked.health).toMatchObject({ nodes: 3, links: 2, connected: 3, isolated: 0, state: "connected" })
    expect(linked.nodes[0]!.memoryId).toBe(a)
    expect(await client.send({ type: "memory.link", from: a, to: a, kind: "related" })).toMatchObject({ ok: false })
    expect(await client.send({ type: "memory.unlink", from: a, to: c })).toMatchObject({ ok: true, result: { removed: true } })
    await client.send({ type: "memory.delete", memoryId: b })
    expect((await graph()).health).toMatchObject({ nodes: 2, links: 0 })
  })

  test("pending memories cannot be linked and a memory has at most 16 links", async () => {
    const { daemon, client, add } = await boot()
    const hub = await add("hub")
    const pending = createIdFactory()("memory")
    daemon.store.memories.add({ memoryId: pending, scope: "project", directory: "/x", text: "p", category: "", status: "pending", source: "agent" })
    expect(await client.send({ type: "memory.link", from: hub, to: pending, kind: "related" })).toMatchObject({ ok: false })
    for (let i = 0; i < 16; i++) expect(await client.send({ type: "memory.link", from: hub, to: await add(`leaf ${i}`), kind: "related" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "memory.link", from: hub, to: await add("one too many"), kind: "related" })).toMatchObject({ ok: false })
  })

  test("a command with a malformed field is refused at once, not left to time out", async () => {
    const { client, add } = await boot()
    const started = Date.now()
    expect(await client.send({ type: "memory.link", from: await add("a"), to: "memory_not-an-id" as MemoryId, kind: "related" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("the graph follows profiles: another profile's user memories are not nodes", async () => {
    const { client, project, add, graph } = await boot()
    await add("mine", "user")
    await client.send({ type: "settings.set", patch: { profiles: [{ name: "work", directories: [project] }] } })
    await add("work fact", "user")
    expect((await graph()).nodes.map((node) => node.text)).toEqual(["work fact"])
  })

  test("the memory_graph tool gives an overview, searches with links, and links by id", async () => {
    const { daemon, add, project } = await boot()
    const a = await add("deploys go through the release branch")
    const b = await add("never push to main")
    const port = {
      graph: (directory: string) => memoryGraph(daemon.store.memories.list({ directory, status: "saved" }), daemon.store.memories.links(daemon.store.memories.list({ directory, status: "saved" }).map((m) => m.memoryId))),
      link: (input: { from: MemoryId; to: MemoryId; kind: "related" | "supports" | "conflicts" | "supersedes" }) => daemon.store.memories.link(input),
    }
    const tool = createMemoryGraphTool(port)
    const context = { cwd: project, signal: new AbortController().signal }
    expect((await tool.execute({ action: "link", from: b, to: a, kind: "supports" }, context)).output).toBe(`linked ${b} supports ${a}`)
    expect((await tool.execute({ action: "overview" }, context)).output).toStartWith("graph connected · 2 memories · 1 links · 0 isolated · 0 conflicts")
    const search = (await tool.execute({ action: "search", query: "release" }, context)).output
    expect(search).toContain(a)
    expect(search).toContain(`supports ← ${b}`)
    expect((await tool.execute({ action: "link", from: a }, context)).isError).toBe(true)
  })

  test("health counts only links whose ends are both nodes", () => {
    const node = (id: string) => ({ memoryId: id, scope: "project", text: id, category: "", status: "saved", source: "user", createdAt: 0, updatedAt: 0 }) as never
    expect(graphHealth([node("a"), node("b"), node("c")], [{ from: "a", to: "b", kind: "conflicts", createdAt: 0 } as never, { from: "a", to: "zz", kind: "related", createdAt: 0 } as never])).toEqual({ nodes: 3, links: 1, connected: 2, isolated: 1, conflicts: 1, state: "partial" })
    expect(graphHealth([], []).state).toBe("empty")
  })
})
