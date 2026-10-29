import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type DreamReport, type MemoryId, type SessionId } from "@mendcode/protocol"
import { ftsAnyQuery, openStore } from "../src"

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-store-scope-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
type Store = ReturnType<typeof openStore>

function add(store: Store, patch: { text: string; scope?: "user" | "project" | "session"; directory?: string; sessionId?: SessionId; status?: "saved" | "pending"; pinned?: boolean; category?: string }) {
  const memoryId = ids("memory")
  const scope = patch.scope ?? "project"
  store.memories.add({
    memoryId,
    scope,
    ...(scope !== "user" ? { directory: patch.directory ?? "/repo" } : {}),
    ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
    text: patch.text,
    category: patch.category ?? "commands",
    status: patch.status ?? "saved",
    source: "user",
    ...(patch.pinned ? { pinned: true } : {}),
  })
  return memoryId
}

function session(store: Store, directory = "/repo") {
  const id = ids("session")
  store.createSession({ id, directory, title: "" })
  return id
}

describe("session scope", () => {
  test("a session memory is visible only to its own session (or to `all`), never to project or user views", () => {
    const store = openStore({ dir: tempDir() })
    const a = session(store)
    const b = session(store)
    const mine = add(store, { scope: "session", sessionId: a, text: "Scratch plan for session a" })
    add(store, { scope: "session", sessionId: b, text: "Scratch plan for session b" })
    const project = add(store, { text: "Project rule" })
    expect(store.memories.list({ directory: "/repo" }).map((m) => m.memoryId)).toEqual([project])
    expect(store.memories.list({ directory: "/repo", session: a }).map((m) => m.memoryId).sort()).toEqual([mine, project].sort())
    expect(store.memories.list({ directory: "/repo", session: "all" })).toHaveLength(3)
    expect(store.memories.get(mine)).toMatchObject({ scope: "session", sessionId: a, directory: "/repo" })
    expect(store.memories.search({ query: "scratch plan" })).toEqual([])
    expect(store.memories.search({ query: "scratch plan", session: a }).map((m) => m.memoryId)).toEqual([mine])
    expect(store.memories.related({ text: "what was the scratch plan", directory: "/repo" })).toEqual([])
    expect(store.memories.related({ text: "what was the scratch plan", directory: "/repo", session: b }).map((hit) => hit.memory.text)).toEqual(["Scratch plan for session b"])
    store.close()
  })

  test("deleting a session deletes its memories, their links and search rows; cleaning old sessions does too", () => {
    const store = openStore({ dir: tempDir() })
    const a = session(store)
    const mine = add(store, { scope: "session", sessionId: a, text: "Scratch plan for session a" })
    const project = add(store, { text: "Project rule" })
    expect(store.memories.link({ from: mine, to: project, kind: "related" })).toBeDefined()
    expect(store.deleteSession(a)).toBe(true)
    expect(store.memories.get(mine)).toBeUndefined()
    expect(store.memories.links([mine, project])).toEqual([])
    expect(store.memories.related({ text: "scratch plan", session: "all" })).toEqual([])
    expect(store.memories.get(project)).toBeDefined()
    store.close()
  })
})

describe("pinned memories", () => {
  test("pin, unpin and count per place; archiving a pinned memory unpins it", () => {
    const store = openStore({ dir: tempDir() })
    const one = add(store, { text: "Always run bun test", pinned: true })
    const two = add(store, { text: "Never force push" })
    add(store, { text: "Other project rule", directory: "/other", pinned: true })
    expect(store.memories.get(one)).toMatchObject({ pinned: true })
    expect(store.memories.get(two)?.pinned).toBeUndefined()
    expect(store.memories.pinnedIn({ scope: "project", directory: "/repo" })).toBe(1)
    expect(store.memories.pinnedIn({ scope: "project", directory: "/repo" }, one)).toBe(0)
    store.memories.update(two, { pinned: true })
    expect(store.memories.pinnedIn({ scope: "project", directory: "/repo" })).toBe(2)
    store.memories.update(one, { status: "archived" })
    expect(store.memories.get(one)?.pinned).toBeUndefined()
    expect(store.memories.pinnedIn({ scope: "project", directory: "/repo" })).toBe(1)
    store.close()
  })
})

