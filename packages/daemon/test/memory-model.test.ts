import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { remoteTokens } from "../src/remote"
import { isReadOnlyCommand } from "@mendcode/protocol"
import { remoteTurnOptions } from "../src/remote-policy"
import { createMemoryTool, createMemoryGraphTool } from "@mendcode/engine-native"
import { createIdFactory } from "@mendcode/protocol"
import type { MemoryEntry, MemoryId, MemoryModelInput } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { DaemonOptions, MemoryAccess } from "../src/daemon"
import { parseMemoryAssistantResponse } from "../src/memory-assistant"
import { resolveModel } from "../src/models"
import { sharedMemoryRevision } from "@mendcode/store"

const cleanups: Array<() => Promise<void> | void> = []

test("faux daemon refuses memory access to full and read-only peers", async () => {
  const dir = temporary()
  const project = temporary()
  const tokens = remoteTokens(dir)
  const peers = [false, true].map((readOnly) => ({ readOnly, token: tokens.create({ name: readOnly ? "observer" : "owner", readOnly }).token }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "sock"), defaultDirectory: project, http: { enabled: true }, httpListen: false, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanups.push(() => daemon.stop())
  for (const { token } of peers) {
    for (const command of [{ type: "memory.model", directory: project, input: { action: "list", scope: "user" } }, { type: "memory.extraction.list", directory: project }, { type: "memory.workspaces", directory: project }]) {
      const response = await daemon.httpAdapter!.fetch(new Request("http://127.0.0.1/command", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: createIdFactory()("command"), clientId: createIdFactory()("client"), ...command }) }))
      if (!response) throw new Error("Missing HTTP response")
      expect(JSON.stringify(await response.json())).toContain("forbidden")
    }
  }
  expect(isReadOnlyCommand("memory.workspaces")).toBe(false)
  expect(isReadOnlyCommand("memory.sharing.status")).toBe(false)
  expect(remoteTurnOptions().excludeTools).toEqual(expect.arrayContaining(["memory", "memory_graph", "remember"]))
})
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
function temporary() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b63-memory-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function boot(complete?: DaemonOptions["complete"], dir = temporary()) {
  let memory!: MemoryAccess
  const options: DaemonOptions = { dir, socketPath: path.join(dir, "sock"), engine: (input) => {
    memory = input.memory
    return createFauxEngine({ clock: input.clock })
  }, ...(complete ? { complete } : {}) }
  const daemon = await startDaemon(options)
  const client = createClient({ socketPath: daemon.socketPath, name: "b63" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  async function model(directory: string, input: MemoryModelInput) {
    const reply = await client.memoryModel(directory, input)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result!
  }
  return { dir, daemon, client, model, memory }
}

test("B63 model CRUD preserves metadata across restart, searches/context/categories and refuses foreign ids", async () => {
  const h = await boot()
  const project = temporary()
  const other = temporary()
  const added = (await h.model(project, { action: "add", text: "Deploy with pnpm", categoryIDs: ["commands", "constraints"], tags: ["deployment"], evidence: "user correction", confidence: .9, sensitivity: "medium" })).memory as MemoryEntry
  expect(added.details).toMatchObject({ categoryIDs: ["commands", "constraints"], tags: ["deployment"], evidence: "user correction", confidence: .9, sensitivity: "medium" })
  expect((await h.model(project, { action: "status" })).project).toBe(1)
  expect((await h.model(project, { action: "categories" })).categories).toBeArray()
  expect((await h.model(project, { action: "search", query: "pnpm" })).memories).toHaveLength(1)
  expect((await h.model(project, { action: "search", query: "deployment" })).memories).toHaveLength(1)
  expect((await h.model(project, { action: "search", query: "constraints" })).memories).toHaveLength(1)
  expect((await h.model(project, { action: "context", query: "pnpm", maxEntries: 1 })).memories).toHaveLength(1)
  expect(await h.client.memoryModel(other, { action: "delete", id: added.memoryId })).toMatchObject({ ok: false })
  await h.model(project, { action: "update", id: added.memoryId, text: "Deploy with pnpm 11", tags: ["updated"] })
  await h.client.close()
  await h.daemon.stop()
  const reopened = await boot(undefined, h.dir)
  expect(((await reopened.model(project, { action: "list" })).memories as MemoryEntry[])[0]).toMatchObject({ memoryId: added.memoryId, text: "Deploy with pnpm 11", details: { tags: ["updated"], evidence: "user correction" } })
  await reopened.model(project, { action: "delete", id: added.memoryId })
  expect((await reopened.model(project, { action: "list" })).memories).toEqual([])
})

test("B63 native tools run through the scoped daemon port; graph writes/default related and policy proposals", async () => {
  const h = await boot()
  const project = temporary()
  const context = { cwd: project, signal: new AbortController().signal }
  const memory = createMemoryTool(h.memory)
  const graph = createMemoryGraphTool(h.memory)
  expect(memory.permission).toBe("write")
  expect(graph.permission).toBe("write")
  const first = JSON.parse((await graph.execute({ action: "upsert_fact", text: "pnpm for builds" }, context)).output).memory as MemoryEntry
  expect((await graph.execute({ action: "upsert_fact", id: first.memoryId, text: "pnpm 11 for builds" }, context)).isError).toBe(false)
  const second = (await h.model(project, { action: "upsert_fact", id: createIdFactory()("memory"), text: "bun for tests" })).memory as MemoryEntry
  expect((await graph.execute({ action: "link", from: first.memoryId, to: second.memoryId }, context)).isError).toBe(false)
  expect((await h.model(project, { action: "validate" })).ok).toBe(true)
  expect((await graph.execute({ action: "search", query: "pnpm absentword", maxFacts: 1 }, context)).output).toContain(first.memoryId)
  await h.model(project, { action: "upsert_fact", id: first.memoryId, text: "pnpm 11 for builds", scope: "global" })
  expect(((await h.model(project, { action: "list", scope: "global" })).memories as MemoryEntry[])[0]?.memoryId).toBe(first.memoryId)
  expect((await h.model(project, { action: "overview" })).links).toHaveLength(1)
  expect((await memory.execute({ action: "propose", text: "Use feature branches", category: "constraints" }, context)).output).toContain("saved")
  await h.client.send({ type: "settings.set", patch: { memoryPolicies: { constraints: "auto" }, memoryProjectMaxEntries: 10 } })
  expect((await memory.execute({ action: "propose", text: "Use focused patches", category: "constraints" }, context)).output).toContain("saved")
  expect((await memory.execute({ action: "update", id: createIdFactory()("memory"), text: "unknown" }, context)).isError).toBe(true)
})

test("B63 memory assistant focuses selection, retains global context, persists history and reviews graph proposals", async () => {
  const calls: string[] = []
  let a!: MemoryId
  let b!: MemoryId
  const h = await boot(async ({ system, prompt }) => {
    calls.push(system + "\n" + prompt)
    return JSON.stringify({ reply: "Review this relationship in Pending.", actions: [{ kind: "graph-link", text: "Both describe validation", fromFactID: a, toFactID: b, linkKind: "supports" }] })
  })
  const project = temporary()
  a = ((await h.model(project, { action: "add", text: "pnpm typecheck", category: "commands" })).memory as MemoryEntry).memoryId
  b = ((await h.model(project, { action: "add", text: "bun test", category: "commands" })).memory as MemoryEntry).memoryId
  await h.model(project, { action: "add", scope: "global", text: "Answer concisely" })
  const answer = await h.client.memoryAssistant(project, "Connect these", { category: "commands", memoryId: a, tab: "graph" })
  expect(answer.ok).toBe(true)
  expect(calls[0]).toContain("<selected_page_context>")
  expect(calls[0]).toContain("Answer concisely")
  expect((await h.model(project, { action: "overview" })).links).toEqual([])
  const thread = answer.ok ? answer.thread : undefined
  expect(thread?.proposals).toHaveLength(1)
  await h.client.send({ type: "memory.update", memoryId: thread!.proposals[0]!, status: "saved" })
  expect((await h.model(project, { action: "overview" })).links).toHaveLength(1)
  const before = await h.client.memoryAssistant(project)
  await h.client.close()
  await h.daemon.stop()
  const reopened = await boot(undefined, h.dir)
  expect(await reopened.client.memoryAssistant(project)).toEqual(before)
  expect(await reopened.client.send({ type: "memory.assistant.clear", directory: project })).toMatchObject({ ok: true, result: { thread: { messages: [], proposals: [] } } })
  expect(await reopened.client.memoryAssistant(project, "new")).toMatchObject({ ok: false, error: { message: "Memory assistant needs a configured native completion provider" } })
})

test("B63 clear/cancel discard late answers and proposals without entering the main session log", async () => {
  let finish!: (text: string) => void
  const h = await boot(() => new Promise((resolve) => { finish = resolve }))
  const project = temporary()
  const created = await h.client.send({ type: "session.create", directory: project, title: "main" })
  const sessionId = created.ok ? created.result!.sessionId as import("@mendcode/protocol").SessionId : createIdFactory()("session")
  const before = await h.client.send({ type: "session.events", sessionId })
  const asking = h.client.memoryAssistant(project, "Remember something")
  while (!finish) await Bun.sleep(2)
  expect(await h.client.memoryAssistant(project, "busy")).toMatchObject({ ok: false })
  await h.client.send({ type: "memory.assistant.clear", directory: project })
  finish('{"reply":"late","actions":[{"kind":"propose-memory","text":"late fact"}]}')
  await asking
  expect(await h.client.memoryAssistant(project)).toMatchObject({ ok: true, thread: { messages: [], proposals: [] } })
  expect(await h.client.send({ type: "session.events", sessionId })).toEqual(before)
  expect(h.daemon.store.memories.list()).toEqual([])
  finish = undefined!
  const canceled = h.client.memoryAssistant(project, "cancel me")
  while (!finish) await Bun.sleep(2)
  await h.client.send({ type: "memory.assistant.cancel", directory: project })
  await canceled
  finish("late")
  expect(await h.client.memoryAssistant(project)).toMatchObject({ ok: true, thread: { busy: false, canceled: true } })
})

test("B63 assistant parser keeps prose/errors and only well-formed review actions", () => {
  expect(parseMemoryAssistantResponse("plain answer")).toEqual({ text: "plain answer", actions: [] })
  expect(parseMemoryAssistantResponse('```json\n{"reply":"hello","actions":[{"kind":"unknown","text":"no"},{"kind":"dream-dry-run","text":"21:00"}]}\n```')).toMatchObject({ text: "hello", actions: [{ kind: "dream-dry-run", text: "21:00" }] })
  expect(parseMemoryAssistantResponse('{"reply":"invalid target","actions":[{"kind":"delete-memory","text":"delete"}]}').actions).toEqual([])
})

test("B63 draft edits apply reviewed text/categories; control drafts remain pending until rejected", async () => {
  const h = await boot(async () => JSON.stringify({ reply: "Review these", actions: [{ kind: "create-memory", text: "original", categoryIDs: ["commands"] }, { kind: "propose-policy", text: "Use manual review" }] }))
  const project = temporary()
  const reply = await h.client.memoryAssistant(project, "Draft a fact and policy")
  if (!reply.ok || !reply.thread) throw new Error("No assistant reply")
  const [fact, policy] = reply.thread.proposals
  expect(await h.client.send({ type: "memory.update", memoryId: fact!, text: "edited", category: "constraints" })).toMatchObject({ ok: true })
  expect(await h.client.send({ type: "memory.update", memoryId: fact!, text: "approved text", status: "saved" })).toMatchObject({ ok: true })
  const saved = (await h.model(project, { action: "list" })).memories as MemoryEntry[]
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ text: "approved text", category: "constraints", details: { categoryIDs: ["constraints"] } })
  expect(await h.client.send({ type: "memory.update", memoryId: policy!, status: "saved" })).toMatchObject({ ok: false })
  expect(h.daemon.store.memories.get(policy!)?.status).toBe("pending")
  expect(await h.client.send({ type: "memory.update", memoryId: policy!, status: "archived" })).toMatchObject({ ok: true })
  expect(h.daemon.store.memories.get(policy!)).toBeUndefined()
})

