import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Scope } from "effect"
import * as Stream from "effect/Stream"
import { ulid } from "ulid"

import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { readPermissionsConfig } from "@/mend/config/permissions"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { Session } from "./session"
import { reconcilePermissionAbandonment } from "./pending-input"
import { SessionID } from "./schema"
import * as WorkflowBackgroundTask from "./workflow-background-task"
import * as WorkflowScheduler from "./workflow-scheduler"
import * as WorkflowService from "./workflow-service"
import * as WorkflowTaskExecutor from "./workflow-task-executor"
import { WorkflowPolicy } from "./workflow-policy"
import type { WorkflowTaskClaim } from "./workflow-scheduler"
import type { ExecutionResult } from "./workflow-task-executor"
import type {
  WorkflowPermissionPolicy,
  WorkflowSessionPermissionMode,
  WorkflowRunState,
  WorkflowWorkspaceLease,
  WorkflowWorkspaceMode,
} from "./workflow"
import { isTransientWorkflowError } from "./workflow"
import { WorkflowPhaseID, WorkflowTaskID } from "./workflow"
import { fingerprintWorkspace } from "./completion-auditor"
import { runCompletionValidationCommand } from "./completion-validation"
import {
  completionAuditJsonSchema,
  type CompletionAuditReceipt,
  type CompletionGate,
  type CompletionProgress,
} from "./completion-contract"

