import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createIdFactory, LedgerPage, CompletionReceipt, type Loop, type WorkflowRun } from "@mendcode/protocol"
import { openStore } from "../src"
import { LEDGER_ENTRY_LIMIT } from "../src/automation-ledger"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(path.join(tmpdir(), "b69-store-")); dirs.push(d); return d }
const workflow = (): WorkflowRun => ({ workflowId: ids("workflow"), name: "wire", directory: "/repo", objective: "preserve wire", plan: { name: "wire", objective: "preserve wire", tasks: [{ kind: "agent", id: "wire", title: "Wire", prompt: "check it", needs: [], mode: "read" }] }, planHash: "a".repeat(64), permission: "ask", state: "running", rootSessionId: ids("session"), tasks: [{ kind: "agent", id: "wire", title: "Wire", mode: "read", needs: [], state: "running", attempt: 1 }], verifications: [], repairs: 0, startedAt: 1, updatedAt: 1 })
const loop = (): Loop => ({ loopId: ids("loop"), name: "watch", directory: "/repo", objective: "watch", sessionId: ids("session"), state: "active", trigger: { kind: "manual" }, budget: { mode: "monitor" }, runs: 0, history: [], createdAt: 1, updatedAt: 1 })

test("workflow events and artifact attempts are immutable, deduplicated, paginated and survive restart", () => {
  const d = dir()
  let store = openStore({ dir: d })
  const run = workflow()
  store.workflows.save(run)
  store.workflows.save({ ...run, state: "failed", tasks: [{ ...run.tasks[0]!, state: "failed", reason: "first attempt failed" }], updatedAt: 2 })
  store.workflows.save({ ...run, tasks: [{ ...run.tasks[0]!, attempt: 2 }], updatedAt: 3 })
  const done: WorkflowRun = { ...run, state: "completed", tasks: [{ ...run.tasks[0]!, state: "done", attempt: 2, result: "wire preserved" }], updatedAt: 4 }
  store.workflows.save(done)
  const all = store.automationLedger.page("workflow", run.workflowId, undefined, { limit: 100 })
  store.workflows.save(done)
  expect(store.automationLedger.page("workflow", run.workflowId).latestSequence).toBe(all.latestSequence)
  expect(all.entries.filter((e) => e.kind === "task-result").map((e) => e.data.attempt)).toEqual([2, 1])
  expect(all.entries.filter((e) => e.category === "event").map((e) => e.kind)).toContain("workflow.running")
  const first = store.automationLedger.page("workflow", run.workflowId, undefined, { limit: 2 })
  const second = store.automationLedger.page("workflow", run.workflowId, undefined, { limit: 2, before: first.nextBefore! })
  expect(second.entries[0]!.sequence).toBeLessThan(first.entries.at(-1)!.sequence)
  expect(new Set([...first.entries, ...second.entries].map((e) => e.sequence)).size).toBe(4)
  expect(LedgerPage.safeParse(all).success).toBe(true)
  expect(store.automationLedger.page("workflow", run.workflowId, "receipt").entries[0]!.data.verified).toBe(false)
  expect(CompletionReceipt.safeParse(store.automationLedger.page("workflow", run.workflowId, "receipt").entries[0]!.data).success).toBe(true)
  store.close()
  store = openStore({ dir: d })
  expect(store.automationLedger.page("workflow", run.workflowId, undefined, { limit: 100 })).toEqual(all)
  store.workflows.remove(run.workflowId)
  expect(store.automationLedger.known("workflow", run.workflowId)).toBe(false)
  store.close()
})

test("loop evidence retains 50 runs beyond the 20-run projection, and unknown cost stays unknown", () => {
  const store = openStore({ dir: dir() })
  let saved = loop()
  for (let n = 1; n <= 53; n++) {
    saved = { ...saved, runs: n, updatedAt: n * 10, history: [...saved.history, { run: n, startedAt: n * 10, endedAt: n * 10 + 1, outcome: "completed" as const, checkpoint: { status: "continue" as const, summary: `run ${n}`, next: `next ${n}` }, usage: { tokens: 50, costMicros: 0, unknownCostCalls: 1 } }].slice(-20) }
    store.loops.save(saved)
  }
  const early = store.automationLedger.page("loop", saved.loopId, "artifact", { run: 4 })
  expect(early.entries.map((e) => e.kind)).toEqual(["cost", "memory", "checkpoint"])
  expect(early.entries[0]!.summary).toContain("cost unknown")
  expect(early.truncated).toBe(true)
  expect(store.automationLedger.page("loop", saved.loopId, undefined, { run: 3 }).entries).toEqual([])
  expect(CompletionReceipt.safeParse(store.automationLedger.page("loop", saved.loopId, "receipt").entries[0]!.data).success).toBe(true)
  store.loops.remove(saved.loopId)
  expect(store.automationLedger.known("loop", saved.loopId)).toBe(false)
  store.close()
})

