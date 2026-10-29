import { z } from "zod"
import { SessionId, WorkflowId } from "./ids"
import { LoopGate } from "./loops"
import { ModelChoice } from "./queries"
import { lazySchema, lazyValue } from "./lazy"

/** Plan-local name of a task, criterion or check (not a global id). */
export const WorkflowSlug = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)
export type WorkflowSlug = z.infer<typeof WorkflowSlug>

/** Name of a saved plan or contract (`workflows/<name>.json`, `contracts/<name>.json`): same rule as recipes. */
export const WorkflowName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/)
export type WorkflowName = z.infer<typeof WorkflowName>

const Permission = z.enum(["ask", "edits", "full"])
// Queries also refer to workflow summaries through events; defer this shared schema across that cycle.
// A wrapper schema (lazy, pipe, optional) stays eager: JSON Schema generation finds it by identity, which a stand-in breaks (lazy.ts).
const WorkflowModelChoice = z.lazy(() => ModelChoice)
export const WorkflowEngineId = z.string().regex(/^(native|claude|codex|pi|acp:[a-zA-Z0-9_.-]{1,64})$/)

export const WorkflowPermissionPolicy = lazySchema(() => z.strictObject({
  mode: z.enum(["normal", "report-only", "custom"]).default("normal"),
  allowedTools: z.array(z.string().min(1).max(100)).max(100).optional(),
  approvalRequiredFor: z.array(z.string().min(1).max(100)).max(100).optional(),
  approvedActions: z.array(z.string().min(1).max(100)).max(100).optional(),
  allowEdits: z.boolean().optional(),
  allowMutatingCommands: z.boolean().optional(),
  allowExternalSend: z.boolean().optional(),
}))
export type WorkflowPermissionPolicy = z.infer<typeof WorkflowPermissionPolicy>

export const WorkflowWorkspacePolicy = lazySchema(() => z.strictObject({ mode: z.enum(["in-place", "read-only", "per-run-worktree", "per-loop-worktree"]) }))
export type WorkflowWorkspacePolicy = z.infer<typeof WorkflowWorkspacePolicy>

/** Tokens include input + output (reasoning/cache are subsets); maxCost is USD. Limits accumulate across retries. */
export const WorkflowTaskBudget = lazySchema(() => z.strictObject({
  maxTurns: z.number().int().min(0).max(1_000).optional(),
  maxRuntimeMs: z.number().int().min(0).max(86_400_000).optional(),
  maxTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  maxCost: z.number().finite().min(0).max(1_000_000).optional(),
  maxChildren: z.number().int().min(0).max(32).optional(),
  maxDepth: z.number().int().min(0).max(8).optional(),
}))
export type WorkflowTaskBudget = z.infer<typeof WorkflowTaskBudget>

export const WorkflowTaskUsage = lazySchema(() => z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative().optional(),
  costUnknown: z.boolean().optional(),
}))
export type WorkflowTaskUsage = z.infer<typeof WorkflowTaskUsage>

/** Frozen effective settings, including the actual workspace. Present only on newly routed tasks. */
export const WorkflowTaskExecution = lazySchema(() => z.strictObject({
  directory: z.string().min(1).max(4096),
  workspace: WorkflowWorkspacePolicy,
  permission: Permission,
  readOnly: z.boolean(),
  model: WorkflowModelChoice.optional(),
  engine: WorkflowEngineId.optional(),
  agent: z.string().min(1).max(64).optional(),
  permissions: WorkflowPermissionPolicy.optional(),
  budget: WorkflowTaskBudget.optional(),
}))
export type WorkflowTaskExecution = z.infer<typeof WorkflowTaskExecution>

const routing = lazyValue(() => ({
  model: WorkflowModelChoice.optional(),
  agent: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
  permission: Permission.optional(),
  permissions: WorkflowPermissionPolicy.optional(),
  workspace: WorkflowWorkspacePolicy.optional(),
  budget: WorkflowTaskBudget.optional(),
}))

export const WorkflowArtifactSelector = lazySchema(() => z.strictObject({
  taskId: WorkflowSlug,
  path: z.string().max(200).optional(),
  projection: z.string().max(200).optional(),
  required: z.boolean().optional(),
}))
export type WorkflowArtifactSelector = z.infer<typeof WorkflowArtifactSelector>

export const WorkflowOutputContract = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), maxChars: z.number().int().min(1).max(8_000).optional() }),
  z.strictObject({ kind: z.literal("json"), schema: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ kind: z.literal("artifact"), artifactKind: WorkflowName, schema: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ kind: z.literal("none") }),
]))
export type WorkflowOutputContract = z.infer<typeof WorkflowOutputContract>

