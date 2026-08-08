import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Scope } from "effect"
import * as Stream from "effect/Stream"
import { ulid } from "ulid"

import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { Session } from "./session"
import { SessionID } from "./schema"
import * as WorkflowBackgroundTask from "./workflow-background-task"
import * as WorkflowScheduler from "./workflow-scheduler"
import * as WorkflowService from "./workflow-service"
import * as WorkflowTaskExecutor from "./workflow-task-executor"
import { WorkflowPolicy } from "./workflow-policy"
import type { WorkflowTaskClaim } from "./workflow-scheduler"
import type { ExecutionResult } from "./workflow-task-executor"
import type { WorkflowPermissionPolicy, WorkflowWorkspaceLease, WorkflowWorkspaceMode } from "./workflow"

export interface Interface {
  readonly start: (runID: string) => Effect.Effect<void>
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

const RUN_LEASE_HEARTBEAT_MS = 10_000

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
    const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
    const permissions = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    const instances = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const worktrees = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    const activeRuns = new Set<string>()

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
        snapshot.run.rootSessionID && sessions
          ? yield* sessions
              .get(snapshot.run.rootSessionID as SessionID)
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      if (root && (root.directory !== current.directory || current.worktree !== current.project.worktree)) {
        return {
          directory: root.directory,
          worktree: root.directory,
          lease: lease(root.directory, false),
        } satisfies ExecutionWorkspace
      }

      if (!root && mode === "per-loop-worktree" && snapshot.run.originSessionID) {
        const origin = sessions
          ? yield* sessions.get(snapshot.run.originSessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
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
        permission: policy.permission,
        depth: 1,
        maxChildren: input.claim.maxChildren,
      })
      yield* scheduler.markStarted({
        runID: input.runID as never,
        taskID: input.claim.taskID,
        attemptID: input.claim.attemptID,
        backgroundTaskID: attempt.sessionID,
        backgroundGeneration: attempt.generation,
      })

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
              failureClass: "environment" as const,
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
        failureClass: "environment",
      })
    })

    const run = Effect.fn("WorkflowRunner.run")(function* (runID: string) {
      const id = runID as never
      const initial = yield* workflow.show(id)
      const current = yield* InstanceState.context
      const target = yield* executionWorkspace(initial)
      const execute = Effect.gen(function* () {
        const root = yield* background.ensureRoot({
          runID: id,
          title: initial.definition.name,
          model: initial.revision.plan.model,
        })

        while (true) {
          const snapshot = yield* workflow.show(id)
          const tick = yield* scheduler.tick(id)
          if (tick.claimed.length === 0) {
            if (tick.nextWakeAt === undefined) return
            yield* Effect.sleep(Duration.millis(Math.max(1, tick.nextWakeAt - Date.now())))
            continue
          }
          const maintainLease = scheduler.heartbeat(id).pipe(
            Effect.flatMap((renewed) =>
              renewed ? Effect.void : Effect.fail(new Error(`Workflow ${runID} scheduler lease was lost`)),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(RUN_LEASE_HEARTBEAT_MS))),
          )
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
          ).pipe(Effect.raceFirst(maintainLease))
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
      if (!permissions || !snapshot.run.rootSessionID || snapshot.run.permissionMode === "custom") return snapshot
      const waiting = (yield* background.listChildren(snapshot.run.rootSessionID)).filter(
        (child) => child.state === "needs_input",
      )
      if (waiting.length === 0) return snapshot
      yield* permissions.replyForSessions({
        sessionIDs: waiting.map((child) => child.taskID),
        reply: snapshot.run.permissionMode === "normal" ? "always" : "reject",
      })
      return snapshot
    })

    const start = Effect.fn("WorkflowRunner.start")(function* (runID: string) {
      if (activeRuns.has(runID)) return
      activeRuns.add(runID)
      yield* Effect.forkIn(run(runID).pipe(Effect.ensuring(Effect.sync(() => activeRuns.delete(runID)))), scope)
    })

    yield* bus.subscribe(WorkflowService.Event.RunWake).pipe(
      Stream.runForEach((event) => start(event.properties.runID).pipe(Effect.catchCause(() => Effect.void))),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ start, run, stop, setPermissionMode })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(WorkflowTaskExecutor.defaultLayer),
  Layer.provide(WorkflowBackgroundTask.defaultLayer),
  Layer.provide(WorkflowScheduler.defaultLayer),
  Layer.provide(WorkflowService.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as WorkflowRunner from "./workflow-runner"
