import { Effect } from "effect"
import { Hono } from "hono"
import type { Context } from "hono"
import z from "zod"
import type { AppServices } from "@/effect/app-runtime"
import { Workflow } from "@/session/workflow"
import { WorkflowPlan } from "@/session/workflow-plan"
import { WorkflowRunner } from "@/session/workflow-runner"
import type { WorkflowPlan as WorkflowPlanInput } from "@/session/workflow-plan"
import {
  Service as WorkflowService,
  type WorkflowSaveInput,
  type WorkflowStartInput,
  WorkflowNotFoundError,
  WorkflowStateError,
  WorkflowValidationError,
} from "@/session/workflow-service"
import { jsonRequest, runRequest } from "./trace"

const reasonBody = z.object({ reason: z.string().optional() })
const permissionModeBody = reasonBody.extend({
  mode: z.enum(["report-only", "normal", "custom"]).optional(),
  sessionMode: z.enum(["approval", "smart", "full_access", "global_default"]).nullable().optional(),
})
const previewBody = z.object({ plan: WorkflowPlan.zod })
const saveBody = previewBody.extend({
  definitionID: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.enum(["session-generated", "saved", "template", "package", "manual"]).optional(),
  ownerSessionID: z.string().optional(),
  saved: z.boolean().optional(),
})
const startBody = z.object({
  plan: WorkflowPlan.zod.optional(),
  revisionID: z.string().optional(),
  definitionID: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.enum(["session-generated", "saved", "template", "package", "manual"]).optional(),
  originSessionID: z.string().optional(),
  loopID: z.string().optional(),
  loopRunID: z.string().optional(),
  overlapKey: z.string().optional(),
})
const retryTaskBody = reasonBody.extend({ taskID: z.string() })
const retryPhaseBody = reasonBody.extend({ phaseID: z.string() })

function errorResponse(error: unknown) {
  if (error instanceof WorkflowNotFoundError) return { status: 404 as const, body: { error: error.message } }
  if (error instanceof WorkflowValidationError)
    return { status: 400 as const, body: { error: error.message, issues: error.issues } }
  if (error instanceof WorkflowStateError) return { status: 400 as const, body: { error: error.message, id: error.id } }
  return { status: 400 as const, body: { error: error instanceof Error ? error.message : String(error) } }
}

async function request<A, E>(name: string, c: Context, effect: Effect.Effect<A, E, AppServices>) {
  const result = await runRequest(
    name,
    c,
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  )
  if (!result.ok) {
    const response = errorResponse(result.error)
    return c.json(response.body, response.status)
  }
  return c.json(result.value)
}

