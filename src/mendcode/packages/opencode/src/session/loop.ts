import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { and, count, Database, desc, eq, gt, inArray, or, type TxOrDb } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { errorMessage } from "@/util/error"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { Slug } from "@mendcode/core/util/slug"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import path from "path"
import { ulid } from "ulid"
import {
  BackgroundSessionTable,
  LoopArtifactTable,
  LoopEventTable,
  LoopRunTable,
  LoopThreadTable,
  LoopWorkflowTable,
  SessionTable,
  SessionStatusTable,
} from "./session.sql"
import { SessionID } from "./schema"
import * as BackgroundSession from "./background"
import { Worktree } from "@/worktree"
import { readBudgetUsageMode } from "@/mend/runtime/budget"
import type { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import type { WorkspaceID } from "@/control-plane/schema"

export const LoopID = Schema.String.pipe(
  Schema.brand("LoopID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type LoopID = Schema.Schema.Type<typeof LoopID>

export const RunID = Schema.String.pipe(
  Schema.brand("LoopRunID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_run_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type RunID = Schema.Schema.Type<typeof RunID>

export const EventID = Schema.String.pipe(
  Schema.brand("LoopEventID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_event_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type EventID = Schema.Schema.Type<typeof EventID>

export const ArtifactID = Schema.String.pipe(
  Schema.brand("LoopArtifactID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_artifact_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type ArtifactID = Schema.Schema.Type<typeof ArtifactID>

export const WorkflowState = Schema.Literals([
  "draft",
  "active",
  "sleeping",
  "working",
  "needs_input",
  "blocked",
  "paused",
  "completed",
  "failed",
  "stopped",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type WorkflowState = Schema.Schema.Type<typeof WorkflowState>

export const RunState = Schema.Literals(["queued", "working", "needs_input", "blocked", "completed", "failed", "stopped"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type RunState = Schema.Schema.Type<typeof RunState>

export const Source = Schema.Literals(["converted-session", "objective", "template", "manual"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type Source = Schema.Schema.Type<typeof Source>

export const TriggerMode = Schema.Literals(["manual", "interval", "daily", "adaptive", "external-signal", "self-paced"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type TriggerMode = Schema.Schema.Type<typeof TriggerMode>

export const BudgetMode = Schema.Literals(["fixed", "max-goal", "unbounded-monitor"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type BudgetMode = Schema.Schema.Type<typeof BudgetMode>

const UsageMode = Schema.Literals(["subscription", "api-usage"])

export const GoalStatus = Schema.Literals(["complete", "continue", "needs_input", "blocked", "stop"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type GoalStatus = Schema.Schema.Type<typeof GoalStatus>

export const EvaluationMode = Schema.Literals(["legacy", "deterministic", "independent"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type EvaluationMode = Schema.Schema.Type<typeof EvaluationMode>

export const JudgmentStatus = Schema.Literals(["pass", "fail", "uncertain", "blocked", "needs_human"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type JudgmentStatus = Schema.Schema.Type<typeof JudgmentStatus>

export const RunTrigger = Schema.Literals(["manual", "interval", "daily", "adaptive", "external-signal", "self-paced", "resume", "run-once"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type RunTrigger = Schema.Schema.Type<typeof RunTrigger>

export const EventLevel = Schema.Literals(["debug", "info", "warning", "error", "decision"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type EventLevel = Schema.Schema.Type<typeof EventLevel>

export const EventType = Schema.Literals([
  "created",
  "activated",
  "started",
  "completed",
  "wake",
  "signal",
  "phase",
  "session",
  "child",
  "gate",
  "budget",
  "action",
  "monitor",
  "paused",
  "resumed",
  "stopped",
  "failed",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type EventType = Schema.Schema.Type<typeof EventType>

export const ArtifactKind = Schema.Literals(["checkpoint", "judgment", "gate", "evidence", "command-output", "diff", "signal", "memory", "cost", "override"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type ArtifactKind = Schema.Schema.Type<typeof ArtifactKind>

export const FailureClass = Schema.Literals(["none", "transient", "environment", "policy", "quality", "budget", "user_input", "terminal"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type FailureClass = Schema.Schema.Type<typeof FailureClass>

export const MemorySection = Schema.Literals(["tried", "verified", "open", "decisions", "rejected"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type MemorySection = Schema.Schema.Type<typeof MemorySection>

export const ValidationCheck = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.optional(NonNegativeInt),
})
export type ValidationCheck = Types.DeepMutable<Schema.Schema.Type<typeof ValidationCheck>>

export const GateWaiver = Schema.Struct({
  action: Schema.Literals(["waive", "accept"]),
  actor: Schema.String,
  reason: Schema.String,
  time: NonNegativeInt,
})
export type GateWaiver = Types.DeepMutable<Schema.Schema.Type<typeof GateWaiver>>

export const RubricResult = Schema.Struct({
  status: Schema.Literals(["pass", "fail", "blocked"]),
  score: Schema.Number,
  threshold: Schema.Number,
  criteria: Schema.Array(Schema.Struct({
    id: Schema.String,
    score: Schema.Number,
    maxScore: Schema.Number,
    passed: Schema.Boolean,
    reason: Schema.String,
    evidence: Schema.Array(Schema.String),
  })),
  blockers: Schema.Array(Schema.Struct({
    id: Schema.String,
    present: Schema.Boolean,
    reason: Schema.String,
  })),
})
export type RubricResult = Types.DeepMutable<Schema.Schema.Type<typeof RubricResult>>

const Spec = Schema.Struct({
  trigger: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(TriggerMode),
      intervalMs: Schema.optional(NonNegativeInt),
      dailyAt: Schema.optional(Schema.String),
      timezone: Schema.optional(Schema.String),
    }),
  ),
  workflow: Schema.optional(
    Schema.Struct({
      revisionID: Schema.optional(Schema.String),
      definitionID: Schema.optional(Schema.String),
      overlapKey: Schema.optional(Schema.String),
    }),
  ),
  budgetMode: Schema.optional(BudgetMode),
  usageMode: Schema.optional(UsageMode),
  completionCriteria: Schema.optional(Schema.Array(Schema.String)),
  successChecks: Schema.optional(Schema.Array(Schema.String)),
  validationChecks: Schema.optional(Schema.Array(ValidationCheck)),
  strategy: Schema.optional(
    Schema.Struct({
      targetTurns: Schema.optional(NonNegativeInt),
      reserveTurns: Schema.optional(NonNegativeInt),
      notifyOwnerOnComplete: Schema.optional(Schema.Boolean),
    }),
  ),
  stopWhen: Schema.optional(Schema.Array(Schema.String)),
  gates: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ),
  agent: Schema.optional(Schema.String),
  evaluation: Schema.optional(Schema.Struct({
    mode: Schema.optional(EvaluationMode),
    evaluatorAgent: Schema.optional(Schema.String),
    requireIndependentForCompletion: Schema.optional(Schema.Boolean),
    allowWorkerSelfComplete: Schema.optional(Schema.Boolean),
    maxEvaluatorRetries: Schema.optional(NonNegativeInt),
  })),
  rubric: Schema.optional(Schema.Struct({
    name: Schema.optional(Schema.String),
    passThreshold: Schema.optional(Schema.Number),
    criteria: Schema.optional(Schema.Array(Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      weight: Schema.optional(Schema.Number),
      minScore: Schema.optional(Schema.Number),
      evidenceRequired: Schema.optional(Schema.Array(Schema.String)),
    }))),
    mandatoryBlockers: Schema.optional(Schema.Array(Schema.String)),
  })),
  workspace: Schema.optional(Schema.Struct({
    mode: Schema.optional(Schema.Literals(["read-only", "in-place", "per-loop-worktree", "per-run-worktree"])),
  })),
  costBudget: Schema.optional(Schema.Struct({
    maxCost: Schema.optional(Schema.Number),
    maxTokens: Schema.optional(NonNegativeInt),
  })),
  approvalPolicy: Schema.optional(Schema.Struct({
    requireApprovalFor: Schema.optional(Schema.Array(Schema.String)),
    approvedActions: Schema.optional(Schema.Array(Schema.String)),
  })),
  memory: Schema.optional(Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    sections: Schema.optional(Schema.Array(Schema.Literals(["tried", "verified", "open", "decisions", "rejected"]))),
  })),
  retention: Schema.optional(Schema.Struct({
    maxArtifacts: Schema.optional(NonNegativeInt),
    maxAgeMs: Schema.optional(NonNegativeInt),
    maxBytes: Schema.optional(NonNegativeInt),
  })),
})
export type Spec = Types.DeepMutable<Schema.Schema.Type<typeof Spec>>

const Policy = Schema.Struct({
  maxTurns: Schema.optional(NonNegativeInt),
  maxRuntimeMs: Schema.optional(NonNegativeInt),
  maxChildren: Schema.optional(NonNegativeInt),
  maxDepth: Schema.optional(NonNegativeInt),
  requireApprovalFor: Schema.optional(Schema.Array(Schema.String)),
  approvedActions: Schema.optional(Schema.Array(Schema.String)),
})
export type Policy = Types.DeepMutable<Schema.Schema.Type<typeof Policy>>

const Metrics = Schema.Struct({
  turns: Schema.optional(NonNegativeInt),
  children: Schema.optional(NonNegativeInt),
  failures: Schema.optional(NonNegativeInt),
  noProgress: Schema.optional(NonNegativeInt),
  cost: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadTokens: Schema.optional(NonNegativeInt),
  cacheWriteTokens: Schema.optional(NonNegativeInt),
})
export type Metrics = Types.DeepMutable<Schema.Schema.Type<typeof Metrics>>

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  activated: Schema.optional(NonNegativeInt),
  archived: Schema.optional(NonNegativeInt),
})

export const MemoryEntry = Schema.Struct({
  section: MemorySection,
  summary: Schema.String,
  source: Schema.optional(Schema.String),
  runID: Schema.optional(RunID),
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
})
export type MemoryEntry = Types.DeepMutable<Schema.Schema.Type<typeof MemoryEntry>>

export const RuntimeMemory = Schema.Struct({
  entries: Schema.Array(MemoryEntry),
})
export type RuntimeMemory = Types.DeepMutable<Schema.Schema.Type<typeof RuntimeMemory>>

export const WorkspaceLease = Schema.Struct({
  id: Schema.String,
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  mode: Schema.Literals(["read-only", "in-place", "per-loop-worktree", "per-run-worktree"]),
  path: Schema.String,
  branch: Schema.optional(Schema.String),
  state: Schema.Literals(["active", "dirty", "promoted", "retained", "cleaning", "cleaned", "failed"]),
  retention: Schema.Literals(["delete_on_success", "retain_on_failure", "manual"]),
  created: NonNegativeInt,
  error: Schema.optional(Schema.String),
})
export type WorkspaceLease = Types.DeepMutable<Schema.Schema.Type<typeof WorkspaceLease>>

export const NormalizedSignal = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  type: Schema.String,
  dedupeKey: Schema.String,
  payloadSummary: Schema.String,
  links: Schema.optional(Schema.Array(Schema.String)),
  receivedAt: NonNegativeInt,
  matches: Schema.Array(LoopID),
})
export type NormalizedSignal = Types.DeepMutable<Schema.Schema.Type<typeof NormalizedSignal>>

export const Usage = Schema.Struct({
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  durationMs: Schema.optional(NonNegativeInt),
  tokens: Schema.optional(Schema.Struct({
    input: Schema.optional(NonNegativeInt),
    output: Schema.optional(NonNegativeInt),
    reasoning: Schema.optional(NonNegativeInt),
    cacheRead: Schema.optional(NonNegativeInt),
    cacheWrite: Schema.optional(NonNegativeInt),
  })),
})
export type Usage = Types.DeepMutable<Schema.Schema.Type<typeof Usage>>

export const SchedulerInfo = Schema.Struct({
  lastWakeAttempt: Schema.optional(NonNegativeInt),
  nextWakeup: Schema.optional(NonNegativeInt),
  lastError: Schema.optional(Schema.String),
  lastRunID: Schema.optional(RunID),
  lastRunState: Schema.optional(RunState),
  lastResult: Schema.optional(Schema.String),
  degraded: Schema.optional(Schema.Boolean),
})
export type SchedulerInfo = Types.DeepMutable<Schema.Schema.Type<typeof SchedulerInfo>>

export const Info = Schema.Struct({
  id: LoopID,
  projectID: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  ownerSessionID: Schema.optional(SessionID),
  rootSessionID: Schema.optional(SessionID),
  name: Schema.String,
  objective: Schema.String,
  state: WorkflowState,
  source: Source,
  templateID: Schema.optional(Schema.String),
  phase: Schema.String,
  nextWakeup: Schema.optional(NonNegativeInt),
  spec: Spec,
  policy: Policy,
  metrics: Metrics,
  memory: Schema.optional(RuntimeMemory),
  scheduler: Schema.optional(SchedulerInfo),
  evaluatorReason: Schema.optional(Schema.String),
  failureClass: Schema.optional(FailureClass),
  time: Time,
})
  .annotate({ identifier: "LoopWorkflow" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export type GlobalInfo = Info & {
  project: {
    id: string
    name?: string
    worktree: string
    directory: string
  }
}

export type ListGlobalPageInput = {
  offset?: number
  limit?: number
  selectedID?: LoopID
  scope?: "all" | "project"
}

export type GlobalPage = {
  active: GlobalInfo[]
  history: GlobalInfo[]
  page: {
    offset: number
    limit: number
    total: number
  }
}

export const RunInfo = Schema.Struct({
  id: RunID,
  workflowID: LoopID,
  rootSessionID: Schema.optional(SessionID),
  state: RunState,
  trigger: RunTrigger,
  phase: Schema.String,
  nextWakeup: Schema.optional(NonNegativeInt),
  evaluatorReason: Schema.optional(Schema.String),
  failureClass: Schema.optional(FailureClass),
  budget: Schema.optional(Metrics),
  checkpoint: Schema.optional(Schema.Struct({
    status: Schema.optional(GoalStatus),
    summary: Schema.optional(Schema.String),
    evidence: Schema.optional(Schema.Array(Schema.String)),
    nextAction: Schema.optional(Schema.String),
    confidence: Schema.optional(Schema.String),
  })),
  judgment: Schema.optional(Schema.Struct({
    status: Schema.optional(JudgmentStatus),
    summary: Schema.optional(Schema.String),
    evidence: Schema.optional(Schema.Array(Schema.String)),
    recommendedNextAction: Schema.optional(Schema.String),
    confidence: Schema.optional(Schema.String),
    failureClass: Schema.optional(FailureClass),
  })),
  rubricResult: Schema.optional(RubricResult),
  usage: Schema.optional(Usage),
  gateResults: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["pass", "fail", "skip", "blocked", "awaiting_approval"]),
    summary: Schema.optional(Schema.String),
    failureClass: Schema.optional(FailureClass),
    evidenceArtifacts: Schema.optional(Schema.Array(ArtifactID)),
    waiver: Schema.optional(GateWaiver),
  }))),
  retry: Schema.optional(Schema.Struct({
    attempt: NonNegativeInt,
    backoffMs: Schema.optional(NonNegativeInt),
    nextWakeup: Schema.optional(NonNegativeInt),
  })),
  workspaceLease: Schema.optional(WorkspaceLease),
  lease: Schema.optional(Schema.Struct({
    holder: Schema.String,
    acquired: NonNegativeInt,
    heartbeat: NonNegativeInt,
    expires: NonNegativeInt,
  })),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    started: Schema.optional(NonNegativeInt),
    ended: Schema.optional(NonNegativeInt),
  }),
})
  .annotate({ identifier: "LoopRun" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RunInfo = Types.DeepMutable<Schema.Schema.Type<typeof RunInfo>>

export const JournalEvent = Schema.Struct({
  id: EventID,
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  sessionID: Schema.optional(SessionID),
  sequence: NonNegativeInt,
  level: EventLevel,
  type: EventType,
  title: Schema.String,
  summary: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopEvent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JournalEvent = Types.DeepMutable<Schema.Schema.Type<typeof JournalEvent>>

export const ArtifactInfo = Schema.Struct({
  id: ArtifactID,
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  sessionID: Schema.optional(SessionID),
  sequence: NonNegativeInt,
  kind: ArtifactKind,
  title: Schema.String,
  summary: Schema.String,
  source: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Unknown),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopArtifact" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ArtifactInfo = Types.DeepMutable<Schema.Schema.Type<typeof ArtifactInfo>>

export const ThreadInfo = Schema.Struct({
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  sessionID: SessionID,
  role: Schema.Literals(["root", "implementer", "reviewer", "verifier", "monitor", "research"]),
  purpose: Schema.String,
  state: Schema.Literals(["queued", "working", "needs_input", "completed", "failed", "stopped"]),
  parentSessionID: Schema.optional(SessionID),
  budget: Schema.optional(Metrics),
  worktree: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopThread" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ThreadInfo = Types.DeepMutable<Schema.Schema.Type<typeof ThreadInfo>>

export const Snapshot = Schema.Struct({
  workflow: Info,
  runs: Schema.Array(RunInfo),
  threads: Schema.Array(ThreadInfo),
  events: Schema.Array(JournalEvent),
  artifacts: Schema.Array(ArtifactInfo),
  rootSession: Schema.optional(Schema.Struct({
    id: SessionID,
    title: Schema.String,
    model: Schema.optional(Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: Schema.optional(Schema.String),
    })),
  })),
})
  .annotate({ identifier: "LoopSnapshot" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Snapshot = Types.DeepMutable<Schema.Schema.Type<typeof Snapshot>>

export const Summary = Schema.Struct({
  workflowID: LoopID,
  state: WorkflowState,
  phase: Schema.String,
  objective: Schema.String,
  nextWakeup: Schema.optional(NonNegativeInt),
  runID: Schema.optional(RunID),
  runState: Schema.optional(RunState),
  verdict: Schema.optional(Schema.String),
  verdictSummary: Schema.optional(Schema.String),
  checkpointStatus: Schema.optional(GoalStatus),
  judgmentStatus: Schema.optional(JudgmentStatus),
  gateSummary: Schema.Struct({
    total: NonNegativeInt,
    pass: NonNegativeInt,
    fail: NonNegativeInt,
    blocked: NonNegativeInt,
    awaitingApproval: NonNegativeInt,
    skip: NonNegativeInt,
    blocking: Schema.optional(Schema.String),
  }),
  evidenceSummary: Schema.Array(Schema.String),
  nextAction: Schema.optional(Schema.String),
  memorySummary: Schema.Struct({
    total: NonNegativeInt,
    open: NonNegativeInt,
    latest: Schema.Array(Schema.String),
  }),
  costSummary: Schema.Struct({
    cost: Schema.optional(Schema.Number),
    tokens: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopSummary" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Summary = Types.DeepMutable<Schema.Schema.Type<typeof Summary>>

export type CreateDraftInput = {
  name: string
  objective: string
  source?: Source
  workspaceID?: WorkspaceID
  ownerSessionID?: SessionID
  templateID?: string
  trigger?: { mode?: TriggerMode; intervalMs?: number; dailyAt?: string; timezone?: string }
  workflow?: {
    revisionID?: string
    definitionID?: string
    overlapKey?: string
  }
  budgetMode?: BudgetMode
  completionCriteria?: string[]
  successChecks?: string[]
  validationChecks?: ValidationCheck[]
  strategy?: {
    targetTurns?: number
    reserveTurns?: number
    notifyOwnerOnComplete?: boolean
  }
  stopWhen?: string[]
  gates?: string[]
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  agent?: string
  evaluation?: Spec["evaluation"]
  rubric?: Spec["rubric"]
  workspace?: Spec["workspace"]
  costBudget?: Spec["costBudget"]
  approvalPolicy?: Spec["approvalPolicy"]
  memory?: Spec["memory"]
  retention?: Spec["retention"]
  policy?: Policy
}

export type UpdateStateInput = {
  id: LoopID
  reason?: string
  now?: number
}

export type UpdateAgentInput = {
  id: LoopID
  agent?: string
  reason?: string
}

export type RunOnceInput = {
  id: LoopID
  reason?: string
  now?: number
}

export type DueInput = {
  now?: number
  limit?: number
}

export type StartRunInput = {
  id: LoopID
  trigger?: RunTrigger
  reason?: string
  leaseHolder?: string
  now?: number
}

export type ReadinessSkipInput = {
  id: LoopID
  trigger?: RunTrigger
  reason: string
  nextWakeup?: number
  now?: number
}

export type IngestSignalInput = {
  workflowID?: LoopID
  source: string
  type: string
  dedupeKey?: string
  payloadSummary?: string
  links?: string[]
  now?: number
  rateLimit?: {
    maxEvents: number
    windowMs: number
  }
}

export type IngestSignalResult = {
  signal: NormalizedSignal
  deduped: boolean
  rateLimited: boolean
  matched: Info[]
}

export type RecordValidationInput = {
  id: LoopID
  runID: RunID
  checkID: string
  command: string
  status: "pass" | "fail" | "blocked" | "skip"
  summary: string
  output?: string
  exitCode?: number
  durationMs?: number
  timedOut?: boolean
}

export type OverrideInput = {
  id: LoopID
  runID?: RunID
  action: "waive" | "accept" | "retry"
  gateID?: string
  actor: string
  reason: string
}

export type CompleteRunInput = {
  id: LoopID
  runID: RunID
  reason?: string
  nextWakeup?: number
  now?: number
  goalStatus?: GoalStatus
  checkpoint?: {
    status?: GoalStatus
    summary?: string
    evidence?: string[]
    nextAction?: string
    confidence?: string
  }
  judgment?: {
    status?: JudgmentStatus
    summary?: string
    evidence?: string[]
    recommendedNextAction?: string
    confidence?: string
    failureClass?: FailureClass
  }
  usage?: Usage
  rubricResult?: RubricResult
  gateResults?: Array<{
    id: string
    status: "pass" | "fail" | "skip" | "blocked" | "awaiting_approval"
    summary?: string
    failureClass?: "none" | "transient" | "environment" | "policy" | "quality" | "budget" | "user_input" | "terminal"
    evidenceArtifacts?: ArtifactID[]
    waiver?: GateWaiver
  }>
}

export type FailRunInput = {
  id: LoopID
  runID: RunID
  error: string
  failureClass?: FailureClass
  now?: number
}

export type SchedulerFailureInput = {
  id: LoopID
  error: string
  failureClass?: FailureClass
  now?: number
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly listGlobal: () => Effect.Effect<GlobalInfo[]>
  readonly listGlobalPage: (input?: ListGlobalPageInput) => Effect.Effect<GlobalPage>
  readonly due: (input?: DueInput) => Effect.Effect<Info[]>
  readonly get: (id: LoopID, now?: number) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly snapshot: (id: LoopID, limit?: number) => Effect.Effect<Snapshot, InstanceType<typeof NotFoundError>>
  readonly events: (id: LoopID, limit?: number) => Effect.Effect<JournalEvent[]>
  readonly createDraft: (input: CreateDraftInput) => Effect.Effect<Info>
  readonly activate: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly startRun: (input: StartRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly recordReadinessSkip: (input: ReadinessSkipInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly recordSchedulerFailure: (input: SchedulerFailureInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly ingestSignal: (input: IngestSignalInput) => Effect.Effect<IngestSignalResult, InstanceType<typeof NotFoundError>>
  readonly recordValidation: (input: RecordValidationInput) => Effect.Effect<ArtifactInfo, InstanceType<typeof NotFoundError>>
  readonly completeRun: (input: CompleteRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly failRun: (input: FailRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly pause: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly resume: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly stop: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly updateAgent: (input: UpdateAgentInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly override: (input: OverrideInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly delete: (id: LoopID) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly runOnce: (input: RunOnceInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LoopWorkflow") {}

export const Event = {
  WorkflowUpdated: BusEvent.define("loop.workflow.updated", Schema.Struct({ workflowID: LoopID, info: Info })),
  RunUpdated: BusEvent.define("loop.run.updated", Schema.Struct({ workflowID: LoopID, run: RunInfo })),
  EventCreated: BusEvent.define("loop.event.created", Schema.Struct({ workflowID: LoopID, event: JournalEvent })),
  ThreadUpdated: BusEvent.define("loop.thread.updated", Schema.Struct({ workflowID: LoopID, thread: ThreadInfo })),
}

type WorkflowRow = typeof LoopWorkflowTable.$inferSelect
type RunRow = typeof LoopRunTable.$inferSelect
type EventRow = typeof LoopEventTable.$inferSelect
type ArtifactRow = typeof LoopArtifactTable.$inferSelect
type ThreadRow = typeof LoopThreadTable.$inferSelect

const terminalWorkflowStates = new Set<WorkflowState>(["paused", "completed", "failed", "stopped"])
const terminalBackgroundStates = new Set<BackgroundSession.State>(["completed", "failed", "stopped"])
const activeRunStates = new Set<RunState>(["queued", "working"])
const globalActiveWorkflowStates: WorkflowState[] = ["active", "sleeping", "working", "needs_input", "blocked"]
const globalHistoryWorkflowStates: WorkflowState[] = ["draft", "paused", "completed", "failed", "stopped"]
const defaultRunLeaseMs = 8 * 60 * 60 * 1000

const riskyDefaults = [
  "push",
  "merge",
  "release",
  "version-bump",
  "external-send",
  "destructive-shell",
  "broad-refactor",
]

function positiveInt(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function normalizeCostBudget(value: Spec["costBudget"]) {
  if (!value) return undefined
  const maxCost = typeof value.maxCost === "number" && Number.isFinite(value.maxCost) && value.maxCost >= 0 ? value.maxCost : undefined
  const maxTokens = positiveInt(value.maxTokens)
  if (maxCost === undefined && maxTokens === undefined) return undefined
  return { maxCost, maxTokens }
}

function normalizeSpec(spec: Spec) {
  const costBudget = normalizeCostBudget(spec.costBudget)
  if (spec.costBudget?.maxCost === costBudget?.maxCost && spec.costBudget?.maxTokens === costBudget?.maxTokens) return spec
  return { ...spec, costBudget }
}

type DailyDateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const dailyTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    return value
  } catch {
    throw new Error(`Invalid IANA timezone: ${value}`)
  }
}

function normalizeDailyAt(value: string | undefined) {
  const dailyAt = value?.trim()
  if (!dailyAt || !dailyTimePattern.test(dailyAt)) throw new Error("dailyAt must use 24-hour HH:mm format")
  return dailyAt
}

function normalizeTrigger(input: CreateDraftInput["trigger"]): Spec["trigger"] {
  if (!input) return undefined
  const mode = input.mode ?? (input.dailyAt !== undefined || input.timezone !== undefined ? "daily" : input.intervalMs !== undefined ? "interval" : "manual")
  if (mode === "daily") {
    return {
      mode,
      dailyAt: normalizeDailyAt(input.dailyAt),
      timezone: validTimeZone(input.timezone?.trim() || localTimeZone()),
    }
  }
  return { mode, intervalMs: input.intervalMs }
}

function normalizeWorkflowReference(input: CreateDraftInput["workflow"]): Spec["workflow"] {
  if (!input) return undefined
  const revisionID = input.revisionID?.trim() || undefined
  const definitionID = input.definitionID?.trim() || undefined
  if (revisionID === undefined && definitionID === undefined) throw new Error("workflow reference requires revisionID or definitionID")
  if (revisionID !== undefined && definitionID !== undefined) throw new Error("workflow reference cannot include both revisionID and definitionID")
  const overlapKey = input.overlapKey?.trim() || undefined
  return {
    ...(revisionID === undefined ? {} : { revisionID }),
    ...(definitionID === undefined ? {} : { definitionID }),
    ...(overlapKey === undefined ? {} : { overlapKey }),
  }
}

function zonedDateParts(timestamp: number, timezone: string): DailyDateParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  }
}

function wallClockMilliseconds(parts: Pick<DailyDateParts, "year" | "month" | "day" | "hour" | "minute" | "second">) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function zonedDateTimeToTimestamp(parts: DailyDateParts, timezone: string) {
  const wallClock = wallClockMilliseconds(parts)
  let timestamp = wallClock
  for (let attempt = 0; attempt < 4; attempt++) {
    const actualWallClock = wallClockMilliseconds(zonedDateParts(timestamp, timezone))
    timestamp += wallClock - actualWallClock
  }
  return timestamp
}

function sameDailyTime(actual: DailyDateParts, expected: DailyDateParts) {
  return actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second
}

export function nextDailyWakeup(now: number, dailyAt: string, timezone = localTimeZone()) {
  const normalizedDailyAt = normalizeDailyAt(dailyAt)
  const resolvedTimezone = validTimeZone(timezone.trim() || localTimeZone())
  const [hour, minute] = normalizedDailyAt.split(":").map(Number)
  const current = zonedDateParts(now, resolvedTimezone)
  const currentDate = Date.UTC(current.year, current.month - 1, current.day)

  for (let dayOffset = 0; dayOffset <= 370; dayOffset++) {
    const date = new Date(currentDate + dayOffset * 24 * 60 * 60 * 1000)
    const expected: DailyDateParts = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
      second: 0,
    }
    const timestamp = zonedDateTimeToTimestamp(expected, resolvedTimezone)
    if (timestamp > now && sameDailyTime(zonedDateParts(timestamp, resolvedTimezone), expected)) return timestamp
  }

  throw new Error(`Unable to calculate the next daily wakeup for ${normalizedDailyAt} in ${resolvedTimezone}`)
}

function defaultPolicy(input?: Policy, budgetMode?: BudgetMode): Policy {
  const maxTurns = positiveInt(input?.maxTurns)
  return {
    maxTurns: budgetMode === "unbounded-monitor" ? undefined : budgetMode === "max-goal" ? maxTurns : maxTurns ?? 30,
    maxRuntimeMs: input?.maxRuntimeMs ?? 8 * 60 * 60 * 1000,
    maxChildren: input?.maxChildren ?? 3,
    maxDepth: input?.maxDepth ?? 1,
    requireApprovalFor: input?.requireApprovalFor ?? riskyDefaults,
    approvedActions: input?.approvedActions,
  }
}

function runLeaseDuration(policy: Policy) {
  return positiveInt(policy.maxRuntimeMs) ?? defaultRunLeaseMs
}

function runLease(input: { holder?: string; policy: Policy; now: number }) {
  return {
    holder: input.holder ?? `loop-service:${process.pid}`,
    acquired: input.now,
    heartbeat: input.now,
    expires: input.now + runLeaseDuration(input.policy),
  }
}

function runLeaseExpired(input: { run: RunRow; policy: Policy; now: number }) {
  const expires = input.run.data.lease?.expires ?? (input.run.time_started ?? input.run.time_created) + runLeaseDuration(input.policy)
  return expires <= input.now
}

function runLeaseProcessID(holder: string | undefined) {
  const match = holder?.match(/^[^:]+:(\d+)(?::|$)/)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function runLeaseProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM"
  }
}

function runLeaseStale(input: { run: RunRow; policy: Policy; now: number }) {
  if (runLeaseExpired(input)) return true
  const pid = runLeaseProcessID(input.run.data.lease?.holder)
  return pid !== undefined && !runLeaseProcessAlive(pid)
}

const maxFailureRetries = 3
const minFailureBackoffMs = 30_000
const maxFailureBackoffMs = 10 * 60_000
const maxSchedulerErrorChars = 1_000
export const externalSignalRateLimit = { maxEvents: 30, windowMs: 60_000 } as const

function classifyFailure(error: string): FailureClass {
  if (/\b(budget|max turns|maximum iteration|quota exceeded|insufficient_quota)\b/i.test(error)) return "budget"
  if (/\b(needs?\s+user|needs?\s+human|human input|ask user|user input|required input)\b/i.test(error)) return "user_input"
  if (/\b(report-only|approval|not approved|policy|forbidden|destructive|permission denied|not allowed)\b/i.test(error)) return "policy"
  if (/\b(timeout|timed out|rate limit|429|econnreset|etimedout|eai_again|network|overloaded|temporar|retry|503|502|504|500)\b/i.test(error)) return "transient"
  if (/\b(enoent|enospc|eacces|disk|filesystem|git|worktree|cwd|environment|no such file|not found)\b/i.test(error)) return "environment"
  if (/\b(validation|parse|malformed|quality|test failed|lint failed|typecheck failed)\b/i.test(error)) return "quality"
  return "terminal"
}

function failureBackoffMs(failures: number) {
  return Math.min(maxFailureBackoffMs, minFailureBackoffMs * 2 ** Math.max(0, failures - 1))
}

function retryableFailure(failureClass: FailureClass) {
  return failureClass === "transient" || failureClass === "environment"
}

function failureTransition(input: { metrics: Metrics; failureClass: FailureClass; now: number }) {
  if (input.failureClass === "budget") return { state: "blocked" as const, phase: "budget_exhausted", nextWakeup: undefined, retry: undefined }
  if (input.failureClass === "user_input") return { state: "needs_input" as const, phase: "needs_input", nextWakeup: undefined, retry: undefined }
  if (input.failureClass === "policy") return { state: "blocked" as const, phase: "policy_blocked", nextWakeup: undefined, retry: undefined }
  if (!retryableFailure(input.failureClass) || (input.metrics.failures ?? 0) >= maxFailureRetries) {
    return { state: "failed" as const, phase: "failed", nextWakeup: undefined, retry: undefined }
  }
  const backoffMs = failureBackoffMs(input.metrics.failures ?? 1)
  const nextWakeup = input.now + backoffMs
  return {
    state: "sleeping" as const,
    phase: "retry_scheduled",
    nextWakeup,
    retry: {
      attempt: input.metrics.failures ?? 1,
      backoffMs,
      nextWakeup,
    },
  }
}

function canStartScheduledRun(workflow: Info, now: number) {
  return workflow.state !== "sleeping" || typeof workflow.nextWakeup !== "number" || workflow.nextWakeup <= now
}

function nextWakeupFor(
  info: { trigger?: { mode?: TriggerMode; intervalMs?: number; dailyAt?: string; timezone?: string }; budgetMode?: BudgetMode },
  now = Date.now(),
  options?: { immediate?: boolean },
) {
  if (!info.trigger || info.trigger.mode === "manual") return undefined
  if (info.trigger.mode === "self-paced") return info.budgetMode === "unbounded-monitor" ? undefined : now
  if (info.trigger.mode === "daily") {
    if (!info.trigger.dailyAt) return undefined
    return nextDailyWakeup(now, info.trigger.dailyAt, info.trigger.timezone)
  }
  if (!info.trigger.intervalMs) return undefined
  if (options?.immediate) return now
  return now + info.trigger.intervalMs
}

function scheduledMonitor(info: { trigger?: { mode?: TriggerMode; intervalMs?: number; dailyAt?: string; timezone?: string }; budgetMode?: BudgetMode }) {
  if (info.budgetMode !== "unbounded-monitor") return false
  const mode = info.trigger?.mode
  return mode === "interval" || mode === "daily" || mode === "adaptive"
}

function scheduledTrigger(info: { trigger?: { mode?: TriggerMode; intervalMs?: number; dailyAt?: string; timezone?: string } }) {
  const mode = info.trigger?.mode
  return mode === "interval" || mode === "daily" || mode === "adaptive" || mode === "self-paced"
}

function scheduledRunTrigger(info: Info): RunTrigger {
  const mode = info.spec.trigger?.mode
  if (mode === "interval" || mode === "daily" || mode === "adaptive" || mode === "external-signal" || mode === "self-paced") return mode
  return "adaptive"
}

function schedulerRetryWakeupFor(info: Info, now: number) {
  const scheduled = nextWakeupFor(info.spec, now)
  if (typeof scheduled === "number" && scheduled > now) return scheduled
  if (info.spec.trigger?.mode === "external-signal" && typeof info.nextWakeup === "number" && info.nextWakeup > now) return info.nextWakeup
  if (scheduledTrigger(info.spec) || info.spec.trigger?.mode === "external-signal") return now + minFailureBackoffMs
  return undefined
}

function nextWakeupAfterRun(info: Info, requested: number | undefined, now: number, pendingExternalSignal: boolean) {
  if (pendingExternalSignal) return info.nextWakeup
  if (typeof requested === "number" && requested > now) return requested
  return nextWakeupFor(info.spec, now)
}

function schedulerFor(info: Info, patch: Partial<SchedulerInfo>) {
  return {
    ...info.scheduler,
    ...patch,
  }
}

function recoveryWakeupFor(info: { trigger?: { mode?: TriggerMode } }, now: number) {
  const mode = info.trigger?.mode
  if (!mode || mode === "manual" || mode === "external-signal") return undefined
  return now
}

function completionState(input: {
  metrics: Metrics
  policy: Policy
  nextWakeup?: number
}): { state: WorkflowState; phase: string; nextWakeup?: number; completed: boolean } {
  const maxTurns = input.policy.maxTurns
  const completed = typeof maxTurns === "number" && (input.metrics.turns ?? 0) >= maxTurns
  if (completed) return { state: "completed", phase: "completed", completed }
  if (input.nextWakeup) return { state: "sleeping", phase: "waiting", nextWakeup: input.nextWakeup, completed }
  return { state: "active", phase: "ready", completed }
}

function requiresIndependentCompletion(spec: Spec) {
  if (spec.budgetMode !== "max-goal") return false
  if (spec.evaluation?.allowWorkerSelfComplete === true) return false
  return spec.evaluation?.requireIndependentForCompletion === true || spec.evaluation?.mode === "independent"
}

function judgmentPassed(judgment: CompleteRunInput["judgment"] | undefined) {
  return judgment?.status === "pass"
}

function completionGatesPassed(gates: CompleteRunInput["gateResults"] | undefined) {
  return !gates?.some((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
}

function completionGateFailureSummary(gates: CompleteRunInput["gateResults"] | undefined) {
  const failed = gates?.find((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
  if (!failed) return
  return `${failed.id} ${failed.status}: ${failed.summary ?? "completion gate did not pass"}`
}

function workflowBlockingGate(gate: { id: string; status: string; failureClass?: FailureClass }) {
  if (gate.status !== "fail" && gate.status !== "blocked" && gate.status !== "awaiting_approval") return false
  if (gate.id === "cost-budget" || gate.id === "approval-policy") return true
  return gate.failureClass === "budget" || gate.failureClass === "policy" || gate.failureClass === "user_input" || gate.failureClass === "terminal"
}

const defaultMemorySections: MemorySection[] = ["tried", "verified", "open", "decisions", "rejected"]
const maxMemoryEntriesPerSection = 12

function memoryEnabled(spec: Spec) {
  return spec.memory?.enabled !== false
}

function allowedMemorySections(spec: Spec) {
  return new Set<MemorySection>(spec.memory?.sections?.length ? spec.memory.sections : defaultMemorySections)
}

function compactMemorySummary(value: string | undefined) {
  const text = value === undefined ? undefined : redactArtifactString(value).replace(/\s+/g, " ").trim()
  if (!text) return
  return text.length > 360 ? `${text.slice(0, 357)}...` : text
}

function memoryEntry(input: { section: MemorySection; summary?: string; source: string; runID: RunID; now: number }): MemoryEntry | undefined {
  const summary = compactMemorySummary(input.summary)
  if (!summary) return
  return {
    section: input.section,
    summary,
    source: input.source,
    runID: input.runID,
    time: { created: input.now },
  }
}

function completionMemoryEntries(input: {
  runID: RunID
  now: number
  checkpointStatus?: GoalStatus
  checkpoint?: CompleteRunInput["checkpoint"]
  judgment?: CompleteRunInput["judgment"]
  gateResults?: CompleteRunInput["gateResults"]
  goalComplete: boolean
  gateFailure?: string
  evaluatorReason: string
}) {
  return [
    memoryEntry({
      section: "tried",
      summary: input.checkpoint?.summary ?? input.evaluatorReason,
      source: "checkpoint",
      runID: input.runID,
      now: input.now,
    }),
    input.goalComplete
      ? memoryEntry({
          section: "verified",
          summary: input.judgment?.summary ?? input.checkpoint?.summary ?? input.evaluatorReason,
          source: "completion",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    input.goalComplete
      ? memoryEntry({
          section: "decisions",
          summary: "Loop goal was accepted as complete by the configured completion gates.",
          source: "completion",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    input.checkpointStatus === "stop"
      ? memoryEntry({
          section: "decisions",
          summary: input.checkpoint?.summary ?? "Loop checkpoint requested stop.",
          source: "checkpoint",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    !input.goalComplete && input.checkpoint?.nextAction
      ? memoryEntry({
          section: "open",
          summary: input.checkpoint.nextAction,
          source: "checkpoint.next_action",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    !input.goalComplete && input.judgment?.recommendedNextAction
      ? memoryEntry({
          section: "open",
          summary: input.judgment.recommendedNextAction,
          source: "judgment.recommended_next_action",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    input.gateFailure
      ? memoryEntry({
          section: "rejected",
          summary: input.gateFailure,
          source: "completion-gate",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    input.checkpointStatus === "complete" && input.judgment?.status && input.judgment.status !== "pass"
      ? memoryEntry({
          section: "rejected",
          summary: input.judgment.summary ?? `Independent evaluator returned ${input.judgment.status}.`,
          source: "independent-evaluator",
          runID: input.runID,
          now: input.now,
        })
      : undefined,
    ...(input.gateResults ?? [])
      .filter((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
      .map((gate) =>
        memoryEntry({
          section: "open",
          summary: gate.summary ?? `${gate.id} returned ${gate.status}.`,
          source: `gate:${gate.id}`,
          runID: input.runID,
          now: input.now,
        }),
      ),
  ].filter((entry): entry is MemoryEntry => Boolean(entry))
}

function appendRuntimeMemory(current: RuntimeMemory | undefined, spec: Spec, entries: MemoryEntry[]): RuntimeMemory | undefined {
  if (!memoryEnabled(spec)) return current
  const allowed = allowedMemorySections(spec)
  const next = [...(current?.entries ?? []), ...entries.filter((entry) => allowed.has(entry.section))]
  const kept = defaultMemorySections.flatMap((section) => next.filter((entry) => entry.section === section).slice(-maxMemoryEntriesPerSection))
  return { entries: kept }
}

type ArtifactMetadataValue = string | number | boolean | null | ArtifactMetadataValue[] | { [key: string]: ArtifactMetadataValue }
type ArtifactMetadata = { [key: string]: ArtifactMetadataValue }

type ArtifactInput = {
  workflowID: LoopID
  runID?: RunID
  sessionID?: SessionID
  kind: ArtifactKind
  title: string
  summary: string
  source?: string
  status?: string
  contentType?: string
  text?: string
  evidence?: string[]
  metadata?: Record<string, unknown>
}

type SanitizedArtifactInput = Omit<ArtifactInput, "metadata"> & {
  metadata?: ArtifactMetadata
}

const maxArtifactsPerWorkflow = 120
const maxArtifactSummaryChars = 1_000
const maxArtifactTextChars = 12_000
const maxArtifactEvidenceItems = 20
const maxArtifactEvidenceChars = 1_000
const maxArtifactMetadataDepth = 6
const maxArtifactMetadataArrayItems = 50
const maxArtifactMetadataObjectEntries = 50
const maxArtifactMetadataKeyChars = 120
const maxArtifactConfidenceChars = 40

function truncateArtifactString(value: string | undefined, max: number) {
  if (value === undefined) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 48)).trimEnd()} [artifact truncated: ${value.length - max} chars omitted]`
}

function redactArtifactString(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(/(["'])(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\1\s*:\s*"[^"\n]*"/gi, '$1$2$1:"[REDACTED]"')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*([:=])\s*([^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/\b(authorization)\s*([:=])\s*([^\n]+)/gi, "$1$2[REDACTED]")
}

function sanitizeArtifactString(value: string | undefined, max: number) {
  return truncateArtifactString(value === undefined ? undefined : redactArtifactString(value), max)
}

function sanitizeArtifactMetadataValue(value: unknown, depth = 0, seen?: WeakSet<object>): ArtifactMetadataValue | undefined {
  if (depth > maxArtifactMetadataDepth) return "[artifact metadata truncated: max depth]"
  if (typeof value === "string") return sanitizeArtifactString(value, maxArtifactTextChars) ?? null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArtifactMetadataArrayItems)
      .map((item) => sanitizeArtifactMetadataValue(item, depth + 1, seen) ?? null)
  }
  if (typeof value === "object") {
    if (seen?.has(value)) return "[artifact metadata truncated: circular]"
    const nextSeen = seen ?? new WeakSet<object>()
    nextSeen.add(value)
    const entries = Object.entries(value)
    return Object.fromEntries([
      ...entries.slice(0, maxArtifactMetadataObjectEntries).flatMap(([key, item]) => {
        const sanitized = sanitizeArtifactMetadataValue(item, depth + 1, nextSeen)
        return sanitized === undefined
          ? []
          : [[truncateArtifactString(key, maxArtifactMetadataKeyChars) ?? key, sanitized] as const]
      }),
      ...(entries.length > maxArtifactMetadataObjectEntries
        ? [["__artifact_truncated__", `[artifact metadata truncated: ${entries.length - maxArtifactMetadataObjectEntries} entries omitted]`] as const]
        : []),
    ])
  }
  return undefined
}

function sanitizeArtifactMetadata(metadata: Record<string, unknown>): ArtifactMetadata {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      const sanitized = sanitizeArtifactMetadataValue(value, 0, new WeakSet<object>())
      return sanitized === undefined ? [] : [[truncateArtifactString(key, maxArtifactMetadataKeyChars) ?? key, sanitized] as const]
    }),
  )
}

function sanitizeCheckpoint(value: CompleteRunInput["checkpoint"]) {
  if (!value) return undefined
  return {
    status: value.status,
    summary: sanitizeArtifactString(value.summary, maxArtifactSummaryChars),
    evidence: value.evidence?.slice(0, maxArtifactEvidenceItems).map((item) => sanitizeArtifactString(item, maxArtifactEvidenceChars) ?? ""),
    nextAction: sanitizeArtifactString(value.nextAction, maxArtifactSummaryChars),
    confidence: sanitizeArtifactString(value.confidence, maxArtifactConfidenceChars),
  }
}

function sanitizeJudgment(value: CompleteRunInput["judgment"]) {
  if (!value) return undefined
  return {
    status: value.status,
    summary: sanitizeArtifactString(value.summary, maxArtifactSummaryChars),
    evidence: value.evidence?.slice(0, maxArtifactEvidenceItems).map((item) => sanitizeArtifactString(item, maxArtifactEvidenceChars) ?? ""),
    recommendedNextAction: sanitizeArtifactString(value.recommendedNextAction, maxArtifactSummaryChars),
    confidence: sanitizeArtifactString(value.confidence, maxArtifactConfidenceChars),
    failureClass: value.failureClass,
  }
}

function sanitizeGateResults(value: CompleteRunInput["gateResults"]) {
  return value?.map((gate) => ({
    id: truncateArtifactString(gate.id, maxArtifactMetadataKeyChars) ?? gate.id,
    status: gate.status,
    summary: sanitizeArtifactString(gate.summary, maxArtifactSummaryChars),
    failureClass: gate.failureClass,
    evidenceArtifacts: gate.evidenceArtifacts?.slice(0, maxArtifactEvidenceItems),
    waiver: gate.waiver
      ? {
          action: gate.waiver.action,
          actor: sanitizeArtifactString(gate.waiver.actor, maxArtifactSummaryChars) ?? gate.waiver.actor,
          reason: sanitizeArtifactString(gate.waiver.reason, maxArtifactSummaryChars) ?? gate.waiver.reason,
          time: gate.waiver.time,
        }
      : undefined,
  }))
}

function sanitizeRubricResult(value: CompleteRunInput["rubricResult"]): RubricResult | undefined {
  if (!value) return undefined
  return {
    status: value.status,
    score: Number.isFinite(value.score) ? Math.max(0, Math.min(1, value.score)) : 0,
    threshold: Number.isFinite(value.threshold) ? Math.max(0, Math.min(1, value.threshold)) : 1,
    criteria: value.criteria.slice(0, 50).map((criterion) => ({
      id: sanitizeArtifactString(criterion.id, maxArtifactMetadataKeyChars) ?? criterion.id,
      score: Number.isFinite(criterion.score) ? Math.max(0, criterion.score) : 0,
      maxScore: Number.isFinite(criterion.maxScore) ? Math.max(0, criterion.maxScore) : 0,
      passed: criterion.passed,
      reason: sanitizeArtifactString(criterion.reason, maxArtifactSummaryChars) ?? criterion.reason,
      evidence: criterion.evidence.slice(0, maxArtifactEvidenceItems).map((item) => sanitizeArtifactString(item, maxArtifactEvidenceChars) ?? ""),
    })),
    blockers: value.blockers.slice(0, 50).map((blocker) => ({
      id: sanitizeArtifactString(blocker.id, maxArtifactMetadataKeyChars) ?? blocker.id,
      present: blocker.present,
      reason: sanitizeArtifactString(blocker.reason, maxArtifactSummaryChars) ?? blocker.reason,
    })),
  }
}

function nonNegativeNumber(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function nonNegativeInt(value: number | undefined) {
  const number = nonNegativeNumber(value)
  return number === undefined ? undefined : Math.floor(number)
}

function sanitizeUsage(value: CompleteRunInput["usage"]): Usage | undefined {
  if (!value) return undefined
  return {
    providerID: sanitizeArtifactString(value.providerID, maxArtifactConfidenceChars),
    modelID: sanitizeArtifactString(value.modelID, maxArtifactConfidenceChars),
    variant: sanitizeArtifactString(value.variant, maxArtifactConfidenceChars),
    cost: nonNegativeNumber(value.cost),
    durationMs: nonNegativeInt(value.durationMs),
    tokens: value.tokens
      ? {
          input: nonNegativeInt(value.tokens.input),
          output: nonNegativeInt(value.tokens.output),
          reasoning: nonNegativeInt(value.tokens.reasoning),
          cacheRead: nonNegativeInt(value.tokens.cacheRead),
          cacheWrite: nonNegativeInt(value.tokens.cacheWrite),
        }
      : undefined,
  }
}

function usageTokenTotal(usage: Usage | undefined) {
  if (!usage?.tokens) return 0
  return (usage.tokens.input ?? 0) + (usage.tokens.output ?? 0) + (usage.tokens.reasoning ?? 0) + (usage.tokens.cacheRead ?? 0) + (usage.tokens.cacheWrite ?? 0)
}

function metricsTokenTotal(metrics: Metrics) {
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0) + (metrics.reasoningTokens ?? 0) + (metrics.cacheReadTokens ?? 0) + (metrics.cacheWriteTokens ?? 0)
}

function addUsageToMetrics(metrics: Metrics, usage: Usage | undefined): Metrics {
  if (!usage) return metrics
  return {
    ...metrics,
    cost: (metrics.cost ?? 0) + (usage.cost ?? 0),
    inputTokens: (metrics.inputTokens ?? 0) + (usage.tokens?.input ?? 0),
    outputTokens: (metrics.outputTokens ?? 0) + (usage.tokens?.output ?? 0),
    reasoningTokens: (metrics.reasoningTokens ?? 0) + (usage.tokens?.reasoning ?? 0),
    cacheReadTokens: (metrics.cacheReadTokens ?? 0) + (usage.tokens?.cacheRead ?? 0),
    cacheWriteTokens: (metrics.cacheWriteTokens ?? 0) + (usage.tokens?.cacheWrite ?? 0),
  }
}

type SanitizedGateResult = NonNullable<CompleteRunInput["gateResults"]>[number]

function costBudgetGate(costBudget: Spec["costBudget"], metrics: Metrics): SanitizedGateResult | undefined {
  if (!costBudget) return undefined
  if (typeof costBudget.maxCost === "number" && (metrics.cost ?? 0) > costBudget.maxCost) {
    return {
      id: "cost-budget",
      status: "blocked",
      summary: `Cost budget exceeded (${(metrics.cost ?? 0).toFixed(6)}/${costBudget.maxCost}).`,
      failureClass: "budget",
    }
  }
  if (typeof costBudget.maxTokens === "number" && metricsTokenTotal(metrics) > costBudget.maxTokens) {
    return {
      id: "cost-budget",
      status: "blocked",
      summary: `Token budget exceeded (${metricsTokenTotal(metrics)}/${costBudget.maxTokens}).`,
      failureClass: "budget",
    }
  }
  return {
    id: "cost-budget",
    status: "pass",
    summary: `Usage is within configured cost budget (tokens=${metricsTokenTotal(metrics)}, cost=${(metrics.cost ?? 0).toFixed(6)}).`,
    failureClass: "none",
  }
}

function rubricGate(rubric: Spec["rubric"], completionProposed: boolean, result: RubricResult | undefined): SanitizedGateResult | undefined {
  if (!rubric || !completionProposed) return undefined
  if (!result) {
    return {
      id: "rubric",
      status: "blocked",
      summary: "Completion was proposed without a persisted runtime rubric evaluation.",
      failureClass: "quality",
    }
  }
  if (result.status === "pass") {
    return {
      id: "rubric",
      status: "pass",
      summary: `Runtime rubric passed (${Math.round(result.score * 100)}% >= ${Math.round(result.threshold * 100)}%).`,
      failureClass: "none",
    }
  }
  const blockers = result.blockers.filter((blocker) => blocker.present).map((blocker) => blocker.id)
  return {
    id: "rubric",
    status: result.status === "blocked" ? "blocked" : "fail",
    summary: blockers.length
      ? `Runtime rubric blocked completion: ${blockers.join(", ")}.`
      : `Runtime rubric did not reach its threshold (${Math.round(result.score * 100)}% < ${Math.round(result.threshold * 100)}%).`,
    failureClass: "quality",
  }
}

function sanitizeArtifactInput(input: ArtifactInput): SanitizedArtifactInput {
  return {
    ...input,
    title: sanitizeArtifactString(input.title, maxArtifactSummaryChars) ?? input.title,
    summary: sanitizeArtifactString(input.summary, maxArtifactSummaryChars) ?? input.summary,
    text: sanitizeArtifactString(input.text, maxArtifactTextChars),
    evidence: input.evidence
      ?.slice(0, maxArtifactEvidenceItems)
      .map((item) => sanitizeArtifactString(item, maxArtifactEvidenceChars) ?? ""),
    metadata: input.metadata ? sanitizeArtifactMetadata(input.metadata) : undefined,
  }
}

function artifactBytes(row: ArtifactRow) {
  return Buffer.byteLength(JSON.stringify(row), "utf8")
}

function pruneArtifactsInDb(db: TxOrDb, workflowID: LoopID) {
  const retention = db
    .select({ data: LoopWorkflowTable.data })
    .from(LoopWorkflowTable)
    .where(eq(LoopWorkflowTable.id, workflowID))
    .get()?.data.spec.retention
  const artifacts = db
    .select()
    .from(LoopArtifactTable)
    .where(eq(LoopArtifactTable.workflow_id, workflowID))
    .orderBy(desc(LoopArtifactTable.sequence))
    .all()
  const stale = new Set<string>()
  const protectedIDs = new Set(
    artifacts.flatMap((artifact) => {
      const value = artifact.data?.metadata?.evidenceArtifacts
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    }),
  )
  const activeRunIDs = new Set(
    db
      .select({ id: LoopRunTable.id, state: LoopRunTable.state })
      .from(LoopRunTable)
      .where(eq(LoopRunTable.workflow_id, workflowID))
      .all()
      .filter((run) => activeRunStates.has(run.state))
      .map((run) => run.id),
  )
  artifacts
    .filter((artifact) => artifact.kind === "command-output" && artifact.run_id && activeRunIDs.has(artifact.run_id))
    .forEach((artifact) => protectedIDs.add(artifact.id))
  for (const kind of ["checkpoint", "judgment"] as const) {
    const latest = artifacts.find((artifact) => artifact.kind === kind)
    if (latest) protectedIDs.add(latest.id)
  }
  const latestGate = artifacts.find(
    (artifact) =>
      artifact.kind === "gate" &&
      (artifact.data?.status === "fail" || artifact.data?.status === "blocked" || artifact.data?.status === "awaiting_approval"),
  ) ?? artifacts.find((artifact) => artifact.kind === "gate")
  if (latestGate) protectedIDs.add(latestGate.id)
  artifacts.filter((artifact) => artifact.kind === "override").forEach((artifact) => protectedIDs.add(artifact.id))
  const protectedArtifact = (artifact: ArtifactRow) => protectedIDs.has(artifact.id)
  const oldest = artifacts.toSorted(
    (a, b) => a.time_created - b.time_created || a.sequence - b.sequence || a.id.localeCompare(b.id),
  )
  const maxAgeMs = nonNegativeInt(retention?.maxAgeMs)
  if (maxAgeMs !== undefined) {
    const cutoff = Date.now() - maxAgeMs
    oldest.filter((artifact) => artifact.time_created < cutoff && !protectedArtifact(artifact)).forEach((artifact) => stale.add(artifact.id))
  }
  const kept = () => artifacts.filter((artifact) => !stale.has(artifact.id))
  const maxBytes = nonNegativeInt(retention?.maxBytes)
  if (maxBytes !== undefined) {
    let total = kept().reduce((sum, artifact) => sum + artifactBytes(artifact), 0)
    for (const artifact of oldest) {
      if (total <= maxBytes) break
      if (stale.has(artifact.id) || protectedArtifact(artifact)) continue
      stale.add(artifact.id)
      total -= artifactBytes(artifact)
    }
  }
  const maxArtifacts = nonNegativeInt(retention?.maxArtifacts) ?? maxArtifactsPerWorkflow
  for (const artifact of oldest) {
    if (kept().length <= maxArtifacts) break
    if (stale.has(artifact.id) || protectedArtifact(artifact)) continue
    stale.add(artifact.id)
  }
  for (const id of stale) db.delete(LoopArtifactTable).where(eq(LoopArtifactTable.id, id)).run()
}

function completionArtifacts(input: CompleteRunInput & { rootSessionID?: SessionID }) {
  const artifacts: ArtifactInput[] = []
  if (input.checkpoint) {
    artifacts.push({
      workflowID: input.id,
      runID: input.runID,
      sessionID: input.rootSessionID,
      kind: "checkpoint",
      title: "Loop checkpoint",
      summary: input.checkpoint.summary ?? `Checkpoint status: ${input.checkpoint.status ?? "unknown"}`,
      source: "worker",
      status: input.checkpoint.status,
      contentType: "application/json",
      evidence: input.checkpoint.evidence,
      metadata: {
        nextAction: input.checkpoint.nextAction,
        confidence: input.checkpoint.confidence,
      },
    })
  }
  if (input.judgment) {
    artifacts.push({
      workflowID: input.id,
      runID: input.runID,
      sessionID: input.rootSessionID,
      kind: "judgment",
      title: "Independent evaluator judgment",
      summary: input.judgment.summary ?? `Evaluator status: ${input.judgment.status ?? "unknown"}`,
      source: "evaluator",
      status: input.judgment.status,
      contentType: "application/json",
      evidence: input.judgment.evidence,
      metadata: {
        recommendedNextAction: input.judgment.recommendedNextAction,
        confidence: input.judgment.confidence,
      },
    })
  }
  if (input.usage && ((input.usage.cost ?? 0) > 0 || usageTokenTotal(input.usage) > 0)) {
    artifacts.push({
      workflowID: input.id,
      runID: input.runID,
      sessionID: input.rootSessionID,
      kind: "cost",
      title: "Loop usage ledger",
      summary: `Usage recorded: cost=${(input.usage.cost ?? 0).toFixed(6)}, tokens=${usageTokenTotal(input.usage)}.`,
      source: "loop-runner",
      status: "recorded",
      contentType: "application/json",
      metadata: {
        providerID: input.usage.providerID,
        modelID: input.usage.modelID,
        variant: input.usage.variant,
        cost: input.usage.cost ?? 0,
        durationMs: input.usage.durationMs ?? 0,
        tokens: input.usage.tokens ?? {},
        totalTokens: usageTokenTotal(input.usage),
      },
    })
  }
  artifacts.push(
    ...(input.gateResults ?? []).map((gate) => ({
      workflowID: input.id,
      runID: input.runID,
      sessionID: input.rootSessionID,
      kind: "gate" as const,
      title: `Gate: ${gate.id}`,
      summary: gate.summary ?? `Gate ${gate.id} returned ${gate.status}.`,
      source: "gate-engine",
      status: gate.status,
      contentType: "application/json",
      metadata: {
        gateID: gate.id,
        failureClass: gate.failureClass,
        evidenceArtifacts: gate.evidenceArtifacts,
        waiver: gate.waiver,
      },
    })),
  )
  return artifacts
}

function summaryVerdict(input: { workflow: Info; run?: RunInfo }) {
  if (input.workflow.state === "completed") return "complete"
  if (input.workflow.state === "blocked" || input.workflow.state === "needs_input" || input.workflow.state === "failed") return input.workflow.state
  if (input.run?.judgment?.status) return input.run.judgment.status
  if (input.run?.checkpoint?.status) return input.run.checkpoint.status
  return input.workflow.phase
}

function summaryEvidence(run: RunInfo | undefined) {
  return [
    ...(run?.checkpoint?.evidence ?? []),
    ...(run?.judgment?.evidence ?? []),
  ].filter(Boolean).slice(0, 8)
}

function summaryGateResults(run: RunInfo | undefined) {
  const gates = run?.gateResults ?? []
  const blocking = gates.find((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
  return {
    total: gates.length,
    pass: gates.filter((gate) => gate.status === "pass").length,
    fail: gates.filter((gate) => gate.status === "fail").length,
    blocked: gates.filter((gate) => gate.status === "blocked").length,
    awaitingApproval: gates.filter((gate) => gate.status === "awaiting_approval").length,
    skip: gates.filter((gate) => gate.status === "skip").length,
    blocking: blocking ? `${blocking.id}: ${blocking.summary ?? blocking.status}` : undefined,
  }
}

function summaryMemory(workflow: Info) {
  const entries = workflow.memory?.entries ?? []
  return {
    total: entries.length,
    open: entries.filter((entry) => entry.section === "open").length,
    latest: entries.slice(-6).map((entry) => `${entry.section}: ${entry.summary}`),
  }
}

export function summarizeSnapshot(snapshot: Snapshot): Summary {
  const run = snapshot.runs[0]
  return {
    workflowID: snapshot.workflow.id,
    state: snapshot.workflow.state,
    phase: snapshot.workflow.phase,
    objective: snapshot.workflow.objective,
    nextWakeup: snapshot.workflow.nextWakeup,
    runID: run?.id,
    runState: run?.state,
    verdict: summaryVerdict({ workflow: snapshot.workflow, run }),
    verdictSummary: run?.judgment?.summary ?? run?.checkpoint?.summary ?? run?.evaluatorReason ?? snapshot.workflow.evaluatorReason,
    checkpointStatus: run?.checkpoint?.status,
    judgmentStatus: run?.judgment?.status,
    gateSummary: summaryGateResults(run),
    evidenceSummary: summaryEvidence(run),
    nextAction: run?.judgment?.recommendedNextAction ?? run?.checkpoint?.nextAction,
    memorySummary: summaryMemory(snapshot.workflow),
    costSummary: {
      cost: snapshot.workflow.metrics.cost,
      tokens: metricsTokenTotal(snapshot.workflow.metrics),
    },
  }
}

function completedRunStateForWorkflow(state: WorkflowState): RunState {
  if (state === "blocked") return "blocked"
  if (state === "needs_input") return "needs_input"
  if (state === "stopped") return "stopped"
  if (state === "failed") return "failed"
  return "completed"
}

function backgroundStateForWorkflow(state: WorkflowState): "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped" {
  if (state === "working") return "working"
  if (state === "needs_input") return "needs_input"
  if (state === "completed") return "completed"
  if (state === "failed") return "failed"
  if (state === "stopped" || state === "paused") return "stopped"
  return "queued"
}

function workflowSummary(state: WorkflowState, phase: string) {
  return phase && phase !== state ? `Loop ${state}: ${phase}` : `Loop ${state}`
}

function threadStateForWorkflow(state: WorkflowState): ThreadInfo["state"] {
  if (state === "working") return "working"
  if (state === "needs_input") return "needs_input"
  if (state === "completed") return "completed"
  if (state === "failed") return "failed"
  if (state === "stopped" || state === "paused") return "stopped"
  return "queued"
}

function reachedTurnLimit(row: WorkflowRow) {
  const metrics = row.data.metrics
  const policy = row.data.policy
  if (row.data.spec.budgetMode === "max-goal") return false
  if (row.state !== "active" && row.state !== "sleeping" && row.state !== "working") return false
  return (
    typeof policy.maxTurns === "number" &&
    (metrics.turns ?? 0) >= policy.maxTurns
  )
}

function deleteSessionTree(db: TxOrDb, sessionID: SessionID) {
  const children = db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all()
  for (const child of children) deleteSessionTree(db, child.id)
  db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
}

function reconcileTerminalWorkflow(row: WorkflowRow): WorkflowRow {
  if (!reachedTurnLimit(row)) return row
  const now = Date.now()
  const turns = row.data.metrics.turns ?? 0
  const reason = `Loop completed after reaching its iteration limit (${turns}/${row.data.policy.maxTurns}).`
  return Database.transaction((db) => {
    db.update(LoopWorkflowTable)
      .set({
        state: "completed",
        phase: "completed",
        next_wakeup: null,
        time_updated: now,
        data: {
          ...row.data,
          evaluatorReason: row.data.evaluatorReason ?? reason,
        },
      })
      .where(eq(LoopWorkflowTable.id, row.id))
      .run()
    if (row.root_session_id) {
      const background = db
        .select()
        .from(BackgroundSessionTable)
        .where(eq(BackgroundSessionTable.session_id, row.root_session_id))
        .get()
      db.insert(BackgroundSessionTable)
        .values({
          session_id: row.root_session_id,
          time_created: background?.time_created ?? now,
          time_updated: now,
          data: {
            ...background?.data,
            state: "completed",
            summary: workflowSummary("completed", "completed"),
            pinned: background?.data.pinned ?? true,
          },
        })
        .onConflictDoUpdate({
          target: BackgroundSessionTable.session_id,
          set: {
            time_updated: now,
            data: {
              ...background?.data,
              state: "completed",
              summary: workflowSummary("completed", "completed"),
              pinned: background?.data.pinned ?? true,
            },
          },
        })
        .run()
      db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, row.root_session_id)).run()
    }
    db.update(LoopThreadTable)
      .set({
        state: "completed",
        time_updated: now,
        data: { budget: row.data.metrics },
      })
      .where(eq(LoopThreadTable.workflow_id, row.id))
      .run()
    db.update(LoopRunTable)
      .set({
        state: "stopped",
        phase: "stopped",
        next_wakeup: null,
        time_updated: now,
        time_ended: now,
        data: {
          evaluatorReason: reason,
          budget: row.data.metrics,
        },
      })
      .where(and(eq(LoopRunTable.workflow_id, row.id), eq(LoopRunTable.state, "working")))
      .run()
    return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, row.id)).get() ?? row
  })
}

function reconcileInvalidCostBudget(row: WorkflowRow): WorkflowRow {
  const spec = normalizeSpec(row.data.spec)
  if (spec === row.data.spec) return row
  return Database.transaction((db) => {
    const current = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, row.id)).get()
    if (!current) return row
    const nextSpec = normalizeSpec(current.data.spec)
    if (nextSpec === current.data.spec) return current
    const now = Date.now()
    db.update(LoopWorkflowTable)
      .set({
        time_updated: now,
        data: { ...current.data, spec: nextSpec },
      })
      .where(eq(LoopWorkflowTable.id, current.id))
      .run()
    return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get() ?? current
  })
}

function fromWorkflowRow(row: WorkflowRow): Info {
  const metrics = row.data.metrics
  const policy = row.data.policy
  const spec = normalizeSpec(row.data.spec)
  return {
    id: LoopID.make(row.id),
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    ownerSessionID: row.owner_session_id ?? undefined,
    rootSessionID: row.root_session_id ?? undefined,
    name: row.name,
    objective: row.objective,
    state: row.state,
    source: row.source,
    templateID: row.template_id ?? undefined,
    phase: row.phase,
    nextWakeup: row.next_wakeup ?? undefined,
    spec,
    policy,
    metrics,
    memory: row.data.memory
      ? {
          entries: row.data.memory.entries.map((entry) => ({
            ...entry,
            runID: entry.runID ? RunID.make(entry.runID) : undefined,
          })),
        }
      : undefined,
    scheduler: row.data.scheduler
      ? {
          ...row.data.scheduler,
          lastRunID: row.data.scheduler.lastRunID ? RunID.make(row.data.scheduler.lastRunID) : undefined,
        }
      : undefined,
    evaluatorReason: row.data.evaluatorReason,
    failureClass: row.data.failureClass,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      activated: row.time_activated ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

function fromRunRow(row: RunRow): RunInfo {
  return {
    id: RunID.make(row.id),
    workflowID: LoopID.make(row.workflow_id),
    rootSessionID: row.root_session_id ?? undefined,
    state: row.state,
    trigger: row.trigger,
    phase: row.phase,
    nextWakeup: row.next_wakeup ?? undefined,
    evaluatorReason: row.data.evaluatorReason,
    failureClass: row.data.failureClass,
    budget: row.data.budget,
    checkpoint: row.data.checkpoint,
    judgment: row.data.judgment,
    rubricResult: row.data.rubricResult,
    usage: row.data.usage,
    gateResults: row.data.gateResults?.map((gate) => ({
      ...gate,
      evidenceArtifacts: gate.evidenceArtifacts?.map(ArtifactID.make),
    })),
    lease: row.data.lease,
    retry: row.data.retry,
    workspaceLease: row.data.workspaceLease
      ? {
          ...row.data.workspaceLease,
          workflowID: LoopID.make(row.data.workspaceLease.workflowID),
          runID: row.data.workspaceLease.runID ? RunID.make(row.data.workspaceLease.runID) : undefined,
        }
      : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      started: row.time_started ?? undefined,
      ended: row.time_ended ?? undefined,
    },
  }
}

function reconcileRunAfterTerminalWorkflow(input: { workflow: Info; runID: RunID; reason: string }): RunRow | undefined {
  const now = Date.now()
  return Database.transaction((db) => {
    const current = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
    if (!current) return undefined
    if (current.state === "working" || current.state === "queued" || current.state === "blocked" || current.state === "needs_input") {
      db.update(LoopRunTable)
        .set({
          state: "stopped",
          phase: "stopped",
          next_wakeup: null,
          time_updated: now,
          time_ended: current.time_ended ?? now,
          data: {
            ...current.data,
            evaluatorReason: input.reason,
            budget: input.workflow.metrics,
            lease: current.data.lease,
          },
        })
        .where(eq(LoopRunTable.id, input.runID))
        .run()
    }
    return db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
  })
}

function fromEventRow(row: EventRow): JournalEvent {
  return {
    id: EventID.make(row.id),
    workflowID: LoopID.make(row.workflow_id),
    runID: row.run_id ? RunID.make(row.run_id) : undefined,
    sessionID: row.session_id ?? undefined,
    sequence: row.sequence,
    level: row.level,
    type: row.type,
    title: row.title,
    summary: row.summary,
    data: row.data ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function fromArtifactRow(row: ArtifactRow): ArtifactInfo {
  return {
    id: ArtifactID.make(row.id),
    workflowID: LoopID.make(row.workflow_id),
    runID: row.run_id ? RunID.make(row.run_id) : undefined,
    sessionID: row.session_id ?? undefined,
    sequence: row.sequence,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    source: row.data?.source,
    status: row.data?.status,
    contentType: row.data?.contentType,
    text: row.data?.text,
    evidence: row.data?.evidence,
    metadata: row.data?.metadata,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function fromThreadRow(row: ThreadRow): ThreadInfo {
  return {
    workflowID: LoopID.make(row.workflow_id),
    runID: row.run_id ? RunID.make(row.run_id) : undefined,
    sessionID: row.session_id,
    role: row.role,
    purpose: row.purpose,
    state: row.state,
    parentSessionID: row.parent_session_id ?? undefined,
    budget: row.data?.budget,
    worktree: row.data?.worktree,
    branch: row.data?.branch,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function notFound(id: string) {
  return new NotFoundError({ message: `Loop workflow not found: ${id}` })
}

type EventInput = {
  workflowID: LoopID
  runID?: RunID
  sessionID?: SessionID
  level?: EventLevel
  type: EventType
  title: string
  summary: string
  data?: Record<string, unknown>
}

function appendEventInDb(db: TxOrDb, input: EventInput, now = Date.now()): JournalEvent {
  const latest = db
    .select({ sequence: LoopEventTable.sequence })
    .from(LoopEventTable)
    .where(eq(LoopEventTable.workflow_id, input.workflowID))
    .orderBy(desc(LoopEventTable.sequence))
    .limit(1)
    .get()
  const row: EventRow = {
    id: EventID.make(),
    workflow_id: input.workflowID,
    run_id: input.runID ?? null,
    session_id: input.sessionID ?? null,
    sequence: (latest?.sequence ?? 0) + 1,
    level: input.level ?? "info",
    type: input.type,
    title: sanitizeArtifactString(input.title, maxArtifactSummaryChars) ?? input.title,
    summary: sanitizeArtifactString(input.summary, maxArtifactSummaryChars) ?? input.summary,
    time_created: now,
    time_updated: now,
    data: input.data ? sanitizeArtifactMetadataValue(input.data, 0, new WeakSet<object>()) as Record<string, unknown> : null,
  }
  db.insert(LoopEventTable).values(row).run()
  return fromEventRow(row)
}

function appendEvent(input: EventInput): JournalEvent {
  return Database.transaction((db) => appendEventInDb(db, input), { behavior: "immediate" })
}

function appendArtifactsInDb(db: TxOrDb, inputs: ArtifactInput[]) {
  if (!inputs.length) return []
  const now = Date.now()
  const latestByWorkflow = new Map<string, number>()
  const inserted = inputs.map((rawInput) => {
    const input = sanitizeArtifactInput(rawInput)
    const latest = latestByWorkflow.get(input.workflowID) ?? (db
      .select({ sequence: LoopArtifactTable.sequence })
      .from(LoopArtifactTable)
      .where(eq(LoopArtifactTable.workflow_id, input.workflowID))
      .orderBy(desc(LoopArtifactTable.sequence))
      .limit(1)
      .get()?.sequence ?? 0)
    const sequence = latest + 1
    latestByWorkflow.set(input.workflowID, sequence)
    const row: ArtifactRow = {
      id: ArtifactID.make(),
      workflow_id: input.workflowID,
      run_id: input.runID ?? null,
      session_id: input.sessionID ?? null,
      sequence,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      time_created: now,
      time_updated: now,
      data: {
        source: input.source,
        status: input.status,
        contentType: input.contentType,
        text: input.text,
        evidence: input.evidence,
        metadata: input.metadata,
      },
    }
    db.insert(LoopArtifactTable).values(row).run()
    return fromArtifactRow(row)
  })
  for (const workflowID of new Set(inserted.map((artifact) => artifact.workflowID))) pruneArtifactsInDb(db, workflowID)
  return inserted
}

function appendArtifacts(inputs: ArtifactInput[]) {
  if (!inputs.length) return []
  return Database.transaction((db) => appendArtifactsInDb(db, inputs))
}

function reconcileStaleWorkingRun(row: WorkflowRow, now = Date.now()): WorkflowRow {
  if (row.state !== "working" && row.state !== "paused") return row
  const activeRuns = Database.use((db) =>
    db
      .select()
      .from(LoopRunTable)
      .where(eq(LoopRunTable.workflow_id, row.id))
      .orderBy(desc(LoopRunTable.time_created))
      .all()
      .filter((run) => activeRunStates.has(run.state)),
  )
  const staleRun = activeRuns.find((run) => runLeaseStale({ run, policy: row.data.policy, now }))
  const orphanedWorkflow = row.state === "working" && activeRuns.length === 0
  if (!staleRun && !orphanedWorkflow) return row
  const nextWakeup = row.state === "paused" ? undefined : recoveryWakeupFor(row.data.spec, now)
  const recoveredState: WorkflowState = row.state === "paused" ? "paused" : nextWakeup ? "sleeping" : "active"
  const recoveredPhase = row.state === "paused" ? "paused" : nextWakeup ? "waiting" : "ready"
  const reason = staleRun
    ? `Recovered stale loop run ${staleRun.id}; its worker process exited or its lease expired before completion.`
    : "Recovered orphaned loop workflow; no active run remained after the previous worker stopped."
  const recovered = Database.transaction((db) => {
    if (staleRun) {
      db.update(LoopRunTable)
        .set({
          state: "failed",
          phase: "stale",
          next_wakeup: null,
          time_updated: now,
          time_ended: now,
          data: {
            ...staleRun.data,
            evaluatorReason: reason,
            budget: row.data.metrics,
            lease: staleRun.data.lease,
          },
        })
        .where(eq(LoopRunTable.id, staleRun.id))
        .run()
    }
    db.update(LoopWorkflowTable)
      .set({
        state: recoveredState,
        phase: recoveredPhase,
        next_wakeup: nextWakeup ?? null,
        time_updated: now,
        data: {
          spec: row.data.spec,
          policy: row.data.policy,
          metrics: { ...row.data.metrics, failures: (row.data.metrics.failures ?? 0) + 1 },
          memory: row.data.memory,
          scheduler: {
            ...row.data.scheduler,
            lastWakeAttempt: now,
            nextWakeup,
            lastRunID: staleRun ? RunID.make(staleRun.id) : row.data.scheduler?.lastRunID,
            lastRunState: staleRun ? "failed" : row.data.scheduler?.lastRunState,
            lastResult: reason,
            lastError: reason,
            degraded: true,
          },
          evaluatorReason: reason,
        },
      })
      .where(eq(LoopWorkflowTable.id, row.id))
      .run()
    if (row.root_session_id) {
      const background = db
        .select()
        .from(BackgroundSessionTable)
        .where(eq(BackgroundSessionTable.session_id, row.root_session_id))
        .get()
      db.insert(BackgroundSessionTable)
        .values({
          session_id: row.root_session_id,
          time_created: background?.time_created ?? now,
          time_updated: now,
          data: {
            ...background?.data,
            state: backgroundStateForWorkflow(recoveredState),
            summary: workflowSummary(recoveredState, recoveredPhase),
            pinned: background?.data.pinned ?? true,
          },
        })
        .onConflictDoUpdate({
          target: BackgroundSessionTable.session_id,
          set: {
            time_updated: now,
            data: {
              ...background?.data,
              state: backgroundStateForWorkflow(recoveredState),
              summary: workflowSummary(recoveredState, recoveredPhase),
              pinned: background?.data.pinned ?? true,
            },
          },
        })
        .run()
      db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, row.root_session_id)).run()
    }
    db.update(LoopThreadTable)
      .set({
        state: threadStateForWorkflow(recoveredState),
        time_updated: now,
        data: { budget: row.data.metrics },
      })
      .where(eq(LoopThreadTable.workflow_id, row.id))
      .run()
    return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, row.id)).get() ?? row
  })
  appendEvent({
    workflowID: LoopID.make(row.id),
    runID: staleRun ? RunID.make(staleRun.id) : undefined,
    sessionID: row.root_session_id ?? undefined,
    level: "warning",
    type: "failed",
    title: staleRun ? "Stale loop run recovered" : "Orphaned loop workflow recovered",
    summary: reason,
    data: { lease: staleRun?.data.lease, recoveredState, nextWakeup },
  })
  return recovered
}

function reconcileBlockedScheduledMonitor(row: WorkflowRow, now = Date.now()): WorkflowRow {
  if (row.state !== "blocked" || !scheduledMonitor(row.data.spec)) return row
  const latestRun = Database.use((db) =>
    db
      .select()
      .from(LoopRunTable)
      .where(eq(LoopRunTable.workflow_id, row.id))
      .orderBy(desc(LoopRunTable.time_created))
      .limit(1)
      .get(),
  )
  if (latestRun?.state !== "blocked" || latestRun.data.checkpoint?.status !== "blocked") return row
  if (latestRun.data.gateResults?.some((gate) =>
    workflowBlockingGate(gate) && !(gate.id === "cost-budget" && !row.data.spec.costBudget),
  )) return row
  const nextWakeup = nextWakeupFor(row.data.spec, now)
  if (!nextWakeup) return row
  const reason = `Scheduled ${row.data.spec.trigger?.mode} monitor kept its cadence after a non-gate blocked checkpoint.`
  return Database.transaction((db) => {
    const current = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, row.id)).get()
    if (!current || current.state !== "blocked") return current ?? row
    const currentRun = db
      .select()
      .from(LoopRunTable)
      .where(eq(LoopRunTable.workflow_id, current.id))
      .orderBy(desc(LoopRunTable.time_created))
      .limit(1)
      .get()
    if (currentRun?.state !== "blocked" || currentRun.data.checkpoint?.status !== "blocked") return current
    if (currentRun.data.gateResults?.some((gate) =>
      workflowBlockingGate(gate) && !(gate.id === "cost-budget" && !current.data.spec.costBudget),
    )) return current
    db.update(LoopWorkflowTable)
      .set({
        state: "sleeping",
        phase: "waiting",
        next_wakeup: nextWakeup,
        time_updated: now,
        data: current.data,
      })
      .where(eq(LoopWorkflowTable.id, current.id))
      .run()
    appendEventInDb(db, {
      workflowID: LoopID.make(current.id),
      runID: RunID.make(currentRun.id),
      sessionID: current.root_session_id ?? undefined,
      level: "warning",
      type: "monitor",
      title: "Scheduled monitor resumed",
      summary: reason,
      data: { previousState: "blocked", nextWakeup, checkpoint: currentRun.data.checkpoint },
    }, now)
    return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get() ?? current
  })
}

function repairOverdueScheduledWakeup(id: LoopID, now: number) {
  return Database.transaction((db) => {
    const current = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, id)).get()
    if (!current || (current.state !== "active" && current.state !== "sleeping")) return current
    if (!scheduledTrigger(current.data.spec) || typeof current.next_wakeup !== "number" || current.next_wakeup >= now) return current

    const alreadyMarked = current.phase === "catch_up" && current.data.scheduler?.nextWakeup === current.next_wakeup
    const previousWakeup = current.next_wakeup
    const nextScheduler = {
      ...current.data.scheduler,
      lastWakeAttempt: now,
      nextWakeup: now,
      lastError: undefined,
      lastResult: "Scheduled wakeup repaired; catch-up run queued.",
      degraded: true,
    }
    db.update(LoopWorkflowTable)
      .set({
        phase: "catch_up",
        next_wakeup: now,
        time_updated: now,
        data: {
          ...current.data,
          scheduler: nextScheduler,
        },
      })
      .where(eq(LoopWorkflowTable.id, current.id))
      .run()
    if (!alreadyMarked) {
      appendEventInDb(
        db,
        {
          workflowID: LoopID.make(current.id),
          sessionID: current.root_session_id ?? undefined,
          level: "warning",
          type: "wake",
          title: "Scheduled wakeup repaired",
          summary: `Repaired overdue ${current.data.spec.trigger?.mode ?? "scheduled"} wakeup and queued a catch-up run.`,
          data: { previousWakeup, nextWakeup: now },
        },
        now,
      )
    }
    const repaired = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get() ?? current
    return repaired
  }, { behavior: "immediate" })
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

function createRootSession(input: {
  title: string
  projectID: ProjectID
  workspaceID?: WorkspaceID
  directory: string
  worktree: string
}) {
  const now = Date.now()
  const id = SessionID.descending()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: input.projectID,
        workspace_id: input.workspaceID ?? null,
        parent_id: null,
        slug: Slug.create(),
        directory: input.directory,
        path: sessionPath(input.worktree, input.directory),
        title: input.title,
        version: InstallationVersion,
        share_url: null,
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        summary_diffs: null,
        revert: null,
        permission: null,
        agent: null,
        model: null,
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
      })
      .run(),
  )
  return id
}

function registerBackground(input: {
  sessionID: SessionID
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  summary?: string
  error?: string
  pinned?: boolean
}) {
  const now = Date.now()
  const current = Database.use((db) =>
    db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, input.sessionID)).get(),
  )
  Database.use((db) =>
    db
      .insert(BackgroundSessionTable)
      .values({
        session_id: input.sessionID,
        time_created: current?.time_created ?? now,
        time_updated: now,
        data: {
          ...current?.data,
          state: input.state,
          summary: input.summary ?? current?.data.summary,
          error: input.error ?? current?.data.error,
          pinned: input.pinned ?? current?.data.pinned,
          writer: terminalBackgroundStates.has(input.state) ? undefined : current?.data.writer,
        },
      })
      .onConflictDoUpdate({
        target: BackgroundSessionTable.session_id,
        set: {
          time_updated: now,
          data: {
            ...current?.data,
            state: input.state,
            summary: input.summary ?? current?.data.summary,
            error: input.error ?? current?.data.error,
            pinned: input.pinned ?? current?.data.pinned,
            writer: terminalBackgroundStates.has(input.state) ? undefined : current?.data.writer,
          },
        },
      })
      .run(),
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = Option.getOrUndefined(yield* Effect.serviceOption(Bus.Service))
    const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundSession.Service))
    const worktree = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const publishWorkflow = (info: Info) => (bus ? bus.publish(Event.WorkflowUpdated, { workflowID: info.id, info }) : Effect.void)
    const publishRun = (run: RunInfo) => (bus ? bus.publish(Event.RunUpdated, { workflowID: run.workflowID, run }) : Effect.void)
    const publishEvent = (event: JournalEvent) =>
      bus ? bus.publish(Event.EventCreated, { workflowID: event.workflowID, event }) : Effect.void
    const publishThread = (thread: ThreadInfo) =>
      bus ? bus.publish(Event.ThreadUpdated, { workflowID: thread.workflowID, thread }) : Effect.void
    const publishBackgroundForWorkflow = (
      workflow: Info,
      override?: Partial<Pick<BackgroundSession.RegisterInput, "state" | "summary" | "error">>,
    ) => {
      if (!workflow.rootSessionID) return Effect.void
      const state = override?.state ?? backgroundStateForWorkflow(workflow.state)
      const summary = override?.summary ?? workflowSummary(workflow.state, workflow.phase)
      if (!background) {
        registerBackground({
          sessionID: workflow.rootSessionID,
          state,
          summary,
          error: override?.error,
          pinned: true,
        })
        return Effect.void
      }
      return background.setState({
        sessionID: workflow.rootSessionID,
        state,
        summary,
        error: override?.error,
        pinned: true,
      }).pipe(Effect.asVoid)
    }
    const hydrateWorkflow = Effect.fn("LoopWorkflow.hydrate")(function* (row: WorkflowRow, now = Date.now()) {
      const normalized = reconcileInvalidCostBudget(row)
      const reconciled = reconcileBlockedScheduledMonitor(reconcileStaleWorkingRun(reconcileTerminalWorkflow(normalized), now), now)
      const info = fromWorkflowRow(reconciled)
      if (reconciled !== row) yield* publishBackgroundForWorkflow(info)
      return info
    })

    const list = Effect.fn("LoopWorkflow.list")(function* () {
      const ctx = yield* InstanceState.context
      const rows = Database.use((db) =>
        db
          .select()
          .from(LoopWorkflowTable)
          .where(eq(LoopWorkflowTable.project_id, ctx.project.id))
          .orderBy(desc(LoopWorkflowTable.time_updated), desc(LoopWorkflowTable.id))
          .all()
      )
      return yield* Effect.forEach(rows, hydrateWorkflow)
    })

    const listGlobal = Effect.fn("LoopWorkflow.listGlobal")(function* () {
      const data = Database.use((db) => ({
        rows: db.select().from(LoopWorkflowTable).orderBy(desc(LoopWorkflowTable.time_updated), desc(LoopWorkflowTable.id)).all(),
        projects: db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .all(),
        workspaces: db
          .select({ id: WorkspaceTable.id, directory: WorkspaceTable.directory })
          .from(WorkspaceTable)
          .all(),
      }))
      const projects = new Map(data.projects.map((project) => [String(project.id), project] as const))
      const workspaces = new Map(data.workspaces.map((workspace) => [String(workspace.id), workspace] as const))
      const workflows = yield* Effect.forEach(data.rows, hydrateWorkflow, { concurrency: 8 })
      return workflows.map((workflow): GlobalInfo => {
        const project = projects.get(workflow.projectID)
        return {
          ...workflow,
          project: {
            id: workflow.projectID,
            name: project?.name ?? undefined,
            worktree: project?.worktree ?? "",
            directory: (workflow.workspaceID ? workspaces.get(workflow.workspaceID)?.directory : undefined) ?? project?.worktree ?? "",
          },
        }
      })
    })

    const listGlobalPage = Effect.fn("LoopWorkflow.listGlobalPage")(function* (input?: ListGlobalPageInput) {
      const limit = typeof input?.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(100, Math.floor(input.limit)))
        : 50
      const requestedOffset = typeof input?.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0
      const projectID = input?.scope === "project" ? (yield* InstanceState.context).project.id : undefined
      const stateFilter = (states: WorkflowState[]) =>
        projectID ? and(eq(LoopWorkflowTable.project_id, projectID), inArray(LoopWorkflowTable.state, states)) : inArray(LoopWorkflowTable.state, states)
      const readPageRows = () =>
        Database.use((db) => {
          const total = db
            .select({ value: count() })
            .from(LoopWorkflowTable)
            .where(stateFilter(globalHistoryWorkflowStates))
            .get()?.value ?? 0
          const selected = input?.selectedID
            ? db
                .select()
                .from(LoopWorkflowTable)
                .where(projectID
                  ? and(eq(LoopWorkflowTable.id, input.selectedID), eq(LoopWorkflowTable.project_id, projectID))
                  : eq(LoopWorkflowTable.id, input.selectedID))
                .get()
            : undefined
          const selectedOffset = selected && globalHistoryWorkflowStates.includes(selected.state)
            ? db
                .select({ value: count() })
                .from(LoopWorkflowTable)
                .where(and(
                  stateFilter(globalHistoryWorkflowStates),
                  or(
                    gt(LoopWorkflowTable.time_updated, selected.time_updated),
                    and(eq(LoopWorkflowTable.time_updated, selected.time_updated), gt(LoopWorkflowTable.id, selected.id)),
                  ),
                ))
                .get()?.value
            : undefined
          const offset = Math.min(
            selectedOffset === undefined ? Math.floor(requestedOffset / limit) * limit : Math.floor(selectedOffset / limit) * limit,
            Math.max(0, Math.ceil(total / limit) - 1) * limit,
          )
          return {
            active: db
              .select()
              .from(LoopWorkflowTable)
              .where(stateFilter(globalActiveWorkflowStates))
              .orderBy(desc(LoopWorkflowTable.time_updated), desc(LoopWorkflowTable.id))
              .all(),
            history: db
              .select()
              .from(LoopWorkflowTable)
              .where(stateFilter(globalHistoryWorkflowStates))
              .orderBy(desc(LoopWorkflowTable.time_updated), desc(LoopWorkflowTable.id))
              .limit(limit)
              .offset(offset)
              .all(),
            total,
            offset,
          }
        })
      const pageFromRows = (data: { active: WorkflowRow[]; history: WorkflowRow[]; total: number; offset: number }) =>
        Effect.gen(function* () {
          const rows = [...data.active, ...data.history]
          const projects = rows.length
            ? Database.use((db) =>
                db
                  .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
                  .from(ProjectTable)
                  .where(inArray(ProjectTable.id, [...new Set(rows.map((row) => row.project_id))]))
                  .all(),
              )
            : []
          const workspaceIDs = [...new Set(rows.flatMap((row) => row.workspace_id ? [row.workspace_id] : []))]
          const workspaces = workspaceIDs.length
            ? Database.use((db) =>
                db
                  .select({ id: WorkspaceTable.id, directory: WorkspaceTable.directory })
                  .from(WorkspaceTable)
                  .where(inArray(WorkspaceTable.id, workspaceIDs))
                  .all(),
              )
            : []
          const projectMap = new Map(projects.map((project) => [String(project.id), project] as const))
          const workspaceMap = new Map(workspaces.map((workspace) => [String(workspace.id), workspace] as const))
          const hydrated = yield* Effect.forEach(rows, hydrateWorkflow, { concurrency: 8 })
          const workflows = new Map(hydrated.map((workflow) => [workflow.id, workflow] as const))
          const changed = rows.some((row) => {
            const workflow = workflows.get(LoopID.make(row.id))
            return workflow && (workflow.state !== row.state || (workflow.time?.updated ?? 0) !== row.time_updated)
          })
          const globalInfo = (row: WorkflowRow): GlobalInfo => {
            const workflow = workflows.get(LoopID.make(row.id))!
            const project = projectMap.get(workflow.projectID)
            return {
              ...workflow,
              project: {
                id: workflow.projectID,
                name: project?.name ?? undefined,
                worktree: project?.worktree ?? "",
                directory: (workflow.workspaceID ? workspaceMap.get(workflow.workspaceID)?.directory : undefined) ?? project?.worktree ?? "",
              },
            }
          }
          return {
            changed,
            page: {
              active: data.active.map(globalInfo),
              history: data.history.map(globalInfo),
              page: { offset: data.offset, limit, total: data.total },
            },
          }
        })
      const first = yield* pageFromRows(readPageRows())
      if (!first.changed) return first.page
      return (yield* pageFromRows(readPageRows())).page
    })

    const due = Effect.fn("LoopWorkflow.due")(function* (input?: DueInput) {
      const now = input?.now ?? Date.now()
      const limit = input?.limit ?? 10
      const items = yield* list()
      const dueItems = items
        .filter((item) => {
          if (item.state !== "active" && item.state !== "sleeping") return false
          const mode = item.spec.trigger?.mode
          if (mode !== "interval" && mode !== "daily" && mode !== "adaptive" && mode !== "self-paced" && mode !== "external-signal") return false
          return typeof item.nextWakeup === "number" && item.nextWakeup <= now
        })
        .slice(0, limit)
      return dueItems.map((item) => {
        const repaired = repairOverdueScheduledWakeup(item.id, now)
        if (!repaired || (repaired.state !== "active" && repaired.state !== "sleeping")) return
        if (typeof repaired.next_wakeup !== "number" || (repaired.next_wakeup > now && repaired.phase !== "catch_up")) return
        return fromWorkflowRow(repaired)
      }).filter((item): item is Info => Boolean(item))
    })

    const get = Effect.fn("LoopWorkflow.get")(function* (id: LoopID, now?: number) {
      const row = Database.use((db) => db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, id)).get())
      if (!row) return yield* Effect.fail(notFound(id))
      return yield* hydrateWorkflow(row, now)
    })

    const events = Effect.fn("LoopWorkflow.events")(function* (id: LoopID, limit = 50) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(LoopEventTable)
          .where(eq(LoopEventTable.workflow_id, id))
          .orderBy(desc(LoopEventTable.sequence))
          .limit(limit)
          .all(),
      )
      return rows.reverse().map(fromEventRow)
    })

    const snapshot = Effect.fn("LoopWorkflow.snapshot")(function* (id: LoopID, limit = 50) {
      const workflow = yield* get(id)
      const rootSession = workflow.rootSessionID
        ? Database.use((db) =>
            db
              .select({
                id: SessionTable.id,
                title: SessionTable.title,
                model: SessionTable.model,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, workflow.rootSessionID!))
              .get(),
          )
        : undefined
      const runs = Database.use((db) =>
        db
          .select()
          .from(LoopRunTable)
          .where(eq(LoopRunTable.workflow_id, id))
          .orderBy(desc(LoopRunTable.time_created))
          .limit(10)
          .all()
          .map(fromRunRow),
      )
      const threads = Database.use((db) =>
        db.select().from(LoopThreadTable).where(eq(LoopThreadTable.workflow_id, id)).all().map(fromThreadRow),
      )
      const artifacts = Database.use((db) =>
        db
          .select()
          .from(LoopArtifactTable)
          .where(eq(LoopArtifactTable.workflow_id, id))
          .orderBy(desc(LoopArtifactTable.sequence))
          .limit(limit)
          .all()
          .reverse()
          .map(fromArtifactRow),
      )
      return {
        workflow,
        rootSession: rootSession
          ? {
              id: rootSession.id,
              title: rootSession.title,
              model: rootSession.model
                ? {
                    providerID: rootSession.model.providerID,
                    modelID: rootSession.model.id,
                    variant: rootSession.model.variant,
                  }
                : undefined,
            }
          : undefined,
        runs,
        threads,
        artifacts,
        events: yield* events(id, limit),
      }
    })

    const createDraft = Effect.fn("LoopWorkflow.createDraft")(function* (input: CreateDraftInput) {
      const ctx = yield* InstanceState.context
      const workspaceID = input.workspaceID ?? (yield* InstanceState.workspaceID)
      const usageMode = yield* Effect.promise(() => readBudgetUsageMode(ctx.directory, "api-usage"))
      const now = Date.now()
      const policy = defaultPolicy(input.policy, input.budgetMode)
      const spec = {
        trigger: normalizeTrigger(input.trigger),
        workflow: normalizeWorkflowReference(input.workflow),
        budgetMode: input.budgetMode,
        usageMode,
        completionCriteria: input.completionCriteria,
        successChecks: input.successChecks,
        validationChecks: input.validationChecks,
        strategy: input.strategy,
        stopWhen: input.stopWhen,
        gates: input.gates,
        model: input.model,
        agent: input.agent,
        evaluation: input.evaluation,
        rubric: input.rubric,
        workspace: input.workspace,
         costBudget: usageMode === "subscription" ? undefined : normalizeCostBudget(input.costBudget),
        approvalPolicy: input.approvalPolicy,
        memory: input.memory,
        retention: input.retention
          ? {
              ...input.retention,
              maxArtifacts: positiveInt(input.retention.maxArtifacts),
            }
          : undefined,
      }
      const row: WorkflowRow = {
        id: LoopID.make(),
        project_id: ctx.project.id,
        workspace_id: workspaceID ?? null,
        owner_session_id: input.ownerSessionID ?? null,
        root_session_id: null,
        name: input.name,
        objective: input.objective,
        state: "draft",
        source: input.source ?? "objective",
        template_id: input.templateID ?? null,
        phase: "draft",
        next_wakeup: null,
        time_created: now,
        time_updated: now,
        time_activated: null,
        time_archived: null,
        data: {
          spec,
          policy: {
            ...policy,
            requireApprovalFor: spec.approvalPolicy?.requireApprovalFor ?? policy.requireApprovalFor,
            approvedActions: spec.approvalPolicy?.approvedActions ?? policy.approvedActions,
          },
          metrics: { turns: 0, children: 0, failures: 0, noProgress: 0 },
          memory: memoryEnabled(spec) ? { entries: [] } : undefined,
        },
      }
      Database.use((db) => db.insert(LoopWorkflowTable).values(row).run())
      const info = fromWorkflowRow(row)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: input.ownerSessionID,
        type: "created",
        title: "Loop draft created",
        summary: info.objective,
      })
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const upsertRootThread = Effect.fn("LoopWorkflow.upsertRootThread")(function* (workflow: Info, runID?: RunID, workspaceLease?: WorkspaceLease) {
      if (!workflow.rootSessionID) return
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const row: ThreadRow = {
        workflow_id: workflow.id,
        run_id: runID ?? null,
        session_id: workflow.rootSessionID,
        role: "root",
        purpose: workflow.objective,
        state: threadStateForWorkflow(workflow.state),
        parent_session_id: workflow.ownerSessionID ?? null,
        time_created: now,
        time_updated: now,
        data: { budget: workflow.metrics, worktree: workspaceLease?.path ?? ctx.worktree, branch: workspaceLease?.branch },
      }
      Database.use((db) =>
        db
          .insert(LoopThreadTable)
          .values(row)
          .onConflictDoUpdate({
            target: [LoopThreadTable.workflow_id, LoopThreadTable.session_id],
            set: {
              run_id: row.run_id,
              purpose: row.purpose,
              state: row.state,
              time_updated: now,
              data: row.data,
            },
          })
          .run(),
      )
      yield* publishThread(fromThreadRow(row))
    })

    function previousPerLoopLease(workflowID: LoopID) {
      return Database.use((db) =>
        db
          .select()
          .from(LoopRunTable)
          .where(eq(LoopRunTable.workflow_id, workflowID))
          .orderBy(desc(LoopRunTable.time_created))
          .all()
          .map((row) => row.data.workspaceLease)
          .find((lease) => lease?.mode === "per-loop-worktree" && lease.state === "active"),
      )
    }

    const createWorkspaceLease = Effect.fn("LoopWorkflow.createWorkspaceLease")(function* (workflow: Info, runID: RunID) {
      const mode = workflow.spec.workspace?.mode
      if (mode !== "per-loop-worktree" && mode !== "per-run-worktree") return undefined
      const now = Date.now()
      if (mode === "per-loop-worktree") {
        const previous = previousPerLoopLease(workflow.id)
        if (previous) return { ...previous, workflowID: workflow.id, runID: undefined } satisfies WorkspaceLease
      }
      if (!worktree) {
        const ctx = yield* InstanceState.context
        return {
          id: `lease_${ulid().toLowerCase()}`,
          workflowID: workflow.id,
          runID: mode === "per-run-worktree" ? runID : undefined,
          mode,
          path: ctx.worktree,
          state: "failed" as const,
          retention: "manual" as const,
          created: now,
          error: "Worktree service unavailable; loop continued in current workspace.",
        } satisfies WorkspaceLease
      }
      return yield* worktree.create({ name: `${workflow.name}-${runID}` }).pipe(
        Effect.map((info) => ({
          id: `lease_${ulid().toLowerCase()}`,
          workflowID: workflow.id,
          runID: mode === "per-run-worktree" ? runID : undefined,
          mode,
          path: info.directory,
          branch: info.branch,
          state: "active" as const,
          retention: "retain_on_failure" as const,
          created: now,
        }) satisfies WorkspaceLease),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            return {
              id: `lease_${ulid().toLowerCase()}`,
              workflowID: workflow.id,
              runID: mode === "per-run-worktree" ? runID : undefined,
              mode,
              path: ctx.worktree,
              state: "failed" as const,
              retention: "manual" as const,
              created: now,
              error: errorMessage(error),
            } satisfies WorkspaceLease
          }),
        ),
      )
    })

    function persistRunWorkspaceLease(run: RunInfo, workspaceLease: WorkspaceLease | undefined) {
      if (!workspaceLease) return run
      const row = Database.use((db) => {
        const current = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, run.id)).get()
        if (!current) return undefined
        db.update(LoopRunTable)
          .set({
            time_updated: Date.now(),
            data: {
              ...current.data,
              workspaceLease: {
                ...workspaceLease,
                workflowID: workspaceLease.workflowID,
                runID: workspaceLease.runID,
              },
            },
          })
          .where(eq(LoopRunTable.id, run.id))
          .run()
        return db.select().from(LoopRunTable).where(eq(LoopRunTable.id, run.id)).get()
      })
      return row ? fromRunRow(row) : run
    }

    const activate = Effect.fn("LoopWorkflow.activate")(function* (input: UpdateStateInput) {
      const current = yield* get(input.id, input.now)
      if (current.state !== "draft") return current
      const ctx = yield* InstanceState.context
      const workspaceID = (current.workspaceID as WorkspaceID | undefined) ?? (yield* InstanceState.workspaceID)
      const rootSessionID =
        current.rootSessionID ??
        createRootSession({
          title: `Loop: ${current.name}`,
          projectID: ctx.project.id,
          workspaceID,
          directory: ctx.directory,
          worktree: ctx.worktree,
        })
      const now = input.now ?? Date.now()
      const nextWakeup = nextWakeupFor(current.spec, now, { immediate: true })
      const state: WorkflowState = nextWakeup ? "sleeping" : "active"
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            root_session_id: rootSessionID,
            workspace_id: workspaceID ?? null,
            state,
            phase: nextWakeup ? "waiting" : "ready",
            next_wakeup: nextWakeup,
            time_updated: now,
            time_activated: current.time.activated ?? now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, { nextWakeup, lastError: undefined, degraded: false }),
              evaluatorReason: input.reason ?? "Activated loop workflow.",
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: rootSessionID,
        type: "activated",
        title: "Loop activated",
        summary: input.reason ?? `Next phase: ${info.phase}`,
        data: { nextWakeup },
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const setWorkflowState = Effect.fn("LoopWorkflow.setWorkflowState")(function* (
      input: UpdateStateInput & { state: WorkflowState; phase: string; type: EventType; title: string },
    ) {
      const current = yield* get(input.id, input.now)
      if (input.state === "paused" && (current.state === "draft" || terminalWorkflowStates.has(current.state))) return current
      if (input.state === "stopped" && (current.state === "completed" || current.state === "failed" || current.state === "stopped")) return current
      const now = input.now ?? Date.now()
      const pendingSignalWakeup = input.state === "paused" && current.spec.trigger?.mode === "external-signal" ? current.nextWakeup : undefined
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            state: input.state,
            phase: input.phase,
            next_wakeup: pendingSignalWakeup ?? null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, {
                nextWakeup: pendingSignalWakeup,
                lastError: input.state === "stopped" ? undefined : current.scheduler?.lastError,
                degraded: input.state === "stopped" ? false : current.scheduler?.degraded,
              }),
              evaluatorReason: input.reason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        if (input.state === "stopped") {
          for (const run of db.select().from(LoopRunTable).where(eq(LoopRunTable.workflow_id, current.id)).all().filter((item) => activeRunStates.has(item.state))) {
            db.update(LoopRunTable)
              .set({
                state: "stopped",
                phase: "stopped",
                next_wakeup: null,
                time_updated: now,
                time_ended: now,
                data: { ...run.data, evaluatorReason: input.reason ?? "Loop stopped by operator." },
              })
              .where(eq(LoopRunTable.id, run.id))
              .run()
          }
        }
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: input.type,
        title: input.title,
        summary: input.reason ?? `Loop is ${info.state}.`,
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const pause = (input: UpdateStateInput) =>
      setWorkflowState({ ...input, state: "paused", phase: "paused", type: "paused", title: "Loop paused" })

    const resume = Effect.fn("LoopWorkflow.resume")(function* (input: UpdateStateInput) {
      const current = yield* get(input.id, input.now)
      if (current.state !== "paused") return current
      const preservedWakeup = typeof current.nextWakeup === "number"
      const pendingSignal = current.spec.trigger?.mode === "external-signal" && preservedWakeup
      const now = input.now ?? Date.now()
      const nextWakeup = preservedWakeup ? current.nextWakeup : nextWakeupFor(current.spec, now)
      const state: WorkflowState = nextWakeup ? "sleeping" : "active"
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            state,
            phase: pendingSignal ? "signal_received" : nextWakeup ? "waiting" : "ready",
            next_wakeup: nextWakeup,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, { nextWakeup, lastError: undefined, degraded: false }),
              evaluatorReason: input.reason ?? "Resumed loop workflow.",
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: "resumed",
        title: "Loop resumed",
        summary: input.reason ?? `Next phase: ${info.phase}`,
        data: { nextWakeup },
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const updateAgent = Effect.fn("LoopWorkflow.updateAgent")(function* (input: UpdateAgentInput) {
      const current = yield* get(input.id)
      const now = Date.now()
      const nextSpec = { ...current.spec, agent: input.agent?.trim() || undefined }
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            time_updated: now,
            data: {
              spec: nextSpec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: current.scheduler,
              evaluatorReason: input.reason ?? `Agent set to ${nextSpec.agent ?? "default"}.`,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: "action",
        title: "Loop agent updated",
        summary: input.reason ?? `Agent: ${info.spec.agent ?? "default"}`,
        data: { agent: info.spec.agent ?? null },
      })
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const override = Effect.fn("LoopWorkflow.override")(function* (input: OverrideInput) {
      const current = yield* get(input.id)
      const actor = sanitizeArtifactString(input.actor.trim(), maxArtifactSummaryChars)
      const reason = sanitizeArtifactString(input.reason.trim(), maxArtifactSummaryChars)
      if (!actor || !reason) return yield* Effect.fail(new NotFoundError({ message: "Loop overrides require a non-empty actor and reason." }))
      const run = Database.use((db) => db.select().from(LoopRunTable).where(eq(LoopRunTable.workflow_id, current.id)).orderBy(desc(LoopRunTable.time_created)).limit(1).get())
      if (!run || (input.runID && input.runID !== run.id)) return yield* Effect.fail(notFound(input.runID ?? current.id))
      if (activeRunStates.has(run.state)) return yield* Effect.fail(new NotFoundError({ message: `Loop run ${run.id} is still active and cannot be overridden.` }))
      const hasPriorWaiver = (run.data.gateResults ?? []).some((gate) => Boolean(gate.waiver))
      if (current.state !== "blocked" && current.state !== "needs_input" && !(input.action === "accept" && current.state === "active" && hasPriorWaiver)) {
        return yield* Effect.fail(new NotFoundError({ message: `Loop ${current.id} is ${current.state}; overrides are available only while blocked or awaiting input.` }))
      }
      const blocking = (run.data.gateResults ?? []).filter((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
      const critical = (gate: NonNullable<RunRow["data"]["gateResults"]>[number]) =>
        gate.status === "awaiting_approval" ||
        gate.id === "approval-policy" ||
        gate.id === "cost-budget" ||
        (gate.id === "rubric" && run.data.rubricResult?.status === "blocked") ||
        gate.failureClass === "policy" ||
        gate.failureClass === "budget" ||
        gate.failureClass === "user_input" ||
        gate.failureClass === "terminal"
      const targets = input.action === "waive"
        ? blocking.filter((gate) => gate.id === input.gateID)
        : input.action === "accept"
          ? blocking
          : []
      if (input.action === "waive" && (!input.gateID || targets.length !== 1)) {
        return yield* Effect.fail(new NotFoundError({ message: `Blocking gate not found for waiver: ${input.gateID ?? "missing gate id"}` }))
      }
      if (input.action === "accept" && !targets.length && !hasPriorWaiver) {
        return yield* Effect.fail(new NotFoundError({ message: "Completion acceptance requires at least one current non-critical blocking gate." }))
      }
      if (input.action === "accept" && !hasPriorWaiver && run.data.checkpoint?.status !== "complete" && run.data.judgment?.status !== "pass") {
        return yield* Effect.fail(new NotFoundError({ message: "Completion acceptance requires a worker completion proposal or passing independent judgment." }))
      }
      const protectedGate = targets.find(critical)
      if (protectedGate) {
        return yield* Effect.fail(new NotFoundError({ message: `Gate ${protectedGate.id} is safety-critical and cannot be waived.` }))
      }
      const now = Date.now()
      const waiver: GateWaiver = { action: input.action === "accept" ? "accept" : "waive", actor, reason, time: now }
      const targetIDs = new Set(targets.map((gate) => gate.id))
      const gateResults = (run.data.gateResults ?? []).map((gate) => targetIDs.has(gate.id)
        ? {
            ...gate,
            status: "pass" as const,
            summary: `${gate.summary ?? `Gate ${gate.id} blocked completion.`} Override accepted by ${actor}: ${reason}`,
            failureClass: "none" as const,
           waiver,
         }
       : gate)
      const remainingBlocking = gateResults.filter((gate) => gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval")
      const needsInput = remainingBlocking.some((gate) => gate.status === "awaiting_approval" || gate.failureClass === "user_input")
      const nextState: WorkflowState = input.action === "accept"
        ? "completed"
        : input.action === "retry" || !remainingBlocking.length
          ? "active"
          : needsInput
            ? "needs_input"
            : "blocked"
      const nextPhase = nextState === "completed" ? "completed" : nextState === "active" ? "ready" : nextState === "needs_input" ? "needs_input" : "blocked"
      const summary = input.action === "retry"
        ? `Retry requested by ${actor}: ${reason}`
        : `${input.action === "accept" ? "Completion accepted" : `Gate ${input.gateID} waived`} by ${actor}: ${reason}`
      const row = Database.transaction((db) => {
        db.update(LoopRunTable)
          .set({
            state: input.action === "accept" ? "completed" : run.state,
            phase: input.action === "accept" ? "completed" : run.phase,
            time_updated: now,
            time_ended: input.action === "accept" ? run.time_ended ?? now : run.time_ended,
            data: {
              ...run.data,
              evaluatorReason: summary,
              gateResults,
            },
          })
          .where(eq(LoopRunTable.id, run.id))
          .run()
        db.update(LoopWorkflowTable)
          .set({
            state: nextState,
            phase: nextPhase,
            next_wakeup: null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, {
                nextWakeup: undefined,
                lastError: input.action === "retry" || input.action === "accept" ? undefined : current.scheduler?.lastError,
                degraded: input.action === "retry" || input.action === "accept" ? false : current.scheduler?.degraded,
              }),
              evaluatorReason: summary,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        appendArtifactsInDb(db, [{
          workflowID: current.id,
          runID: RunID.make(run.id),
          sessionID: current.rootSessionID,
          kind: "override",
          title: `Human override: ${input.action}`,
          summary,
          source: actor,
          status: input.action,
          metadata: {
            actor,
            reason,
            action: input.action,
            gateID: input.gateID,
            previousState: current.state,
            nextState,
          },
        }])
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        runID: RunID.make(run.id),
        sessionID: info.rootSessionID,
        level: "decision",
        type: "action",
        title: `Loop override: ${input.action}`,
        summary,
        data: { actor, reason, action: input.action, gateID: input.gateID ?? null, previousState: current.state, nextState },
      })
      yield* upsertRootThread(info, RunID.make(run.id))
      yield* publishWorkflow(info)
      yield* publishRun(fromRunRow(Database.use((db) => db.select().from(LoopRunTable).where(eq(LoopRunTable.id, run.id)).get())!))
      yield* publishEvent(event)
      return info
    })

    const stop = (input: UpdateStateInput) =>
      setWorkflowState({ ...input, state: "stopped", phase: "stopped", type: "stopped", title: "Loop stopped" })

    const deleteWorkflow = Effect.fn("LoopWorkflow.delete")(function* (id: LoopID) {
      const current = yield* get(id)
      Database.transaction((db) => {
        db.delete(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).run()
        if (current.rootSessionID) deleteSessionTree(db, current.rootSessionID)
      })
      return current
    })

    function eventSignalData(event: JournalEvent) {
      const signal = event.data?.signal
      if (!signal || typeof signal !== "object" || Array.isArray(signal)) return undefined
      return signal as { id?: unknown; source?: unknown; type?: unknown; dedupeKey?: unknown }
    }

    const ingestSignal = Effect.fn("LoopWorkflow.ingestSignal")(function* (input: IngestSignalInput) {
      const now = input.now ?? Date.now()
      const receivedAt = now
      const source = sanitizeArtifactString(input.source.trim(), maxArtifactConfidenceChars) || "unknown"
      const type = sanitizeArtifactString(input.type.trim(), maxArtifactConfidenceChars) || "event"
      const payloadSummary = sanitizeArtifactString(input.payloadSummary?.trim(), maxArtifactSummaryChars) || `${source}:${type}`
      const dedupeKey = sanitizeArtifactString(input.dedupeKey?.trim(), maxArtifactSummaryChars) || `${source}:${type}:${payloadSummary}`
      const candidates = input.workflowID ? [yield* get(input.workflowID)] : (yield* list())
      const matched = candidates.filter(
        (item) => item.spec.trigger?.mode === "external-signal" && item.state !== "completed" && item.state !== "failed" && item.state !== "stopped",
      )
      const pendingSignal: NormalizedSignal = {
        id: `signal_${ulid().toLowerCase()}`,
        source,
        type,
        dedupeKey,
        payloadSummary,
        links: input.links?.slice(0, 10).map((link) => sanitizeArtifactString(link, maxArtifactSummaryChars) ?? "").filter(Boolean),
        receivedAt,
        matches: matched.map((item) => item.id),
      }
      const deliveries = yield* Effect.forEach(
        matched,
        (workflow) =>
          Effect.sync(() =>
            Database.transaction((db) => {
              const persisted = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, workflow.id)).get()
              if (!persisted) return { status: "ignored" as const }
              const current = fromWorkflowRow(persisted)
               if (
                 current.spec.trigger?.mode !== "external-signal" ||
                 current.state === "completed" ||
                 current.state === "failed" ||
                 current.state === "stopped"
               ) return { status: "ignored" as const }
              const signalEvents = db.select().from(LoopEventTable).where(eq(LoopEventTable.workflow_id, current.id)).all().filter((row) => row.type === "signal")
              const duplicate = signalEvents.find((row) => {
                const existing = eventSignalData(fromEventRow(row))
                return existing?.source === source && existing?.type === type && existing?.dedupeKey === dedupeKey
              })
              if (duplicate) {
                const existing = eventSignalData(fromEventRow(duplicate))
                return {
                  status: "duplicate" as const,
                  workflow: current,
                  signalID: typeof existing?.id === "string" ? existing.id : undefined,
                }
              }
              const maxEvents = positiveInt(input.rateLimit?.maxEvents)
              const windowMs = positiveInt(input.rateLimit?.windowMs)
              if (maxEvents && windowMs) {
                const cutoff = now - windowMs
                const recent = signalEvents.filter((row) => {
                  if (row.time_created < cutoff) return false
                  return eventSignalData(fromEventRow(row))?.source === source
                })
                if (recent.length >= maxEvents) return { status: "rate-limited" as const, workflow: current }
              }
              db.update(LoopWorkflowTable)
                .set({
                  state: current.state === "paused" || current.state === "working" ? current.state : "sleeping",
                  phase: "signal_received",
                  next_wakeup: receivedAt,
                  time_updated: now,
                  data: {
                    spec: current.spec,
                    policy: current.policy,
                    metrics: current.metrics,
                    memory: current.memory,
                    scheduler: schedulerFor(current, { lastWakeAttempt: receivedAt, nextWakeup: receivedAt, lastError: undefined, degraded: false }),
                    evaluatorReason: `External signal ${source}/${type}: ${payloadSummary}`,
                    failureClass: current.failureClass,
                  },
                })
                .where(eq(LoopWorkflowTable.id, current.id))
                .run()
              appendArtifactsInDb(db, [
                {
                  workflowID: current.id,
                  sessionID: current.rootSessionID,
                  kind: "signal",
                  title: `External signal: ${type}`,
                  summary: payloadSummary,
                  source,
                  status: "received",
                  metadata: { signalID: pendingSignal.id, source, type, dedupeKey, links: pendingSignal.links ?? [], receivedAt },
                },
              ])
              const row = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
              const info = fromWorkflowRow(row)
              const event = appendEventInDb(db, {
                workflowID: info.id,
                sessionID: info.rootSessionID,
                type: "signal",
                title: "External signal received",
                summary: payloadSummary,
                 data: { signal: pendingSignal, scheduled: info.nextWakeup === receivedAt },
              }, now)
              return { status: "accepted" as const, workflow: info, event }
            }, { behavior: "immediate" }),
          ),
        { concurrency: 1 },
      )
      const accepted = deliveries.filter((delivery) => delivery.status === "accepted")
      for (const delivery of accepted) {
        yield* publishWorkflow(delivery.workflow)
        yield* publishEvent(delivery.event)
      }
      const duplicates = deliveries.filter((delivery) => delivery.status === "duplicate")
      const rateLimited = deliveries.some((delivery) => delivery.status === "rate-limited")
      const signal = accepted.length || !duplicates[0]?.signalID
        ? pendingSignal
        : { ...pendingSignal, id: duplicates[0].signalID }
      return {
        signal,
        deduped: accepted.length === 0 && duplicates.length > 0,
        rateLimited: accepted.length === 0 && rateLimited,
        matched: deliveries.flatMap((delivery) => delivery.status === "ignored" || delivery.status === "rate-limited" ? [] : [delivery.workflow]),
      }
    })

    const recordValidation = Effect.fn("LoopWorkflow.recordValidation")(function* (input: RecordValidationInput) {
      const current = yield* get(input.id)
      const artifact = Database.transaction((db) => {
        const run = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
        if (!run || run.workflow_id !== current.id || !activeRunStates.has(run.state)) return
        return appendArtifactsInDb(db, [{
          workflowID: current.id,
          runID: input.runID,
          sessionID: current.rootSessionID,
          kind: "command-output",
          title: `Validation: ${input.checkID}`,
          summary: input.summary,
          source: "validation-runner",
          status: input.status,
          contentType: "text/plain",
          text: input.output,
          metadata: {
            checkID: input.checkID,
            command: input.command,
            exitCode: input.exitCode,
            durationMs: input.durationMs,
            timedOut: input.timedOut ?? false,
          },
        }])[0]
      }, { behavior: "immediate" })
      if (!artifact) return yield* Effect.fail(notFound(input.runID))
      return artifact
    })

    const recordReadinessSkip = Effect.fn("LoopWorkflow.recordReadinessSkip")(function* (input: ReadinessSkipInput) {
      const current = yield* get(input.id, input.now)
      const now = input.now ?? Date.now()
      const pendingExternalSignal = current.spec.trigger?.mode === "external-signal" && typeof current.nextWakeup === "number"
      const nextWakeup = nextWakeupAfterRun(current, input.nextWakeup, now, pendingExternalSignal)
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            state: current.state === "paused" ? "paused" : nextWakeup ? "sleeping" : "active",
            phase: current.state === "paused" ? "paused" : nextWakeup ? "readiness_skipped" : "ready",
            next_wakeup: current.state === "paused" ? current.nextWakeup ?? null : nextWakeup ?? null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, {
                lastWakeAttempt: now,
                nextWakeup,
                lastResult: input.reason,
                lastError: undefined,
                degraded: false,
              }),
              evaluatorReason: input.reason,
              failureClass: current.failureClass,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        appendArtifactsInDb(db, [
          {
            workflowID: current.id,
            sessionID: current.rootSessionID,
            kind: "evidence",
            title: "Proactive readiness skipped",
            summary: input.reason,
            source: "readiness",
            status: "skipped",
            metadata: { trigger: input.trigger ?? current.spec.trigger?.mode ?? "manual", nextWakeup: nextWakeup ?? null },
          },
        ])
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: "monitor",
        title: "Loop readiness skipped",
        summary: input.reason,
        data: { trigger: input.trigger ?? info.spec.trigger?.mode ?? "manual", nextWakeup },
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const recordSchedulerFailure = Effect.fn("LoopWorkflow.recordSchedulerFailure")(function* (input: SchedulerFailureInput) {
      const current = yield* get(input.id, input.now)
      if (terminalWorkflowStates.has(current.state)) {
        const latest = Database.use((db) =>
          db
            .select()
            .from(LoopRunTable)
            .where(eq(LoopRunTable.workflow_id, current.id))
            .orderBy(desc(LoopRunTable.time_created))
            .limit(1)
            .get(),
        )
        if (!latest) return yield* Effect.fail(notFound(current.id))
        return fromRunRow(latest)
      }
      const now = input.now ?? Date.now()
      const failureClass = input.failureClass ?? classifyFailure(input.error)
      const nextWakeup = schedulerRetryWakeupFor(current, now)
      const nextState: WorkflowState = nextWakeup ? "sleeping" : "blocked"
      const nextPhase = nextWakeup ? "scheduler_degraded" : "scheduler_blocked"
      const error = sanitizeArtifactString(input.error, maxSchedulerErrorChars) ?? "Unknown scheduler error."
      const evaluatorReason = `Loop scheduler degraded: ${error}`
      const runID = RunID.make()
      const runRow: RunRow = {
        id: runID,
        workflow_id: current.id,
        root_session_id: current.rootSessionID ?? null,
        state: "failed",
        trigger: scheduledRunTrigger(current),
        phase: nextPhase,
        next_wakeup: nextWakeup ?? null,
        time_created: now,
        time_updated: now,
        time_started: now,
        time_ended: now,
        data: {
          evaluatorReason,
          failureClass,
          budget: current.metrics,
          retry: nextWakeup
            ? {
                attempt: 1,
                backoffMs: Math.max(0, nextWakeup - now),
                nextWakeup,
              }
            : undefined,
        },
      }
      const result = Database.transaction((db) => {
        const persisted = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()
        if (!persisted) return undefined
        const persistedInfo = fromWorkflowRow(persisted)
        if (terminalWorkflowStates.has(persistedInfo.state)) return undefined
        db.insert(LoopRunTable).values(runRow).run()
        db.update(LoopWorkflowTable)
          .set({
            state: nextState,
            phase: nextPhase,
            next_wakeup: nextWakeup ?? null,
            time_updated: now,
            data: {
              spec: persistedInfo.spec,
              policy: persistedInfo.policy,
              metrics: persistedInfo.metrics,
              memory: persistedInfo.memory,
              scheduler: schedulerFor(persistedInfo, {
                lastWakeAttempt: now,
                nextWakeup,
                lastRunID: runID,
                lastRunState: "failed",
                lastResult: undefined,
                lastError: error,
                degraded: true,
              }),
              evaluatorReason,
              failureClass,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        appendArtifactsInDb(db, [
          {
            workflowID: current.id,
            runID,
            sessionID: current.rootSessionID,
            kind: "evidence",
            title: "Loop scheduler failure",
            summary: error,
            source: "loop-scheduler",
            status: nextState,
            metadata: { failureClass, nextWakeup: nextWakeup ?? null },
          },
        ])
        const event = appendEventInDb(
          db,
          {
            workflowID: current.id,
            runID,
            sessionID: current.rootSessionID,
            level: "error",
            type: "failed",
            title: "Loop scheduler degraded",
            summary: error,
            data: { failureClass, nextWakeup: nextWakeup ?? null },
          },
          now,
        )
        return {
          workflow: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!,
          run: db.select().from(LoopRunTable).where(eq(LoopRunTable.id, runID)).get()!,
          event,
        }
      }, { behavior: "immediate" })
      if (!result) return yield* Effect.fail(notFound(current.id))
      const workflow = fromWorkflowRow(result.workflow)
      const run = fromRunRow(result.run)
      yield* publishBackgroundForWorkflow(workflow, {
        summary: workflowSummary(workflow.state, workflow.phase),
        error,

      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(result.event)
      return run
    })

    const startRun = Effect.fn("LoopWorkflow.startRun")(function* (input: StartRunInput) {
      let current = yield* get(input.id, input.now)
      if (terminalWorkflowStates.has(current.state)) return yield* Effect.fail(notFound(current.id))
      if (current.state === "blocked" || current.state === "needs_input") {
        return yield* Effect.fail(new NotFoundError({ message: `Loop "${current.name}" is ${current.state}; resolve the blocking condition before starting another run.` }))
      }
      if (!current.rootSessionID) current = yield* activate({ id: current.id, reason: input.reason ?? "Activated for loop run.", now: input.now })
      const now = input.now ?? Date.now()
      if (!canStartScheduledRun(current, now)) {
        return yield* Effect.fail(new NotFoundError({ message: `Loop \"${current.name}\" is sleeping until ${new Date(current.nextWakeup!).toISOString()}.` }))
      }
      const lease = runLease({ holder: input.leaseHolder, policy: current.policy, now })
      const runRow: RunRow = {
        id: RunID.make(),
        workflow_id: current.id,
        root_session_id: current.rootSessionID ?? null,
        state: "working",
        trigger: input.trigger ?? "adaptive",
        phase: "executing",
        next_wakeup: null,
        time_created: now,
        time_updated: now,
        time_started: now,
        time_ended: null,
        data: {
          evaluatorReason: input.reason ?? "Loop run started.",
          budget: current.metrics,
          lease,
        },
      }
      const started = Database.transaction(
        (db) => {
          const existing = db
            .select()
            .from(LoopRunTable)
            .where(eq(LoopRunTable.workflow_id, current.id))
            .orderBy(desc(LoopRunTable.time_created))
            .all()
            .find((run) => activeRunStates.has(run.state))
          if (existing && !runLeaseStale({ run: existing, policy: current.policy, now })) {
            return {
              run: existing,
              workflow: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!,
              acquired: false,
            }
          }
          if (existing) {
            db.update(LoopRunTable)
              .set({
                state: "failed",
                phase: "stale",
                next_wakeup: null,
                time_updated: now,
                time_ended: now,
                data: {
                  ...existing.data,
                  evaluatorReason: `Recovered stale loop run ${existing.id}; its worker process exited or its lease expired before a new run started.`,
                  budget: current.metrics,
                },
              })
              .where(eq(LoopRunTable.id, existing.id))
              .run()
          }
          db.insert(LoopRunTable).values(runRow).run()
          db.update(LoopWorkflowTable)
            .set({
              state: "working",
              phase: "executing",
              next_wakeup: null,
              time_updated: now,
              data: {
                spec: current.spec,
                policy: current.policy,
                metrics: current.metrics,
                memory: current.memory,
                scheduler: schedulerFor(current, {
                  lastWakeAttempt: now,
                  nextWakeup: undefined,
                  lastError: undefined,
                  degraded: false,
                }),
                evaluatorReason: runRow.data.evaluatorReason,
              },
            })
            .where(eq(LoopWorkflowTable.id, current.id))
            .run()
          return {
            run: runRow,
            workflow: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!,
            acquired: true,
          }
        },
        { behavior: "immediate" },
      )
      const workflow = fromWorkflowRow(started.workflow)
      const run = fromRunRow(started.run)
      if (!started.acquired) return run
      const workspaceLease: WorkspaceLease | undefined = yield* createWorkspaceLease(workflow, run.id)
      const persistedRun = persistRunWorkspaceLease(run, workspaceLease)
      yield* publishBackgroundForWorkflow(workflow, {
        state: "working",
        summary: workflowSummary("working", workflow.phase),
      })
      const event = appendEvent({
        workflowID: workflow.id,
        runID: persistedRun.id,
        sessionID: workflow.rootSessionID,
        type: "started",
        title: "Loop run started",
        summary: input.reason ?? `Trigger: ${persistedRun.trigger}`,
        data: workspaceLease
          ? {
              workspaceLease: {
                id: workspaceLease.id,
                mode: workspaceLease.mode,
                path: workspaceLease.path,
                branch: workspaceLease.branch,
                state: workspaceLease.state,
                retention: workspaceLease.retention,
                error: workspaceLease.error,
              },
            }
          : undefined,
      })
      yield* upsertRootThread(workflow, persistedRun.id, workspaceLease)
      yield* publishRun(persistedRun)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return persistedRun
    })

    const completeRun = Effect.fn("LoopWorkflow.completeRun")(function* (input: CompleteRunInput) {
      const current = yield* get(input.id, input.now)
      const ctx = yield* InstanceState.context
      const usageMode = current.spec.usageMode ?? (yield* Effect.promise(() => readBudgetUsageMode(ctx.directory, "api-usage")))
      if (current.state === "completed" || current.state === "stopped" || current.state === "failed") {
        const row = reconcileRunAfterTerminalWorkflow({
          workflow: current,
          runID: input.runID,
          reason: "Ignored late loop run completion because the workflow is already terminal.",
        })
        if (!row) return yield* Effect.fail(notFound(input.runID))
        return fromRunRow(row)
      }
      const now = input.now ?? Date.now()
      const sanitizedCheckpoint = sanitizeCheckpoint(input.checkpoint)
      const sanitizedJudgment = sanitizeJudgment(input.judgment)
      const sanitizedRubricResult = sanitizeRubricResult(input.rubricResult)
      const usage = sanitizeUsage(input.usage)
      const sanitizedReason = sanitizeArtifactString(input.reason, maxArtifactSummaryChars)
      const pendingExternalSignal = current.spec.trigger?.mode === "external-signal" && typeof current.nextWakeup === "number"
      const nextWakeup = nextWakeupAfterRun(current, input.nextWakeup, now, pendingExternalSignal)
      const metrics = addUsageToMetrics({ ...current.metrics, turns: (current.metrics.turns ?? 0) + 1 }, usage)
      const checkpointStatus = input.goalStatus ?? sanitizedCheckpoint?.status
      const completionProposed = checkpointStatus === "complete" || (checkpointStatus === "blocked" && judgmentPassed(sanitizedJudgment))
      const sanitizedGateResults = [
        ...(sanitizeGateResults(input.gateResults) ?? []),
        rubricGate(current.spec.rubric, completionProposed, sanitizedRubricResult),
        costBudgetGate(usageMode === "subscription" ? undefined : current.spec.costBudget, metrics),
      ].filter((gate): gate is SanitizedGateResult => Boolean(gate))
      const budgetMode = current.spec.budgetMode
      const turns = metrics.turns ?? 0
      const reachedMaxTurns = typeof current.policy.maxTurns === "number" && turns >= current.policy.maxTurns
      const independentRequired = requiresIndependentCompletion(current.spec)
      const judgeCompletedGoal = independentRequired && judgmentPassed(sanitizedJudgment) && (checkpointStatus === "complete" || checkpointStatus === "blocked")
      const completionJudged = !independentRequired || judgmentPassed(sanitizedJudgment)
      const gateFailure = completionGateFailureSummary(sanitizedGateResults)
      const gatesPassed = completionGatesPassed(sanitizedGateResults)
       const blockingGate = sanitizedGateResults.find(workflowBlockingGate)
      const gateBlocked = Boolean(blockingGate)
       const scheduledBlocked = checkpointStatus === "blocked" && scheduledMonitor(current.spec) && !gateBlocked && typeof nextWakeup === "number"
      const goalComplete = (checkpointStatus === "complete" || judgeCompletedGoal) && completionJudged && gatesPassed && budgetMode !== "fixed" && budgetMode !== "unbounded-monitor"
      const explicitStop = checkpointStatus === "stop"
      const budgetExhaustedBeforeGoal = budgetMode === "max-goal" && reachedMaxTurns && !goalComplete
      const fixedCompletionRejectedAtLimit = budgetMode === "fixed" && reachedMaxTurns && completionProposed && !gatesPassed
      const budgetExhaustedReason = gateFailure
        ? `Loop reached its maximum iteration budget (${turns}/${current.policy.maxTurns}) before the goal was marked complete because completion gate did not pass (${gateFailure}). Last checkpoint: ${sanitizedReason ?? sanitizedCheckpoint?.summary ?? "no checkpoint summary"}`
        : `Loop reached its maximum iteration budget (${turns}/${current.policy.maxTurns}) before the goal was marked complete. Last checkpoint: ${sanitizedReason ?? sanitizedCheckpoint?.summary ?? "no checkpoint summary"}`
      const computedNext =
        explicitStop
          ? ({ state: "stopped" as const, phase: "stopped", completed: false, nextWakeup: undefined })
          : gateBlocked
            ? ({ state: "blocked" as const, phase: blockingGate?.status === "awaiting_approval" ? "approval_required" : "blocked", completed: false, nextWakeup: undefined })
            : scheduledBlocked
              ? ({ state: "sleeping" as const, phase: "waiting", completed: false, nextWakeup })
              : goalComplete
                ? ({ state: "completed" as const, phase: "completed", completed: true, nextWakeup: undefined })
                : budgetExhaustedBeforeGoal
                  ? ({ state: "blocked" as const, phase: "budget_exhausted", completed: false, nextWakeup: undefined })
              : fixedCompletionRejectedAtLimit
                ? ({ state: "blocked" as const, phase: "completion_gate_failed", completed: false, nextWakeup: undefined })
              : checkpointStatus === "needs_input"
                ? ({ state: "needs_input" as const, phase: "needs_input", completed: false, nextWakeup: undefined })
                : checkpointStatus === "blocked"
                  ? ({ state: "blocked" as const, phase: "blocked", completed: false, nextWakeup: undefined })
                  : pendingExternalSignal
                    ? ({ state: "sleeping" as const, phase: "signal_received", completed: false, nextWakeup })
                    : completionState({ metrics, policy: current.policy, nextWakeup })
      const pauseAfterRun = current.state === "paused" && !computedNext.completed && computedNext.state !== "blocked" && computedNext.state !== "needs_input"
      const next = pauseAfterRun
        ? { state: "paused" as const, phase: "paused", completed: false, nextWakeup: pendingExternalSignal ? current.nextWakeup : undefined }
        : computedNext
      const evaluatorReason = sanitizeArtifactString(
        goalComplete
          ? (sanitizedJudgment?.summary ?? sanitizedReason ?? sanitizedCheckpoint?.summary ?? "Loop goal completed and verified by checkpoint.")
          : explicitStop
            ? (sanitizedReason ?? sanitizedCheckpoint?.summary ?? "Loop checkpoint requested stop.")
            : budgetExhaustedBeforeGoal
              ? budgetExhaustedReason
              : fixedCompletionRejectedAtLimit
                ? `Loop reached its fixed iteration limit, but completion gate did not pass (${gateFailure ?? "unknown gate failure"}).`
              : gateBlocked
                ? (blockingGate?.summary ?? "Loop blocked by policy gate.")
              : checkpointStatus === "complete" && independentRequired && sanitizedJudgment?.status && sanitizedJudgment.status !== "pass"
                ? `Independent evaluator did not accept completion (${sanitizedJudgment.status}): ${sanitizedJudgment.summary ?? sanitizedReason ?? sanitizedCheckpoint?.summary ?? "no evaluator summary"}`
                : checkpointStatus === "complete" && independentRequired && !sanitizedJudgment?.status
                  ? `Independent evaluator did not provide a passing verdict; continuing instead of trusting worker self-completion. Last checkpoint: ${sanitizedReason ?? sanitizedCheckpoint?.summary ?? "no checkpoint summary"}`
                  : checkpointStatus === "complete" && gateFailure
                    ? `Completion gate did not pass (${gateFailure}); continuing instead of marking the loop complete.`
                    : (sanitizedReason ?? sanitizedCheckpoint?.summary ?? "Loop run completed."),
        maxArtifactSummaryChars,
      ) ?? "Loop run completed."
      const artifacts = completionArtifacts({
        ...input,
        checkpoint: sanitizedCheckpoint,
        judgment: sanitizedJudgment,
        rubricResult: sanitizedRubricResult,
        usage,
        gateResults: sanitizedGateResults,
        reason: sanitizedReason,
        rootSessionID: current.rootSessionID,
      })
      const memory = appendRuntimeMemory(current.memory, current.spec, completionMemoryEntries({
        runID: input.runID,
        now,
        checkpointStatus,
        checkpoint: sanitizedCheckpoint,
        judgment: sanitizedJudgment,
        gateResults: sanitizedGateResults,
        goalComplete,
        gateFailure,
        evaluatorReason,
      }))
      const result = Database.transaction((db) => {
        const currentRun = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
        if (!currentRun) return { applied: false as const, row: undefined }
        if (!activeRunStates.has(currentRun.state)) return { applied: false as const, row: currentRun }
        const persistedWorkflow = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()
        if (!persistedWorkflow) return { applied: false as const, row: currentRun }
        const canDefer = next.state === "active" || next.state === "sleeping"
        const queuedSignal =
          persistedWorkflow.data.spec.trigger?.mode === "external-signal" &&
          persistedWorkflow.phase === "signal_received" &&
          typeof persistedWorkflow.next_wakeup === "number"
        const appliedNext = canDefer && persistedWorkflow.state === "paused"
          ? { state: "paused" as const, phase: "paused", completed: false, nextWakeup: persistedWorkflow.next_wakeup ?? undefined }
          : canDefer && queuedSignal
            ? { state: "sleeping" as const, phase: "signal_received", completed: false, nextWakeup: persistedWorkflow.next_wakeup! }
            : next
        const appliedRunState = completedRunStateForWorkflow(appliedNext.state)
        db.update(LoopRunTable)
          .set({
            state: appliedRunState,
            phase: appliedRunState === "completed" ? "completed" : appliedNext.phase,
            next_wakeup: appliedNext.nextWakeup ?? null,
            time_updated: now,
            time_ended: now,
            data: {
              evaluatorReason,
              budget: metrics,
              checkpoint: sanitizedCheckpoint,
              judgment: sanitizedJudgment,
              rubricResult: sanitizedRubricResult,
              usage,
              gateResults: sanitizedGateResults,
              lease: currentRun.data.lease,
              workspaceLease: currentRun.data.workspaceLease,
            },
          })
          .where(eq(LoopRunTable.id, input.runID))
          .run()
        db.update(LoopWorkflowTable)
          .set({
            state: appliedNext.state,
            phase: appliedNext.phase,
            next_wakeup: appliedNext.nextWakeup ?? null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics,
              memory,
              scheduler: schedulerFor(current, {
                lastWakeAttempt: current.scheduler?.lastWakeAttempt ?? now,
                nextWakeup: appliedNext.nextWakeup,
                lastRunID: input.runID,
                lastRunState: appliedRunState,
                lastResult: evaluatorReason,
                lastError: undefined,
                degraded: false,
              }),
              evaluatorReason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        appendArtifactsInDb(db, artifacts)
        return {
          applied: true as const,
          row: db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()!,
          next: appliedNext,
          runState: appliedRunState,
        }
      }, { behavior: "immediate" })
      if (!result.row) return yield* Effect.fail(notFound(input.runID))
      if (!result.applied) return fromRunRow(result.row)
      const appliedNext = result.next
      const appliedRunState = result.runState
      const workflow = yield* get(current.id)
      const run = fromRunRow(result.row)
      yield* publishBackgroundForWorkflow(workflow)
      const event = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        type: "completed",
        title: appliedRunState === "completed" ? "Loop run completed" : `Loop run ${appliedRunState}`,
          summary: goalComplete
            ? checkpointStatus === "complete"
              ? "Loop completed after the goal checkpoint reported success."
              : "Loop completed after the independent evaluator verified the goal."
            : explicitStop
              ? "Loop stopped after the checkpoint requested stop."
              : budgetExhaustedBeforeGoal
                ? gateFailure
                  ? `Loop blocked after reaching its maximum iteration budget (${turns}/${current.policy.maxTurns}) because completion gate did not pass (${gateFailure}).`
                  : `Loop blocked after reaching its maximum iteration budget (${turns}/${current.policy.maxTurns}) before completion.`
                : gateBlocked
                  ? (blockingGate?.summary ?? "Loop blocked by policy gate.")
                : appliedNext.completed
                  ? "Loop completed after reaching its fixed iteration limit."
                  : appliedNext.state === "paused"
                    ? "Loop paused after completing the current run."
                    : evaluatorReason,
        data: {
          nextWakeup: appliedNext.nextWakeup,
          completed: appliedNext.completed,
          goalStatus: checkpointStatus,
          checkpoint: sanitizedCheckpoint,
          judgment: sanitizedJudgment,
          rubricResult: sanitizedRubricResult,
          gateResults: sanitizedGateResults,
          usage,
        },

      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return run
    })

    const failRun = Effect.fn("LoopWorkflow.failRun")(function* (input: FailRunInput) {
      const current = yield* get(input.id, input.now)
      if (current.state === "completed" || current.state === "stopped" || current.state === "failed") {
        const row = reconcileRunAfterTerminalWorkflow({
          workflow: current,
          runID: input.runID,
          reason: "Ignored late loop run failure because the workflow is already terminal.",
        })
        if (!row) return yield* Effect.fail(notFound(input.runID))
        return fromRunRow(row)
      }
      const now = input.now ?? Date.now()
      const metrics = { ...current.metrics, failures: (current.metrics.failures ?? 0) + 1 }
      const failureClass = input.failureClass ?? classifyFailure(input.error)
      const transition = failureTransition({ metrics, failureClass, now })
      const pendingSignal = current.spec.trigger?.mode === "external-signal" && typeof current.nextWakeup === "number"
      const scheduled = pendingSignal && transition.state === "sleeping"
        ? {
            ...transition,
            phase: "signal_received",
            nextWakeup: current.nextWakeup,
            retry: transition.retry ? { ...transition.retry, nextWakeup: current.nextWakeup } : undefined,
          }
        : transition
      const next = current.state === "paused" && scheduled.state === "sleeping"
        ? { ...scheduled, state: "paused" as const, phase: "paused", nextWakeup: scheduled.nextWakeup }
        : scheduled
      const result = Database.transaction((db) => {
        const currentRun = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
        if (!currentRun) return { applied: false as const, row: undefined }
        if (!activeRunStates.has(currentRun.state)) return { applied: false as const, row: currentRun }
        const persistedWorkflow = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()
        if (!persistedWorkflow) return { applied: false as const, row: currentRun }
        const queuedSignal =
          next.state === "sleeping" &&
          persistedWorkflow.data.spec.trigger?.mode === "external-signal" &&
          persistedWorkflow.phase === "signal_received" &&
          typeof persistedWorkflow.next_wakeup === "number"
        const appliedNext = next.state === "sleeping" && persistedWorkflow.state === "paused"
          ? { ...next, state: "paused" as const, phase: "paused", nextWakeup: persistedWorkflow.next_wakeup ?? next.nextWakeup }
          : queuedSignal
            ? {
                ...next,
                phase: "signal_received",
                nextWakeup: persistedWorkflow.next_wakeup!,
                retry: next.retry ? { ...next.retry, nextWakeup: persistedWorkflow.next_wakeup! } : undefined,
              }
            : next
        const appliedRunState = appliedNext.state === "blocked" ? "blocked" as const : appliedNext.state === "needs_input" ? "needs_input" as const : "failed" as const
        db.update(LoopRunTable)
          .set({
            state: appliedRunState,
            phase: appliedNext.phase,
            next_wakeup: appliedNext.nextWakeup ?? null,
            time_updated: now,
            time_ended: now,
            data: {
              evaluatorReason: input.error,
              failureClass,
              budget: metrics,
              lease: currentRun.data.lease,
              retry: appliedNext.retry,
            },
          })
          .where(eq(LoopRunTable.id, input.runID))
          .run()
        db.update(LoopWorkflowTable)
          .set({
            state: appliedNext.state,
            phase: appliedNext.phase,
            next_wakeup: appliedNext.nextWakeup ?? null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics,
              memory: current.memory,
              scheduler: schedulerFor(current, {
                lastWakeAttempt: current.scheduler?.lastWakeAttempt ?? now,
                nextWakeup: appliedNext.nextWakeup,
                lastRunID: input.runID,
                lastRunState: appliedRunState,
                lastResult: input.error,
                lastError: undefined,
                degraded: false,
              }),
              failureClass,
              evaluatorReason: input.error,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return {
          applied: true as const,
          row: db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()!,
          next: appliedNext,
        }
      }, { behavior: "immediate" })
      if (!result.row) return yield* Effect.fail(notFound(input.runID))
      if (!result.applied) return fromRunRow(result.row)
      const appliedNext = result.next
      const workflow = yield* get(current.id)
      const run = fromRunRow(result.row)
      yield* publishBackgroundForWorkflow(workflow, {
        summary: appliedNext.retry ? `Loop retry scheduled after ${appliedNext.retry.backoffMs}ms: ${input.error}` : `Loop ${workflow.state}: ${workflow.phase}`,
        error: appliedNext.retry ? undefined : input.error,
      })
      const event = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        level: appliedNext.retry ? "warning" : "error",
        type: "failed",
        title: appliedNext.retry ? "Loop run retry scheduled" : "Loop run failed",
        summary: appliedNext.retry
          ? `Classified as ${failureClass}; retry ${appliedNext.retry.attempt}/${maxFailureRetries} scheduled for ${new Date(appliedNext.retry.nextWakeup ?? appliedNext.nextWakeup ?? Date.now()).toISOString()}. ${input.error}`
          : `Classified as ${failureClass}. ${input.error}`,
        data: {
          failureClass,
          retry: appliedNext.retry,
          nextWakeup: appliedNext.nextWakeup,
        },
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return run
    })

    const runOnce = Effect.fn("LoopWorkflow.runOnce")(function* (input: RunOnceInput) {
      let current = yield* get(input.id, input.now)
      if (terminalWorkflowStates.has(current.state)) return yield* Effect.fail(notFound(current.id))
      if (!current.rootSessionID) current = yield* activate({ id: current.id, reason: "Activated for run once.", now: input.now })
      if (current.state === "working") return yield* Effect.fail(new NotFoundError({ message: `Loop ${current.id} already has an active run.` }))
      if (current.state !== "active" && current.state !== "sleeping") {
        return yield* Effect.fail(new NotFoundError({ message: `Loop ${current.id} is ${current.state}; run-once is available only while active or sleeping.` }))
      }
      const now = input.now ?? Date.now()
      const result = Database.transaction((db) => {
        const persistedRow = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()
        if (!persistedRow) return { status: "missing" as const }
        const persisted = fromWorkflowRow(persistedRow)
        const activeRun = db
          .select()
          .from(LoopRunTable)
          .where(eq(LoopRunTable.workflow_id, persisted.id))
          .orderBy(desc(LoopRunTable.time_created))
          .all()
          .find((run) => activeRunStates.has(run.state))
        if (persisted.state === "working" || activeRun) return { status: "busy" as const, workflow: persisted }
        if (persisted.state !== "active" && persisted.state !== "sleeping") return { status: "unavailable" as const, workflow: persisted }
        const evaluatorReason = `Loop run was not dispatched because the loop runner service is unavailable.${input.reason ? ` ${input.reason}` : ""}`
        const runID = RunID.make()
        const runRow: RunRow = {
          id: runID,
          workflow_id: persisted.id,
          root_session_id: persisted.rootSessionID ?? null,
          state: "blocked",
          trigger: "run-once",
          phase: "dispatcher_unavailable",
          next_wakeup: null,
          time_created: now,
          time_updated: now,
          time_started: now,
          time_ended: now,
          data: {
            evaluatorReason,
            failureClass: "environment",
            budget: persisted.metrics,
          },
        }
        db.insert(LoopRunTable).values(runRow).run()
        db.update(LoopWorkflowTable)
          .set({
            state: "blocked",
            phase: "dispatcher_unavailable",
            next_wakeup: null,
            time_updated: now,
            data: {
              spec: persisted.spec,
              policy: persisted.policy,
              metrics: persisted.metrics,
              memory: persisted.memory,
              scheduler: schedulerFor(persisted, {
                lastWakeAttempt: now,
                nextWakeup: undefined,
                lastRunID: runID,
                lastRunState: "blocked",
                lastResult: undefined,
                lastError: evaluatorReason,
                degraded: true,
              }),
              evaluatorReason,
              failureClass: "environment",
            },
          })
          .where(eq(LoopWorkflowTable.id, persisted.id))
          .run()
        appendArtifactsInDb(db, [{
          workflowID: persisted.id,
          runID,
          sessionID: persisted.rootSessionID,
          kind: "evidence",
          title: "Loop execution blocked",
          summary: evaluatorReason,
          source: "loop-dispatcher",
          status: "blocked",
          metadata: { failureClass: "environment", reason: input.reason },
        }])
        return {
          status: "blocked" as const,
          workflowRow: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, persisted.id)).get()!,
          runRow,
        }
      }, { behavior: "immediate" })
      if (result.status === "missing") return yield* Effect.fail(notFound(current.id))
      if (result.status === "busy") return yield* Effect.fail(new NotFoundError({ message: `Loop ${current.id} already has an active run.` }))
      if (result.status === "unavailable") {
        return yield* Effect.fail(new NotFoundError({ message: `Loop ${current.id} is ${result.workflow.state}; run-once is available only while active or sleeping.` }))
      }
      const workflow = fromWorkflowRow(result.workflowRow)
      const run = fromRunRow(result.runRow)
      yield* publishBackgroundForWorkflow(workflow)
      const blocked = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        level: "error",
        type: "failed",
        title: "Loop execution blocked",
        summary: run.evaluatorReason ?? "Loop runner service is unavailable.",
        data: { failureClass: run.failureClass, nextWakeup: run.nextWakeup },
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(blocked)
      return run
    })

    return Service.of({
      list,
      listGlobal,
      listGlobalPage,
      due,
      get,
      snapshot,
      events,
      createDraft,
      activate,
      startRun,
      recordReadinessSkip,
      recordSchedulerFailure,
      ingestSignal,
      recordValidation,
      completeRun,
      failRun,
      pause,
      resume,
      updateAgent,
      override,
      stop,
      delete: deleteWorkflow,
      runOnce,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provideMerge(Worktree.defaultLayer)),
)

export * as LoopWorkflow from "./loop"
