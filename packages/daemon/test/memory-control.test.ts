import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type DreamRun, type MemoryEntry, type MemoryId, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { dateKey, windows } from "../src/dream-schedule"
import { createMemorySelector } from "@mendcode/engine-native"
import { memorySettings } from "../src/memory-config"
import { createMemoryControl } from "../src/memory-control"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const ids = createIdFactory()
async function boot(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b19-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...extra })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B19" })
  await client.connect()
  cleanup.push(() => client.close())
  async function control(input: Parameters<typeof client.memoryControl>[1], directory = "/repo") {
    const reply = await client.memoryControl(directory, input)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result!
  }
  async function dream(input: Parameters<typeof client.dreamControl>[1], directory = "/repo") {
    const reply = await client.dreamControl(directory, input)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result!
  }
  const seed = (text: string, patch: Partial<MemoryEntry> = {}) => {
    const memoryId = ids("memory")
    daemon.store.memories.add({ memoryId, scope: "project", directory: "/repo", text, source: "agent", status: "pending", category: "commands", ...patch })
    return memoryId
  }
  return { dir, daemon, client, control, dream, seed }
}

describe("B19 daemon memory controls", () => {
  test("manual proposals always wait; edit/apply/reject/delete use the visible scope and preserve ids", async () => {
    const h = await boot()
    await h.client.send({ type: "memory.policy", category: "commands", policy: "auto" })
    const proposal = (await h.control({ operation: "propose", text: "Use pnpm for dependencies", scope: "project", tags: ["cli"], category: "commands" })).proposal as MemoryEntry
    expect(proposal).toMatchObject({ status: "pending", source: "user", details: { tags: ["cli"] } })
    expect(await h.control({ operation: "status" })).toMatchObject({ counts: { saved: 0, pending: 1, archived: 0 } })
    await h.control({ operation: "edit", memoryId: proposal.memoryId, text: "Use pnpm 11 for dependencies" })
    expect((await h.control({ operation: "apply", memoryId: proposal.memoryId })).proposal).toMatchObject({ memoryId: proposal.memoryId, status: "saved", text: "Use pnpm 11 for dependencies" })
    expect(await h.client.memoryControl("/other", { operation: "delete", memoryId: proposal.memoryId })).toMatchObject({ ok: false })
    expect(await h.client.memoryControl("/repo", { operation: "reject", memoryId: proposal.memoryId })).toMatchObject({ ok: false })
    const pending = (await h.control({ operation: "propose", text: "Another durable fact" })).proposal as MemoryEntry
    expect((await h.control({ operation: "reject", memoryId: pending.memoryId })).proposal).toMatchObject({ status: "archived" })
    expect(await h.control({ operation: "delete", memoryId: proposal.memoryId })).toMatchObject({ deleted: proposal.memoryId })
    expect(h.daemon.store.memories.get(proposal.memoryId)).toBeUndefined()
  })
  test("user imports and CRUD cannot escape their profile or declared scope", async () => {
    const h = await boot()
    await h.client.send({ type: "settings.set", patch: { profiles: [{ name: "company", directories: ["/company"] }] } })
    const user = (await h.control({ operation: "propose", text: "A company preference", scope: "user" }, "/company")).proposal as MemoryEntry
    expect(user).toMatchObject({ scope: "user", profile: "company" })
    expect(await h.client.memoryControl("/repo", { operation: "apply", memoryId: user.memoryId })).toMatchObject({ ok: false })
    expect(await h.client.memoryControl("/company", { operation: "edit", scope: "project", memoryId: user.memoryId, text: "wrong" })).toMatchObject({ ok: false })
  })
  test("revision approval rejects changed targets and rejection never touches a saved fact", async () => {
    const h = await boot()
    const target = h.seed("Original fact", { status: "saved" })
    const revision = h.seed("Updated fact", { kind: "update", targetId: target, reason: "Original fact" })
    h.daemon.store.memories.update(target, { text: "A newer manual fact" })
    expect(await h.client.memoryControl("/repo", { operation: "apply", memoryId: revision })).toMatchObject({ ok: false })
    expect(h.daemon.store.memories.get(target)?.text).toBe("A newer manual fact")
    const archive = h.seed("A newer manual fact", { kind: "archive", targetId: target })
    await h.control({ operation: "reject", memoryId: archive })
    expect(h.daemon.store.memories.get(target)?.status).toBe("saved")
  })
  test("project config persists and affects actual selector and preview without changing other projects", async () => {
    const h = await boot()
    h.seed("Use pnpm in this repository", { status: "saved" })
    h.seed("Second remembered command", { status: "saved" })
    expect(await h.control({ operation: "preview", query: "pnpm" })).toMatchObject({ use: false, promptBlock: "", entries: [] })
    await h.control({ operation: "config", project: true, patch: { memoryUse: true, memoryProjectMaxEntries: 1, memoryGlobalCompactionMaxEntries: 2 } })
    expect((await h.control({ operation: "preview", query: "pnpm" })).promptBlock).toContain("<mendcode_memory>")
    expect((await h.control({ operation: "preview", mode: "manual" })).entries as unknown[]).toHaveLength(2)
    expect(await h.control({ operation: "status" }, "/other")).toMatchObject({ config: { use: false } })
    const selector = createMemorySelector({ visible: () => h.daemon.store.memories.list({ directory: "/repo", status: "saved" }), related: () => [], links: () => [] }, { settings: (directory) => memorySettings(h.daemon.store.settings.get(), directory) })
    expect(selector.select({ directory: "/repo", prompt: "" }).memories).toHaveLength(1)
    expect(selector.block({ directory: "/other", prompt: "" })).toBe("")
    expect(h.daemon.store.settings.get().memoryProjects?.["/repo"]).toMatchObject({ memoryUse: true })
  })
  test("Codex preview is read-only, redacted, bounded and excludes rollout summaries and symlinks", async () => {
    const h = await boot()
    const root = path.join(h.dir, "codex")
    mkdirSync(path.join(root, "rollout_summaries"), { recursive: true })
    writeFileSync(path.join(root, "MEMORY.md"), "Use pnpm. sk-abcdEFGH1234ijklMNOP5678")
    writeFileSync(path.join(root, "rollout_summaries", "excluded.md"), "should not import")
    writeFileSync(path.join(root, "big.txt"), "x".repeat(256_001))
    symlinkSync(path.join(root, "MEMORY.md"), path.join(root, "linked.md"))
    const result = await h.control({ operation: "import-codex", from: root })
    expect(result).toMatchObject({ exists: true, apply: false, callsProviders: false, proposals: [], writesMemory: false })
    expect(result.candidates as unknown[]).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("sk-abcdEFGH1234ijklMNOP5678")
    expect(h.daemon.store.memories.list()).toHaveLength(0)
    expect(await h.control({ operation: "import-codex", from: path.join(root, "missing") })).toMatchObject({ exists: false, candidates: [] })
  })
  test("Codex --apply calls the extractor once and creates deduplicated user proposals, never saved facts", async () => {
    const calls: string[] = []
    const h = await boot({ extractMemory: async (job) => { calls.push(job.text); return [{ scope: "project", category: "commands", text: "Use pnpm for dependencies" }, { scope: "user", category: "commands", text: "Use pnpm for dependencies" }] } })
    const root = path.join(h.dir, "codex")
    mkdirSync(root)
    writeFileSync(path.join(root, "MEMORY.md"), "Use pnpm for dependencies")
    const result = await h.control({ operation: "import-codex", from: root, apply: true })
    expect(result).toMatchObject({ callsProviders: true, writesMemory: false, skipped: false })
    expect(result.proposals as MemoryEntry[]).toHaveLength(1)
    expect((result.proposals as MemoryEntry[])[0]).toMatchObject({ scope: "user", status: "pending", details: { tags: ["codex-import"] } })
    expect(calls).toHaveLength(1)
    expect((await h.control({ operation: "import-codex", from: root, apply: true })).proposals).toEqual([])
  })
  test("v1 sharing snapshots become v1-import proposals without a model; credentials, bad headers, links and known memories are skipped", async () => {
    const h = await boot()
    const root = path.join(h.dir, "v1-sharing")
    mkdirSync(root)
    const snapshot = (id: string, scope: string, text: string) => `<!-- mendcode-memory ${JSON.stringify({ version: 1, id, scope, identity: "a".repeat(64), revision: "b".repeat(64) })} -->\n\n${text}\n`
    writeFileSync(path.join(root, "README.md"), "# Shared MendCode memories")
    writeFileSync(path.join(root, "m1.md"), snapshot("m1", "project", "Run focused checks before committing."))
    writeFileSync(path.join(root, "m2.md"), snapshot("m2", "global", "Answer in Spanish."))
    writeFileSync(path.join(root, "m3.md"), snapshot("m3", "project", "OPENAI_API_KEY=sk-abcdEFGH1234ijklMNOP5678"))
    writeFileSync(path.join(root, "m4.md"), "no header here")
    writeFileSync(path.join(root, "m5.md"), snapshot("m5", "project", "Already known rule"))
    symlinkSync(path.join(root, "m1.md"), path.join(root, "m6.md"))
    h.seed("already known RULE", { status: "saved" })
    const preview = await h.control({ operation: "import-v1", from: root })
    expect(preview).toMatchObject({ exists: true, apply: false, callsProviders: false, proposals: [] })
    expect((preview.candidates as Array<{ id: string; scope: string }>).map((item) => [item.id, item.scope])).toEqual([["m1", "project"], ["m2", "user"]])
    expect(Object.fromEntries((preview.skipped as Array<{ file: string; reason: string }>).map((item) => [item.file, item.reason]))).toEqual({ "m3.md": "contains a credential", "m4.md": "no MendCode v1 memory header", "m5.md": "already in memory", "m6.md": "not a regular file" })
    expect(JSON.stringify(preview)).not.toContain("sk-abcdEFGH1234ijklMNOP5678")
    const applied = await h.control({ operation: "import-v1", from: root, apply: true })
    expect((applied.proposals as MemoryEntry[]).map((entry) => [entry.text, entry.scope, entry.status, entry.details?.tags])).toEqual([["Run focused checks before committing.", "project", "pending", ["v1-import"]], ["Answer in Spanish.", "user", "pending", ["v1-import"]]])
    expect((await h.control({ operation: "import-v1", from: root, apply: true })).proposals).toEqual([])
  })
  test("file extraction creates pending proposals; missing extractor is an explicit skip", async () => {
    const h = await boot({ extractMemory: async () => [{ scope: "project", category: "commands", text: "Run checks before a release" }] })
    writeFileSync(path.join(h.dir, "notes.md"), "Run checks before a release")
    expect((await h.control({ operation: "propose", fromFile: path.join(h.dir, "notes.md"), scope: "project" })).proposals as MemoryEntry[]).toHaveLength(1)
    const missing = await boot()
    writeFileSync(path.join(missing.dir, "notes.md"), "A fact")
    expect(await missing.control({ operation: "propose", fromFile: path.join(missing.dir, "notes.md") })).toMatchObject({ skipped: true, callsProviders: false, reason: "Memory extractor is not configured" })
  })
  test("reindex preserves memory identity and state and keeps saved search operational", async () => {
    const h = await boot()
    const memoryId = h.seed("Use pnpm for dependency installation", { status: "saved" })
    h.seed("Pending fact for later")
    expect(await h.control({ operation: "index" })).toMatchObject({ indexed: 2, callsProviders: false })
    const search = await h.client.send({ type: "memory.search", directory: "/repo", query: "pnpm" })
    expect(search.ok && (search.result?.memories as MemoryEntry[])[0]?.memoryId).toBe(memoryId)
    expect(h.daemon.store.memories.get(memoryId)?.status).toBe("saved")
  })
  test("project generation config reaches the durable extraction worker with global generation off", async () => {
    const h = await boot({ extractMemory: async () => [{ scope: "project", category: "commands", text: "Build this repository with pnpm build" }] })
    await h.control({ operation: "config", project: true, patch: { memoryGenerate: true } })
    const created = await h.client.send({ type: "session.create", directory: "/repo" })
    const sessionId = created.ok && created.result?.sessionId as SessionId
    if (!sessionId) throw new Error("No session")
    await h.client.send({ type: "user.submit", sessionId, text: "Our build procedure", attachments: [] })
    for (let i = 0; i < 200 && !h.daemon.store.extraction.list().some((job) => job.state === "completed"); i++) await Bun.sleep(5)
    expect(h.daemon.store.extraction.list()[0]).toMatchObject({ state: "completed", proposed: 1, directory: "/repo" })
    expect(h.daemon.store.settings.get().memoryGenerate).toBeUndefined()
    expect(h.daemon.store.memories.list()[0]).toMatchObject({ status: "pending", text: "Build this repository with pnpm build" })
  })
  test("stopping a manual extractor aborts it and never commits a late result", async () => {
    const h = await boot()
    let release!: (memories: Array<{ scope: "project"; category: string; text: string }>) => void
    let started = false
    const gate = new Promise<Array<{ scope: "project"; category: string; text: string }>>((resolve) => { release = resolve })
    const control = createMemoryControl({ store: h.daemon.store, profile: () => "personal", now: Date.now, id: () => ids("memory"), resolve: () => undefined, changed() {}, settingsChanged() {}, extract: async () => { started = true; return gate } })
    writeFileSync(path.join(h.dir, "notes.md"), "A supported durable command")
    const running = control.run("/repo", { operation: "propose", fromFile: path.join(h.dir, "notes.md") })
    for (let i = 0; i < 100 && !started; i++) await Bun.sleep(2)
    expect(started).toBe(true)
    control.stop()
    await expect(running).rejects.toThrow("Memory control stopped")
    release([{ scope: "project", category: "commands", text: "A late result" }])
    await Bun.sleep(1)
    expect(h.daemon.store.memories.list()).toEqual([])
  })
  test("a real client's manual extraction survives its shorter ordinary RPC deadline", async () => {
    const h = await boot({ extractMemory: async () => { await Bun.sleep(600); return [{ scope: "project", category: "commands", text: "Run typecheck before a release" }] } })
    const client = createClient({ socketPath: h.daemon.socketPath, name: "B19-deadline", timeoutMs: 200 })
    await client.connect()
    cleanup.push(() => client.close())
    writeFileSync(path.join(h.dir, "notes.md"), "Run typecheck before a release")
    const reply = await client.memoryControl("/repo", { operation: "propose", fromFile: path.join(h.dir, "notes.md") })
    expect(reply).toMatchObject({ ok: true, result: { callsProviders: true, proposals: [{ status: "pending" }] } })
  })
})