function queryLimit(value: string | undefined) {
  const parsed = value === undefined ? undefined : Number(value)
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

export const WorkflowRoutes = () =>
  new Hono()
    .post("/preview", async (c) => {
      const body = previewBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.preview",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.preview(body.plan as unknown as WorkflowPlanInput)
        }),
      )
    })
    .post("/save", async (c) => {
      const body = saveBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.save",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.save(body as unknown as WorkflowSaveInput)
        }),
      )
    })
    .post("/start", async (c) => {
      const body = startBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.start",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const started = yield* workflow.start(body as unknown as WorkflowStartInput)
          yield* runner.start(started.run.id)
          return started
        }),
      )
    })
    .get("/", async (c) =>
      jsonRequest("WorkflowRoutes.list", c, function* () {
        const workflow = yield* WorkflowService
        const runner = yield* WorkflowRunner.Service
        const initial = yield* workflow.list(queryLimit(c.req.query("limit")))
        const stranded = initial.filter((snapshot) => snapshot.run.state === "needs_input")
        yield* Effect.forEach(stranded, (snapshot) => runner.run(snapshot.run.id).pipe(Effect.catchCause(() => Effect.void)), {
          concurrency: 8,
          discard: true,
        })
        const snapshots = stranded.length ? yield* workflow.list(queryLimit(c.req.query("limit"))) : initial
        yield* Effect.forEach(
          snapshots.filter((snapshot) => snapshot.run.state === "queued" || snapshot.run.state === "working"),
          (snapshot) => runner.start(snapshot.run.id),
          { concurrency: 8, discard: true },
        )
        return snapshots
      }),
    )
    .get("/:runID", async (c) =>
      request(
        "WorkflowRoutes.show",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const initial = yield* workflow.show(Workflow.WorkflowRunID.make(c.req.param("runID")))
          if (initial.run.state === "needs_input") yield* runner.run(initial.run.id).pipe(Effect.catchCause(() => Effect.void))
          const snapshot = initial.run.state === "needs_input" ? yield* workflow.show(initial.run.id) : initial
          if (snapshot.run.state === "queued" || snapshot.run.state === "working") yield* runner.start(snapshot.run.id)
          return snapshot
        }),
      ),
    )
    .delete("/:runID", async (c) =>
      request(
        "WorkflowRoutes.remove",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.remove(Workflow.WorkflowRunID.make(c.req.param("runID")))
        }),
      ),
    )
    .get("/:runID/events", async (c) =>
      request(
        "WorkflowRoutes.events",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.events(
            Workflow.WorkflowRunID.make(c.req.param("runID")),
            queryLimit(c.req.query("limit")),
          )
        }),
      ),
    )
    .get("/:runID/artifacts", async (c) =>
      request(
        "WorkflowRoutes.artifacts",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.artifacts(
            Workflow.WorkflowRunID.make(c.req.param("runID")),
            queryLimit(c.req.query("limit")),
          )
        }),
      ),
    )
    .post("/:runID/pause", async (c) => {
      const body = reasonBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.pause",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          return yield* workflow.pause({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            reason: body.reason,
            actor: "api",
          })
        }),
      )
    })
    .post("/:runID/resume", async (c) => {
      const body = reasonBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.resume",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const resumed = yield* workflow.resume({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            reason: body.reason,
            actor: "api",
          })
          yield* runner.wake(resumed.run.id)
          return resumed
        }),
      )
    })
    .post("/:runID/stop", async (c) => {
      const body = reasonBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.stop",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const stopped = yield* workflow.stop({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            reason: body.reason,
            actor: "api",
          })
          yield* runner.stop(stopped.run.id)
          return stopped
        }),
      )
    })
    .post("/:runID/permission-mode", async (c) => {
      const body = permissionModeBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.permissionMode",
        c,
        Effect.gen(function* () {
          const runner = yield* WorkflowRunner.Service
          const changed = yield* runner.setPermissionMode({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            mode: body.mode,
            sessionMode: body.sessionMode === "global_default" ? null : body.sessionMode,
            reason: body.reason,
            actor: "api",
          })
          if (changed.run.state === "queued") yield* runner.start(changed.run.id)
          return changed
        }),
      )
    })
    .post("/:runID/retry-task", async (c) => {
      const body = retryTaskBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.retryTask",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const retried = yield* workflow.retryTask({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            taskID: Workflow.WorkflowTaskID.make(body.taskID),
            reason: body.reason,
            actor: "api",
          })
          yield* runner.start(retried.run.id)
          return retried
        }),
      )
    })
    .post("/:runID/retry-phase", async (c) => {
      const body = retryPhaseBody.parse(await c.req.json().catch(() => ({})))
      return request(
        "WorkflowRoutes.retryPhase",
        c,
        Effect.gen(function* () {
          const workflow = yield* WorkflowService
          const runner = yield* WorkflowRunner.Service
          const retried = yield* workflow.retryPhase({
            runID: Workflow.WorkflowRunID.make(c.req.param("runID")),
            phaseID: Workflow.WorkflowPhaseID.make(body.phaseID),
            reason: body.reason,
            actor: "api",
          })
          yield* runner.start(retried.run.id)
          return retried
        }),
      )
    })
