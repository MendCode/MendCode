import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { SharingResult, SharingStatusReport, MemoryBrowseReport, MemoryWorkspacesReport } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-b08-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b08" })
  await client.connect()
  cleanups.push(() => client.close())
  const ok = async (command: Parameters<typeof client.send>[0]) => {
    const reply = await client.send(command)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result
  }
  return { daemon, client, ok }
}

test("B08 daemon/client wire flow exports, reviews, approves and protects later revisions", async () => {
  const h = await boot()
  const id = (await h.ok({ type: "memory.add", scope: "project", directory: "/repo", text: "Run bun test" }))!.memoryId as never
  const status = await h.client.sharingStatus("project", "/repo")
  expect(status.ok).toBe(true)
  if (status.ok) expect(SharingStatusReport.parse(status.report).enabled).toBe(false)
  expect(await h.client.send({ type: "memory.sharing.configure", scope: "project", directory: "/repo", enabled: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  await h.ok({ type: "memory.sharing.configure", scope: "project", directory: "/repo", enabled: true, confirmation: "ENABLE PROJECT" })
  const result = SharingResult.parse(await h.ok({ type: "memory.sharing.export", scope: "project", directory: "/repo" }))
  const file = path.join(result.directory, `${id}.md`)
  writeFileSync(file, readFileSync(file, "utf8").replace("Run bun test", "Run focused tests"))
  const imported = SharingResult.parse(await h.ok({ type: "memory.sharing.import", scope: "project", directory: "/repo" }))
  expect(imported.proposals).toHaveLength(1)
  expect(h.daemon.store.memories.get(id)?.text).toBe("Run bun test")
  await h.ok({ type: "memory.update", memoryId: imported.proposals[0]!, status: "saved" })
  expect(h.daemon.store.memories.get(id)?.text).toBe("Run focused tests")
  await h.ok({ type: "memory.sharing.export", scope: "project", directory: "/repo" })
  writeFileSync(file, readFileSync(file, "utf8").replace("Run focused tests", "Run all checks"))
  const next = SharingResult.parse(await h.ok({ type: "memory.sharing.import", scope: "project", directory: "/repo" }))
  await h.ok({ type: "memory.update", memoryId: id, text: "Run typecheck" })
  expect(await h.client.send({ type: "memory.update", memoryId: next.proposals[0]!, status: "saved" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(h.daemon.store.memories.get(id)?.text).toBe("Run typecheck")
})

test("workspace helpers enumerate origins and browse a union graph via the daemon", async () => {
  const h = await boot()
  await h.ok({ type: "session.create", directory: "/older", title: "Older project" })
  await h.ok({ type: "memory.add", scope: "project", directory: "/older", text: "Older rule" })
  await h.ok({ type: "memory.add", scope: "project", directory: "/repo", text: "Current rule" })
  const projects = await h.client.memoryWorkspaces("/repo")
  expect(projects.ok).toBe(true)
  if (projects.ok) expect(MemoryWorkspacesReport.parse(projects.report).workspaces.map((item) => item.root).sort()).toEqual(["/older", "/repo"])
  const all = await h.client.browseMemory("all", "/repo")
  expect(all.ok).toBe(true)
  if (all.ok) expect(MemoryBrowseReport.parse(all.report).graph.nodes).toHaveLength(2)
  const selected = await h.client.browseMemory("project", "/repo", "/older")
  expect(selected.ok).toBe(true)
  if (selected.ok) expect(selected.report.memories.map((item) => item.text)).toEqual(["Older rule"])
})
