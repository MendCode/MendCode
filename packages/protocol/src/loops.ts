import { z } from "zod"
import { LoopId, SessionId } from "./ids"
import { adaptiveBounds } from "./loop-wire"
import { lazySchema } from "./lazy"
export { adaptiveBounds } from "./loop-wire"

const MAX_INTERVAL_MS = 30 * 86_400_000

/** True when `name` is a time zone the runtime knows (IANA names such as "Europe/Madrid", plus "UTC"). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return true
  } catch {
    return false
  }
}

/**
 * When a loop wakes up. Daily times are wall-clock "HH:MM" in `timezone` (an IANA name), local time when absent.
 * adaptive: an interval that starts at `everyMs`, doubles (up to `maxMs`) after a run that found nothing and halves
 * (down to `minMs`) after a run that acted; the bounds default to a quarter and eight times `everyMs`.
 * external: never wakes by itself; something outside (cron, CI) fires it with `loop.fire`.
 */
export const LoopTrigger = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().min(60_000).max(MAX_INTERVAL_MS) }),
  z.strictObject({
    kind: z.literal("daily"),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(64).refine(isTimeZone, { message: "unknown time zone (use an IANA name such as Europe/Madrid)" }).optional(),
  }),
  z
    .strictObject({
      kind: z.literal("adaptive"),
      everyMs: z.number().int().min(60_000).max(MAX_INTERVAL_MS),
      minMs: z.number().int().min(60_000).max(MAX_INTERVAL_MS).optional(),
      maxMs: z.number().int().min(60_000).max(MAX_INTERVAL_MS).optional(),
    })
    .refine((trigger) => adaptiveBounds(trigger).minMs <= trigger.everyMs && trigger.everyMs <= adaptiveBounds(trigger).maxMs, { message: "adaptive bounds must satisfy minMs <= everyMs <= maxMs" }),
  z.strictObject({ kind: z.literal("external") }),
]))
export type LoopTrigger = z.infer<typeof LoopTrigger>

/**
 * How a loop finishes (independent of when it wakes):
 * goal — stop as soon as a run reports the goal complete; `maxRuns` is only a safety cap.
 * monitor — repeat the objective at every wakeup until stopped.
 * fixed — exactly `maxRuns` runs.
 */
export const LoopBudget = lazySchema(() => z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("goal"), maxRuns: z.number().int().min(1).max(1_000).optional() }),
  z.strictObject({ mode: z.literal("monitor") }),
  z.strictObject({ mode: z.literal("fixed"), maxRuns: z.number().int().min(1).max(1_000) }),
]))
export type LoopBudget = z.infer<typeof LoopBudget>

export const LoopCostBudget = lazySchema(() => z.strictObject({
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** USD, never a subscription quota. */
  maxCost: z.number().min(0.000001).optional(),
  /** A USD cap fails closed for calls without a price unless explicitly allowed. */
  unknownCost: z.enum(["block", "allow"]).optional(),
}))
export type LoopCostBudget = z.infer<typeof LoopCostBudget>

export const LoopUsage = lazySchema(() => z.strictObject({
  tokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  unknownCostCalls: z.number().int().nonnegative(),
  /** Turns without a usage event; their token total is unavailable. */
  unreportedTurns: z.number().int().nonnegative().optional(),
}))
export type LoopUsage = z.infer<typeof LoopUsage>

export const LoopRubric = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(120).optional(),
  passThreshold: z.number().min(0).max(1).optional(),
  criteria: z.array(z.strictObject({
    id: z.string().min(1).max(80),
    description: z.string().min(1).max(1_000),
    weight: z.number().nonnegative().max(1_000).optional(),
    minScore: z.number().min(0).max(5).optional(),
    evidenceRequired: z.array(z.string().min(1).max(300)).max(10).optional(),
  })).max(20).refine((criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length, "duplicate criterion id"),
  mandatoryBlockers: z.array(z.string().min(1).max(300)).max(10).optional(),
}))
export type LoopRubric = z.infer<typeof LoopRubric>