export interface Interface {
  readonly start: (runID: string) => Effect.Effect<void>
  readonly wake: (runID: string) => Effect.Effect<void>
  readonly run: (runID: string) => Effect.Effect<void, Error>
  readonly stop: (runID: string) => Effect.Effect<void, WorkflowService.WorkflowNotFoundError>
  readonly setPermissionMode: (
    input: WorkflowService.WorkflowPermissionModeInput,
  ) => Effect.Effect<
    WorkflowService.WorkflowSnapshot,
    WorkflowService.WorkflowNotFoundError | WorkflowService.WorkflowStateError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowRunner") {}

export const completionAuditResponseTimeoutMs = 3 * 60_000

export function shouldRecoverWorkflowRun(state: WorkflowRunState) {
  return state === "queued" || state === "working"
}

export function shouldAuditWorkflowCompletion(state: WorkflowRunState) {
  return state === "queued" || state === "working"
}

export function workflowClaimCanExecute(
  snapshot: WorkflowService.WorkflowSnapshot,
  claim: Pick<WorkflowTaskClaim, "taskID" | "attempt">,
  sessionID: SessionID,
) {
  if (!shouldRecoverWorkflowRun(snapshot.run.state)) return false
  const task = snapshot.tasks.find((candidate) => candidate.id === claim.taskID)
  return task?.state === "working" && task.attempt === claim.attempt && task.sessionID === sessionID
}

const errorText = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

const artifactContext = (input: {
  readonly task: WorkflowTaskClaim["task"]
  readonly artifacts: readonly {
    readonly taskID?: string
    readonly summary: string
    readonly evidence: readonly string[]
  }[]
}) => {
  const ARTIFACT_LIMIT = 64 * 1024
  const SUMMARY_LIMIT = 16 * 1024
  const selected =
    input.task.inputs?.flatMap((selector) =>
      input.artifacts
        .filter((artifact) => artifact.taskID === selector.taskID)
        .map((artifact) => ({ artifact, selector })),
    ) ?? []
  if (selected.length === 0) return
  const context = selected
    .map(({ artifact, selector }) => {
      const projection = selector.projection ? ` (${selector.projection})` : ""
      const evidence = artifact.evidence.length ? `\nEvidence: ${artifact.evidence.join("; ")}` : ""
      const summary =
        artifact.summary.length > SUMMARY_LIMIT ? `${artifact.summary.slice(0, SUMMARY_LIMIT)}…` : artifact.summary
      return `[${selector.taskID}${projection}] ${summary}${evidence}`
    })
    .join("\n")
  if (context.length <= ARTIFACT_LIMIT) return context
  return `${context.slice(0, ARTIFACT_LIMIT)}\n[workflow artifact context truncated]`
}

export const workflowCompletionAuditReceipt = (input: {
  readonly result: ExecutionResult
  readonly progress: CompletionProgress
  readonly criteria: readonly { readonly id: string; readonly description: string }[]
  readonly fingerprintBefore?: string
  readonly fingerprintAfter?: string
  readonly now: number
}): CompletionAuditReceipt => {
  const fallbackStatus = input.result.state === "needs_input"
    ? "needs_human" as const
    : input.result.state === "blocked"
      ? "blocked" as const
      : input.result.failureClass === "quality"
        ? "fail" as const
        : input.result.state === "failed"
          ? "uncertain" as const
          : "uncertain" as const
  let parsed: Record<string, unknown> | undefined
  if (input.result.state === "completed" && input.result.summary) {
    try {
      const value = JSON.parse(input.result.summary)
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch {
      parsed = undefined
    }
  }
  const parsedStatus = parsed?.status
  const status = parsedStatus === "pass" || parsedStatus === "fail" || parsedStatus === "uncertain" || parsedStatus === "blocked" || parsedStatus === "needs_human"
    ? parsedStatus
    : fallbackStatus
  const parsedCriteria = Array.isArray(parsed?.criteria) ? parsed.criteria : []
  const byID = new Map(
    parsedCriteria.flatMap((criterion) => {
      if (typeof criterion !== "object" || criterion === null || Array.isArray(criterion)) return []
      const value = criterion as Record<string, unknown>
      return typeof value.id === "string" ? [[value.id, value] as const] : []
    }),
  )
  return {
    generation: input.progress.generation,
    status,
    summary: typeof parsed?.summary === "string"
      ? parsed.summary
      : input.result.error ?? input.result.summary ?? "Completion auditor did not return a valid structured receipt.",
    criteria: input.criteria.map((criterion) => {
      const value = byID.get(criterion.id)
      const criterionStatus = value?.status
      const evidence = Array.isArray(value?.evidence)
        ? value.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : []
      return {
        id: criterion.id,
        status: criterionStatus === "pass" || criterionStatus === "fail" || criterionStatus === "uncertain" || criterionStatus === "blocked" || criterionStatus === "needs_human"
          ? criterionStatus
          : "uncertain" as const,
        summary: typeof value?.summary === "string" ? value.summary : `No structured audit result was returned for ${criterion.id}.`,
        evidence: evidence.map((summary, index) => ({
          id: `workflow-audit:${input.progress.generation}:${criterion.id}:${index + 1}`,
          kind: "observation" as const,
          summary,
          source: "workflow-completion-auditor",
        })),
      }
    }),
    ...(input.fingerprintBefore ? { fingerprintBefore: input.fingerprintBefore } : {}),
    ...(input.fingerprintAfter ? { fingerprintAfter: input.fingerprintAfter } : {}),
    recommendedNextAction: typeof parsed?.recommendedNextAction === "string" ? parsed.recommendedNextAction : "retry",
    createdAt: input.now,
  }
}

const workspaceMode = (snapshot: WorkflowService.WorkflowSnapshot): WorkflowWorkspaceMode | undefined => {
  const modes = [
    snapshot.revision.plan.workspace?.mode,
    ...snapshot.tasks.flatMap((task) => (task.workspace?.mode ? [task.workspace.mode] : [])),
  ]
  if (modes.includes("per-run-worktree")) return "per-run-worktree"
  if (modes.includes("per-loop-worktree")) return "per-loop-worktree"
  if (modes.includes("read-only")) return "read-only"
  if (modes.includes("in-place")) return "in-place"
  return undefined
}

type ExecutionWorkspace = {
  readonly directory: string
  readonly worktree: string
  readonly lease?: WorkflowWorkspaceLease
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workflow = yield* WorkflowService.Service
    const scheduler = yield* WorkflowScheduler.Service
    const background = yield* WorkflowBackgroundTask.Service
    const executor = yield* WorkflowTaskExecutor.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const instances = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const worktrees = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    const activeRuns = new Map<string, number>()

    const reconcileAttempts = Effect.fn("WorkflowRunner.reconcileAttempts")(function* (
      snapshot: WorkflowService.WorkflowSnapshot,
    ) {
      yield* Effect.forEach(
        snapshot.tasks.filter((task) => (task.state === "working" || task.state === "needs_input") && task.sessionID),
        (task) =>
          Effect.gen(function* () {
            if (!task.sessionID) return
            if (task.state === "needs_input") {
              yield* Effect.sync(() => reconcilePermissionAbandonment(task.sessionID!))
              return
            }
            const latest = (
              yield* sessions
                .messages({ sessionID: task.sessionID, limit: 1 })
                .pipe(Effect.catchCause(() => Effect.succeed([])))
            )[0]
            const backgroundAttempt = yield* background
              .getAttempt({ sessionID: task.sessionID })
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            const terminalMessage =
              latest?.info.role === "assistant" &&
              (latest.info.error !== undefined || Boolean(latest.info.finish) || latest.info.time.completed !== undefined)
                ? latest
                : undefined
            const result = terminalMessage
              ? WorkflowTaskExecutor.resultFromMessage(task, terminalMessage)
              : backgroundAttempt?.state === "completed"
                ? ({ state: "completed", summary: backgroundAttempt.result?.summary } satisfies ExecutionResult)
                : backgroundAttempt && ["failed", "cancelled", "interrupted"].includes(backgroundAttempt.state)
                  ? ({
                      state: "failed",
                      failureClass: isTransientWorkflowError(
                        backgroundAttempt.result?.error ??
                          backgroundAttempt.result?.summary ??
                          `Background task ended as ${backgroundAttempt.state} before the workflow attempt was reconciled.`,
                      )
                        ? "transient"
                        : "environment",
                      error:
                        backgroundAttempt.result?.error ??
                        `Background task ended as ${backgroundAttempt.state} before the workflow attempt was reconciled.`,
                      summary: backgroundAttempt.result?.summary,
                    } satisfies ExecutionResult)
                  : undefined
            if (!result) return

            if (backgroundAttempt && !["completed", "failed", "cancelled", "interrupted"].includes(backgroundAttempt.state)) {
              yield* background
                .finishAttempt({
                  taskID: task.sessionID,
                  generation: backgroundAttempt.generation,
                  state: result.state === "completed" ? "completed" : "failed",
                  result: {
                    summary: result.summary,
                    error: result.error,
                    changedFiles: [],
                    transcriptSessionID: task.sessionID,
                  },
                })
                .pipe(Effect.catchCause(() => Effect.void))
            }
            yield* scheduler.finishSession({
              sessionID: task.sessionID,
              ...(backgroundAttempt === undefined ? {} : { backgroundGeneration: backgroundAttempt.generation }),
              state: result.state,
              summary: result.summary,
              error: result.error,
              failureClass: result.failureClass,
              usage: result.usage,
              evidence: result.evidence,
            })
          }).pipe(Effect.catchCause(() => Effect.void)),
        { concurrency: 8, discard: true },
      )
    })

    const executionWorkspace = Effect.fn("WorkflowRunner.executionWorkspace")(function* (
      snapshot: WorkflowService.WorkflowSnapshot,
    ) {
      const current = yield* InstanceState.context
      const mode = workspaceMode(snapshot)
      const previous =
        snapshot.run.workspaceLease && snapshot.run.workspaceLease.state !== "cleaned"
          ? snapshot.run.workspaceLease
          : undefined
      const lease = (path: string, managed: boolean, branch?: string): WorkflowWorkspaceLease | undefined =>
        mode === undefined
          ? undefined
          : previous && previous.path === path && previous.mode === mode
            ? { ...previous, state: "active" }
            : {
                id: `lease_${ulid().toLowerCase()}`,
                mode,
                path,
                ...(branch === undefined ? {} : { branch }),
                state: "active",
                managed,
                createdAt: Date.now(),
              }
      if (mode !== "per-loop-worktree" && mode !== "per-run-worktree") {
        return {
          directory: current.directory,
          worktree: current.worktree,
          lease: lease(current.directory, false),
        } satisfies ExecutionWorkspace
      }

      const root =
        snapshot.run.rootSessionID
          ? yield* sessions.get(snapshot.run.rootSessionID as SessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      if (root && (root.directory !== current.directory || current.worktree !== current.project.worktree)) {
        return {
          directory: root.directory,
          worktree: root.directory,
          lease: lease(root.directory, false),
        } satisfies ExecutionWorkspace
      }

      if (!root && mode === "per-loop-worktree" && snapshot.run.originSessionID) {
        const origin = yield* sessions
          .get(snapshot.run.originSessionID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (origin && (origin.directory !== current.directory || current.worktree !== current.project.worktree)) {
          return {
            directory: origin.directory,
            worktree: origin.directory,
            lease: lease(origin.directory, false),
          } satisfies ExecutionWorkspace
        }
      }

      if (current.worktree !== current.project.worktree) {
        return {
          directory: current.directory,
          worktree: current.worktree,
          lease: lease(current.directory, false),
        } satisfies ExecutionWorkspace
      }
      if (root) {
        throw new Error(`Workflow ${snapshot.run.id} already has a root session in the primary workspace`)
      }

      if (!worktrees) throw new Error("Worktree service unavailable for an isolated workflow workspace")
      const created = yield* worktrees.createReady({ name: `${snapshot.definition.name}-${snapshot.run.id}` })
      return {
        directory: created.directory,
        worktree: created.directory,
        lease: lease(created.directory, true, created.branch),
      } satisfies ExecutionWorkspace
    })

    const cleanupWorkspace = Effect.fn("WorkflowRunner.cleanupWorkspace")(function* (input: {
      readonly runID: string
      readonly target: ExecutionWorkspace
      readonly current: InstanceContext
    }) {
      const lease = input.target.lease
      if (!lease?.managed) return
      const snapshot = yield* workflow
        .show(input.runID as never)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!snapshot) return
      if (lease.mode !== "per-run-worktree" || snapshot.run.state !== "completed") {
        const state = snapshot.run.state === "failed" || snapshot.run.state === "stopped" ? "retained" : "active"
        if (lease.state !== state) {
          yield* workflow
            .setWorkspaceLease({ runID: input.runID as never, workspaceLease: { ...lease, state } })
            .pipe(Effect.asVoid)
        }
        return
      }

      const cleaning = { ...lease, state: "cleaning" as const }
      yield* workflow.setWorkspaceLease({ runID: input.runID as never, workspaceLease: cleaning }).pipe(Effect.asVoid)
      if (!instances || !worktrees) {
        yield* workflow
          .setWorkspaceLease({
            runID: input.runID as never,
            workspaceLease: { ...cleaning, state: "failed", error: "Workspace cleanup services unavailable" },
          })
          .pipe(Effect.asVoid)
        return
      }

      const instance = yield* instances
        .load({ directory: input.target.directory, worktree: input.target.worktree, project: input.current.project })
        .pipe(
          Effect.map((ctx) => ({ ok: true as const, ctx })),
          Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: errorText(Cause.squash(cause)) })),
        )
      if (!instance.ok) {
        yield* workflow
          .setWorkspaceLease({
            runID: input.runID as never,
            workspaceLease: { ...cleaning, state: "failed", error: instance.error },
          })
          .pipe(Effect.asVoid)
        return
      }
      const disposed = yield* instances.dispose(instance.ctx).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false as const)),
      )
      if (!disposed) {
        yield* workflow
          .setWorkspaceLease({
            runID: input.runID as never,
            workspaceLease: {
              ...cleaning,
              state: "failed",
              error: "Failed to dispose the workflow workspace instance",
            },
          })
          .pipe(Effect.asVoid)
        return
      }
      const removed = yield* worktrees.remove({ directory: input.target.directory }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false as const)),
      )
      yield* workflow
        .setWorkspaceLease({
          runID: input.runID as never,
          workspaceLease: removed
            ? { ...cleaning, state: "cleaned" }
            : { ...cleaning, state: "retained", error: "Failed to remove the completed workflow worktree" },
        })
        .pipe(Effect.asVoid)
    })

    const executeClaim = Effect.fn("WorkflowRunner.executeClaim")(function* (input: {
      readonly runID: string
      readonly claim: WorkflowTaskClaim
      readonly rootSessionID: SessionID
      readonly planModel?: WorkflowTaskClaim["task"]["model"]
      readonly planPermissions?: WorkflowPermissionPolicy
      readonly sessionPermissionMode: WorkflowSessionPermissionMode
      readonly planWorkspace?: WorkflowTaskClaim["task"]["workspace"]
      readonly artifacts: readonly {
        readonly taskID?: string
        readonly summary: string
        readonly evidence: readonly string[]
      }[]
    }) {
      const model = input.claim.task.model ?? input.planModel
      const policy = WorkflowPolicy.taskPolicy({
        workflow: input.planPermissions,
        task: input.claim.task,
        workspace: input.planWorkspace,
        maxDepth: input.claim.maxDepth,
      })
      const attempt = yield* background.startAttempt({
        runID: input.runID as never,
        taskID: input.claim.taskID,
        parentSessionID: input.rootSessionID,
        rootSessionID: input.rootSessionID,
        title: input.claim.task.name,
        agent: input.claim.task.agentProfile ?? "general",
        model,
        permission: Permission.withSessionMode(policy.permission, input.sessionPermissionMode),
        depth: 1,
        maxChildren: input.claim.maxChildren,
      })
      yield* scheduler
        .markStarted({
          runID: input.runID as never,
          taskID: input.claim.taskID,
          attemptID: input.claim.attemptID,
          backgroundTaskID: attempt.sessionID,
          backgroundGeneration: attempt.generation,
        })
        .pipe(
          Effect.tapCause(() =>
            background
              .cancelAttempt({ sessionID: attempt.sessionID, generation: attempt.generation })
              .pipe(Effect.catchCause(() => Effect.void)),
          ),
        )

      const latest = yield* workflow.show(input.runID as never)
      if (!workflowClaimCanExecute(latest, input.claim, attempt.sessionID)) {
        yield* background
          .cancelAttempt({ sessionID: attempt.sessionID, generation: attempt.generation })
          .pipe(Effect.catchCause(() => Effect.void))
        return
      }

      const result: ExecutionResult = yield* executor
        .execute({
          task: input.claim.task,
          sessionID: attempt.sessionID,
          workflowModel: input.planModel,
          context: [
            WorkflowPolicy.workspaceInstruction(policy.workspace),
            artifactContext({ task: input.claim.task, artifacts: input.artifacts }),
          ]
            .filter(Boolean)
            .join("\n\n"),
          workflowPermissions: input.planPermissions,
          workflowWorkspace: input.planWorkspace,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.succeed<ExecutionResult>({
              state: "failed" as const,
              failureClass: isTransientWorkflowError(errorText(Cause.squash(cause))) ? "transient" as const : "environment" as const,
              error: errorText(Cause.squash(cause)),
            }),
          ),
        )

      if (result.state === "needs_input" || result.state === "blocked") {
        yield* scheduler.finish({
          runID: input.runID as never,
          taskID: input.claim.taskID,
          attemptID: input.claim.attemptID,
          attempt: input.claim.attempt,
          state: result.state,
          summary: result.summary,
          error: result.error,
          failureClass: result.failureClass,
          usage: result.usage,
          evidence: result.evidence,
        })
        yield* background.finishAttempt({
          taskID: attempt.sessionID,
          generation: attempt.generation,
          state: result.state === "needs_input" ? "interrupted" : "failed",
          result: {
            summary: result.summary,
            error: result.error,
            changedFiles: [],
            transcriptSessionID: attempt.sessionID,
          },
        })
        return
      }

      yield* background.finishAttempt({
        taskID: attempt.sessionID,
        generation: attempt.generation,
        state: result.state === "completed" ? "completed" : "failed",
        result: {
          summary: result.summary,
          error: result.error,
          changedFiles: [],
          transcriptSessionID: attempt.sessionID,
        },
      })
      yield* scheduler.finish({
        runID: input.runID as never,
        taskID: input.claim.taskID,
        attemptID: input.claim.attemptID,
        attempt: input.claim.attempt,
        state: result.state,
        summary: result.summary,
        error: result.error,
        failureClass: result.failureClass,
        usage: result.usage,
        evidence: result.evidence,
      })
    })

    const auditCompletion = Effect.fn("WorkflowRunner.auditCompletion")(function* (input: {
      readonly snapshot: WorkflowService.WorkflowSnapshot
      readonly rootSessionID: SessionID
      readonly directory: string
      readonly sessionPermissionMode: WorkflowSessionPermissionMode
    }) {
      const pending = input.snapshot.run.completion
      if (!shouldAuditWorkflowCompletion(input.snapshot.run.state)) return false
      if (!pending || (pending.status !== "candidate" && pending.status !== "auditing")) return false
      const fingerprintBeforeResult = yield* Effect.promise(() => fingerprintWorkspace(input.directory))
      const holder = `workflow-completion-auditor:${process.pid}:${crypto.randomUUID()}`
      const auditLeaseMs = 10 * 60_000
      const progress = yield* workflow.claimCompletionAudit({
        runID: input.snapshot.run.id,
        holder,
        leaseMs: auditLeaseMs,
        ...(fingerprintBeforeResult.status === "ok" ? { candidateFingerprint: fingerprintBeforeResult.value } : {}),
      })
      if (!progress) return false

      const withAuditLeaseHeartbeat = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(Duration.millis(Math.floor(auditLeaseMs / 3)))
                const renewal = yield* workflow.claimCompletionAudit({
                  runID: input.snapshot.run.id,
                  holder,
                  leaseMs: auditLeaseMs,
                }).pipe(Effect.option)
                if (Option.isSome(renewal) && !renewal.value) return
              }
            }).pipe(Effect.forkScoped)
            return yield* effect
          }),
        )

      const checks = input.snapshot.revision.plan.completion?.validationChecks ?? []
      const validationAllowed = input.snapshot.revision.plan.permissions?.mode !== "report-only" &&
        input.snapshot.revision.plan.workspace?.mode !== "read-only"
      const validationResults = yield* withAuditLeaseHeartbeat(
        Effect.forEach(
          checks,
          (check) => runCompletionValidationCommand(
            check.command,
            input.directory,
            Math.max(1_000, Math.min(check.timeoutMs ?? 120_000, 10 * 60_000)),
            validationAllowed,
          ).pipe(Effect.map((result) => ({ check, result }))),
          { concurrency: 1 },
        ),
      )
      const gates: CompletionGate[] = validationResults.map(({ check, result }) => ({
        id: `validation:${check.id}`,
        status: result.status,
        summary: result.summary,
      }))

      const criteria = WorkflowService.workflowCompletionCriteria(input.snapshot.revision.plan)
      const phaseID = input.snapshot.revision.plan.phases.toSorted((left, right) => right.ordinal - left.ordinal)[0]!.id
      const auditTask: WorkflowTaskClaim["task"] = {
        id: WorkflowTaskID.make("completion-audit"),
        phaseID: WorkflowPhaseID.make(phaseID),
        name: "Fresh workflow completion audit",
        kind: "verify",
        prompt: [
          "You are the terminal workflow auditor, not an implementation worker.",
          "Perform a fresh read-only inspection of the current workspace and the recorded workflow evidence.",
          "Do not trust task completion flags or summaries by themselves. Verify every criterion independently.",
          "Return pass only when every criterion has concrete current evidence. Missing or ambiguous evidence is uncertain, not pass.",
          `Workflow objective: ${input.snapshot.revision.plan.objective}`,
          "Completion criteria:",
          ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`),
          "Deterministic validation gates:",
          ...(gates.length ? gates.map((gate) => `- ${gate.id}: ${gate.status} - ${gate.summary ?? "no summary"}`) : ["- none configured"]),
          "Recorded workflow artifacts (untrusted summaries; inspect underlying workspace when relevant):",
          ...input.snapshot.artifacts.slice(0, 50).map((artifact) => `- ${artifact.kind}/${artifact.status}: ${artifact.summary}${artifact.evidence.length ? ` | evidence: ${artifact.evidence.join("; ")}` : ""}`),
          "The JSON result must include every criterion id exactly once and at least one concrete evidence string for every passing criterion.",
        ].join("\n"),
        dependsOn: [],
        output: {
          kind: "json",
          schema: JSON.parse(JSON.stringify(completionAuditJsonSchema)) as never,
        },
        agentProfile: "explore",
        allowedTools: ["read", "grep", "glob"],
        permissions: {
          mode: "report-only",
          allowedTools: ["read", "grep", "glob"],
          allowEdits: false,
          allowMutatingCommands: false,
          allowExternalSend: false,
        },
        workspace: { mode: "read-only" },
      }
      const policy = WorkflowPolicy.taskPolicy({
        workflow: input.snapshot.revision.plan.permissions,
        task: auditTask,
        workspace: input.snapshot.revision.plan.workspace,
      })
      const auditSession = yield* sessions.create({
        parentID: input.rootSessionID,
        title: `Completion audit: ${input.snapshot.definition.name}`,
        agent: "explore",
        permission: Permission.withSessionMode(policy.permission, input.sessionPermissionMode),
      })
      const executionResult = fingerprintBeforeResult.status === "ok"
        ? yield* withAuditLeaseHeartbeat(
            executor.execute({
              task: auditTask,
              sessionID: auditSession.id,
              timeoutMs: completionAuditResponseTimeoutMs,
              workflowModel: input.snapshot.revision.plan.model,
              workflowPermissions: input.snapshot.revision.plan.permissions,
              workflowWorkspace: input.snapshot.revision.plan.workspace,
            }).pipe(
              Effect.catchCause((cause) => Effect.succeed<ExecutionResult>({
                state: "failed",
                failureClass: isTransientWorkflowError(errorText(Cause.squash(cause))) ? "transient" : "environment",
                error: errorText(Cause.squash(cause)),
              })),
            ),
          )
        : {
            state: "blocked" as const,
            failureClass: "environment" as const,
            error: fingerprintBeforeResult.summary,
          }
      const auditMessages = yield* sessions.messages({ sessionID: auditSession.id, view: "full" }).pipe(
        Effect.catchCause(() => Effect.succeed([])),
      )
      const inspectionTools = auditMessages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          (part.tool === "read" || part.tool === "grep" || part.tool === "glob")
            ? [part.tool]
            : [],
        ),
      )
      gates.push({
        id: "audit-inspection",
        status: inspectionTools.length ? "pass" : "fail",
        summary: inspectionTools.length
          ? `Fresh auditor completed ${inspectionTools.length} read-only workspace inspection(s).`
          : "Fresh auditor returned without completing a read, grep, or glob workspace inspection.",
      })
      const fingerprintAfterResult = yield* Effect.promise(() => fingerprintWorkspace(input.directory))
      const fingerprintsAvailable = fingerprintBeforeResult.status === "ok" && fingerprintAfterResult.status === "ok"
      const fingerprintsStable = fingerprintsAvailable &&
        fingerprintBeforeResult.value === fingerprintAfterResult.value &&
        (!progress.candidateFingerprint || progress.candidateFingerprint === fingerprintBeforeResult.value)
      gates.push({
        id: "workspace-fingerprint",
        status: fingerprintsStable ? "pass" : fingerprintsAvailable ? "fail" : "blocked",
        summary: fingerprintsStable
          ? "Workspace fingerprint matched the candidate and stayed stable during the fresh audit."
          : fingerprintsAvailable
            ? "Workspace changed after the completion candidate was recorded or during its audit."
            : fingerprintAfterResult.summary,
      })
      const receipt = workflowCompletionAuditReceipt({
        result: executionResult,
        progress,
        criteria,
        fingerprintBefore: fingerprintBeforeResult.status === "ok" ? fingerprintBeforeResult.value : undefined,
        fingerprintAfter: fingerprintAfterResult.status === "ok" ? fingerprintAfterResult.value : undefined,
        now: Date.now(),
      })
      yield* workflow.applyCompletionAudit({
        runID: input.snapshot.run.id,
        holder,
        receipt,
        gates,
        usage: executionResult.usage,
      })
      return true
    })

    const failClaim = Effect.fn("WorkflowRunner.failClaim")(function* (input: {
      readonly runID: string
      readonly claim: WorkflowTaskClaim
      readonly error: string
    }) {
      yield* scheduler.finish({
        runID: input.runID as never,
        taskID: input.claim.taskID,
        attemptID: input.claim.attemptID,
        attempt: input.claim.attempt,
        state: "failed",
        error: input.error,
        failureClass: isTransientWorkflowError(input.error) ? "transient" : "environment",
      })
    })

    const run = Effect.fn("WorkflowRunner.run")(function* (runID: string) {
      const id = runID as never
      const initial = yield* workflow.show(id)
      yield* reconcileAttempts(initial)
      const recovered = yield* workflow.show(id)
      if (!["queued", "working"].includes(recovered.run.state)) return
      const current = yield* InstanceState.context
      const target = yield* executionWorkspace(recovered)
      const execute = Effect.gen(function* () {
        const root = yield* background.ensureRoot({
          runID: id,
          title: recovered.definition.name,
          model: recovered.revision.plan.model,
        })

        while (true) {
          const snapshot = yield* workflow.show(id)
          const sessionPermissionMode =
            snapshot.run.sessionPermissionMode ?? (yield* Effect.promise(() => readPermissionsConfig())).mode
          const tick = yield* scheduler.tick(id)
          if (tick.claimed.length === 0) {
            const pending = yield* workflow.show(id)
            const audited = yield* auditCompletion({
              snapshot: pending,
              rootSessionID: root.sessionID,
              directory: target.directory,
              sessionPermissionMode,
            })
            if (audited) continue
            if (tick.nextWakeAt === undefined) return
            yield* Effect.sleep(Duration.millis(Math.max(1, tick.nextWakeAt - Date.now())))
            continue
          }
          yield* Effect.forEach(
            tick.claimed,
            (claim) =>
              executeClaim({
                runID,
                claim,
                rootSessionID: root.sessionID,
                planModel: snapshot.revision.plan.model,
                planPermissions: WorkflowPolicy.permissionPolicyForMode(
                  snapshot.revision.plan.permissions,
                  snapshot.run.permissionMode,
                ),
                sessionPermissionMode,
                planWorkspace: snapshot.revision.plan.workspace,
                artifacts: snapshot.artifacts,
              }).pipe(
                Effect.catchCause((cause) =>
                  failClaim({
                    runID,
                    claim,
                    error: errorText(Cause.squash(cause)),
                  }).pipe(Effect.catchCause(() => Effect.void)),
                ),
              ),
            { concurrency: Math.max(1, Math.min(snapshot.preview.maxConcurrency, tick.claimed.length)), discard: true },
          )
        }
      })
      const executeTarget =
        target.directory === current.directory
          ? execute
          : !instances
            ? Effect.fail(new Error("Instance store unavailable for an isolated workflow workspace"))
            : instances.provide(
                {
                  directory: target.directory,
                  worktree: target.worktree,
                  project: current.project,
                },
                execute,
              )
      yield* Effect.gen(function* () {
        if (target.lease) {
          yield* workflow.setWorkspaceLease({ runID: id, workspaceLease: target.lease }).pipe(Effect.asVoid)
        }
        yield* executeTarget
      }).pipe(Effect.ensuring(cleanupWorkspace({ runID, target, current }).pipe(Effect.catchCause(() => Effect.void))))
    })

    const stop = (runID: string): Effect.Effect<void, WorkflowService.WorkflowNotFoundError> =>
      Effect.gen(function* () {
        const snapshot = yield* workflow.show(runID as never)
        if (!snapshot.run.rootSessionID) return
        const children = yield* background.listChildren(snapshot.run.rootSessionID)
        yield* Effect.forEach(
          children.filter(
            (child) => ["queued", "running", "needs_input"].includes(child.state) && child.controlIntent !== "cancel",
          ),
          (child) =>
            background
              .cancelAttempt({ sessionID: child.taskID, generation: child.generation })
              .pipe(Effect.catchCause(() => Effect.void)),
          { concurrency: 8, discard: true },
        )
      }).pipe(Effect.mapError(() => new WorkflowService.WorkflowNotFoundError(runID)))

    const setPermissionMode = Effect.fn("WorkflowRunner.setPermissionMode")(function* (
      input: WorkflowService.WorkflowPermissionModeInput,
    ) {
      const snapshot = yield* workflow.setPermissionMode(input)
      if (!snapshot.run.rootSessionID) return snapshot
      const children = yield* background.listChildren(snapshot.run.rootSessionID)
      const sessionIDs = Array.from(
        new Set([
          snapshot.run.rootSessionID,
          ...snapshot.tasks.flatMap((task) => (task.sessionID ? [task.sessionID] : [])),
          ...children.map((child) => child.taskID),
        ]),
      )
      const sessionPermissionMode =
        snapshot.run.sessionPermissionMode ?? (yield* Effect.promise(() => readPermissionsConfig())).mode

      yield* Effect.forEach(
        sessionIDs,
        (sessionID) =>
          sessions.get(sessionID).pipe(
            Effect.flatMap((session) =>
              sessions.setPermission({
                sessionID,
                permission: Permission.withSessionMode(session.permission ?? [], sessionPermissionMode),
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        { concurrency: 8, discard: true },
      )
      if (sessionIDs.length === 0) return snapshot

      if (input.mode !== undefined && snapshot.run.permissionMode !== "custom") {
        yield* permissions.replyForSessions({
          sessionIDs,
          reply: snapshot.run.permissionMode === "normal" ? "always" : "reject",
        })
        return snapshot
      }
      if (sessionPermissionMode === "full_access") {
        yield* permissions.replyForSessions({ sessionIDs, reply: "once" })
      }
      if (sessionPermissionMode === "smart") {
        yield* permissions.replyForSessions({
          sessionIDs,
          reply: "once",
          filter: Permission.isSafeSmartAutoApprovalRequest,
        })
      }
      return snapshot
    })

    const launch = Effect.fn("WorkflowRunner.launch")(function* (runID: string, force: boolean) {
      const active = activeRuns.get(runID) ?? 0
      if (active > 0 && !force) return
      activeRuns.set(runID, active + 1)
      yield* Effect.forkIn(
        run(runID).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (activeRuns.get(runID) ?? 1) - 1
              if (remaining > 0) activeRuns.set(runID, remaining)
              else activeRuns.delete(runID)
            }),
          ),
        ),
        scope,
      )
    })

    const start = Effect.fn("WorkflowRunner.start")((runID: string) => launch(runID, false))
    const wake = Effect.fn("WorkflowRunner.wake")((runID: string) => launch(runID, true))

    // A process restart loses the in-memory RunWake event and activeRuns map,
    // but the workflow run and task leases remain durable. Reattach every
    // runnable run once the instance services are ready; approval, pause,
    // input, and terminal states remain operator-controlled. Repeat the scan
    // so a sibling server holding SQLite during startup cannot strand a queued
    // run forever after the first recovery attempt fails.
    const recoverDurableRuns = Effect.gen(function* () {
      let snapshots: readonly WorkflowService.WorkflowSnapshot[] | undefined
      for (let attempt = 0; attempt < 4 && snapshots === undefined; attempt++) {
        const result = yield* workflow.list(500).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchCause(() => Effect.succeed({ ok: false as const })),
        )
        if (result.ok) {
          snapshots = result.value
          break
        }
        if (attempt < 3) yield* Effect.sleep(Duration.millis(250 * (attempt + 1)))
      }
      if (!snapshots) return
      yield* Effect.forEach(
        snapshots.filter((snapshot) => shouldRecoverWorkflowRun(snapshot.run.state)),
        (snapshot) => launch(snapshot.run.id, false).pipe(Effect.catchCause(() => Effect.void)),
        { concurrency: 8, discard: true },
      )
    }).pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(5))),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* bus.subscribe(WorkflowService.Event.RunWake).pipe(
      Stream.runForEach((event) => wake(event.properties.runID).pipe(Effect.catchCause(() => Effect.void))),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ start, wake, run, stop, setPermissionMode })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Permission.defaultLayer),
  Layer.provide(WorkflowTaskExecutor.defaultLayer),
  Layer.provide(WorkflowBackgroundTask.defaultLayer),
  Layer.provide(WorkflowScheduler.defaultLayer),
  Layer.provide(WorkflowService.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as WorkflowRunner from "./workflow-runner"
