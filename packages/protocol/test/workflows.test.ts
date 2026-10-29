import { describe, expect, test } from "bun:test"
import {
  Command,
  GlobalEvent,
  MAX_WORKFLOW_RUN_BYTES,
  WorkflowContract,
  WorkflowId,
  WorkflowPlan,
  WorkflowRun,
  WorkflowSummary,
  createIdFactory,
  summarizeWorkflow,
  type WorkflowRun as WorkflowRunType,
} from "../src"

const id = createIdFactory({ now: () => 1_790_000_000_000 })
const clientId = id("client")
const at = 1_790_000_000_000

const agent = { kind: "agent", id: "survey", title: "Survey", prompt: "Read the repo." }
const check = { kind: "check", id: "unit", title: "Unit tests", command: "bun test", needs: ["survey"] }
const plan = { name: "api rewrite", objective: "Rewrite the API layer.", tasks: [agent, check] }

test("B21 save and revision refs are additive; invalid/mixed references reject", () => {
  const base = { id: id("command"), clientId, directory: "/work/project" }
  expect(Command.safeParse({ ...base, type: "workflow.save", plan, definitionId: "wfd_1" }).success).toBe(true)
  for (const ref of [{ definitionId: "wfd_1" }, { revisionId: "wfr_1" }, { ref: "named" }]) expect(Command.safeParse({ ...base, type: "workflow.start", plan: ref }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "workflow.start", plan: { definitionId: "wfd_1", revisionId: "wfr_1" } }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "workflow.save", plan, definitionId: "../escape" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "workflow.definitions", limit: 101 }).success).toBe(false)
})

describe("workflow ids", () => {
  test("wfl ids validate against their own schema only", () => {
    const workflowId = id("workflow")
    expect(workflowId.startsWith("wfl_")).toBe(true)
    expect(WorkflowId.safeParse(workflowId).success).toBe(true)
    expect(WorkflowId.safeParse(id("loop")).success).toBe(false)
  })
})

describe("WorkflowPlan", () => {
  test("defaults fill needs, mode, criterion required and contract caps", () => {
    const parsed = WorkflowPlan.parse({ ...plan, contract: { criteria: [{ id: "tests", text: "Tests pass" }] } })
    expect(parsed.tasks[0]).toMatchObject({ kind: "agent", needs: [], mode: "work" })
    expect(parsed.contract).toEqual({ criteria: [{ id: "tests", text: "Tests pass", required: true }], checks: [], audit: "auto", maxRepairs: 2, maxAudits: 2 })
  })

  test("accepts a contract by name, with dots and leading digits allowed like layer file names", () => {
    expect(WorkflowPlan.safeParse({ ...plan, contract: "release-gate" }).success).toBe(true)
    expect(WorkflowPlan.safeParse({ ...plan, contract: "2.release_gate" }).success).toBe(true)
    expect(WorkflowPlan.safeParse({ ...plan, contract: "Release Gate" }).success).toBe(false)
  })

  const rejected: Array<[string, unknown]> = [
    ["no tasks", { ...plan, tasks: [] }],
    ["33 tasks", { ...plan, tasks: Array.from({ length: 33 }, (_, i) => ({ ...agent, id: `t${i}` })) }],
    ["unknown task kind", { ...plan, tasks: [{ ...agent, kind: "wizard" }] }],
    ["human task with a command", { ...plan, tasks: [{ kind: "human", id: "h", title: "H", prompt: "ok?", command: "bun test" }] }],
    ["human task with a retry policy", { ...plan, tasks: [{ kind: "human", id: "h", title: "H", prompt: "ok?", retry: { maxAttempts: 2 } }] }],
    ["retry above six attempts", { ...plan, tasks: [{ ...agent, retry: { maxAttempts: 7 } }] }],
    ["retry on an unknown class", { ...plan, tasks: [{ ...agent, retry: { maxAttempts: 2, retryOn: ["flaky"] } }] }],
    ["negative retention", { ...plan, retention: { maxBytes: -1 } }],
    ["agent without prompt", { ...plan, tasks: [{ kind: "agent", id: "a", title: "A" }] }],
    ["check without command", { ...plan, tasks: [{ kind: "check", id: "c", title: "C" }] }],
    ["agent with a command", { ...plan, tasks: [{ ...agent, command: "bun test" }] }],
    ["check with a prompt", { ...plan, tasks: [{ ...check, prompt: "x" }] }],
    ["slug starting with a digit", { ...plan, tasks: [{ ...agent, id: "1st" }] }],
    ["slug with uppercase", { ...plan, tasks: [{ ...agent, id: "Survey" }] }],
    ["slug longer than 40", { ...plan, tasks: [{ ...agent, id: `a${"b".repeat(40)}` }] }],
    ["9 needs", { ...plan, tasks: [{ ...agent, needs: Array.from({ length: 9 }, (_, i) => `n${i}`) }] }],
    ["prompt over 8000", { ...plan, tasks: [{ ...agent, prompt: "x".repeat(8_001) }] }],
    ["timeout 0 minutes", { ...plan, tasks: [{ ...agent, timeoutMinutes: 0 }] }],
    ["timeout 241 minutes", { ...plan, tasks: [{ ...agent, timeoutMinutes: 241 }] }],
    ["check timeout 601 s", { ...plan, tasks: [{ ...check, timeoutSeconds: 601 }] }],
    ["unknown plan field", { ...plan, phases: [] }],
    ["permission plan", { ...plan, permission: "plan" }],
    ["maxConcurrent 5", { ...plan, maxConcurrent: 5 }],
    ["maxRuntimeMinutes 1441", { ...plan, maxRuntimeMinutes: 1_441 }],
    ["empty name", { ...plan, name: "" }],
  ]
  for (const [name, value] of rejected) test(`rejects ${name}`, () => expect(WorkflowPlan.safeParse(value).success).toBe(false))

  test("keeps a check task's optional fields and an agent task's read mode", () => {
    const parsed = WorkflowPlan.parse({ ...plan, tasks: [{ ...agent, mode: "read", timeoutMinutes: 30 }, { ...check, timeoutSeconds: 60 }], permission: "edits", maxConcurrent: 2, maxRuntimeMinutes: 60 })
    expect(parsed.tasks[0]).toMatchObject({ mode: "read", timeoutMinutes: 30 })
    expect(parsed.tasks[1]).toMatchObject({ timeoutSeconds: 60 })
  })
})

