import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_WORKFLOW_RUN_BYTES, createIdFactory, type SessionId, type WorkflowRun } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-workflows-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 28, 12)

function open() {
  const dir = tempDir()
  let clock = NOW
  const store = openStore({ dir, now: () => clock })
  const at = (value: number) => void (clock = value)
  /** A session last touched `daysAgo` days ago. */
  function session(daysAgo: number) {
    const id = ids("session")
    at(NOW - daysAgo * DAY)
    store.createSession({ id, directory: "/repo", title: `s${daysAgo}` })
    at(NOW)
    return id
  }
  return { store, dir, session }
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const updatedAt = overrides.updatedAt ?? 1_000
  return {
    workflowId: ids("workflow"),
    name: "wf",
    directory: "/repo",
    objective: "Do the thing.",
    plan: { name: "wf", objective: "Do the thing.", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "go", needs: [], mode: "work" }] },
    planHash: "a".repeat(64),
    permission: "edits",
    state: "running",
    rootSessionId: ids("session"),
    tasks: [{ id: "a", title: "A", kind: "agent", mode: "work", needs: [], state: "running", attempt: 1, sessionId: ids("session") }],
    verifications: [],
    repairs: 0,
    startedAt: 500,
    updatedAt,
    ...overrides,
  }
}

describe("store.workflows", () => {
  test("a saved run comes back identical, newest activity first, and save replaces the same id", () => {
    const { store } = open()
    const first = run({ updatedAt: 1_000 })
    const second = run({ updatedAt: 2_000, state: "paused" })
    store.workflows.save(first)
    store.workflows.save(second)
    expect(store.workflows.all()).toEqual([second, first])
    const moved = { ...first, updatedAt: 3_000, state: "verifying" as const }
    store.workflows.save(moved)
    expect(store.workflows.all()).toEqual([moved, second])
    store.close()
  })

  test("a run survives closing and reopening the store", () => {
    const { store, dir } = open()
    const saved = run({ state: "needs_input" })
    store.workflows.save(saved)
    store.close()
    const reopened = openStore({ dir })
    expect(reopened.workflows.all()).toEqual([saved])
    expect(reopened.workflows.hasLive()).toBe(true)
    reopened.close()
  })

  test("remove deletes one run and leaves the others", () => {
    const { store } = open()
    const keep = run()
    const drop = run()
    store.workflows.save(keep)
    store.workflows.save(drop)
    store.workflows.remove(drop.workflowId)
    store.workflows.remove(ids("workflow"))
    expect(store.workflows.all()).toEqual([keep])
    store.close()
  })

  test("a row that no longer validates is skipped, not fatal", () => {
    const { store, dir } = open()
    const good = run()
    store.workflows.save(good)
    const raw = new Database(path.join(dir, "mendd.db"))
    raw.query("INSERT INTO workflows(id, directory, state, payload, updated_at) VALUES (?, ?, ?, ?, ?)").run(ids("workflow"), "/repo", "running", JSON.stringify({ nope: true }), 5)
    raw.close()
    expect(store.workflows.all()).toEqual([good])
    store.close()
  })

  test("hasLive is false when empty and when every run is finished, true for any unfinished state", () => {
    const { store } = open()
    expect(store.workflows.hasLive()).toBe(false)
    for (const state of ["completed", "failed", "stopped"] as const) store.workflows.save(run({ state }))
    expect(store.workflows.hasLive()).toBe(false)
    for (const state of ["running", "needs_input", "verifying", "paused", "blocked"] as const) {
      const live = run({ state })
      store.workflows.save(live)
      expect(store.workflows.hasLive()).toBe(true)
      store.workflows.remove(live.workflowId)
      expect(store.workflows.hasLive()).toBe(false)
    }
    store.close()
  })

  test("a run over the size bound is refused and the stored one is untouched", () => {
    const { store } = open()
    const saved = run()
    store.workflows.save(saved)
    const huge = { ...saved, reason: "x".repeat(MAX_WORKFLOW_RUN_BYTES) }
    expect(() => store.workflows.save(huge)).toThrow(RangeError)
    expect(store.workflows.all()).toEqual([saved])
    store.close()
  })
})