describe("B19 Dream controls", () => {
  test("status reports the integrated service, and a disabled tick makes no run", async () => {
    const h = await boot()
    expect(await h.dream({ operation: "status" })).toMatchObject({ schedule: { enabled: false, at: null }, service: { kind: "integrated", configured: false }, runs: [], callsProviders: false })
    expect(await h.dream({ operation: "tick" })).toMatchObject({ status: "skipped", reason: "Schedule disabled", runs: [] })
    expect(await h.client.dreamControl("/repo", { operation: "run" })).toMatchObject({ ok: false })
  })
  test("explicit ticks share the scheduler's persisted window and never repeat one", async () => {
    const h = await boot({ dream: { complete: async () => JSON.stringify({ proposals: [], notes: "" }) } })
    await h.client.send({ type: "session.create", directory: "/repo", title: "Active" })
    await h.client.send({ type: "settings.set", patch: { dreamAt: "03:00" } })
    const last = windows(Date.now(), "03:00").last
    h.daemon.store.meta.set("dream.window", dateKey(last - 86_400_000))
    expect(await h.dream({ operation: "tick" })).toMatchObject({ status: "started", runs: [{ runId: expect.any(Number) }] })
    expect(await h.dream({ operation: "tick" })).toMatchObject({ status: "skipped", runs: [] })
    expect(h.daemon.store.dreamRuns.list("/repo")).toHaveLength(1)
  })
  test("run waits for its final report and concurrent runs are refused", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = await boot({ dream: { complete: async () => { await gate; return JSON.stringify({ proposals: [], notes: "Finished" }) } } })
    const created = await h.client.send({ type: "session.create", directory: "/repo" })
    const sessionId = created.ok && created.result?.sessionId as SessionId
    if (!sessionId) throw new Error("No session")
    await h.client.send({ type: "user.submit", sessionId, text: "Remember how we build", attachments: [] })
    for (let i = 0; i < 100 && !h.daemon.store.readAfter(sessionId, 0).some((event) => event.type === "turn.completed"); i++) await Bun.sleep(5)
    const running = h.dream({ operation: "run", policy: "disabled" })
    for (let i = 0; i < 100 && !h.daemon.store.dreamRuns.list("/repo").length; i++) await Bun.sleep(2)
    expect(await h.client.dreamControl("/repo", { operation: "run" })).toMatchObject({ ok: false, error: { code: "busy" } })
    release()
    expect(await running).toMatchObject({ run: { status: "done", notes: "Finished" }, callsProviders: true })
  })
  test("consolidation preview keeps proposals; auto applies scored safe facts and archives duplicates and unsafe proposals", async () => {
    const h = await boot({ dream: { complete: async () => "{}" } })
    const safe = h.seed("Release with pnpm release", { details: { confidence: .95, durability: .95, changeRisk: .1 } })
    const duplicate = h.seed("Release with pnpm release")
    const unsafe = h.seed("A low confidence convention")
    const preview = await h.dream({ operation: "consolidate", policy: "preview" })
    expect(preview.consolidation).toMatchObject({ pendingBefore: 3, pendingAfter: 3, applied: 0, archived: 0 })
    expect(h.daemon.store.memories.get(safe)?.status).toBe("pending")
    const auto = await h.dream({ operation: "consolidate", policy: "auto-consolidate" })
    expect(auto.consolidation).toMatchObject({ applied: 1, archived: 2, pendingAfter: 0 })
    expect(h.daemon.store.memories.get(safe)?.status).toBe("saved")
    expect(h.daemon.store.memories.get(duplicate)?.status).toBe("archived")
    expect(h.daemon.store.memories.get(unsafe)?.status).toBe("archived")
    const status = await h.dream({ operation: "status" })
    expect((status.runs as DreamRun[])[0]?.report?.consolidation?.applied).toBe(1)
  })
})
