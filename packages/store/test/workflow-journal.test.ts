import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type WorkflowRun } from "@mendcode/protocol"
import { openStore } from "../src"
import { MAX_JOURNAL_PAYLOAD_BYTES, MAX_JOURNAL_RUN_BYTES } from "../src/workflow-journal"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ids = createIdFactory()

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-journal-"))
  dirs.push(dir)
  return dir
}

function run(state: WorkflowRun["state"] = "running", updatedAt = 1_000): WorkflowRun {
  return {
    workflowId: ids("workflow"),
    name: "wf",
    directory: "/repo",
    objective: "Do the thing.",
    plan: { name: "wf", objective: "Do the thing.", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "go", needs: [], mode: "work" }] },
    planHash: "a".repeat(64),
    permission: "edits",
    state,
    rootSessionId: ids("session"),
    tasks: [],
    verifications: [],
    repairs: 0,
    startedAt: 500,
    updatedAt,
  }
}

describe("store.workflowJournal", () => {
  test("rows survive closing and reopening the store, per run and in key order", () => {
    const dir = tempDir()
    const first = openStore({ dir, now: () => 1_000 })
    first.workflowJournal.set("wfl_a", "call:2", '{"v":2}')
    first.workflowJournal.set("wfl_a", "call:1", '{"v":1}')
    first.workflowJournal.set("wfl_a", "memo:k", '"m"')
    first.workflowJournal.set("wfl_b", "call:1", '{"other":true}')
    first.close?.()
    const again = openStore({ dir, now: () => 2_000 })
    expect(again.workflowJournal.get("wfl_a", "call:1")).toBe('{"v":1}')
    expect(again.workflowJournal.list("wfl_a", "call:").map((row) => row.key)).toEqual(["call:1", "call:2"])
    expect(again.workflowJournal.list("wfl_a").map((row) => row.key)).toEqual(["call:1", "call:2", "memo:k"])
    expect(again.workflowJournal.get("wfl_b", "call:2")).toBeUndefined()
  })

  test("set replaces a key, delete removes it", () => {
    const store = openStore({ dir: tempDir(), now: () => 1_000 })
    store.workflowJournal.set("wfl_a", "call:1", "1")
    store.workflowJournal.set("wfl_a", "call:1", "22")
    expect(store.workflowJournal.get("wfl_a", "call:1")).toBe("22")
    store.workflowJournal.delete("wfl_a", "call:1")
    expect(store.workflowJournal.get("wfl_a", "call:1")).toBeUndefined()
  })

  test("an entry over the payload limit is refused, not truncated", () => {
    const store = openStore({ dir: tempDir(), now: () => 1_000 })
    expect(() => store.workflowJournal.set("wfl_a", "call:1", "x".repeat(MAX_JOURNAL_PAYLOAD_BYTES + 1))).toThrow(RangeError)
    expect(store.workflowJournal.get("wfl_a", "call:1")).toBeUndefined()
    store.workflowJournal.set("wfl_a", "call:1", "x".repeat(MAX_JOURNAL_PAYLOAD_BYTES))
    expect(store.workflowJournal.get("wfl_a", "call:1")?.length).toBe(MAX_JOURNAL_PAYLOAD_BYTES)
  })

  test("a run's whole journal is bounded, and replacing a key does not count it twice", () => {
    const store = openStore({ dir: tempDir(), now: () => 1_000 })
    const chunk = "y".repeat(MAX_JOURNAL_PAYLOAD_BYTES)
    const fits = Math.floor(MAX_JOURNAL_RUN_BYTES / MAX_JOURNAL_PAYLOAD_BYTES)
    for (let i = 0; i < fits; i++) store.workflowJournal.set("wfl_a", `call:${i}`, chunk)
    expect(() => store.workflowJournal.set("wfl_a", "call:extra", "z")).toThrow(/exceeds/)
    store.workflowJournal.set("wfl_a", "call:0", chunk)
    store.workflowJournal.set("wfl_b", "call:0", chunk)
  })

  test("removing a run deletes its journal; pruned finished runs leave no orphans", () => {
    const store = openStore({ dir: tempDir(), now: () => 1_000 })
    const gone = run()
    const kept = run()
    store.workflows.save(gone)
    store.workflows.save(kept)
    store.workflowJournal.set(gone.workflowId, "call:1", "1")
    store.workflowJournal.set(kept.workflowId, "call:1", "1")
    store.workflowJournal.set("wfl_orphan", "call:1", "1")
    store.workflows.remove(gone.workflowId)
    expect(store.workflowJournal.list(gone.workflowId)).toEqual([])
    expect(store.workflowJournal.list(kept.workflowId)).toHaveLength(1)
    store.workflowJournal.removeOrphans()
    expect(store.workflowJournal.list("wfl_orphan")).toEqual([])
    expect(store.workflowJournal.list(kept.workflowId)).toHaveLength(1)
  })
})