export const LoopRubricResult = lazySchema(() => z.strictObject({
  status: z.enum(["pass", "fail", "blocked"]),
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  criteria: z.array(z.strictObject({
    id: z.string().max(80),
    score: z.number().min(0).max(5),
    maxScore: z.literal(5),
    passed: z.boolean(),
    reason: z.string().max(1_000),
    evidence: z.array(z.string().max(1_000)).max(10),
  })).max(20),
  blockers: z.array(z.strictObject({ id: z.string().max(300), present: z.boolean(), reason: z.string().max(500) })).max(10),
}))
export type LoopRubricResult = z.infer<typeof LoopRubricResult>

export const LoopApprovalAction = z.enum(["push", "merge", "deploy", "publish", "delete"])
export const LoopApprovalPolicy = lazySchema(() => z.strictObject({
  requireApprovalFor: z.array(LoopApprovalAction).max(5),
}))
export type LoopApprovalPolicy = z.infer<typeof LoopApprovalPolicy>

export const LoopGateWaiver = lazySchema(() => z.strictObject({
  action: z.enum(["waive", "accept", "approve"]),
  actor: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
  at: z.number().int().nonnegative(),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
}))
export type LoopGateWaiver = z.infer<typeof LoopGateWaiver>

/**
 * active: waiting for its next wakeup · running: a run is in progress · needs_input: a run waits for the user ·
 * verifying: a goal run claimed completion and the host is running its checks and the independent audit.
 */
export const LoopState = z.enum(["active", "running", "needs_input", "verifying", "paused", "completed", "blocked", "stopped"])
export type LoopState = z.infer<typeof LoopState>

/** What a run reported at its end (the LOOP_CHECKPOINT block), or what the host concluded without one. */
export const LoopCheckpoint = lazySchema(() => z.strictObject({
  status: z.enum(["complete", "continue", "blocked"]),
  summary: z.string().max(2_000),
  next: z.string().max(1_000).optional(),
  /** idle: the run found nothing to do · acted: it changed or fixed something. Absent: unknown (an adaptive loop keeps its pace). */
  activity: z.enum(["idle", "acted"]).optional(),
  evidence: z.array(z.string().min(1).max(1_000)).max(10).optional(),
}))
export type LoopCheckpoint = z.infer<typeof LoopCheckpoint>

/** One host-run check after a completion claim: the command, whether it passed, and the end of its output. */
export const LoopGate = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(300),
  status: z.enum(["pass", "fail"]),
  detail: z.string().max(2_000).optional(),
  failureClass: z.enum(["quality", "budget", "policy", "integrity"]).optional(),
  waiver: LoopGateWaiver.optional(),
}))
export type LoopGate = z.infer<typeof LoopGate>

/** The independent auditor's judgment of a completion claim, made read-only in a fresh session. */
export const LoopAudit = lazySchema(() => z.strictObject({
  verdict: z.enum(["pass", "fail"]),
  findings: z.string().max(4_000),
  sessionId: SessionId.optional(),
  /** True when the workspace differed after the audit (an auditor must not change it): the verdict is void. */
  workspaceChanged: z.boolean().optional(),
}))
export type LoopAudit = z.infer<typeof LoopAudit>

/**
 * The git worktree a run worked in (workspace "worktree"), on its own branch cut from `base`. active: in use ·
 * removed: the run changed nothing, so the worktree and its branch were deleted · retained: the run's work (anything it
 * left uncommitted is committed first) is kept on `branch` for the user to review or merge; the directory is deleted,
 * unless cleaning failed, which `detail` says.
 */
export const LoopWorktree = lazySchema(() => z.strictObject({
  path: z.string().min(1).max(4096),
  branch: z.string().min(1).max(200),
  /** The commit the branch was cut from. */
  base: z.string().max(64).optional(),
  state: z.enum(["active", "removed", "retained"]),
  detail: z.string().max(500).optional(),
}))
export type LoopWorktree = z.infer<typeof LoopWorktree>

/** What started a run: its schedule, the user (`loop.control run`) or an external `loop.fire`. */
export const LoopRunTrigger = z.enum(["schedule", "manual", "external"])
export type LoopRunTrigger = z.infer<typeof LoopRunTrigger>