describe("WorkflowContract", () => {
  const criterion = { id: "tests", text: "Tests pass" }
  const contract = { criteria: [criterion] }

  const rejected: Array<[string, unknown]> = [
    ["no criteria", { criteria: [] }],
    ["13 criteria", { criteria: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, text: "x" })) }],
    ["6 checks", { ...contract, checks: Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, command: "bun test" })) }],
    ["empty criterion text", { criteria: [{ id: "tests", text: "" }] }],
    ["criterion text over 300", { criteria: [{ id: "tests", text: "x".repeat(301) }] }],
    ["check without command", { ...contract, checks: [{ id: "unit" }] }],
    ["check with 13 covers", { ...contract, checks: [{ id: "unit", command: "bun test", covers: Array.from({ length: 13 }, (_, i) => `c${i}`) }] }],
    ["unknown audit mode", { ...contract, audit: "always" }],
    ["maxRepairs 6", { ...contract, maxRepairs: 6 }],
    ["maxAudits 0", { ...contract, maxAudits: 0 }],
    ["maxAudits 4", { ...contract, maxAudits: 4 }],
    ["unknown field", { ...contract, threshold: 0.8 }],
  ]
  for (const [name, value] of rejected) test(`rejects ${name}`, () => expect(WorkflowContract.safeParse(value).success).toBe(false))

  test("accepts the layer example", () => {
    const parsed = WorkflowContract.safeParse({
      criteria: [
        { id: "tests", text: "The full test suite passes", owners: ["impl-api", "impl-ui"] },
        { id: "api-doc", text: "docs/api.md documents every new endpoint", owners: ["docs"], required: false },
      ],
      checks: [{ id: "unit", command: "bun test", covers: ["tests"] }],
      audit: "independent",
      maxRepairs: 0,
    })
    expect(parsed.success).toBe(true)
  })
})