describe("related search", () => {
  test("any distinctive word of a prompt matches, best first; stop words and pending memories are ignored", () => {
    const store = openStore({ dir: tempDir() })
    const deploy = add(store, { text: "Deploy with fly deploy after the release tag" })
    add(store, { text: "Tests run with bun test" })
    add(store, { text: "Deploy secrets live in the vault", status: "pending" })
    const hits = store.memories.related({ text: "how do I deploy the release now?", directory: "/repo" })
    expect(hits.map((hit) => hit.memory.memoryId)).toEqual([deploy])
    expect(hits[0]!.rank).toBeLessThan(0)
    expect(store.memories.related({ text: "the and with for", directory: "/repo" })).toEqual([])
    expect(ftsAnyQuery("How do I deploy the release?")).toBe('"deploy"* OR "release"*')
    expect(ftsAnyQuery('say "hi" to OR AND NEAR')).toBe('"say"* OR "near"*')
    store.close()
  })
})

describe("migration", () => {
  test("a database from before scopes, pins, reports and digests gains what it needs and keeps its rows", () => {
    const dir = tempDir()
    const legacy = new Database(path.join(dir, "mendd.db"), { create: true, strict: true })
    legacy.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
    legacy.run("CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, directory TEXT, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID")
    legacy.run("CREATE TABLE dream_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, directory TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, proposed INTEGER NOT NULL DEFAULT 0, notes TEXT, error TEXT)")
    legacy.run("INSERT INTO memories VALUES ('memory_old', 'project', '/repo', 'Use pnpm', 'commands', 'saved', 'user', 1, 2)")
    legacy.run("INSERT INTO dream_runs(directory, status, started_at) VALUES ('/repo', 'done', 5)")
    legacy.close()
    const store = openStore({ dir })
    expect(store.memories.get("memory_old" as MemoryId)).toMatchObject({ text: "Use pnpm", scope: "project" })
    expect(store.dreamRuns.list("/repo")).toMatchObject([{ status: "done", startedAt: 5 }])
    store.memories.update("memory_old" as MemoryId, { pinned: true })
    expect(store.memories.get("memory_old" as MemoryId)?.pinned).toBe(true)
    store.close()
  })
})

describe("dream ledger", () => {
  const report: DreamReport = {
    read: { sessions: [], memories: 2, promptChars: 100 },
    proposed: [],
    refused: [{ item: "x", reason: "y" }],
    redactions: { evidence: 0, proposals: 0 },
    model: { calls: 1, inputTokens: 10, outputTokens: 5, estimated: false },
    budget: { limit: 60_000, used: 15, stopped: false },
    failures: [],
  }

  test("a run keeps its trigger and report; the list carries the report of the newest five only, `get` any", () => {
    const store = openStore({ dir: tempDir() })
    const runs = Array.from({ length: 7 }, (_, i) => {
      const run = store.dreamRuns.start("/repo", i === 0 ? "recovered" : "manual")
      store.dreamRuns.finish(run.runId, { status: "done", proposed: i, report })
      return run.runId
    })
    expect(store.dreamRuns.get(runs[0]!)).toMatchObject({ trigger: "recovered", proposed: 0, report })
    const listed = store.dreamRuns.list("/repo")
    expect(listed).toHaveLength(7)
    expect(listed.filter((run) => run.report).map((run) => run.runId)).toEqual(runs.slice(2).reverse())
    expect(store.dreamRuns.start("/repo")).not.toHaveProperty("trigger")
    store.close()
  })

  test("a report that no longer validates is left out rather than failing the list", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const run = store.dreamRuns.start("/repo", "manual")
    store.dreamRuns.finish(run.runId, { status: "done", report })
    store.close()
    const raw = new Database(path.join(dir, "mendd.db"), { strict: true })
    raw.run("UPDATE dream_runs SET report = '{\"nope\":1}'")
    raw.close()
    const again = openStore({ dir })
    expect(again.dreamRuns.list("/repo")[0]).toMatchObject({ status: "done" })
    expect(again.dreamRuns.list("/repo")[0]!.report).toBeUndefined()
    again.close()
  })
})

