import { Schema, Types } from "effect"
import { ulid } from "ulid"

import { SessionID } from "@/session/schema"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, PositiveInt, withStatics } from "@/util/schema"

const brandedID = <Brand extends string>(brand: Brand, prefix: string) =>
  Schema.String.pipe(
    Schema.brand(brand),
    withStatics((schema) => ({
      make: (id?: string) => (id ?? `${prefix}_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof schema>,
      zod: zod(schema),
    })),
  )

export const WorkflowDefinitionID = brandedID("WorkflowDefinitionID", "wf")
export type WorkflowDefinitionID = Schema.Schema.Type<typeof WorkflowDefinitionID>

export const WorkflowRevisionID = brandedID("WorkflowRevisionID", "wf_rev")
export type WorkflowRevisionID = Schema.Schema.Type<typeof WorkflowRevisionID>

export const WorkflowRunID = brandedID("WorkflowRunID", "wf_run")
export type WorkflowRunID = Schema.Schema.Type<typeof WorkflowRunID>

export const WorkflowPhaseID = brandedID("WorkflowPhaseID", "wf_phase")
export type WorkflowPhaseID = Schema.Schema.Type<typeof WorkflowPhaseID>

export const WorkflowTaskID = brandedID("WorkflowTaskID", "wf_task")
export type WorkflowTaskID = Schema.Schema.Type<typeof WorkflowTaskID>

export const WorkflowTaskAttemptID = brandedID("WorkflowTaskAttemptID", "wf_attempt")
export type WorkflowTaskAttemptID = Schema.Schema.Type<typeof WorkflowTaskAttemptID>

export const WorkflowArtifactID = brandedID("WorkflowArtifactID", "wf_artifact")
export type WorkflowArtifactID = Schema.Schema.Type<typeof WorkflowArtifactID>

export const WorkflowEventID = brandedID("WorkflowEventID", "wf_event")
export type WorkflowEventID = Schema.Schema.Type<typeof WorkflowEventID>

export const WorkflowGateID = brandedID("WorkflowGateID", "wf_gate")
export type WorkflowGateID = Schema.Schema.Type<typeof WorkflowGateID>

export const WorkflowSource = Schema.Literals(["session-generated", "saved", "template", "package", "manual"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowSource = Schema.Schema.Type<typeof WorkflowSource>

export const WorkflowRunState = Schema.Literals([
  "planning",
  "awaiting_approval",
  "queued",
  "working",
  "needs_input",
  "blocked",
  "paused",
  "completed",
  "failed",
  "stopped",
]).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type WorkflowRunState = Schema.Schema.Type<typeof WorkflowRunState>

export const WorkflowPhaseState = Schema.Literals([
  "pending",
  "queued",
  "working",
  "needs_input",
  "blocked",
  "paused",
  "completed",
  "failed",
  "stopped",
]).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type WorkflowPhaseState = Schema.Schema.Type<typeof WorkflowPhaseState>

export const WorkflowTaskState = Schema.Literals([
  "pending",
  "queued",
  "working",
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "stopped",
]).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type WorkflowTaskState = Schema.Schema.Type<typeof WorkflowTaskState>

export const WorkflowTaskKind = Schema.Literals(["agent", "synthesize", "verify", "validate", "human", "map"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowTaskKind = Schema.Schema.Type<typeof WorkflowTaskKind>

export const WorkflowBarrierKind = Schema.Literals(["all", "quorum", "best-effort", "condition"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowBarrierKind = Schema.Schema.Type<typeof WorkflowBarrierKind>

const AllBarrier = Schema.Struct({ kind: Schema.Literal("all") })
const BestEffortBarrier = Schema.Struct({ kind: Schema.Literal("best-effort") })
const QuorumBarrier = Schema.Struct({ kind: Schema.Literal("quorum"), quorum: PositiveInt })
const ConditionBarrier = Schema.Struct({ kind: Schema.Literal("condition"), expression: Schema.String })

export const WorkflowBarrier = Schema.Union([AllBarrier, QuorumBarrier, BestEffortBarrier, ConditionBarrier])
export type WorkflowBarrier = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowBarrier>>

export const WorkflowOutputKind = Schema.Literals(["text", "json", "artifact", "none"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowOutputKind = Schema.Schema.Type<typeof WorkflowOutputKind>

const JsonSchema = Schema.Record(Schema.String, Schema.Unknown)

const TextOutput = Schema.Struct({
  kind: Schema.Literal("text"),
  maxChars: Schema.optional(PositiveInt),
})

const JsonOutput = Schema.Struct({
  kind: Schema.Literal("json"),
  schema: Schema.optional(JsonSchema),
})

const ArtifactOutput = Schema.Struct({
  kind: Schema.Literal("artifact"),
  artifactKind: Schema.optional(Schema.String),
  schema: Schema.optional(JsonSchema),
})

const EmptyOutput = Schema.Struct({ kind: Schema.Literal("none") })

export const WorkflowOutputContract = Schema.Union([TextOutput, JsonOutput, ArtifactOutput, EmptyOutput])
export type WorkflowOutputContract = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowOutputContract>>

export const WorkflowModelRoute = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.String),
})
export type WorkflowModelRoute = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowModelRoute>>

export const WorkflowWorkspaceMode = Schema.Literals(["read-only", "in-place", "per-loop-worktree", "per-run-worktree"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowWorkspaceMode = Schema.Schema.Type<typeof WorkflowWorkspaceMode>

export const WorkflowWorkspacePolicy = Schema.Struct({
  mode: WorkflowWorkspaceMode,
})
export type WorkflowWorkspacePolicy = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowWorkspacePolicy>>

export const WorkflowWorkspaceLease = Schema.Struct({
  id: Schema.String,
  mode: WorkflowWorkspaceMode,
  path: Schema.String,
  branch: Schema.optional(Schema.String),
  state: Schema.Literals(["active", "retained", "cleaning", "cleaned", "failed"]),
  managed: Schema.Boolean,
  createdAt: NonNegativeInt,
  error: Schema.optional(Schema.String),
})
export type WorkflowWorkspaceLease = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowWorkspaceLease>>

export const WorkflowPermissionMode = Schema.Literals(["report-only", "normal", "custom"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowPermissionMode = Schema.Schema.Type<typeof WorkflowPermissionMode>

export const WorkflowPermissionPolicy = Schema.Struct({
  mode: WorkflowPermissionMode,
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  approvalRequiredFor: Schema.optional(Schema.Array(Schema.String)),
  approvedActions: Schema.optional(Schema.Array(Schema.String)),
  allowEdits: Schema.optional(Schema.Boolean),
  allowMutatingCommands: Schema.optional(Schema.Boolean),
  allowExternalSend: Schema.optional(Schema.Boolean),
})
export type WorkflowPermissionPolicy = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowPermissionPolicy>>

export const WorkflowFailureClass = Schema.Literals(["transient", "environment", "policy", "quality", "budget", "user_input", "terminal"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowFailureClass = Schema.Schema.Type<typeof WorkflowFailureClass>

export const WorkflowRetryPolicy = Schema.Struct({
  maxAttempts: Schema.optional(PositiveInt),
  backoffMs: Schema.optional(NonNegativeInt),
  retryOn: Schema.optional(Schema.Array(WorkflowFailureClass)),
})
export type WorkflowRetryPolicy = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowRetryPolicy>>

export const WorkflowTaskBudget = Schema.Struct({
  maxTurns: Schema.optional(NonNegativeInt),
  maxRuntimeMs: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(NonNegativeInt),
  maxCost: Schema.optional(Schema.Number),
  maxChildren: Schema.optional(NonNegativeInt),
  maxDepth: Schema.optional(NonNegativeInt),
})
export type WorkflowTaskBudget = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowTaskBudget>>

export const WorkflowBudget = Schema.Struct({
  maxConcurrency: Schema.optional(PositiveInt),
  maxFanOut: Schema.optional(PositiveInt),
  maxTurns: Schema.optional(NonNegativeInt),
  maxRuntimeMs: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(NonNegativeInt),
  maxCost: Schema.optional(Schema.Number),
  maxChildren: Schema.optional(NonNegativeInt),
  maxDepth: Schema.optional(NonNegativeInt),
  retention: Schema.optional(
    Schema.Struct({
      maxArtifacts: Schema.optional(NonNegativeInt),
      maxAgeMs: Schema.optional(NonNegativeInt),
      maxBytes: Schema.optional(NonNegativeInt),
    }),
  ),
})
export type WorkflowBudget = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowBudget>>

export const WorkflowOverlapPolicy = Schema.Literals(["skip", "queue", "replace"]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type WorkflowOverlapPolicy = Schema.Schema.Type<typeof WorkflowOverlapPolicy>

export const WorkflowArtifactSelector = Schema.Struct({
  taskID: WorkflowTaskID,
  path: Schema.optional(Schema.String),
  projection: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
})
export type WorkflowArtifactSelector = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowArtifactSelector>>

export const WorkflowTaskTemplate = Schema.Struct({
  kind: Schema.Literals(["agent", "synthesize", "verify", "validate"]),
  prompt: Schema.String,
  output: WorkflowOutputContract,
  model: Schema.optional(WorkflowModelRoute),
  agentProfile: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  workspace: Schema.optional(WorkflowWorkspacePolicy),
  permissions: Schema.optional(WorkflowPermissionPolicy),
  retry: Schema.optional(WorkflowRetryPolicy),
  budget: Schema.optional(WorkflowTaskBudget),
})
export type WorkflowTaskTemplate = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowTaskTemplate>>

export const WorkflowMapSpec = Schema.Struct({
  source: WorkflowArtifactSelector,
  maxItems: PositiveInt,
  taskTemplate: WorkflowTaskTemplate,
})
export type WorkflowMapSpec = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowMapSpec>>

export const WorkflowTask = Schema.Struct({
  id: WorkflowTaskID,
  phaseID: WorkflowPhaseID,
  name: Schema.String,
  kind: WorkflowTaskKind,
  prompt: Schema.String,
  dependsOn: Schema.Array(WorkflowTaskID),
  inputs: Schema.optional(Schema.Array(WorkflowArtifactSelector)),
  output: WorkflowOutputContract,
  model: Schema.optional(WorkflowModelRoute),
  agentProfile: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  workspace: Schema.optional(WorkflowWorkspacePolicy),
  permissions: Schema.optional(WorkflowPermissionPolicy),
  retry: Schema.optional(WorkflowRetryPolicy),
  budget: Schema.optional(WorkflowTaskBudget),
  map: Schema.optional(WorkflowMapSpec),
})
export type WorkflowTask = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowTask>>

export const WorkflowPhase = Schema.Struct({
  id: WorkflowPhaseID,
  ordinal: PositiveInt,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  barrier: WorkflowBarrier,
  taskIDs: Schema.Array(WorkflowTaskID),
})
export type WorkflowPhase = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowPhase>>

export const WorkflowDefinition = Schema.Struct({
  id: WorkflowDefinitionID,
  projectID: Schema.String,
  name: Schema.String,
  description: Schema.String,
  source: WorkflowSource,
  ownerSessionID: Schema.optional(SessionID),
  currentRevision: Schema.optional(PositiveInt),
  saved: Schema.Boolean,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
})
export type WorkflowDefinition = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowDefinition>>

export const WorkflowTaskAttempt = Schema.Struct({
  id: WorkflowTaskAttemptID,
  taskID: WorkflowTaskID,
  attempt: PositiveInt,
  state: WorkflowTaskState,
  backgroundTaskID: Schema.optional(Schema.String),
  backgroundGeneration: Schema.optional(NonNegativeInt),
  failureClass: Schema.optional(WorkflowFailureClass),
  reason: Schema.optional(Schema.String),
  startedAt: Schema.optional(NonNegativeInt),
  completedAt: Schema.optional(NonNegativeInt),
})
export type WorkflowTaskAttempt = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowTaskAttempt>>

export const WorkflowArtifact = Schema.Struct({
  id: WorkflowArtifactID,
  runID: WorkflowRunID,
  taskID: Schema.optional(WorkflowTaskID),
  kind: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["pending", "valid", "invalid"]),
  schemaValidated: Schema.Boolean,
  outputRefs: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  sessionID: Schema.optional(SessionID),
  attempt: Schema.optional(PositiveInt),
  createdAt: NonNegativeInt,
})
export type WorkflowArtifact = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowArtifact>>

export const WorkflowRun = Schema.Struct({
  id: WorkflowRunID,
  definitionID: WorkflowDefinitionID,
  revisionID: WorkflowRevisionID,
  revision: PositiveInt,
  originSessionID: Schema.optional(SessionID),
  rootSessionID: Schema.optional(SessionID),
  loopID: Schema.optional(Schema.String),
  loopRunID: Schema.optional(Schema.String),
  workspaceLease: Schema.optional(WorkflowWorkspaceLease),
  state: WorkflowRunState,
  currentPhaseID: Schema.optional(WorkflowPhaseID),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
})
export type WorkflowRun = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowRun>>

export * as Workflow from "./workflow"
