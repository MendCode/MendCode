import { SessionID } from "@/session/schema"
import { Workflow } from "@/session/workflow"
import { WorkflowPlan, WorkflowPlanPreview, WorkflowRevision } from "@/session/workflow-plan"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { ApiBadRequestError, ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/workflow"

const WorkflowUsageSnapshot = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
})

const WorkflowPhaseSnapshot = Schema.Struct({
  id: Workflow.WorkflowPhaseID,
  ordinal: Schema.Int,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  state: Workflow.WorkflowPhaseState,
  barrier: Workflow.WorkflowBarrier,
  counts: Schema.Struct({
    total: Schema.Int,
    queued: Schema.Int,
    working: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
    blocked: Schema.Int,
  }),
  usage: Schema.optional(WorkflowUsageSnapshot),
})

const WorkflowTaskSnapshot = Schema.Struct({
  id: Workflow.WorkflowTaskID,
  phaseID: Workflow.WorkflowPhaseID,
  name: Schema.String,
  kind: Workflow.WorkflowTaskKind,
  prompt: Schema.String,
  dependsOn: Schema.Array(Workflow.WorkflowTaskID),
  inputs: Schema.optional(Schema.Array(Workflow.WorkflowArtifactSelector)),
  output: Workflow.WorkflowOutputContract,
  model: Schema.optional(Workflow.WorkflowModelRoute),
  agentProfile: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  workspace: Schema.optional(Workflow.WorkflowWorkspacePolicy),
  permissions: Schema.optional(Workflow.WorkflowPermissionPolicy),
  retry: Schema.optional(Workflow.WorkflowRetryPolicy),
  budget: Schema.optional(Workflow.WorkflowTaskBudget),
  map: Schema.optional(Workflow.WorkflowMapSpec),
  state: Workflow.WorkflowTaskState,
  attempt: Schema.Int,
  sessionID: Schema.optional(SessionID),
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
  blocker: Schema.optional(Schema.String),
  usage: Schema.optional(WorkflowUsageSnapshot),
})