describe("workflow commands", () => {
  const workflowId = id("workflow")
  const base = { id: id("command"), clientId }

  test("workflow.start takes an inline plan or a saved plan name", () => {
    const start = { ...base, type: "workflow.start", directory: "/repo" }
    expect(Command.safeParse({ ...start, plan }).success).toBe(true)
    expect(Command.safeParse({ ...start, plan: { ref: "api-rewrite" } }).success).toBe(true)
    expect(Command.safeParse({ ...start, plan: { ref: "Api Rewrite" } }).success).toBe(false)
    expect(Command.safeParse({ ...start, plan: { ref: "api-rewrite", extra: 1 } }).success).toBe(false)
    expect(Command.safeParse({ ...start, plan: { ...plan, tasks: [] } }).success).toBe(false)
    expect(Command.safeParse({ ...start }).success).toBe(false)
    expect(Command.safeParse({ ...start, plan, permission: "full", originSessionId: id("session") }).success).toBe(true)
    expect(Command.safeParse({ ...start, plan, permission: "plan" }).success).toBe(false)
    expect(Command.safeParse({ ...start, plan, directory: "" }).success).toBe(false)
  })

  test("workflow.list and workflow.get", () => {
    expect(Command.safeParse({ ...base, type: "workflow.list" }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "workflow.list", directory: "/repo" }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "workflow.get", workflowId }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "workflow.get" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "workflow.get", workflowId: id("loop") }).success).toBe(false)
  })

  test("workflow.control needs its explicit target and the fields its action requires", () => {
    const control = { ...base, type: "workflow.control", workflowId }
    for (const action of ["pause", "resume", "stop", "verify", "delete"]) expect(Command.safeParse({ ...control, action }).success).toBe(true)
    expect(Command.safeParse({ ...control, action: "retry", taskId: "survey" }).success).toBe(true)
    expect(Command.safeParse({ ...control, action: "retry" }).success).toBe(false)
    expect(Command.safeParse({ ...control, action: "accept", reason: "reviewed by hand" }).success).toBe(true)
    expect(Command.safeParse({ ...control, action: "accept" }).success).toBe(false)
    expect(Command.safeParse({ ...control, action: "run" }).success).toBe(false)
    expect(Command.safeParse({ ...control, action: "stop", workflowId: undefined }).success).toBe(false)
    expect(Command.safeParse({ ...control, action: "retry", taskId: "Survey" }).success).toBe(false)
  })

  test("workflow.preview is directory plus plan", () => {
    const preview = { ...base, type: "workflow.preview", directory: "/repo" }
    expect(Command.safeParse({ ...preview, plan }).success).toBe(true)
    expect(Command.safeParse({ ...preview, plan: { ref: "api-rewrite" } }).success).toBe(true)
    expect(Command.safeParse({ ...preview }).success).toBe(false)
    expect(Command.safeParse({ ...preview, plan, permission: "full" }).success).toBe(false)
  })
})

/**
 * A run at the spec's sizing: every list at its cap and prompts totalling 48 KB, with the other free text at
 * typical rather than schema-maximum length (the schema caps alone allow more; the service clips before saving).
 */
function maximalRun(): WorkflowRunType {
  const session = () => id("session")
  const slug = (i: number) => `task${String(i).padStart(2, "0")}`
  const needs = (i: number) => Array.from({ length: Math.min(i, 2) }, (_, n) => slug(i - 1 - n))
  const specs = Array.from({ length: 32 }, (_, i) => ({ kind: "agent" as const, id: slug(i), title: "t".repeat(40), prompt: "p".repeat(1_500), needs: needs(i), mode: "work" as const, timeoutMinutes: 240 }))
  const owners = Array.from({ length: 8 }, (_, n) => slug(n))
  const criteria = Array.from({ length: 12 }, (_, i) => ({ id: `crit${i}`, text: "c".repeat(300), required: true, owners }))
  const contract = {
    criteria,
    checks: Array.from({ length: 5 }, (_, i) => ({ id: `chk${i}`, command: "k".repeat(300), timeoutSeconds: 600, covers: criteria.map((c) => c.id), owners })),
    audit: "independent" as const,
    maxRepairs: 5,
    maxAudits: 3,
  }
  const verification = (round: number) => ({
    round,
    at,
    gates: Array.from({ length: 5 }, (_, i) => ({ id: `chk${i}`, status: "fail" as const, detail: "d".repeat(300) })),
    audit: {
      verdict: "fail" as const,
      sessionId: session(),
      inspections: 40,
      workspaceChanged: false,
      findings: "f".repeat(1_000),
      criteria: criteria.map((c) => ({ id: c.id, status: "fail" as const, evidence: "e".repeat(100) })),
    },
    criteria: criteria.map((c) => ({ id: c.id, status: "fail" as const, by: "audit" as const })),
    accepted: false,
  })
  return {
    workflowId: id("workflow"),
    name: "n".repeat(120),
    directory: "/repo",
    objective: "o".repeat(4_000),
    plan: { name: "n".repeat(120), objective: "o".repeat(4_000), tasks: specs, contract, permission: "full", maxConcurrent: 4, maxRuntimeMinutes: 1_440 },
    planHash: "a".repeat(64),
    permission: "full",
    state: "blocked",
    reason: "r".repeat(500),
    rootSessionId: session(),
    originSessionId: session(),
    tasks: specs.map((spec, i) => ({
      id: spec.id,
      title: spec.title,
      kind: "agent" as const,
      mode: "work" as const,
      needs: spec.needs,
      state: "failed" as const,
      attempt: 6,
      sessionId: session(),
      startedAt: at,
      endedAt: at,
      result: "r".repeat(500),
      ...(i % 2 ? { reason: "x".repeat(100) } : {}),
      ...(i === 0 ? { latest: "l".repeat(60) } : {}),
      ...(i < 2 ? { feedback: "f".repeat(4_000) } : {}),
    })),
    verifications: Array.from({ length: 6 }, (_, i) => verification(i + 1)),
    repairs: 5,
    override: { reason: "o".repeat(500), at },
    startedAt: at,
    endedAt: at,
    updatedAt: at,
  }
}