export const WorkflowBarrier = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("quorum"), quorum: z.number().int().min(1).max(32) }),
  z.strictObject({ kind: z.literal("best-effort") }),
  z.strictObject({ kind: z.literal("condition"), expression: z.string().trim().min(1).max(200) }),
]))
export type WorkflowBarrier = z.infer<typeof WorkflowBarrier>

export const WorkflowPhase = lazySchema(() => z.strictObject({
  id: WorkflowSlug,
  title: z.string().min(1).max(80),
  tasks: z.array(WorkflowSlug).min(1).max(32),
  barrier: WorkflowBarrier.default({ kind: "all" }),
}))
export type WorkflowPhase = z.infer<typeof WorkflowPhase>

/**
 * Why a task attempt failed, for retry policies. Budget failures are never retried. A host check or an
 * output contract that fails is `quality`; a turn that errors or times out is `transient`; a task that cannot be
 * routed (model, worktree) is `environment`; a missing input or a stop the model asks for is `terminal`.
 */
export const WorkflowFailureClass = z.enum(["transient", "environment", "policy", "quality", "budget", "user_input", "terminal"])
export type WorkflowFailureClass = z.infer<typeof WorkflowFailureClass>

/** A failed attempt starts again (same session for agents) while attempts remain. `maxAttempts` counts every start, the first included. */
export const WorkflowRetryPolicy = lazySchema(() => z.strictObject({
  maxAttempts: z.number().int().min(1).max(6),
  backoffMs: z.number().int().min(0).max(3_600_000).default(0),
  /** Default: transient and environment failures only. */
  retryOn: z.array(WorkflowFailureClass).min(1).max(7).default(["transient", "environment"]),
}))
export type WorkflowRetryPolicy = z.infer<typeof WorkflowRetryPolicy>

/** An agent task runs a prompt in its own child session. `read` = plan mode (cannot change anything); `work` = the workflow's permission. */
export const WorkflowAgentTaskSpec = lazySchema(() => z.strictObject({
  kind: z.literal("agent"),
  id: WorkflowSlug,
  title: z.string().min(1).max(80),
  prompt: z.string().min(1).max(8_000),
  needs: z.array(WorkflowSlug).max(8).default([]),
  mode: z.enum(["read", "work"]).default("work"),
  timeoutMinutes: z.number().int().min(1).max(240).optional(),
  retry: WorkflowRetryPolicy.optional(),
  ...routing(),
  /** The engine this task's model runs on (`native`, `claude`, `codex`, `pi`, `acp:<name>`); the model must belong to it. */
  engine: WorkflowEngineId.optional(),
  allowedTools: WorkflowPermissionPolicy.shape.allowedTools,
  inputs: z.array(WorkflowArtifactSelector).max(8).optional(),
  output: WorkflowOutputContract.optional(),
}))
export type WorkflowAgentTaskSpec = z.infer<typeof WorkflowAgentTaskSpec>

/** A check task runs one host command (plain argv, no model, no tokens). */
export const WorkflowCheckTaskSpec = lazySchema(() => z.strictObject({
  kind: z.literal("check"),
  id: WorkflowSlug,
  title: z.string().min(1).max(80),
  command: z.string().min(1).max(300),
  needs: z.array(WorkflowSlug).max(8).default([]),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
  workspace: WorkflowWorkspacePolicy.optional(),
  retry: WorkflowRetryPolicy.optional(),
}))
export type WorkflowCheckTaskSpec = z.infer<typeof WorkflowCheckTaskSpec>

/**
 * A human task waits for the user: it needs input as soon as its needs are done, uses no session or model, and does not
 * count against the concurrency cap. The user approves it (an optional note becomes its text output) or rejects it
 * (the task fails). An approval gate before the work is a human task the other tasks need or an earlier phase.
 */
export const WorkflowHumanTaskSpec = lazySchema(() => z.strictObject({
  kind: z.literal("human"),
  id: WorkflowSlug,
  title: z.string().min(1).max(80),
  /** What the user is asked to decide or provide. */
  prompt: z.string().min(1).max(8_000),
  needs: z.array(WorkflowSlug).max(8).default([]),
}))
export type WorkflowHumanTaskSpec = z.infer<typeof WorkflowHumanTaskSpec>