test("B63 assistant refuses another profile selection and isolates history when the active profile changes", async () => {
  const calls: string[] = []
  const h = await boot(async ({ prompt }) => {
    calls.push(prompt)
    return '{"reply":"Scoped answer","actions":[]}'
  })
  const project = temporary()
  const privateRoot = temporary()
  const privateProject = path.join(privateRoot, "project")
  await h.client.send({ type: "settings.set", patch: { profiles: [{ name: "company", directories: [`${privateRoot}/*`] }] } })
  await h.model(project, { action: "add", scope: "global", text: "Personal rule" })
  await h.model(privateProject, { action: "add", scope: "global", text: "Company rule" })
  expect(await h.client.memoryAssistant(project, "foreign selection", { root: privateProject })).toMatchObject({ ok: false })
  expect(calls).toHaveLength(0)
  expect(await h.client.memoryAssistant(privateProject, "company question", { tab: "extraction" })).toMatchObject({ ok: true })
  expect(calls[0]).toContain("Company rule")
  expect(calls[0]).not.toContain("Personal rule")
  expect(calls[0]).toContain('"requireApproval":true')
  expect(await h.client.memoryAssistant(project)).toMatchObject({ ok: true, thread: { messages: [] } })
  await h.client.send({ type: "settings.set", patch: { profiles: [] } })
  expect(await h.client.memoryAssistant(privateProject)).toMatchObject({ ok: true, thread: { messages: [] } })
})

test("B63 assistant role falls back through extractor/small/main and metadata changes invalidate sharing revisions", () => {
  const catalog = { selectable: true, list: () => [{ id: "local", name: "Local", efforts: [] }], defaults: { model: "local" } }
  expect(resolveModel({ role: "memoryAssistant", roles: { memoryAssistant: { model: "assistant" }, memoryExtractor: { model: "extractor" } }, catalog })).toEqual({ model: "assistant" })
  expect(resolveModel({ role: "memoryAssistant", roles: { memoryExtractor: { model: "extractor" }, small: { model: "small" } }, catalog })).toEqual({ model: "extractor" })
  expect(resolveModel({ role: "memoryAssistant", roles: { small: { model: "small" } }, catalog })).toEqual({ model: "small" })
  expect(resolveModel({ role: "memoryAssistant", roles: { main: { model: "main" } }, catalog })).toEqual({ model: "main" })
  const entry: MemoryEntry = { memoryId: createIdFactory()("memory"), text: "Fact", category: "commands", scope: "project", status: "saved", source: "agent", createdAt: 1, updatedAt: 1 }
  expect(sharedMemoryRevision(entry)).not.toBe(sharedMemoryRevision({ ...entry, details: { sensitivity: "high" } }))
})