describe("digest cache and meta", () => {
  test("a digest is returned only for the state and format it was built from, and goes with its session", () => {
    const store = openStore({ dir: tempDir() })
    const s = session(store)
    store.digests.put(s, { sourceSeq: 4, version: 1, payload: '{"x":1}' })
    expect(store.digests.get(s, { sourceSeq: 4, version: 1 })).toBe('{"x":1}')
    expect(store.digests.get(s, { sourceSeq: 5, version: 1 })).toBeUndefined()
    expect(store.digests.get(s, { sourceSeq: 4, version: 2 })).toBeUndefined()
    expect(() => store.digests.put(s, { sourceSeq: 4, version: 1, payload: "x".repeat(20_000) })).toThrow(RangeError)
    store.deleteSession(s)
    expect(store.digests.get(s, { sourceSeq: 4, version: 1 })).toBeUndefined()
    store.meta.set("dream.window", "2026-09-29")
    expect(store.meta.get("dream.window")).toBe("2026-09-29")
    expect(store.meta.get("nothing")).toBeUndefined()
    store.close()
  })
})

describe("evolution ledger", () => {
  test("recurring ideas need two sessions; observe rows carry no text; evidence goes with its session", () => {
    const store = openStore({ dir: tempDir() })
    const [a, b] = [session(store), session(store)]
    store.evolution.record([{ directory: "/repo", sessionId: a, source: "correction", fingerprint: "f1" }, { directory: "/repo", sessionId: a, source: "preference", fingerprint: "f2", text: "Always answer in Spanish" }])
    expect(store.evolution.recurring("/repo")).toEqual([])
    store.evolution.record([{ directory: "/repo", sessionId: b, source: "correction", fingerprint: "f1", text: "Use pnpm instead of npm" }])
    expect(store.evolution.recurring("/repo")).toMatchObject([{ fingerprint: "f1", source: "correction", sessions: 2, text: "Use pnpm instead of npm" }])
    expect(store.evolution.observed("/repo")).toEqual({ corrections: 1, preferences: 1, recurring: 1 })
    expect(store.evolution.observed("/other")).toEqual({ corrections: 0, preferences: 0, recurring: 0 })
    // Recording the same thing again does not count twice, and later text fills an earlier observe row.
    store.evolution.record([{ directory: "/repo", sessionId: a, source: "correction", fingerprint: "f1", text: "Use pnpm please not npm" }])
    expect(store.evolution.recurring("/repo")[0]).toMatchObject({ sessions: 2 })
    store.deleteSession(b)
    expect(store.evolution.recurring("/repo")).toEqual([])
    store.close()
  })

  test("suggestions: no duplicates of a pending or accepted one, a rejected one may come back, pending ones are capped", () => {
    const store = openStore({ dir: tempDir() })
    const input = { directory: "/repo", kind: "skill" as const, name: "use-pnpm", description: "Install with pnpm", content: "Run pnpm install.", evidence: 2 }
    const first = store.evolution.suggest(input)!
    expect(first).toMatchObject({ kind: "skill", name: "use-pnpm", status: "pending", evidence: 2 })
    expect(store.evolution.suggest(input)).toBeUndefined()
    expect(store.evolution.resolve(first.suggestionId, "rejected")).toMatchObject({ status: "rejected", resolvedAt: expect.any(Number) })
    expect(store.evolution.suggest(input)).toBeDefined()
    // Resolving twice changes nothing.
    expect(store.evolution.resolve(first.suggestionId, "accepted")?.status).toBe("rejected")
    for (let i = 0; i < 120; i++) store.evolution.suggest({ ...input, name: `skill-number-${i}` })
    expect(store.evolution.suggestions("/repo", "pending").length).toBeLessThanOrEqual(50)
    expect(store.evolution.suggest({ ...input, name: "one-more-skill" })).toBeUndefined()
    store.close()
  })
})