const WorkflowEventSnapshot = Schema.Struct({
  id: Workflow.WorkflowEventID,
  sequence: Schema.Int,
  level: Schema.Literals(["debug", "info", "warning", "error", "decision"]),
  type: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  createdAt: Schema.Number,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const WorkflowGateSnapshot = Schema.Struct({
  id: Workflow.WorkflowGateID,
  phaseID: Schema.optional(Workflow.WorkflowPhaseID),
  taskID: Schema.optional(Workflow.WorkflowTaskID),
  state: Schema.Literals(["pending", "pass", "fail", "blocked", "awaiting_approval", "waived"]),
  required: Schema.Boolean,
  actor: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

export const WorkflowSnapshot = Schema.Struct({
  definition: Workflow.WorkflowDefinition,
  revision: WorkflowRevision,
  run: Workflow.WorkflowRun,
  preview: WorkflowPlanPreview,
  phases: Schema.Array(WorkflowPhaseSnapshot),
  tasks: Schema.Array(WorkflowTaskSnapshot),
  artifacts: Schema.Array(Workflow.WorkflowArtifact),
  events: Schema.Array(WorkflowEventSnapshot),
  gates: Schema.Array(WorkflowGateSnapshot),
  usage: Schema.optional(WorkflowUsageSnapshot),
})

export const WorkflowRevisionReceipt = Schema.Struct({
  definitionID: Workflow.WorkflowDefinitionID,
  revisionID: Workflow.WorkflowRevisionID,
  revision: Schema.Int,
  plan: WorkflowPlan,
  preview: WorkflowPlanPreview,
})

export const WorkflowPreviewPayload = Schema.Struct({ plan: WorkflowPlan })

export const WorkflowSavePayload = Schema.Struct({
  plan: WorkflowPlan,
  definitionID: Schema.optional(Workflow.WorkflowDefinitionID),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.optional(Workflow.WorkflowSource),
  ownerSessionID: Schema.optional(SessionID),
  saved: Schema.optional(Schema.Boolean),
})

export const WorkflowStartPayload = Schema.Struct({
  plan: Schema.optional(WorkflowPlan),
  revisionID: Schema.optional(Workflow.WorkflowRevisionID),
  definitionID: Schema.optional(Workflow.WorkflowDefinitionID),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.optional(Workflow.WorkflowSource),
  originSessionID: Schema.optional(SessionID),
  loopID: Schema.optional(Schema.String),
  loopRunID: Schema.optional(Schema.String),
  overlapKey: Schema.optional(Schema.String),
})

export const WorkflowControlPayload = Schema.Struct({ reason: Schema.optional(Schema.String) })

export const WorkflowPermissionModePayload = Schema.Struct({
  mode: Schema.optional(Workflow.WorkflowPermissionMode),
  sessionMode: Schema.optional(
    Schema.Union([Workflow.WorkflowSessionPermissionMode, Schema.Literal("global_default"), Schema.Null]),
  ),
  reason: Schema.optional(Schema.String),
})

export const WorkflowRetryTaskPayload = Schema.Struct({
  taskID: Workflow.WorkflowTaskID,
  reason: Schema.optional(Schema.String),
})

export const WorkflowRetryPhasePayload = Schema.Struct({
  phaseID: Workflow.WorkflowPhaseID,
  reason: Schema.optional(Schema.String),
})

export const WorkflowListQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
})

export const WorkflowPaths = {
  list: root,
  preview: `${root}/preview`,
  save: `${root}/save`,
  start: `${root}/start`,
  show: `${root}/:runID`,
  remove: `${root}/:runID`,
  events: `${root}/:runID/events`,
  artifacts: `${root}/:runID/artifacts`,
  pause: `${root}/:runID/pause`,
  resume: `${root}/:runID/resume`,
  stop: `${root}/:runID/stop`,
  permissionMode: `${root}/:runID/permission-mode`,
  retryTask: `${root}/:runID/retry-task`,
  retryPhase: `${root}/:runID/retry-phase`,
} as const

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.post("preview", WorkflowPaths.preview, {
          payload: WorkflowPreviewPayload,
          success: described(WorkflowPlanPreview, "Validated workflow plan preview"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.preview",
            summary: "Preview a workflow plan",
            description:
              "Validate a declarative workflow plan and return bounded execution estimates without starting it.",
          }),
        ),
        HttpApiEndpoint.post("save", WorkflowPaths.save, {
          payload: WorkflowSavePayload,
          success: described(WorkflowRevisionReceipt, "Saved immutable workflow revision"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.save",
            summary: "Save a workflow revision",
            description: "Validate and persist an immutable project-scoped workflow plan revision.",
          }),
        ),
        HttpApiEndpoint.post("start", WorkflowPaths.start, {
          payload: WorkflowStartPayload,
          success: described(WorkflowSnapshot, "Started workflow snapshot"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.start",
            summary: "Start a workflow",
            description: "Queue an independent workflow run from a validated plan or saved revision.",
          }),
        ),
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: WorkflowListQuery,
          success: described(Schema.Array(WorkflowSnapshot), "Workflow run snapshots"),
          error: ApiBadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflow runs",
            description: "List bounded workflow snapshots for the current project.",
          }),
        ),
        HttpApiEndpoint.get("show", WorkflowPaths.show, {
          params: { runID: Workflow.WorkflowRunID },
          success: described(WorkflowSnapshot, "Workflow run snapshot"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.show",
            summary: "Inspect a workflow run",
            description: "Read the canonical durable workflow snapshot used for monitor rehydration.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkflowPaths.remove, {
          params: { runID: Workflow.WorkflowRunID },
          success: described(Schema.Boolean, "Successfully deleted workflow run"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.delete",
            summary: "Delete a workflow run",
            description:
              "Permanently delete a terminal workflow run and its persisted phases, tasks, attempts, artifacts, events, and gates.",
          }),
        ),
        HttpApiEndpoint.get("events", WorkflowPaths.events, {
          params: { runID: Workflow.WorkflowRunID },
          query: WorkflowListQuery,
          success: described(Schema.Array(WorkflowEventSnapshot), "Workflow events"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.events",
            summary: "List workflow events",
            description: "Read bounded workflow events for TUI and API rehydration.",
          }),
        ),
        HttpApiEndpoint.get("artifacts", WorkflowPaths.artifacts, {
          params: { runID: Workflow.WorkflowRunID },
          query: WorkflowListQuery,
          success: described(Schema.Array(Workflow.WorkflowArtifact), "Workflow artifacts"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.artifacts",
            summary: "List workflow artifacts",
            description: "Read bounded structured outputs and evidence references for a workflow run.",
          }),
        ),
        HttpApiEndpoint.post("pause", WorkflowPaths.pause, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowControlPayload,
          success: described(WorkflowSnapshot, "Paused workflow snapshot"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
        HttpApiEndpoint.post("resume", WorkflowPaths.resume, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowControlPayload,
          success: described(WorkflowSnapshot, "Resumed workflow snapshot"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
        HttpApiEndpoint.post("stop", WorkflowPaths.stop, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowControlPayload,
          success: described(WorkflowSnapshot, "Stopped workflow snapshot"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
        HttpApiEndpoint.post("permissionMode", WorkflowPaths.permissionMode, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowPermissionModePayload,
          success: described(WorkflowSnapshot, "Workflow snapshot with updated permission mode"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
        HttpApiEndpoint.post("retryTask", WorkflowPaths.retryTask, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowRetryTaskPayload,
          success: described(WorkflowSnapshot, "Workflow snapshot with task retry queued"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
        HttpApiEndpoint.post("retryPhase", WorkflowPaths.retryPhase, {
          params: { runID: Workflow.WorkflowRunID },
          payload: WorkflowRetryPhasePayload,
          success: described(WorkflowSnapshot, "Workflow snapshot with phase retry queued"),
          error: [ApiBadRequestError, ApiNotFoundError],
        }),
      )
      .annotateMerge(OpenApi.annotations({ title: "workflow", description: "Durable one-shot workflow routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MendCode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