export const LoopRun = lazySchema(() => z.strictObject({
  run: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  trigger: LoopRunTrigger.optional(),
  /** Workspace "worktree": the session that ran this wakeup (a fresh one per run, in the worktree). Absent: the loop's root session. */
  sessionId: SessionId.optional(),
  worktree: LoopWorktree.optional(),
  endedAt: z.number().int().nonnegative().optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "interrupted"]).optional(),
  checkpoint: LoopCheckpoint.optional(),
  gates: z.array(LoopGate).max(10).optional(),
  audit: LoopAudit.optional(),
  usage: LoopUsage.optional(),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  rubricResult: LoopRubricResult.optional(),
  approvals: z.array(z.strictObject({ action: LoopApprovalAction, evidence: LoopGateWaiver })).max(5).optional(),
}))
export type LoopRun = z.infer<typeof LoopRun>

export const LoopJournalEvent = lazySchema(() => z.strictObject({
  seq: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  type: z.enum(["created", "updated", "state", "run", "checkpoint", "verification"]),
  title: z.string().max(500),
  run: z.number().int().positive().optional(),
}))
export type LoopJournalEvent = z.infer<typeof LoopJournalEvent>

export const Loop = lazySchema(() => z.strictObject({
  loopId: LoopId,
  name: z.string().min(1).max(120),
  directory: z.string().min(1).max(4096),
  objective: z.string().min(1).max(8_000),
  /** For goal loops: what must be true to finish. */
  criteria: z.string().max(4_000).optional(),
  /** Commands the host runs after a completion claim (plain commands: no pipes, redirection or chaining); all must exit 0. */
  checks: z.array(z.string().min(1).max(300)).max(5).optional(),
  /** Goal loops: "independent" has a fresh read-only session confirm a completion claim; absent (older loops) means "none". */
  audit: z.enum(["independent", "none"]).optional(),
  /** Why the last completion claim was rejected; the next run is told, then it is cleared. */
  feedback: z.string().max(4_000).optional(),
  /** Set when the user accepted completion by hand. */
  override: z.strictObject({ reason: z.string().min(1).max(500), at: z.number().int().nonnegative() }).optional(),
  trigger: LoopTrigger,
  budget: LoopBudget,
  costBudget: LoopCostBudget.optional(),
  usage: LoopUsage.optional(),
  rubric: LoopRubric.optional(),
  approvalPolicy: LoopApprovalPolicy.optional(),
  /** The template the loop was created from, for display. */
  template: z.string().max(40).optional(),
  /** Report-only: a run reports but never changes anything (its session is read-only: no write or execute tools). Absent = may edit. */
  reportOnly: z.boolean().optional(),
  /** "worktree": each run works in its own git worktree, never in the user's checkout (see `LoopWorktree`). Absent = "in-place". */
  workspace: z.enum(["in-place", "worktree"]).optional(),
  /** Adaptive triggers: the interval the next wakeup uses (moves between the trigger's bounds as runs act or find nothing). */
  adaptiveMs: z.number().int().min(60_000).max(MAX_INTERVAL_MS).optional(),
  /** External triggers: a fire that arrived while a run was in progress; it starts a run as soon as the loop is free. */
  pendingFire: z.strictObject({ at: z.number().int().nonnegative(), note: z.string().max(500).optional() }).optional(),
  state: LoopState,
  /** The loop's root session: every run is a message in it, so its whole history is inspectable (worktree loops: each run has its own, see `LoopRun.sessionId`). */
  sessionId: SessionId,
  runs: z.number().int().nonnegative(),
  nextWakeAt: z.number().int().nonnegative().optional(),
  /** Last runs, newest last, bounded. */
  history: z.array(LoopRun).max(20),
  /** Review rules changed after the last claim; only a new run can clear this. */
  reviewInvalidatedAt: z.number().int().nonnegative().optional(),
  reason: z.string().max(500).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** A draft is paused until activated; optional for older records. */
  draft: z.boolean().optional(),
  /** Bounded lifecycle journal, oldest first. */
  journal: z.array(LoopJournalEvent).max(200).optional(),
}))
export type Loop = z.infer<typeof Loop>

/** A built-in loop template as `loop.templates` lists it (the trigger and budget it fills in are shown in `summary`). */
export const LoopTemplateInfo = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().max(300),
  summary: z.string().max(300),
}))
export type LoopTemplateInfo = z.infer<typeof LoopTemplateInfo>
