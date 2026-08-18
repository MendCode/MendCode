import { Workflow } from "@/session/workflow"
import type { WorkflowPlan as WorkflowPlanInput } from "@/session/workflow-plan"
import { WorkflowRunner } from "@/session/workflow-runner"
import {
  Service as WorkflowService,
  type WorkflowSaveInput,
  type WorkflowStartInput,
  WorkflowNotFoundError,
  WorkflowStateError,
  WorkflowValidationError,
} from "@/session/workflow-service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import {
  WorkflowControlPayload,
  WorkflowListQuery,
  WorkflowPermissionModePayload,
  WorkflowPreviewPayload,
  WorkflowRetryPhasePayload,
  WorkflowRetryTaskPayload,
  WorkflowSavePayload,
  WorkflowStartPayload,
} from "../groups/workflow"

const toApiError = (error: unknown) => {
  if (error instanceof WorkflowNotFoundError) return ApiError.notFound(error.message)
  if (error instanceof WorkflowValidationError) {
    return ApiError.badRequest({ name: error.name, issues: error.issues })
  }
  if (error instanceof WorkflowStateError) {
    return ApiError.badRequest({ name: error.name, id: error.id, message: error.message })
  }
  return ApiError.badRequest({ message: error instanceof Error ? error.message : String(error) })
}

const mapWorkflowError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ApiError.ApiBadRequestError | ApiError.ApiNotFoundError, R> =>
  effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error))))

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowService
    const runner = yield* WorkflowRunner.Service

    const preview = Effect.fn("WorkflowHttpApi.preview")(function* (ctx: {
      payload: typeof WorkflowPreviewPayload.Type
    }) {
      return yield* mapWorkflowError(workflow.preview(ctx.payload.plan as unknown as WorkflowPlanInput))
    })

    const save = Effect.fn("WorkflowHttpApi.save")(function* (ctx: { payload: typeof WorkflowSavePayload.Type }) {
      return yield* mapWorkflowError(workflow.save(ctx.payload as unknown as WorkflowSaveInput))
    })

    const start = Effect.fn("WorkflowHttpApi.start")(function* (ctx: { payload: typeof WorkflowStartPayload.Type }) {
      const started = yield* mapWorkflowError(workflow.start(ctx.payload as unknown as WorkflowStartInput))
      yield* runner.start(started.run.id)
      return started
    })

    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: typeof WorkflowListQuery.Type }) {
      const initial = yield* workflow.list(ctx.query.limit)
      const stranded = initial.filter((snapshot) => snapshot.run.state === "needs_input")
      yield* Effect.forEach(stranded, (snapshot) => runner.run(snapshot.run.id).pipe(Effect.catchCause(() => Effect.void)), {
        concurrency: 8,
        discard: true,
      })
      const snapshots = stranded.length ? yield* workflow.list(ctx.query.limit) : initial
      yield* Effect.forEach(
        snapshots.filter((snapshot) => snapshot.run.state === "queued" || snapshot.run.state === "working"),
        (snapshot) => runner.start(snapshot.run.id),
        { concurrency: 8, discard: true },
      )
      return snapshots
    })

    const show = Effect.fn("WorkflowHttpApi.show")(function* (ctx: { params: { runID: Workflow.WorkflowRunID } }) {
      const initial = yield* mapWorkflowError(workflow.show(ctx.params.runID))
      if (initial.run.state === "needs_input") yield* runner.run(initial.run.id).pipe(Effect.catchCause(() => Effect.void))
      const snapshot = initial.run.state === "needs_input" ? yield* mapWorkflowError(workflow.show(initial.run.id)) : initial
      if (snapshot.run.state === "queued" || snapshot.run.state === "working") yield* runner.start(snapshot.run.id)
      return snapshot
    })

    const remove = Effect.fn("WorkflowHttpApi.remove")(function* (ctx: { params: { runID: Workflow.WorkflowRunID } }) {
      return yield* mapWorkflowError(workflow.remove(ctx.params.runID))
    })

    const events = Effect.fn("WorkflowHttpApi.events")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      query: typeof WorkflowListQuery.Type
    }) {
      return yield* mapWorkflowError(workflow.events(ctx.params.runID, ctx.query.limit))
    })

    const artifacts = Effect.fn("WorkflowHttpApi.artifacts")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      query: typeof WorkflowListQuery.Type
    }) {
      return yield* mapWorkflowError(workflow.artifacts(ctx.params.runID, ctx.query.limit))
    })

    const pause = Effect.fn("WorkflowHttpApi.pause")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowControlPayload.Type
    }) {
      return yield* mapWorkflowError(
        workflow.pause({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }),
      )
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowControlPayload.Type
    }) {
      const resumed = yield* mapWorkflowError(
        workflow.resume({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }),
      )
      yield* runner.wake(resumed.run.id)
      return resumed
    })

    const stop = Effect.fn("WorkflowHttpApi.stop")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowControlPayload.Type
    }) {
      const stopped = yield* mapWorkflowError(
        workflow.stop({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }),
      )
      yield* mapWorkflowError(runner.stop(stopped.run.id))
      return stopped
    })

    const permissionMode = Effect.fn("WorkflowHttpApi.permissionMode")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowPermissionModePayload.Type
    }) {
      const changed = yield* mapWorkflowError(
        runner.setPermissionMode({
          runID: ctx.params.runID,
          mode: ctx.payload.mode,
          sessionMode: ctx.payload.sessionMode === "global_default" ? null : ctx.payload.sessionMode,
          reason: ctx.payload.reason,
          actor: "api",
        }),
      )
      if (changed.run.state === "queued") yield* runner.start(changed.run.id)
      return changed
    })

    const retryTask = Effect.fn("WorkflowHttpApi.retryTask")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowRetryTaskPayload.Type
    }) {
      const retried = yield* mapWorkflowError(
        workflow.retryTask({
          runID: ctx.params.runID,
          taskID: ctx.payload.taskID,
          reason: ctx.payload.reason,
          actor: "api",
        }),
      )
      yield* runner.start(retried.run.id)
      return retried
    })

    const retryPhase = Effect.fn("WorkflowHttpApi.retryPhase")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowRetryPhasePayload.Type
    }) {
      const retried = yield* mapWorkflowError(
        workflow.retryPhase({
          runID: ctx.params.runID,
          phaseID: ctx.payload.phaseID,
          reason: ctx.payload.reason,
          actor: "api",
        }),
      )
      yield* runner.start(retried.run.id)
      return retried
    })

    return handlers
      .handle("preview", preview)
      .handle("save", save)
      .handle("start", start)
      .handle("list", list)
      .handle("show", show)
      .handle("remove", remove)
      .handle("events", events)
      .handle("artifacts", artifacts)
      .handle("pause", pause)
      .handle("resume", resume)
      .handle("stop", stop)
      .handle("permissionMode", permissionMode)
      .handle("retryTask", retryTask)
      .handle("retryPhase", retryPhase)
  }),
)