test("bounded run protects latest checkpoint, rejected gate and manual override; sequences never reset", () => {
  const store = openStore({ dir: dir() })
  let saved: Loop = { ...loop(), runs: 1, history: [{ run: 1, startedAt: 1, endedAt: 2, outcome: "completed", checkpoint: { status: "complete", summary: "claim", evidence: ["file.ts:1"] }, gates: [{ id: "quality", status: "fail", detail: "missing evidence" }] }] }
  for (let n = 0; n < 530; n++) {
    saved = { ...saved, state: n % 2 ? "paused" : "blocked", updatedAt: n + 2 }
    store.loops.save(saved)
  }
  store.loops.save({ ...saved, state: "completed", override: { at: 900, reason: "Reviewed manually" }, updatedAt: 900 })
  const page = store.automationLedger.page("loop", saved.loopId)
  expect(page.retained).toBeLessThanOrEqual(LEDGER_ENTRY_LIMIT)
  expect(page.truncated).toBe(true)
  expect(page.latestSequence).toBeGreaterThan(LEDGER_ENTRY_LIMIT)
  const artifacts = store.automationLedger.page("loop", saved.loopId, "artifact")
  expect(artifacts.entries.map((e) => e.kind)).toContain("checkpoint")
  expect(artifacts.entries.map((e) => e.kind)).toContain("gate")
  expect(artifacts.entries[0]!.kind).toBe("override")
  expect(store.automationLedger.page("loop", saved.loopId, "receipt").entries[0]!.data.verified).toBe(false)
  store.close()
}, 15_000)

test("legacy snapshot explicitly marks missing history and byte pagination always makes progress", () => {
  const d = dir()
  const store = openStore({ dir: d })
  const run = workflow()
  store.close()
  const db = new Database(path.join(d, "mendd.db"))
  db.query("INSERT INTO workflows(id, directory, state, payload, updated_at) VALUES (?, ?, ?, ?, ?)").run(run.workflowId, run.directory, run.state, JSON.stringify(run), run.updatedAt)
  db.close()
  const reopened = openStore({ dir: d })
  expect(reopened.automationLedger.page("workflow", run.workflowId).historical).toBe(false)
  const big = workflow()
  big.plan.tasks = Array.from({ length: 4 }, (_, i) => ({ kind: "agent" as const, id: `t${i}`, title: `Task ${i}`, prompt: "界".repeat(8_000), mode: "read" as const, needs: [] }))
  big.tasks = []
  reopened.workflows.save(big)
  const page = reopened.automationLedger.page("workflow", big.workflowId, undefined, { limit: 100 })
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024)
  expect(page.entries.length).toBeGreaterThan(0)
  expect(page.nextBefore).toBeDefined()
  reopened.close()
})

test("a plan's retention drops the oldest artifacts, events and aged entries, keeps the receipt and does not write dropped evidence again", () => {
  const store = openStore({ dir: dir() })
  const run = workflow()
  const retained = (retention: NonNullable<WorkflowRun["plan"]["retention"]>, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({ ...run, ...extra, plan: { ...run.plan, retention } })
  store.workflows.save(retained({ maxArtifacts: 1 }))
  store.workflows.save(retained({ maxArtifacts: 1 }, { state: "failed", tasks: [{ ...run.tasks[0]!, state: "failed", reason: "first attempt failed" }], updatedAt: 2 }))
  const done = retained({ maxArtifacts: 1 }, { state: "completed", tasks: [{ ...run.tasks[0]!, state: "done", attempt: 2, result: "wire preserved" }], updatedAt: 3 })
  store.workflows.save(done)
  const artifacts = store.automationLedger.page("workflow", run.workflowId, "artifact", { limit: 100 })
  expect(artifacts.entries).toHaveLength(1)
  expect(artifacts.truncated).toBe(true)
  const receipts = store.automationLedger.page("workflow", run.workflowId, "receipt").entries.length
  expect(receipts).toBe(3)
  const latest = store.automationLedger.page("workflow", run.workflowId).latestSequence
  store.workflows.save(done)
  store.workflows.save({ ...done, updatedAt: 4 })
  expect(store.automationLedger.page("workflow", run.workflowId).latestSequence).toBe(latest)
  const aged = retained({ maxAgeMs: 1 }, { state: "completed", tasks: [{ ...run.tasks[0]!, state: "done", attempt: 2, result: "wire preserved" }], updatedAt: 1_000 })
  store.workflows.save(aged)
  expect(store.automationLedger.page("workflow", run.workflowId, "event", { limit: 100 }).entries.every((entry) => entry.at >= 999)).toBe(true)
  expect(store.automationLedger.page("workflow", run.workflowId, "receipt").entries.length).toBeGreaterThanOrEqual(receipts)
  const small = retained({ maxBytes: 1 }, { updatedAt: 1_001, state: "failed" })
  store.workflows.save(small)
  const rest = store.automationLedger.page("workflow", run.workflowId, undefined, { limit: 100 })
  expect(new Set(rest.entries.map((entry) => entry.category))).toEqual(new Set(["receipt"]))
  store.close()
})
