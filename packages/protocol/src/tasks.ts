import { z } from "zod"
import { SessionId, TurnId } from "./ids"
import { lazySchema } from "./lazy"

export const TaskInput = lazySchema(() => z.strictObject({
  description: z.string().min(1).max(80),
  prompt: z.string().min(1).max(20_000),
  agent: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  engine: z.string().regex(/^(native|claude|codex|pi|acp:[a-zA-Z0-9_.-]+)$/).optional(),
  variant: z.string().min(1).max(80).optional(),
  task_id: SessionId.optional(),
  background: z.boolean().optional(),
  /** Full tier (`task_worktree`): a new child runs in a git worktree of its parent's HEAD; a resumed one stays where it is. */
  isolation: z.literal("worktree").optional(),
  /** Full tier, opt-in (`task_fork`): a new child starts from its parent's latest request (same model, its cached prefix) instead of a fresh context. */
  fork: z.boolean().optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
}))
export type TaskInput = z.infer<typeof TaskInput>
export const TaskRecord = lazySchema(() => z.strictObject({
  taskId: SessionId,
  parentId: SessionId,
  rootId: SessionId,
  depth: z.number().int().positive(),
  generation: z.number().int().positive(),
  description: z.string(),
  agent: z.string(),
  background: z.boolean(),
  state: z.enum(["queued", "running", "needs_input", "completed", "failed", "cancelled", "interrupted"]),
  result: z.string().max(20_000),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** When this generation started (a resumed child keeps `createdAt` from its first); absent on older records. */
  startedAt: z.number().optional(),
  /**
   * What the daemon resolved for this run when it launched it: the model (and its shown name), who serves it, the engine (harness)
   * that runs it, the reasoning effort and variant, and whether calls ask for priority processing (`/fast`). Absent on a record
   * written before this was kept.
   */
  run: z.strictObject({
    model: z.string().min(1).max(128),
    name: z.string().max(160).optional(),
    provider: z.string().max(64).optional(),
    engine: z.string().min(1).max(80),
    effort: z.string().max(20).optional(),
    variant: z.string().max(100).optional(),
    fast: z.boolean().optional(),
  }).optional(),
  /**
   * What the child spent and changed over all its generations, counted from its own session when a generation ends: tokens
   * read (fresh and cached) and written, the estimated cost when every call had a price, and the files its edit tools wrote
   * (the first 20). Absent until a generation ended, and on a record written before this was kept.
   */
  stats: z.strictObject({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative().optional(),
    files: z.array(z.string().max(300)).max(20),
  }).optional(),
  /**
   * An isolated child (`isolation: "worktree"`): its worktree, the commit it started from and, once it ended, the branch its
   * changes were committed to and their size. Nothing is merged into the parent's checkout.
   */
  worktree: z.strictObject({
    path: z.string().min(1).max(4096),
    base: z.string().max(64),
    branch: z.string().max(200).optional(),
    commit: z.string().max(64).optional(),
    files: z.number().int().nonnegative().optional(),
    insertions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    changed: z.array(z.string().max(200)).max(20).optional(),
  }).optional(),
  /** Launched with `fork: true`: its first turn starts from the parent's context when that is still on record (`task_fork`). */
  fork: z.literal(true).optional(),
}))
export type TaskRecord = z.infer<typeof TaskRecord>
export const ExtractionJob = lazySchema(() => z.strictObject({
  jobId: z.string(),
  sessionId: SessionId,
  turnId: TurnId,
  directory: z.string(),
  text: z.string().max(64_000),
  state: z.enum(["queued", "running", "completed", "skipped", "failed"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number(),
  reason: z.string(),
  proposed: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
}))
export type ExtractionJob = z.infer<typeof ExtractionJob>