/** One node of the plan. Graph rules (unique ids, known needs, no cycles, argv-only commands) are checked by `validatePlan`. */
export const WorkflowMapTaskSpec = lazySchema(() => z.strictObject({
  kind: z.literal("map"),
  id: WorkflowSlug,
  title: z.string().min(1).max(80),
  needs: z.array(WorkflowSlug).max(8).default([]),
  map: z.strictObject({
    source: WorkflowArtifactSelector,
    maxItems: z.number().int().min(1).max(16),
    taskTemplate: WorkflowAgentTaskSpec.omit({ kind: true, id: true, needs: true }),
  }),
  workspace: WorkflowWorkspacePolicy.optional(),
}))
export type WorkflowMapTaskSpec = z.infer<typeof WorkflowMapTaskSpec>

export const WorkflowTaskSpec = lazySchema(() => z.discriminatedUnion("kind", [WorkflowAgentTaskSpec, WorkflowCheckTaskSpec, WorkflowMapTaskSpec, WorkflowHumanTaskSpec]))
export type WorkflowTaskSpec = z.infer<typeof WorkflowTaskSpec>

export const ContractCriterion = lazySchema(() => z.strictObject({
  id: WorkflowSlug,
  text: z.string().min(1).max(300),
  /** false = advisory: reported, never blocks. */
  required: z.boolean().default(true),
  /** Tasks re-run (with their dependents) when this criterion fails. */
  owners: z.array(WorkflowSlug).max(8).optional(),
}))
export type ContractCriterion = z.infer<typeof ContractCriterion>

export const ContractCheck = lazySchema(() => z.strictObject({
  id: WorkflowSlug,
  command: z.string().min(1).max(300),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
  /** Criteria this check proves by itself; the auditor is not asked about them. */
  covers: z.array(WorkflowSlug).max(12).optional(),
  /** Repair owners when this check fails (else the criteria it covers decide). */
  owners: z.array(WorkflowSlug).max(8).optional(),
}))
export type ContractCheck = z.infer<typeof ContractCheck>

/** The completion contract: what must be true for the workflow to count as done, and how that is judged. */
export const WorkflowContract = lazySchema(() => z.strictObject({
  criteria: z.array(ContractCriterion).min(1).max(12),
  checks: z.array(ContractCheck).max(5).default([]),
  /** auto = ask the auditor only for required criteria no check covers; independent = always audit; none = explicitly unverified. */
  audit: z.enum(["auto", "independent", "none"]).default("auto"),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  maxAudits: z.number().int().min(1).max(3).default(2),
}))
export type WorkflowContract = z.infer<typeof WorkflowContract>

/**
 * Bounds on what the run's evidence ledger keeps (events and artifacts; the completion receipt always stays). Applied each time the
 * ledger is written, oldest first; an entry dropped this way marks the ledger as truncated.
 */
export const WorkflowRetention = lazySchema(() => z.strictObject({
  maxArtifacts: z.number().int().min(0).max(100_000).optional(),
  maxAgeMs: z.number().int().min(0).max(31_536_000_000).optional(),
  maxBytes: z.number().int().min(0).max(1_000_000_000).optional(),
}))
export type WorkflowRetention = z.infer<typeof WorkflowRetention>

/** Hard caps a script declares in `meta.budget` and the engine enforces; absent keys mean the built-in default. */
export const WorkflowScriptBudget = lazySchema(() => z.strictObject({
  agents: z.number().int().min(1).max(200).optional(),
  tokens: z.number().int().min(1).max(1_000_000_000).optional(),
  usd: z.number().finite().min(0).max(1_000_000).optional(),
  minutes: z.number().int().min(1).max(1_440).optional(),
}))
export type WorkflowScriptBudget = z.infer<typeof WorkflowScriptBudget>

/** The pure-literal `export const meta` of a script: read without running it. */
export const WorkflowScriptMeta = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).default(""),
  phases: z.array(z.strictObject({ title: z.string().min(1).max(80), detail: z.string().max(300).optional() })).max(16).default([]),
  budget: WorkflowScriptBudget.optional(),
  contract: z.union([WorkflowContract, WorkflowName]).optional(),
  permission: Permission.optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
}))
export type WorkflowScriptMeta = z.infer<typeof WorkflowScriptMeta>

export const WORKFLOW_SCRIPT_MAX_BYTES = 48 * 1024
export const WORKFLOW_SCRIPT_MAX_AGENTS = 200
/** Agent calls a script may make without declaring `meta.budget`. */
export const WORKFLOW_SCRIPT_UNDECLARED_AGENTS = 10

/** Where a script came from decides how it is trusted: model-written, typed-in and file scripts always get an approval; project and package ones also need a trusted project. */
export const WorkflowScriptOrigin = z.enum(["model", "file", "inline", "user", "project", "package"])
export type WorkflowScriptOrigin = z.infer<typeof WorkflowScriptOrigin>

