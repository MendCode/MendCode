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

const mapWorkflowError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ApiError.ApiBadRequestError | ApiError.ApiNotFoundError, R> =>
  effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error))))

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowService
    const runner = yield* WorkflowRunner.Service

    const preview = Effect.fn("WorkflowHttpApi.preview")(function* (ctx: { payload: typeof WorkflowPreviewPayload.Type }) {
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
      return yield* workflow.list(ctx.query.limit)
    })

    const show = Effect.fn("WorkflowHttpApi.show")(function* (ctx: { params: { runID: Workflow.WorkflowRunID } }) {
      return yield* mapWorkflowError(workflow.show(ctx.params.runID))
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
      return yield* mapWorkflowError(workflow.pause({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }))
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowControlPayload.Type
    }) {
      const resumed = yield* mapWorkflowError(workflow.resume({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }))
      yield* runner.start(resumed.run.id)
      return resumed
    })

    const stop = Effect.fn("WorkflowHttpApi.stop")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowControlPayload.Type
    }) {
      const stopped = yield* mapWorkflowError(workflow.stop({ runID: ctx.params.runID, reason: ctx.payload.reason, actor: "api" }))
      yield* mapWorkflowError(runner.stop(stopped.run.id))
      return stopped
    })

    const retryTask = Effect.fn("WorkflowHttpApi.retryTask")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowRetryTaskPayload.Type
    }) {
      const retried = yield* mapWorkflowError(workflow.retryTask({ runID: ctx.params.runID, taskID: ctx.payload.taskID, reason: ctx.payload.reason, actor: "api" }))
      yield* runner.start(retried.run.id)
      return retried
    })

    const retryPhase = Effect.fn("WorkflowHttpApi.retryPhase")(function* (ctx: {
      params: { runID: Workflow.WorkflowRunID }
      payload: typeof WorkflowRetryPhasePayload.Type
    }) {
      const retried = yield* mapWorkflowError(workflow.retryPhase({ runID: ctx.params.runID, phaseID: ctx.payload.phaseID, reason: ctx.payload.reason, actor: "api" }))
      yield* runner.start(retried.run.id)
      return retried
    })

    return handlers
      .handle("preview", preview)
      .handle("save", save)
      .handle("start", start)
      .handle("list", list)
      .handle("show", show)
      .handle("events", events)
      .handle("artifacts", artifacts)
      .handle("pause", pause)
      .handle("resume", resume)
      .handle("stop", stop)
      .handle("retryTask", retryTask)
      .handle("retryPhase", retryPhase)
  }),
)
