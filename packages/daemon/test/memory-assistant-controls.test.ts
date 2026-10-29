import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { MEMORY_ASSISTANT_ARCHIVE_MAX } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { DaemonOptions } from "../src/daemon"
import { firstClockTime } from "../src/memory-model"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
function temporary() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "r4-assistant-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function boot(complete: NonNullable<DaemonOptions["complete"]>,extra: Partial<DaemonOptions> = {}, dir = temporary()) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "sock"), engine: (input) => createFauxEngine({ clock: input.clock }), complete, ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "r4" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { dir, daemon, client }
}
const approve = (h: Awaited<ReturnType<typeof boot>>, id: string) => h.client.send({ type: "memory.update", memoryId: id as never, status: "saved" })

test("R4 clock times come from the first HH:MM, a window gives its start", () => {
  expect(firstClockTime("keep it at 21:30-23:00")).toBe("21:30")
  expect(firstClockTime("at 3:05 each night")).toBe("03:05")
  expect(firstClockTime("no time here, build 12345")).toBeUndefined()
})

test("R4 approved policy, category and Dream drafts change what they describe", async () => {
  const project = temporary()
  const actions = [
    { kind: "propose-policy", text: "Let commands save directly", categoryID: "commands", policy: "auto" },
    { kind: "edit-category", text: "Drop security proposals", categoryID: "project.security", policy: "never" },
    { kind: "delete-category", text: "Reset security", categoryID: "security" },
    { kind: "propose-policy", text: "Preview consolidation", settings: { memoryMaintenance: "preview", dreamConsolidationPolicy: "preview", memoryGenerate: true } },
    { kind: "dream-service-start", text: "Run Dream at night, 21:30-23:00" },
    { kind: "dream-dry-run", text: "Try Dream once" },
    { kind: "create-category", text: "A new category" },
  ]
  const h = await boot(async () => JSON.stringify({ reply: "Drafted", actions }), { dream: { complete: async () => "{}" } })
  const reply = await h.client.memoryAssistant(project, "Configure memory")
  if (!reply.ok) throw new Error(reply.error.message)
  expect(reply.thread.proposals).toHaveLength(6)
  expect(reply.thread.error).toContain("fixed category list")
  const [policy, edit, reset, settings, service, dry] = reply.thread.proposals
  expect(h.daemon.store.settings.get().memoryPolicies).toBeUndefined()

  expect(await approve(h, policy!)).toMatchObject({ ok: true, result: { action: "applied", category: "commands", policy: "auto" } })
  expect(h.daemon.store.settings.get().memoryPolicies).toEqual({ commands: "auto" })
  expect(h.daemon.store.memories.get(policy!)).toBeUndefined()
  expect(await approve(h, edit!)).toMatchObject({ ok: true, result: { category: "security", policy: "never" } })
  expect(h.daemon.store.settings.get().memoryPolicies).toEqual({ commands: "auto", security: "never" })
  expect(await approve(h, reset!)).toMatchObject({ ok: true })
  expect(h.daemon.store.settings.get().memoryPolicies).toEqual({ commands: "auto" })

  expect(await approve(h, settings!)).toMatchObject({ ok: true })
  expect(h.daemon.store.settings.get()).toMatchObject({ memoryMaintenance: "preview", dreamConsolidationPolicy: "preview", memoryGenerate: true })

  expect(h.daemon.store.settings.get().dreamAt).toBeUndefined()
  expect(await approve(h, service!)).toMatchObject({ ok: true, result: { dreamAt: "21:30" } })
  expect(h.daemon.store.settings.get().dreamAt).toBe("21:30")

  expect(h.daemon.store.dreamRuns.list(project)).toHaveLength(0)
  expect(await approve(h, dry!)).toMatchObject({ ok: true, result: { action: "applied", dryRun: true, runId: expect.any(Number) } })
  for (let i = 0; i < 200 && !h.daemon.store.dreamRuns.list(project).every((run) => run.status !== "running"); i++) await Bun.sleep(5)
  expect(h.daemon.store.dreamRuns.list(project)).toMatchObject([{ trigger: "manual", status: "skipped" }])
})