describe("WorkflowRun and WorkflowSummary", () => {
  test("a maximal run parses and stays under the stored-row bound", () => {
    const run = maximalRun()
    expect(WorkflowRun.safeParse(run).success).toBe(true)
    expect(JSON.stringify(run).length).toBeLessThan(MAX_WORKFLOW_RUN_BYTES)
  })

  test("the summary of a maximal run parses, drops the plan, results and feedback and stays under 20 KB", () => {
    const run = maximalRun()
    const summary = summarizeWorkflow(run)
    const parsed = WorkflowSummary.safeParse(summary)
    expect(parsed.success).toBe(true)
    const json = JSON.stringify(summary)
    expect(json.length).toBeLessThan(20 * 1024)
    expect(json).not.toContain("ppppp")
    expect(json).not.toContain("f".repeat(4_000))
    expect(summary).not.toHaveProperty("plan")
    expect(summary.contract).toEqual({ criteria: 12, checks: 5, audit: "independent", maxRepairs: 5, maxAudits: 3 })
    expect(summary.rounds).toBe(6)
    expect(summary.verification?.round).toBe(6)
    expect(summary.tasks.every((task) => !("result" in task) && !("feedback" in task))).toBe(true)
  })

  test("the summary of a run without optional parts omits them", () => {
    const run: WorkflowRunType = {
      workflowId: id("workflow"),
      name: "docs",
      directory: "/repo",
      objective: "Write docs.",
      plan: WorkflowPlan.parse(plan),
      planHash: "b".repeat(64),
      permission: "ask",
      state: "running",
      rootSessionId: id("session"),
      tasks: [{ id: "survey", title: "Survey", kind: "agent", mode: "work", needs: [], state: "pending", attempt: 0 }],
      verifications: [],
      repairs: 0,
      startedAt: at,
      updatedAt: at,
    }
    expect(WorkflowRun.safeParse(run).success).toBe(true)
    const summary = summarizeWorkflow(run)
    expect(WorkflowSummary.safeParse(summary).success).toBe(true)
    expect(summary).not.toHaveProperty("verification")
    expect(summary).not.toHaveProperty("endedAt")
    expect(summary.rounds).toBe(0)
  })

  const rejected: Array<[string, (run: WorkflowRunType) => unknown]> = [
    ["257 tasks (a script run holds up to 256)", (run) => ({ ...run, tasks: Array.from({ length: 257 }, (_, index) => ({ ...run.tasks[0]!, id: `t${index}` })) })],
    ["7 verifications", (run) => ({ ...run, verifications: [...run.verifications, ...run.verifications.slice(0, 2)] })],
    ["repairs 6", (run) => ({ ...run, repairs: 6 })],
    ["unknown state", (run) => ({ ...run, state: "unknown" })],
    ["short plan hash", (run) => ({ ...run, planHash: "abc" })],
    ["attempt 7", (run) => ({ ...run, tasks: run.tasks.map((task) => ({ ...task, attempt: 7 })) })],
    ["result over 1500", (run) => ({ ...run, tasks: run.tasks.map((task) => ({ ...task, result: "x".repeat(1_501) })) })],
    ["loop id as workflow id", (run) => ({ ...run, workflowId: id("loop") })],
    ["extra field", (run) => ({ ...run, phases: [] })],
  ]
  for (const [name, mutate] of rejected)
    test(`rejects a run with ${name}`, () => expect(WorkflowRun.safeParse(mutate(maximalRun())).success).toBe(false))
})

describe("workflow.changed", () => {
  test("is a global event carrying the summary", () => {
    const summary = summarizeWorkflow(maximalRun())
    expect(GlobalEvent.safeParse({ gseq: 1, at, type: "workflow.changed", workflow: summary }).success).toBe(true)
    expect(GlobalEvent.safeParse({ gseq: 1, at, type: "workflow.changed", workflow: summary, deleted: true }).success).toBe(true)
    expect(GlobalEvent.safeParse({ gseq: 1, at, type: "workflow.changed" }).success).toBe(false)
    expect(GlobalEvent.safeParse({ gseq: 1, at, type: "workflow.changed", workflow: { ...summary, tasks: [{}] } }).success).toBe(false)
  })
})