/** A script frozen into a plan: the source, its SHA-256, the parsed meta and the arguments it was started with. */
export const WorkflowScript = lazySchema(() => z.strictObject({
  source: z.string().min(1).max(WORKFLOW_SCRIPT_MAX_BYTES),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  meta: WorkflowScriptMeta,
  args: z.record(z.string(), z.unknown()).optional(),
  origin: WorkflowScriptOrigin,
}))
export type WorkflowScript = z.infer<typeof WorkflowScript>

/** What `workflow.start` and `preview` accept for a script: its source, or the name of a saved one (`workflows/<name>.js` in a layer). */
export const WorkflowScriptInput = lazySchema(() => z.union([
  z.strictObject({ script: z.string().min(1).max(WORKFLOW_SCRIPT_MAX_BYTES), args: z.record(z.string(), z.unknown()).optional(), origin: WorkflowScriptOrigin.optional() }),
  z.strictObject({ scriptRef: WorkflowName, args: z.record(z.string(), z.unknown()).optional() }),
]))
export type WorkflowScriptInput = z.infer<typeof WorkflowScriptInput>

export const WorkflowPlan = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(8_000),
  tasks: z.array(WorkflowTaskSpec).min(1).max(32),
  /** Inline contract, or the name of a `contracts/<name>.json` in an extension layer. Omitted = no verification (shown as such). */
  contract: z.union([WorkflowContract, WorkflowName]).optional(),
  /** A request, never a grant: applied = min(this, what the user granted at start). */
  permission: Permission.optional(),
  maxConcurrent: z.number().int().min(1).max(4).optional(),
  maxRuntimeMinutes: z.number().int().min(1).max(1_440).optional(),
  model: routing().model,
  agent: routing().agent,
  permissions: routing().permissions,
  workspace: routing().workspace,
  budget: routing().budget,
  phases: z.array(WorkflowPhase).min(1).max(16).optional(),
  overlapPolicy: z.enum(["skip", "queue", "replace"]).optional(),
  overlapKey: WorkflowName.optional(),
  retention: WorkflowRetention.optional(),
}))

/**
 * A script plan: no static tasks (the script's agent calls become tasks of the run as it makes them), up to 16 concurrent, and the
 * script frozen in (source, SHA-256, meta, args, origin). It shares every other field with a static plan.
 */
export const WorkflowScriptPlan = lazySchema(() => WorkflowPlan.extend({
  tasks: z.array(WorkflowTaskSpec).max(0),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  script: WorkflowScript,
}))

/** What a run or a saved revision holds: a static plan or a script plan. */
export const WorkflowAnyPlan = lazySchema(() => z.union([WorkflowPlan, WorkflowScriptPlan]) as unknown as z.ZodType<WorkflowPlan>)

/** Static or script plan (a static plan's `script` is always absent). */
export type WorkflowPlan = Omit<z.infer<typeof WorkflowPlan>, "script"> & { script?: WorkflowScript | undefined }

/** A saved plan addressed by name instead of inline. */
export const WorkflowRef = lazySchema(() => z.strictObject({ ref: WorkflowName }))
export type WorkflowRef = z.infer<typeof WorkflowRef>

export const WorkflowDefinitionId = z.string().regex(/^wfd_[a-zA-Z0-9_-]{1,80}$/)
export const WorkflowRevisionId = z.string().regex(/^wfr_[a-zA-Z0-9_-]{1,80}$/)
export const WorkflowRevisionRef = lazySchema(() => z.union([
  z.strictObject({ definitionId: WorkflowDefinitionId }),
  z.strictObject({ revisionId: WorkflowRevisionId }),
]))

/** What `workflow.start` and `workflow.preview` accept as the plan. */
export const WorkflowPlanInput = lazySchema(() => z.union([WorkflowPlan, WorkflowRef, WorkflowRevisionRef, WorkflowScriptInput]))
export type WorkflowPlanInput = z.infer<typeof WorkflowPlanInput>

/** The plan input of the static workflow tools: no script form, so their schema (and context cost) is what it always was. */
export const WorkflowStaticPlanInput = lazySchema(() => z.union([WorkflowPlan, WorkflowRef, WorkflowRevisionRef]))

export const WorkflowDefinition = lazySchema(() => z.strictObject({
  definitionId: WorkflowDefinitionId,
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(""),
  source: z.enum(["session-generated", "saved", "template", "package", "manual"]).default("manual"),
  saved: z.boolean(),
  currentRevision: z.number().int().positive(),
  currentRevisionId: WorkflowRevisionId,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  ownerSessionId: SessionId.optional(),
}))
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>

