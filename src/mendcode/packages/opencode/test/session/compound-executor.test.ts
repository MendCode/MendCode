import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"

import { tmpdir } from "../fixture/fixture"
import {
  execute as executeCompound,
  parseCriticAssessment,
  type CompoundExecutorDependencies,
  type CompoundExecutionInput,
  type CompoundSingleResult,
  type CompoundSingleInput,
} from "../../src/session/compound-executor"
import type { CompletionValidationResult } from "../../src/session/completion-validation"
import { WorkflowPhaseID, WorkflowTaskID, type WorkflowTask } from "../../src/session/workflow"

const phaseID = WorkflowPhaseID.make("compound-phase")
const taskID = WorkflowTaskID.make("compound-task")

const pricing = {
  inputUsdPer1M: 1,
  outputUsdPer1M: 2,
  cacheReadUsdPer1M: null,
  cacheWriteUsdPer1M: null,
  source: "fixture",
} as const

const modelRef = (providerID: string, modelID: string) => ({
  source: "direct" as const,
  providerID,
  modelID,
  authMode: "api",
  pricing,
})

function profile(strategy: "single" | "cascade" | "critic") {
  return {
    name: "fixture",
    strategy,
    primary: modelRef("provider-primary", "model-primary"),
    ...(strategy === "cascade" ? { escalation: modelRef("provider-escalation", "model-escalation") } : {}),
    ...(strategy === "critic" ? { critic: modelRef("provider-critic", "model-critic") } : {}),
    limits: {
      maxModelRequests: strategy === "single" ? 1 : strategy === "cascade" ? 2 : 3,
      maxTotalTokens: 20_000,
      maxRuntimeMs: 60_000,
      unknownCost: "block" as const,
    },
  }
}

function taskFor(resolved: ReturnType<typeof profile>, checks = [{ id: "deterministic", command: "git diff --check" }]): WorkflowTask {
  return {
    id: taskID,
    phaseID,
    name: "Compound fixture",
    kind: "human",
    prompt: "Produce a candidate in the leased workspace.",
    dependsOn: [],
    output: { kind: "text", maxChars: 8_000 },
    workspace: { mode: "per-run-worktree" },
    compound: {
      profile: "fixture",
      validationChecks: checks,
      configHash: "fixture-config",
      resolved,
    },
  } as WorkflowTask
}

function validationResult(status: CompletionValidationResult["status"], failureClass: CompletionValidationResult["failureClass"], summary: string): CompletionValidationResult {
  return {
    status,
    failureClass,
    summary,
    output: summary,
    durationMs: 1,
    timedOut: false,
    ...(status === "pass" ? { exitCode: 0 } : { exitCode: 1 }),
  }
}

function dependenciesFor(input: {
  readonly candidate: string
  readonly execute: (call: CompoundSingleInput, index: number) => Promise<CompoundSingleResult>
  readonly validate?: (index: number) => CompletionValidationResult
}) {
  const calls: CompoundSingleInput[] = []
  const validations: { readonly cwd: string; readonly executionAllowed: boolean }[] = []
  const ledgers: CompoundExecutorDependencies["persistLedger"] extends ((input: infer T) => unknown) ? T[] : never[] = []
  const dependencies: CompoundExecutorDependencies = {
    executeSingle: (call) => {
      calls.push(call)
      return Effect.promise(() => input.execute(call, calls.length))
    },
    runValidation: ({ cwd, executionAllowed }) => {
      validations.push({ cwd, executionAllowed })
      return Effect.succeed(input.validate?.(validations.length) ?? validationResult("pass", "none", "validation passed"))
    },
    persistLedger: (ledger) => Effect.sync(() => {
      ledgers.push(ledger as never)
    }),
  }
  return { calls, validations, ledgers, dependencies }
}

const completedResult = (summary: string): { state: "completed"; summary: string } => ({ state: "completed", summary })

function compoundInput(task: WorkflowTask, workspacePath: string, resolvedProfile: ReturnType<typeof profile>): CompoundExecutionInput {
  return {
    task,
    sessionID: "solver-session",
    workspacePath,
    workflowPermissions: {
      mode: "normal",
      allowEdits: true,
      allowMutatingCommands: true,
      allowExternalSend: false,
    },
    workflowWorkspace: { mode: "per-run-worktree" },
    compoundContext: {
      runID: "run-fixture",
      taskAttemptID: "attempt-fixture",
      generation: 1,
      resolvedProfile,
      configHash: "fixture-config",
    },
  }
}

