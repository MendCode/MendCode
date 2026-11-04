import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type MemoryEntry, type Settings } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { consolidationCategories, FULL_MEMORY_DEFAULTS, memorySettings } from "../src/memory-config"
import { consolidateMemory } from "../src/memory-consolidation"
import { createResumeSource, resumeNote, RESUME_MAX_CHARS } from "../src/memory-resume"
import { ROLE_FALLBACKS } from "../src/models"

const ids = createIdFactory()
const memory = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", category: "preferences", source: "agent", status: "pending", createdAt: 0, updatedAt: 0, text, details: { confidence: .95, durability: .9, changeRisk: .1 }, ...patch })

describe("memory by tier", () => {
  test("only the full tier fills unset memory switches, and a switch the user set wins", () => {
    expect(memorySettings({} as Settings, "/repo")).toEqual({})
    expect(memorySettings({ tier: "balanced" } as Settings).memoryUse).toBeUndefined()
    expect(memorySettings({ tier: "minimalist" } as Settings).memoryGenerate).toBeUndefined()
    const full = memorySettings({ tier: "full" } as Settings)
    expect(full).toMatchObject(FULL_MEMORY_DEFAULTS)
    expect(memorySettings({ tier: "full", memoryUse: false } as Settings).memoryUse).toBe(false)
    expect(memorySettings({ tier: "full", memoryProjects: { "/repo": { memoryGenerate: false } } } as Settings, "/repo").memoryGenerate).toBe(false)
    expect(memorySettings({ tier: "full", features: { memory_auto: false } } as Settings).memoryUse).toBeUndefined()
  })
  test("nightly consolidation saves preferences in full, and holds back what needs a person instead of archiving it", async () => {
    expect(consolidationCategories({ tier: "balanced" } as Settings)).not.toContain("preferences")
    expect(consolidationCategories({ tier: "full" } as Settings)).toContain("preferences")
    let entries = [memory("Always answer in Spanish"), memory("Misc note", { category: "other" })]
    const apply = async (m: MemoryEntry) => { entries = entries.map((e) => e.memoryId === m.memoryId ? { ...e, status: "saved" } : e) }
    const archive = (m: MemoryEntry) => { entries = entries.map((e) => e.memoryId === m.memoryId ? { ...e, status: "archived" } : e) }
    const result = await consolidateMemory({ entries: () => entries, policy: "auto-consolidate", limit: 50, apply, archive, categories: consolidationCategories({ tier: "full" } as Settings), holdForReview: true })
    expect(result).toMatchObject({ applied: 1, archived: 0, pendingAfter: 1 })
    expect(result.decisions.map((d) => d.outcome).sort()).toEqual(["applied", "kept"])
  })
  test("dream and the extractor fall back to the cheap small model before main", () => {
    expect(ROLE_FALLBACKS.dream).toEqual(["small"])
  })
})

describe("dream interruption and the resume note", () => {
  const dirs: string[] = []
  const stores: ReturnType<typeof openStore>[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  function open() {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-resume-"))
    dirs.push(dir)
    const store = openStore({ dir })
    stores.push(store)
    return store
  }
  test("runs a stopped daemon left running are closed as interrupted", () => {
    const store = open()
    const run = store.dreamRuns.start("/repo", "scheduled")
    expect(store.dreamRuns.abandonRunning("Interrupted: the daemon stopped")).toEqual([{ runId: run.runId, directory: "/repo" }])
    expect(store.dreamRuns.get(run.runId)).toMatchObject({ status: "failed", error: "Interrupted: the daemon stopped" })
    expect(store.dreamRuns.abandonRunning("x")).toEqual([])
  })
  test("a new chat gets a bounded note of this project's and other projects' latest sessions", () => {
    const store = open()
    const chat = (directory: string, title: string, text?: string) => {
      const sessionId = ids("session")
      store.createSession({ id: sessionId, directory, title })
      if (text) {
        const turnId = ids("turn"), itemId = ids("item")
        store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
        store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
        store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
        store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      }
      return sessionId
    }
    chat("/work/app", "Fix login", "Fix the login redirect loop in auth.ts " + "x".repeat(400))
    chat("/work/other", "Docs pass", "Rewrite the install docs")
    const fresh = chat("/work/app", "New chat")
    const note = resumeNote({ store, sessionId: fresh, directory: "/work/app", now: Date.now() })
    expect(note).toContain("This project:")
    expect(note).toContain("Fix the login redirect loop")
    expect(note).toContain("Other projects:")
    expect(note).toContain("other · ")
    expect(note.length).toBeLessThanOrEqual(RESUME_MAX_CHARS)
    expect(resumeNote({ store, sessionId: fresh, directory: "/nowhere", now: Date.now() + 30 * 86_400_000 })).toBe("")
  })
  test("served from the system prompt: nothing is written to the session, the text stays identical, and a chat with turns gets none", () => {
    const store = open()
    const add = (directory: string, title: string, text: string, done = true) => {
      const sessionId = ids("session")
      store.createSession({ id: sessionId, directory, title })
      const turnId = ids("turn"), itemId = ids("item")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
      if (done) store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      return sessionId
    }
    add("/work/app", "Old work", "Ship the billing page")
    const fresh = ids("session")
    store.createSession({ id: fresh, directory: "/work/app", title: "" })
    let on = false
    const source = createResumeSource({ store, now: Date.now, enabled: () => on })
    expect(source(fresh, "/work/app")).toBe("")
    on = true
    const before = store.readAfter(fresh, 0, 1000).length
    const sessions = store.listSessions({ limit: 50 }).length
    const first = source(fresh, "/work/app")
    expect(first).toContain("Ship the billing page")
    add("/work/app", "Newer", "Something else entirely")
    expect(source(fresh, "/work/app")).toBe(first)
    expect(store.readAfter(fresh, 0, 1000).length).toBe(before)
    expect(store.listSessions({ limit: 50 }).length).toBe(sessions + 1)
    const running = add("/work/app", "Mid chat", "hello", true)
    expect(source(running, "/work/app")).toBe("")
  })
})
