import { describe, expect, test } from "bun:test"

import { materializeCompoundPlan, validateCompoundTask } from "../../src/session/compound-plan"
import { validateWorkflowPlan } from "../../src/session/workflow-plan"
import { WorkflowPhaseID, WorkflowTaskID } from "../../src/session/workflow"
import type { WorkflowPlan } from "../../src/session/workflow-plan"

const phaseID = WorkflowPhaseID.make("implementation")
const taskID = WorkflowTaskID.make("solver")

const snapshot = {
  name: "economical",
  strategy: "single" as const,
  primary: {
    source: "direct" as const,
    providerID: "alpha",
    modelID: "fast",
    authMode: "api",
    pricing: {
      inputUsdPer1M: 1,
      outputUsdPer1M: 2,
      cacheReadUsdPer1M: null,
      cacheWriteUsdPer1M: null,
      source: "fixture",
    },
  },
  limits: {
    maxModelRequests: 1,
    maxTotalTokens: 10_000,
    maxRuntimeMs: 60_000,
    unknownCost: "block" as const,
  },
}

const plan = (compound?: Record<string, unknown>): WorkflowPlan => ({
  formatVersion: 1,
  name: "Compound implementation",
  description: "Run an isolated candidate",
  objective: "Produce a candidate",
  phases: [{ id: phaseID, ordinal: 1, name: "Implementation", barrier: { kind: "all" }, taskIDs: [taskID] }],
  tasks: [
    {
      id: taskID,
      phaseID,
      name: "Solver",
      kind: "agent",
      prompt: "Implement the requested change",
      dependsOn: [],
      output: { kind: "text" },
      workspace: { mode: "per-run-worktree" },
      ...(compound ? { compound: compound as never } : {}),
    },
  ],
  finalTaskID: WorkflowTaskID.make("final"),
  completionCriteria: ["candidate exists"],
  requiredGates: [],
  budget: { maxConcurrency: 1, maxFanOut: 1 },
})

describe("compound workflow materialization", () => {
  test("accepts the public agent shape and materializes a human compatibility sentinel", () => {
    const input = plan({
      profile: "economical",
      validationChecks: [{ id: "tests", command: "bun test test/session/compound-plan.test.ts" }],
      resolved: snapshot,
    })
    expect(validateWorkflowPlan(input).valid).toBe(false) // the fixture omits the final synthesize task
    const result = materializeCompoundPlan(input)
    expect(result.issues).toEqual([])
    expect(result.plan?.tasks[0]).toMatchObject({ kind: "human", compound: { profile: "economical", resolved: snapshot } })
  })

  test("requires isolated workspace, deterministic checks, and a resolved profile before materialization", () => {
    const input = plan({ profile: "economical", validationChecks: [] })
    const issues = validateCompoundTask({ task: input.tasks[0], plan: input })
    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining(["compound-checks", "compound-resolution"]))

    const unsafe = {
      ...input,
      budget: { maxConcurrency: 2, maxFanOut: 1 },
      tasks: [{ ...input.tasks[0], workspace: { mode: "in-place" as const }, compound: { ...input.tasks[0].compound!, resolved: snapshot } }],
    }
    expect(materializeCompoundPlan(unsafe).issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["compound-workspace", "compound-concurrency"]),
    )
  })

  test("round-trips the sentinel and never converts it back into an ordinary agent", () => {
    const input = plan({
      profile: "economical",
      validationChecks: [{ id: "tests", command: "bun test test/session/compound-plan.test.ts" }],
      resolved: snapshot,
    })
    const materialized = materializeCompoundPlan(input).plan!
    const reloaded = JSON.parse(JSON.stringify(materialized)) as WorkflowPlan
    expect(reloaded.tasks[0]?.kind).toBe("human")
    expect(reloaded.tasks[0]?.compound?.profile).toBe("economical")
    expect(reloaded.tasks[0]?.compound?.resolved).toEqual(snapshot)
  })
})