describe("compound executor", () => {
  test("accepts a single candidate with one accounted leg and retains the workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("single")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (_call) => {
        await Bun.write(path.join(tmp.path, "candidate.txt"), "single candidate\n")
        return completedResult("solver complete")
      },
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "completed", compound: { outcome: "accepted", strategy: "single" } })
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0]).toMatchObject({
      model: { providerID: "provider-primary", modelID: "model-primary" },
      toolMode: "normal",
      maxOutputTokens: 4_096,
    })
    expect(result.compound.ledger.records).toHaveLength(1)
    expect(result.compound.ledgerAggregate.requests).toMatchObject({ used: 1, reserved: 0, remaining: 0 })
    expect(deps.ledgers.length).toBeGreaterThanOrEqual(3)
    expect(await Bun.file(path.join(tmp.path, "candidate.txt")).exists()).toBe(true)
    expect(result.compound.workspacePath).toBe(tmp.path)
    expect(result.compound.patchDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test("escalates a cascade only for a quality validation failure", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("cascade")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (_call, index) => {
        await Bun.write(path.join(tmp.path, "cascade.txt"), `attempt ${index}\n`)
        return completedResult(`solver leg ${index}`)
      },
      validate: (index) => index === 1
        ? validationResult("fail", "quality", "expected quality failure")
        : validationResult("pass", "none", "quality repaired"),
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "completed", compound: { outcome: "accepted", strategy: "cascade" } })
    expect(deps.calls).toHaveLength(2)
    expect(deps.calls.map((call) => call.model?.modelID)).toEqual(["model-primary", "model-escalation"])
    expect(result.compound.legs.map((leg) => leg.role)).toEqual(["primary", "escalation"])
    expect(result.compound.validation.map((check) => check.status)).toEqual(["fail", "pass"])
  })

  test("does not cascade after an environmental validation block", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("cascade")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (_call) => {
        await Bun.write(path.join(tmp.path, "environment.txt"), "candidate\n")
        return completedResult("solver complete")
      },
      validate: () => validationResult("blocked", "environment", "validation environment unavailable"),
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "blocked", failureClass: "environment", compound: { outcome: "blocked" } })
    expect(deps.calls).toHaveLength(1)
    expect(result.compound.legs.map((leg) => leg.role)).toEqual(["primary"])
  })

  test("stops after an authentication failure without model hopping", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("cascade")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async () => ({ state: "failed" as const, failureClass: "environment" as const, error: "401 unauthorized" }),
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "failed", compound: { outcome: "failed" } })
    expect(deps.calls).toHaveLength(1)
    expect(result.compound.validation).toEqual([])
  })

  test("gives an independent critic strict JSON and zero executable tools", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("critic")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (call) => {
        if (call.toolMode === "none") {
          return completedResult(JSON.stringify({ verdict: "accept", findings: [], summary: "candidate is sound" }))
        }
        await Bun.write(path.join(tmp.path, "critic.txt"), "candidate\n")
        return completedResult("solver complete")
      },
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))
    const critic = deps.calls[1]

    expect(result).toMatchObject({ state: "completed", compound: { outcome: "accepted", review: { verdict: "accept", changedDuringReview: false } } })
    expect(deps.calls).toHaveLength(2)
    expect(critic).toMatchObject({
      toolMode: "none",
      maxOutputTokens: 4_096,
      task: { kind: "agent", allowedTools: [], output: { kind: "text" } },
      workflowPermissions: { mode: "report-only", allowedTools: [], allowEdits: false, allowMutatingCommands: false, allowExternalSend: false },
      workflowWorkspace: { mode: "read-only" },
      model: { providerID: "provider-critic", modelID: "model-critic" },
    })
    expect(critic?.task.permissions?.allowedTools).toEqual([])
    expect(result.compound.legs.map((leg) => leg.role)).toEqual(["primary", "critic"])
  })

  test("allows one critic-requested revision and labels it unreviewed", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("critic")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (call) => {
        if (call.toolMode === "none") {
          return completedResult(JSON.stringify({
            verdict: "revise",
            findings: [{ path: "candidate.txt", line: 1, message: "Repair the candidate." }],
            summary: "one bounded repair is required",
          }))
        }
        const revision = call.context?.includes("requested one bounded primary revision")
        await Bun.write(path.join(tmp.path, "candidate.txt"), revision ? "fixed candidate\n" : "initial candidate\n")
        return completedResult(revision ? JSON.stringify({ dispositions: [{ path: "candidate.txt", disposition: "fixed" }] }) : "solver complete")
      },
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "completed", compound: { outcome: "unreviewed-revision", review: { verdict: "revise" } } })
    expect(deps.calls).toHaveLength(3)
    expect(result.compound.legs.map((leg) => leg.role)).toEqual(["primary", "critic", "revision"])
    expect(result.compound.reviewLimitations.join(" ")).toContain("not independently reviewed again")
    expect(await Bun.file(path.join(tmp.path, "candidate.txt")).text()).toBe("fixed candidate\n")
  })

  test("blocks when a hostile critic changes the candidate during review", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = profile("critic")
    const deps = dependenciesFor({
      candidate: tmp.path,
      execute: async (call) => {
        if (call.toolMode === "none") {
          await Bun.write(path.join(tmp.path, "candidate.txt"), "hostile mutation\n")
          return completedResult(JSON.stringify({ verdict: "accept", findings: [], summary: "accepted" }))
        }
        await Bun.write(path.join(tmp.path, "candidate.txt"), "candidate\n")
        return completedResult("solver complete")
      },
    })

    const result = await Effect.runPromise(executeCompound(compoundInput(taskFor(resolved), tmp.path, resolved), deps.dependencies))

    expect(result).toMatchObject({ state: "blocked", failureClass: "quality", compound: { outcome: "blocked", review: { changedDuringReview: true } } })
    expect(deps.calls).toHaveLength(2)
  })

  test("rejects malformed or out-of-snapshot critic findings", () => {
    expect(parseCriticAssessment("not json")).toMatchObject({ ok: false })
    expect(parseCriticAssessment(JSON.stringify({ verdict: "accept", findings: [], summary: "ok", extra: true }))).toMatchObject({ ok: false })
  })
})