describe("workflow retention", () => {
  test("keeps the newest 50 finished runs and evicts the oldest on save", () => {
    const { store } = open()
    const finished = Array.from({ length: 50 }, (_, i) => run({ state: i % 3 === 0 ? "failed" : i % 3 === 1 ? "stopped" : "completed", updatedAt: 1_000 + i }))
    for (const item of finished) store.workflows.save(item)
    expect(store.workflows.all()).toHaveLength(50)
    const extra = run({ state: "completed", updatedAt: 5_000 })
    store.workflows.save(extra)
    const kept = store.workflows.all()
    expect(kept).toHaveLength(50)
    expect(kept[0]).toEqual(extra)
    expect(kept.map((item) => item.workflowId)).not.toContain(finished[0]!.workflowId)
    expect(kept.map((item) => item.workflowId)).toContain(finished[1]!.workflowId)
    store.close()
  })

  test("unfinished runs are never evicted and do not count toward the cap", () => {
    const { store } = open()
    const live = [run({ state: "paused", updatedAt: 1 }), run({ state: "blocked", updatedAt: 2 }), run({ state: "running", updatedAt: 3 })]
    for (const item of live) store.workflows.save(item)
    for (let i = 0; i < 60; i++) store.workflows.save(run({ state: "completed", updatedAt: 100 + i }))
    const all = store.workflows.all()
    expect(all).toHaveLength(53)
    for (const item of live) expect(all.map((stored) => stored.workflowId)).toContain(item.workflowId)
    expect(all.filter((item) => item.state === "completed")).toHaveLength(50)
    store.close()
  })

  test("a run that finishes stops counting as live and can push an old finished run out", () => {
    const { store } = open()
    const old = run({ state: "completed", updatedAt: 10 })
    store.workflows.save(old)
    for (let i = 0; i < 49; i++) store.workflows.save(run({ state: "stopped", updatedAt: 100 + i }))
    const running = run({ state: "running", updatedAt: 20 })
    store.workflows.save(running)
    expect(store.workflows.all()).toHaveLength(51)
    store.workflows.save({ ...running, state: "failed", updatedAt: 200 })
    const all = store.workflows.all()
    expect(all).toHaveLength(50)
    expect(all.map((item) => item.workflowId)).not.toContain(old.workflowId)
    expect(all.map((item) => item.workflowId)).toContain(running.workflowId)
    expect(store.workflows.hasLive()).toBe(false)
    store.close()
  })

  test("a finished run older than every kept one is still stored when it is the one being saved", () => {
    const { store } = open()
    for (let i = 0; i < 50; i++) store.workflows.save(run({ state: "completed", updatedAt: 1_000 + i }))
    const ancient = run({ state: "completed", updatedAt: 1 })
    store.workflows.save(ancient)
    const all = store.workflows.all()
    expect(all).toHaveLength(50)
    expect(all.map((item) => item.workflowId)).toContain(ancient.workflowId)
    store.close()
  })
})

describe("cleanStorage and workflows", () => {
  test("keeps the root, task and auditor sessions of every unfinished workflow and cleans finished ones", () => {
    const { store, session } = open()
    const exists = (id: SessionId) => store.hasSession(id)
    const root = session(300)
    const taskOne = session(300)
    const taskTwo = session(300)
    const auditor = session(300)
    const unrelated = session(300)
    const doneRoot = session(300)
    const doneTask = session(300)
    const withTasks = (state: WorkflowRun["state"], rootSessionId: SessionId, sessions: SessionId[], audit?: SessionId): WorkflowRun =>
      run({
        state,
        rootSessionId,
        tasks: sessions.map((sessionId, i) => ({ id: `t${i}`, title: `T${i}`, kind: "agent" as const, mode: "work" as const, needs: [], state: "done" as const, attempt: 1, sessionId })),
        verifications: audit
          ? [{ round: 1, at: 1, gates: [], audit: { verdict: "pass" as const, sessionId: audit, inspections: 2, findings: "ok", criteria: [] }, criteria: [], accepted: false }]
          : [],
      })
    store.workflows.save(withTasks("verifying", root, [taskOne, taskTwo], auditor))
    store.workflows.save(withTasks("completed", doneRoot, [doneTask]))
    const result = store.cleanStorage({ olderThanDays: 90 })
    expect(result).toMatchObject({ sessionsRemoved: 3, protectedSessions: 4 })
    for (const kept of [root, taskOne, taskTwo, auditor]) expect(exists(kept)).toBe(true)
    for (const gone of [unrelated, doneRoot, doneTask]) expect(exists(gone)).toBe(false)
    store.close()
  })

  test("a paused or blocked workflow keeps its sessions and a stopped one does not", () => {
    const { store, session } = open()
    const paused = session(300)
    const blocked = session(300)
    const stopped = session(300)
    store.workflows.save(run({ state: "paused", rootSessionId: paused, tasks: [] }))
    store.workflows.save(run({ state: "blocked", rootSessionId: blocked, tasks: [] }))
    store.workflows.save(run({ state: "stopped", rootSessionId: stopped, tasks: [] }))
    expect(store.cleanStorage({ olderThanDays: 90 })).toMatchObject({ sessionsRemoved: 1, protectedSessions: 2 })
    expect(store.hasSession(paused)).toBe(true)
    expect(store.hasSession(blocked)).toBe(true)
    expect(store.hasSession(stopped)).toBe(false)
    store.close()
  })

  test("a dry run counts the protected workflow sessions too", () => {
    const { store, session } = open()
    const root = session(300)
    session(300)
    store.workflows.save(run({ state: "running", rootSessionId: root, tasks: [] }))
    expect(store.cleanStorage({ olderThanDays: 90, dryRun: true })).toMatchObject({ sessionsRemoved: 1, protectedSessions: 1 })
    expect(store.hasSession(root)).toBe(true)
    store.close()
  })
})