export const WorkflowRevision = lazySchema(() => z.strictObject({
  definitionId: WorkflowDefinitionId,
  revisionId: WorkflowRevisionId,
  revision: z.number().int().positive(),
  plan: WorkflowAnyPlan,
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  immutable: z.literal(true),
  createdAt: z.number().int().nonnegative(),
  restPlan: z.record(z.string(), z.unknown()).optional(),
}))
export type WorkflowRevision = z.infer<typeof WorkflowRevision>
export type WorkflowRevisionReceipt = WorkflowRevision & { definition: WorkflowDefinition }

/**
 * pending → running → done | failed | stopped · needs_input: the running task's session waits on a request ·
 * skipped: a task it needs failed, was skipped or stopped.
 */
export const WorkflowTaskState = z.enum(["pending", "running", "needs_input", "done", "failed", "skipped", "stopped"])
export type WorkflowTaskState = z.infer<typeof WorkflowTaskState>

/** verifying: every task is done and the contract is being checked · blocked: the contract could not be settled (resume re-verifies, accept overrides). */
export const WorkflowRunState = z.enum(["running", "needs_input", "verifying", "paused", "completed", "failed", "blocked", "stopped", "queued"])
export type WorkflowRunState = z.infer<typeof WorkflowRunState>

export const WorkflowTask = lazySchema(() => z.strictObject({
  id: WorkflowSlug,
  title: z.string().max(80),
  kind: z.enum(["agent", "check", "map", "human"]),
  mode: z.enum(["read", "work"]).optional(),
  needs: z.array(WorkflowSlug).max(8),
  state: WorkflowTaskState,
  /** Starts of this task (automatic retries, manual retries and repairs all count). */
  attempt: z.number().int().min(0).max(6),
  /** A pending task waiting out its retry backoff does not start before this time. */
  retryAt: z.number().int().nonnegative().optional(),
  sessionId: SessionId.optional(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  /** The last answer, clipped; the transcript holds the rest. */
  result: z.string().max(1_500).optional(),
  /** Why the task failed, was skipped or stopped. */
  reason: z.string().max(500).optional(),
  /** Rework note, cleared when consumed. */
  feedback: z.string().max(4_000).optional(),
  /** Title of the tool in flight, for display only. */
  latest: z.string().max(120).optional(),
  execution: WorkflowTaskExecution.optional(),
  usage: WorkflowTaskUsage.optional(),
  phaseId: WorkflowSlug.optional(),
  mapParentId: WorkflowSlug.optional(),
  mapIndex: z.number().int().min(0).max(15).optional(),
  mapItem: z.string().max(8_000).optional(),
  mapRetired: z.boolean().optional(),
  output: z.strictObject({ kind: z.enum(["text", "json", "artifact"]), value: z.string().max(8_000), artifactKind: WorkflowName.optional() }).optional(),
  expanded: z.boolean().optional(),
  /** Script runs: the call this task answers (hash of prompt, options and occurrence), its shown label and phase title. */
  scriptKey: z.string().min(1).max(80).optional(),
  label: z.string().max(80).optional(),
  phase: z.string().max(80).optional(),
  /** Script agents: the engine and model the call asked for, shown in the row. */
  engine: WorkflowEngineId.optional(),
  modelId: z.string().max(100).optional(),
  /** Runs in its own worktree: it does not hold the directory's single-writer slot. */
  isolated: z.boolean().optional(),
}))
export type WorkflowTask = z.infer<typeof WorkflowTask>

/** One verification round: the host checks, the auditor's judgment and the per-criterion outcome. */
export const WorkflowVerification = lazySchema(() => z.strictObject({
  round: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  gates: z.array(LoopGate).max(10),
  audit: z
    .strictObject({
      verdict: z.enum(["pass", "fail"]),
      sessionId: SessionId,
      /** Read tool calls the auditor made; none voids the verdict. */
      inspections: z.number().int().nonnegative(),
      /** True when the workspace differed after the audit: the verdict is void. */
      workspaceChanged: z.boolean().optional(),
      findings: z.string().max(4_000),
      criteria: z.array(z.strictObject({ id: WorkflowSlug, status: z.enum(["pass", "fail", "unsure"]), evidence: z.string().max(500) })).max(12),
    })
    .optional(),
  criteria: z.array(z.strictObject({ id: WorkflowSlug, status: z.enum(["pass", "fail", "unsure", "unverified"]), by: z.enum(["check", "audit", "none"]) })).max(12),
  accepted: z.boolean(),
}))
export type WorkflowVerification = z.infer<typeof WorkflowVerification>

const Override = lazySchema(() => z.strictObject({ reason: z.string().min(1).max(500), at: z.number().int().nonnegative() }))

/**
 * What a script run keeps in its row (the journal holds the rest): whether its host process runs, how many agent calls it
 * made, where it is, its log tail and result. `budget` replaces the declared caps once the user raised them.
 */
export const WorkflowScriptState = lazySchema(() => z.strictObject({
  host: z.enum(["idle", "running", "done", "failed"]),
  /** Agent calls the script made (each call key counts once, across replays). */
  calls: z.number().int().nonnegative(),
  phase: z.string().max(80).optional(),
  logCount: z.number().int().nonnegative(),
  logs: z.array(z.string().max(200)).max(10),
  result: z.string().max(4_000).optional(),
  error: z.string().max(500).optional(),
  budget: WorkflowScriptBudget.optional(),
  /** Times the host process started (a restart or a resume replays the journal). */
  starts: z.number().int().nonnegative(),
}))
export type WorkflowScriptState = z.infer<typeof WorkflowScriptState>

/** The stored record of one workflow run: one bounded JSON row (§3.5). The plan is frozen at start, contract included. */
export const WorkflowRun = lazySchema(() => z.strictObject({
  workflowId: WorkflowId,
  name: z.string().max(120),
  directory: z.string().max(4096),
  objective: z.string().max(8_000),
  plan: WorkflowAnyPlan,
  planHash: z.string().length(64),
  /** Applied permission: min(plan request, what the user granted). */
  permission: Permission,
  state: WorkflowRunState,
  reason: z.string().max(500).optional(),
  rootSessionId: SessionId,
  originSessionId: SessionId.optional(),
  tasks: z.array(WorkflowTask).max(256),
  verifications: z.array(WorkflowVerification).max(6),
  repairs: z.number().int().min(0).max(5),
  override: Override.optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
  definitionId: WorkflowDefinitionId.optional(),
  revisionId: WorkflowRevisionId.optional(),
  revision: z.number().int().positive().optional(),
  queuedBehind: WorkflowId.optional(),
  queuedAfter: z.array(WorkflowId).max(16).optional(),
  permissionMode: WorkflowPermissionPolicy.shape.mode.unwrap().optional(),
  permissionReason: z.string().max(500).optional(),
  sessionPermission: Permission.optional(),
  startKey: z.string().min(1).max(200).optional(),
  loopId: z.string().min(1).max(200).optional(),
  loopRunId: z.string().min(1).max(200).optional(),
  script: WorkflowScriptState.optional(),
}))
export type WorkflowRun = z.infer<typeof WorkflowRun>

/** Upper bound of one stored run (P11). */
export const MAX_WORKFLOW_RUN_BYTES = 160 * 1024

const SUMMARY_TEXT_CHARS = 200
const SUMMARY_OBJECTIVE_CHARS = 500

/** The contract as clients list it: the counts and modes; the criteria and checks come with `workflow.get`. */
export const WorkflowContractSummary = lazySchema(() => z.strictObject({
  criteria: z.number().int().min(1).max(12),
  checks: z.number().int().min(0).max(5),
  audit: WorkflowContract.shape.audit,
  maxRepairs: WorkflowContract.shape.maxRepairs,
  maxAudits: WorkflowContract.shape.maxAudits,
}))
export type WorkflowContractSummary = z.infer<typeof WorkflowContractSummary>

/** A task as listed: no `result` or `feedback` (they come with `workflow.get`), `reason` clipped. */
export const WorkflowTaskSummary = lazySchema(() => WorkflowTask.omit({ result: true, reason: true, feedback: true, output: true, mapItem: true }).extend({
  reason: z.string().max(SUMMARY_TEXT_CHARS).optional(),
  outputKind: z.enum(["text", "json", "artifact"]).optional(),
}))
export type WorkflowTaskSummary = z.infer<typeof WorkflowTaskSummary>

/** A script run as clients list it: phases with progress, the effective caps, live usage and the log tail. Finished tasks beyond the newest 48 are counted, not listed. */
export const WorkflowScriptSummary = lazySchema(() => z.strictObject({
  hash: z.string().length(64),
  origin: WorkflowScriptOrigin,
  host: WorkflowScriptState.shape.host,
  calls: z.number().int().nonnegative(),
  phase: z.string().max(80).optional(),
  phases: z.array(z.strictObject({ title: z.string().max(80), detail: z.string().max(300).optional(), state: z.enum(["pending", "running", "done", "blocked"]), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() })).max(24),
  budget: WorkflowScriptBudget,
  usage: z.strictObject({
    agents: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative().optional(),
    /** Per engine, for calls that named one: agent calls and tokens. */
    engines: z.record(z.string(), z.strictObject({ agents: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })).optional(),
  }),
  counts: z.strictObject({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), done: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  omitted: z.number().int().nonnegative(),
  logs: z.array(z.string().max(200)).max(10),
  result: z.string().max(500).optional(),
  error: z.string().max(500).optional(),
}))
export type WorkflowScriptSummary = z.infer<typeof WorkflowScriptSummary>

/** The caps a script run is held to now: the raised ones, else the declared ones, else the built-in defaults. */
export function effectiveScriptBudget(run: Pick<WorkflowRun, "plan" | "script">): WorkflowScriptBudget {
  const declared = run.plan.script?.meta.budget
  const raised = run.script?.budget
  const agents = raised?.agents ?? declared?.agents ?? WORKFLOW_SCRIPT_UNDECLARED_AGENTS
  return { agents: Math.min(agents, WORKFLOW_SCRIPT_MAX_AGENTS), ...((raised?.tokens ?? declared?.tokens) !== undefined ? { tokens: (raised?.tokens ?? declared?.tokens)! } : {}), ...((raised?.usd ?? declared?.usd) !== undefined ? { usd: (raised?.usd ?? declared?.usd)! } : {}), ...((raised?.minutes ?? declared?.minutes) !== undefined ? { minutes: (raised?.minutes ?? declared?.minutes)! } : {}) }
}

/** What `workflow.list` and `workflow.changed` carry: the run without the plan, feedback or old rounds. */
export const WorkflowSummary = lazySchema(() => z.strictObject({
  workflowId: WorkflowId,
  name: WorkflowRun.shape.name,
  directory: WorkflowRun.shape.directory,
  objective: z.string().max(SUMMARY_OBJECTIVE_CHARS),
  planHash: WorkflowRun.shape.planHash,
  contract: WorkflowContractSummary.optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  maxRuntimeMinutes: WorkflowPlan.shape.maxRuntimeMinutes,
  permission: WorkflowRun.shape.permission,
  state: WorkflowRunState,
  reason: WorkflowRun.shape.reason,
  rootSessionId: SessionId,
  originSessionId: SessionId.optional(),
  tasks: z.array(WorkflowTaskSummary).max(256),
  /** Rounds run so far; only the last one travels. */
  rounds: z.number().int().min(0).max(6),
  verification: WorkflowVerification.optional(),
  repairs: WorkflowRun.shape.repairs,
  override: Override.optional(),
  startedAt: WorkflowRun.shape.startedAt,
  endedAt: WorkflowRun.shape.endedAt,
  updatedAt: WorkflowRun.shape.updatedAt,
  definitionId: WorkflowRun.shape.definitionId,
  revisionId: WorkflowRun.shape.revisionId,
  revision: WorkflowRun.shape.revision,
  phases: z.array(WorkflowPhase.extend({ state: z.enum(["pending", "running", "done", "blocked"]), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() })).max(16).optional(),
  overlapPolicy: WorkflowPlan.shape.overlapPolicy,
  queuedBehind: WorkflowRun.shape.queuedBehind,
  script: WorkflowScriptSummary.optional(),
}))
export type WorkflowSummary = z.infer<typeof WorkflowSummary>

const clipped = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

/** The pushed form of a run (pure). */
export function summarizeWorkflow(run: WorkflowRun): WorkflowSummary {
  const last = run.verifications.at(-1)
  const script = summarizeScript(run)
  return {
    workflowId: run.workflowId,
    name: run.name,
    directory: run.directory,
    objective: clipped(run.objective, SUMMARY_OBJECTIVE_CHARS),
    planHash: run.planHash,
    ...(typeof run.plan.contract === "object"
      ? { contract: { criteria: run.plan.contract.criteria.length, checks: run.plan.contract.checks.length, audit: run.plan.contract.audit, maxRepairs: run.plan.contract.maxRepairs, maxAudits: run.plan.contract.maxAudits } }
      : {}),
    ...(run.plan.maxConcurrent ? { maxConcurrent: run.plan.maxConcurrent } : {}),
    ...(run.plan.maxRuntimeMinutes ? { maxRuntimeMinutes: run.plan.maxRuntimeMinutes } : {}),
    permission: run.permission,
    state: run.state,
    ...(run.reason ? { reason: run.reason } : {}),
    rootSessionId: run.rootSessionId,
    ...(run.originSessionId ? { originSessionId: run.originSessionId } : {}),
    tasks: (script ? script.listed : run.tasks).map(({ result: _result, reason, feedback: _feedback, output, mapItem: _mapItem, ...task }) => ({
      ...task,
      ...(reason !== undefined ? { reason: clipped(reason, SUMMARY_TEXT_CHARS) } : {}),
      ...(output ? { outputKind: output.kind } : {}),
    })),
    rounds: run.verifications.length,
    ...(last ? { verification: last } : {}),
    repairs: run.repairs,
    ...(run.override ? { override: run.override } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    updatedAt: run.updatedAt,
    ...(run.definitionId ? { definitionId: run.definitionId, revisionId: run.revisionId, revision: run.revision } : {}),
    ...(run.plan.phases ? { phases: run.plan.phases.map((phase) => {
      const tasks = run.tasks.filter((task) => phase.tasks.includes(task.id))
      const completed = tasks.filter((task) => task.state === "done").length
      const terminal = tasks.every((task) => ["done", "failed", "skipped", "stopped"].includes(task.state))
      const done = phase.barrier.kind === "quorum" ? completed >= phase.barrier.quorum : phase.barrier.kind === "best-effort" ? terminal : phase.barrier.kind === "condition" && phase.barrier.expression.trim().toLowerCase() === "false" ? false : completed === tasks.length
      return { ...phase, completed, total: tasks.length, state: done ? "done" as const : terminal ? "blocked" as const : tasks.some((task) => task.state !== "pending") ? "running" as const : "pending" as const }
    }) } : {}),
    ...(run.plan.overlapPolicy ? { overlapPolicy: run.plan.overlapPolicy } : {}),
    ...(run.queuedBehind ? { queuedBehind: run.queuedBehind } : {}),
    ...(script ? { script: script.summary } : {}),
  }
}

const SCRIPT_LISTED_FINISHED = 48

/** The script block of a summary and the tasks it lists: every live task, the newest finished ones, and a count of the rest. */
function summarizeScript(run: WorkflowRun): { summary: WorkflowScriptSummary; listed: WorkflowTask[] } | undefined {
  const script = run.plan.script
  const host = run.script
  if (!script || !host) return undefined
  const live = run.tasks.filter((task) => !["done", "skipped", "stopped"].includes(task.state))
  const finished = run.tasks.filter((task) => ["done", "skipped", "stopped"].includes(task.state)).slice(-SCRIPT_LISTED_FINISHED)
  const listed = run.tasks.filter((task) => live.includes(task) || finished.includes(task))
  const titles = [...script.meta.phases.map((phase) => phase.title), ...run.tasks.flatMap((task) => (task.phase ? [task.phase] : []))]
  const phases = [...new Set(titles)].slice(0, 24).map((title) => {
    const tasks = run.tasks.filter((task) => task.phase === title)
    const completed = tasks.filter((task) => task.state === "done").length
    const terminal = tasks.length > 0 && tasks.every((task) => ["done", "failed", "skipped", "stopped"].includes(task.state))
    const progress = tasks.length === 0 ? (host.phase === title ? "running" as const : "pending" as const) : completed === tasks.length ? "done" as const : terminal ? "blocked" as const : "running" as const
    const detail = script.meta.phases.find((phase) => phase.title === title)?.detail
    return { title, ...(detail ? { detail } : {}), state: progress, completed, total: tasks.length }
  })
  const usage = run.tasks.reduce((sum, task) => ({ tokens: sum.tokens + (task.usage?.input ?? 0) + (task.usage?.output ?? 0), costMicros: sum.costMicros + (task.usage?.costMicros ?? 0) }), { tokens: 0, costMicros: 0 })
  const count = (...states: string[]) => run.tasks.filter((task) => states.includes(task.state)).length
  const engines: Record<string, { agents: number; tokens: number }> = {}
  for (const task of run.tasks) {
    if (!task.engine) continue
    const entry = engines[task.engine] ?? { agents: 0, tokens: 0 }
    engines[task.engine] = { agents: entry.agents + 1, tokens: entry.tokens + (task.usage?.input ?? 0) + (task.usage?.output ?? 0) }
  }
  return {
    listed,
    summary: {
      hash: script.hash,
      origin: script.origin,
      host: host.host,
      calls: host.calls,
      ...(host.phase ? { phase: host.phase } : {}),
      phases,
      budget: effectiveScriptBudget(run),
      usage: { agents: host.calls, tokens: usage.tokens, costMicros: usage.costMicros, ...(Object.keys(engines).length ? { engines } : {}) },
      counts: { pending: count("pending"), running: count("running", "needs_input"), done: count("done"), failed: count("failed") },
      omitted: run.tasks.length - listed.length,
      logs: host.logs,
      ...(host.result ? { result: host.result.slice(0, 500) } : {}),
      ...(host.error ? { error: host.error } : {}),
    },
  }
}
