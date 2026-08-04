import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import {
  WorkflowArtifactSelector,
  WorkflowPhaseID,
  WorkflowTaskID,
} from "../../src/session/workflow"
import type { WorkflowModelRoute, WorkflowOutputContract } from "../../src/session/workflow"
import { assertValidWorkflowPlan, validateWorkflowPlan, WorkflowPlan } from "../../src/session/workflow-plan"
import type { WorkflowPlan as WorkflowPlanType } from "../../src/session/workflow-plan"

const phaseResearch = WorkflowPhaseID.make("research")
const phaseSynthesis = WorkflowPhaseID.make("synthesis")
const taskResearch = WorkflowTaskID.make("research-task")
const taskSynthesis = WorkflowTaskID.make("synthesis-task")

const model: WorkflowModelRoute = {
  providerID: "openai",
  modelID: "gpt-5.6",
}

const jsonOutput = (title: string): WorkflowOutputContract => ({
  kind: "json",
  schema: { type: "object", title },
})

const basePlan = (): WorkflowPlanType => ({
  formatVersion: 1,
  name: "Architecture review",
  description: "Review the architecture",
  objective: "Produce a bounded architecture review",
  phases: [
    {
      id: phaseResearch,
      ordinal: 1,
      name: "Research",
      barrier: { kind: "all" },
      taskIDs: [taskResearch],
    },
    {
      id: phaseSynthesis,
      ordinal: 2,
      name: "Synthesis",
      barrier: { kind: "all" },
      taskIDs: [taskSynthesis],
    },
  ],
  tasks: [
    {
      id: taskResearch,
      phaseID: phaseResearch,
      name: "Research",
      kind: "agent",
      prompt: "Inspect the repository",
      dependsOn: [],
      output: jsonOutput("research"),
      model,
    },
    {
      id: taskSynthesis,
      phaseID: phaseSynthesis,
      name: "Synthesize",
      kind: "synthesize",
      prompt: "Summarize the research",
      dependsOn: [taskResearch],
      inputs: [{ taskID: taskResearch, required: true }],
      output: jsonOutput("synthesis"),
      model,
    },
  ],
  finalTaskID: taskSynthesis,
  completionCriteria: ["The synthesis is schema-valid"],
  requiredGates: [],
  budget: { maxConcurrency: 2, maxFanOut: 4 },
})

const decode = (input: unknown) => Schema.decodeUnknownSync(WorkflowPlan)(input) as WorkflowPlanType

describe("WorkflowPlan", () => {
  test("decodes and previews a valid immutable-plan shape", () => {
    const plan = decode(basePlan())
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(true)
    expect(result.preview).toEqual({
      phaseCount: 2,
      taskCount: 2,
      taskUpperBound: 2,
      maxConcurrency: 2,
      maxFanOut: 4,
      sideEffectClasses: [],
    })
    expect(assertValidWorkflowPlan(plan)).toEqual(result.preview!)
    expect(WorkflowPlan.zod.parse(plan)).toEqual(plan)
  })

  test("rejects duplicate identifiers and missing references", () => {
    const plan = basePlan()
    plan.tasks[1] = { ...plan.tasks[1], id: taskResearch, dependsOn: [WorkflowTaskID.make("missing")] }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["duplicate-identifier", "missing-reference"]))
  })

  test("rejects dependency cycles and later-phase dependencies", () => {
    const plan = basePlan()
    plan.tasks[0] = { ...plan.tasks[0], dependsOn: [taskSynthesis] }
    plan.tasks[1] = { ...plan.tasks[1], dependsOn: [taskResearch] }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["dependency-cycle"]))
  })

  test("requires artifact consumers to depend on their producer", () => {
    const plan = basePlan()
    plan.tasks[1] = { ...plan.tasks[1], dependsOn: [] }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "missing-artifact-dependency",
        message: expect.stringContaining(taskResearch),
      }),
    )
  })

  test("rejects invalid phase barriers and unsupported outputs", () => {
    const plan = basePlan()
    plan.phases[0] = { ...plan.phases[0], barrier: { kind: "quorum", quorum: 2 } }
    plan.tasks[0] = { ...plan.tasks[0], output: { kind: "json" } }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["invalid-barrier", "unsupported-output"]))
  })

  test("bounds dynamic map fan-out and requires typed descriptors", () => {
    const plan = basePlan()
    plan.tasks[0] = {
      ...plan.tasks[0],
      kind: "map",
      map: {
        source: { taskID: taskResearch },
        maxItems: 8,
        taskTemplate: {
          kind: "agent",
          prompt: "Inspect one item",
          output: jsonOutput("item"),
        },
      },
    }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["unsafe-fan-out"]))
  })

  test("fails closed for report-only side effects", () => {
    const plan = basePlan()
    plan.tasks[0] = {
      ...plan.tasks[0],
      permissions: { mode: "report-only", allowEdits: true },
    }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.map((entry) => entry.code)).toContain("policy-contradiction")
  })

  test("rejects task policies that widen the workflow permission envelope", () => {
    const plan = basePlan()
    plan.permissions = { mode: "report-only", allowEdits: false, allowMutatingCommands: false }
    plan.tasks[0] = {
      ...plan.tasks[0],
      permissions: { mode: "normal", allowEdits: true, allowMutatingCommands: true },
    }
    const result = validateWorkflowPlan(plan)

    expect(result.valid).toBe(false)
    expect(result.issues.filter((entry) => entry.code === "policy-contradiction").length).toBeGreaterThanOrEqual(3)
  })

  test("keeps selectors typed as artifact references", () => {
    const selector = Schema.decodeUnknownSync(WorkflowArtifactSelector)({ taskID: taskResearch, projection: "summary" })
    expect(selector).toEqual({ taskID: taskResearch, projection: "summary" })
  })
})
