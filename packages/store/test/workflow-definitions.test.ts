import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { WorkflowPlan } from "@mendcode/protocol"
import { createWorkflowDefinitions, workflowPlanHash } from "../../workflows/src"
import { openStore } from "../src"

const cleanups: Array<() => void> = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })
const plan = WorkflowPlan.parse({ name: "inspect", objective: "Inspect the project", tasks: [{ kind: "agent", id: "read", title: "Read", prompt: "Read the project", mode: "read" }] })
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b21-store-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir })
  cleanups.push(() => store.close())
  return { dir, store, definitions: createWorkflowDefinitions({ store: store.workflowDefinitions, now: () => 10 }) }
}

test("revisions survive restart and preserve old plans; head writes are atomic and insert-only", () => {
  const h = harness()
  const first = h.definitions.save({ directory: h.dir, plan })
  const second = h.definitions.save({ directory: h.dir, plan: { ...plan, objective: "Changed objective" }, definitionId: first.definitionId })
  expect(second.revision).toBe(2)
  expect(second.revisionId).not.toBe(first.revisionId)
  expect(second.planHash).not.toBe(first.planHash)
  expect(h.definitions.get(h.dir, { revisionId: first.revisionId }).plan.objective).toBe(plan.objective)
  expect(h.definitions.get(h.dir, { definitionId: first.definitionId }).revisionId).toBe(second.revisionId)
  const { definition: _firstDefinition, ...firstRevision } = first
  const { definition: _secondDefinition, ...secondRevision } = second
  expect(() => h.store.workflowDefinitions.save(first.definition, firstRevision)).toThrow("changed")
  expect(() => h.store.workflowDefinitions.save({ ...second.definition, currentRevision: 3 }, { ...secondRevision, revision: 3 })).toThrow()
  expect(h.store.workflowDefinitions.definition(first.definitionId)?.currentRevision).toBe(2)
  h.store.close()
  cleanups.pop()
  const restored = openStore({ dir: h.dir })
  cleanups.push(() => restored.close())
  expect(restored.workflowDefinitions.revision(first.revisionId)).toMatchObject({ immutable: true, planHash: first.planHash, revision: 1 })
  expect(restored.workflowDefinitions.list(h.dir, 1)).toHaveLength(1)
})

test("hashes are stable across key order; reads are defensive, scoped and reject unresolved contracts", () => {
  const h = harness()
  const first = h.definitions.save({ directory: h.dir, plan })
  expect(workflowPlanHash({ tasks: plan.tasks, objective: plan.objective, name: plan.name })).toBe(first.planHash)
  first.plan.tasks[0]!.title = "Mutated"
  expect(h.definitions.get(h.dir, { revisionId: first.revisionId }).plan.tasks[0]!.title).toBe("Read")
  expect(() => h.definitions.get("/other", { definitionId: first.definitionId })).toThrow("unknown")
  expect(() => h.definitions.save({ directory: "/other", definitionId: first.definitionId, plan })).toThrow("unknown")
  expect(() => h.definitions.save({ directory: h.dir, plan: { ...plan, contract: "gate" } })).toThrow("resolve")
  expect(h.definitions.list("/other")).toEqual([])
})

test("oversized revisions leave the head unchanged and corrupted hashes cannot be read", () => {
  const h = harness()
  const first = h.definitions.save({ directory: h.dir, plan })
  const oversized = WorkflowPlan.parse({ ...plan, tasks: Array.from({ length: 6 }, (_, i) => ({ kind: "agent", id: `read${i}`, title: "Read", prompt: "界".repeat(8_000), mode: "read" })) })
  expect(() => h.definitions.save({ directory: h.dir, plan: oversized, definitionId: first.definitionId })).toThrow("128 KB")
  expect(h.definitions.get(h.dir, { definitionId: first.definitionId }).revisionId).toBe(first.revisionId)
  const broken = createWorkflowDefinitions({ store: { ...h.store.workflowDefinitions, revision: (id) => {
    const revision = h.store.workflowDefinitions.revision(id)
    return revision && { ...revision, planHash: "0".repeat(64) }
  } }, now: () => 10 })
  expect(() => broken.get(h.dir, { revisionId: first.revisionId })).toThrow("integrity")
})