test("R4 a draft that cannot be applied stays pending and changes nothing; rejecting removes it", async () => {
  const project = temporary()
  const h = await boot(async () => JSON.stringify({ reply: "Drafted", actions: [
    { kind: "propose-policy", text: "Be stricter" },
    { kind: "propose-policy", text: "Unknown", categoryID: "invented", policy: "auto" },
    { kind: "edit-category", text: "No policy", categoryID: "stack" },
    { kind: "dream-service-start", text: "Whenever" },
    { kind: "propose-policy", text: "Turn approvals off", settings: { memoryRequireApproval: false } },
  ] }))
  const reply = await h.client.memoryAssistant(project, "Configure memory")
  if (!reply.ok) throw new Error(reply.error.message)
  expect(reply.thread.proposals).toHaveLength(4)
  const before = JSON.stringify(h.daemon.store.settings.get())
  for (const id of reply.thread.proposals) {
    expect(await approve(h, id)).toMatchObject({ ok: false })
    expect(h.daemon.store.memories.get(id)?.status).toBe("pending")
  }
  expect(JSON.stringify(h.daemon.store.settings.get())).toBe(before)
  expect(await h.client.send({ type: "memory.update", memoryId: reply.thread.proposals[0]!, status: "archived" })).toMatchObject({ ok: true })
  expect(h.daemon.store.memories.get(reply.thread.proposals[0]!)).toBeUndefined()
})

test("R4 chats can be archived, listed, restored in place of the live one and forgotten, per project, across restart", async () => {
  const project = temporary()
  const other = temporary()
  let answer = 0
  const h = await boot(async () => JSON.stringify({ reply: `Answer ${++answer}`, actions: [] }))
  const archive = (action: "archive" | "list" | "restore" | "delete", id?: string, directory = project) => h.client.memoryAssistantArchive(directory, action, id)
  expect(await archive("archive")).toMatchObject({ ok: true, thread: { messages: [] }, archives: [] })
  await h.client.memoryAssistant(project, "First question about commands")
  const first = await archive("archive")
  if (!first.ok) throw new Error(first.error.message)
  expect(first.thread.messages).toEqual([])
  expect(first.archives).toMatchObject([{ messages: 2, title: "First question about commands" }])
  await h.client.memoryAssistant(project, "Second question")
  const swapped = await archive("restore", first.archives[0]!.archiveId)
  if (!swapped.ok) throw new Error(swapped.error.message)
  expect(swapped.thread.messages[0]).toEqual({ role: "user", text: "First question about commands" })
  expect(swapped.archives).toMatchObject([{ title: "Second question" }])
  expect((await archive("list", undefined, other))).toMatchObject({ ok: true, archives: [] })
  expect(await archive("restore", first.archives[0]!.archiveId)).toMatchObject({ ok: false })
  await h.client.close()
  await h.daemon.stop()
  const reopened = await boot(async () => "{}", {}, h.dir)
  const listed = await reopened.client.memoryAssistantArchive(project, "list")
  if (!listed.ok) throw new Error(listed.error.message)
  expect(listed.archives).toMatchObject([{ title: "Second question" }])
  expect(await reopened.client.memoryAssistantArchive(project, "delete", listed.archives[0]!.archiveId)).toMatchObject({ ok: true, archives: [] })
  expect(await reopened.client.memoryAssistantArchive(project, "delete", "nope")).toMatchObject({ ok: false })
})

test("R4 the archive keeps the newest chats only", async () => {
  const project = temporary()
  const h = await boot(async () => JSON.stringify({ reply: "ok", actions: [] }))
  for (let index = 0; index < MEMORY_ASSISTANT_ARCHIVE_MAX + 3; index++) {
    await h.client.memoryAssistant(project, `question ${index}`)
    await h.client.memoryAssistantArchive(project, "archive")
  }
  const listed = await h.client.memoryAssistantArchive(project, "list")
  if (!listed.ok) throw new Error(listed.error.message)
  expect(listed.archives).toHaveLength(MEMORY_ASSISTANT_ARCHIVE_MAX)
})
