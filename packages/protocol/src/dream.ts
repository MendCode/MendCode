import { z } from "zod"
import { EVOLUTION_MODES } from "./constants"
import { WorkflowPlan } from "./workflows"
import { lazySchema } from "./lazy"

/** What started a run: the user (`manual`), the daily window (`scheduled`) or the first check after a window passed while the daemon was down or the machine asleep (`recovered`). */
export const DreamTrigger = z.enum(["manual", "scheduled", "recovered"])
export type DreamTrigger = z.infer<typeof DreamTrigger>

/** Where a session's digest came from: built now or reused from the cache (its session had not changed). */
const DigestOrigin = z.enum(["built", "reused"])

/** What Evolution did in a run; absent on runs with Evolution off. */
export const EvolutionReport = lazySchema(() => z.strictObject({
  mode: z.enum(EVOLUTION_MODES),
  /** Corrections and preferences seen in the digests, and how many of them recur across sessions. No text in `observe`. */
  observed: z.strictObject({ corrections: z.number().int().nonnegative(), preferences: z.number().int().nonnegative(), recurring: z.number().int().nonnegative() }),
  /** Candidates the model proposed that passed validation. */
  suggested: z.strictObject({ memories: z.number().int().nonnegative(), skills: z.number().int().nonnegative(), instructions: z.number().int().nonnegative(), workflows: z.number().int().nonnegative().optional() }),
  /** Memory proposals saved directly (auto-safe and category policy `auto` only). */
  applied: z.number().int().nonnegative(),
  /** Why no model call was made, when none was. */
  note: z.string().max(200).optional(),
}))
export type EvolutionReport = z.infer<typeof EvolutionReport>

/**
 * The safety report of one Dream run: what it read, what it proposes, what it refused and why, how many secrets
 * were redacted, what the model cost and whether the token budget stopped it. Bounded so twenty of them fit a frame.
 */
export const DreamReport = lazySchema(() => z.strictObject({
  read: z.strictObject({
    sessions: z.array(z.strictObject({ sessionId: z.string().max(64), title: z.string().max(80), digest: DigestOrigin, messages: z.number().int().nonnegative(), redactions: z.number().int().nonnegative() })).max(12),
    /** Saved and pending memories shown to the model. */
    memories: z.number().int().nonnegative(),
    /** Characters of the prompt(s) sent to the model. */
    promptChars: z.number().int().nonnegative(),
  }),
  proposed: z
    .array(z.strictObject({ kind: z.enum(["new", "update", "archive"]), category: z.string().max(64), scope: z.enum(["user", "project", "session"]).optional(), text: z.string().max(160), outcome: z.enum(["pending", "saved", "dropped"]) }))
    .max(12),
  refused: z.array(z.strictObject({ item: z.string().max(120), reason: z.string().max(120) })).max(20),
  redactions: z.strictObject({ evidence: z.number().int().nonnegative(), proposals: z.number().int().nonnegative() }),
  model: z.strictObject({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** True when a count was estimated (characters / 4) because the provider reported no usage. */
    estimated: z.boolean(),
  }),
  budget: z.strictObject({ limit: z.number().int().positive(), used: z.number().int().nonnegative(), stopped: z.boolean(), reason: z.string().max(200).optional() }),
  evolution: EvolutionReport.optional(),
  failures: z.array(z.string().max(200)).max(5),
  consolidation: z.strictObject({
    policy: z.enum(["disabled", "preview", "auto-consolidate"]),
    pendingBefore: z.number().int().nonnegative(),
    pendingAfter: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    decisions: z.array(z.strictObject({ memoryId: z.string(), outcome: z.enum(["preview", "applied", "archived", "failed", "kept"]), reason: z.string().max(200), by: z.enum(["host", "model"]).optional(), canonicalId: z.string().optional() })).max(50),
    /** Absent on runs recorded before the semantic consolidator existed (they were deterministic). */
    mode: z.enum(["deterministic", "semantic"]).optional(),
    /** The configured `memoryConsolidator` model when the semantic pass ran, its usage, and why a batch fell back to the host gates alone. */
    semantic: z.strictObject({
      model: z.string().max(200),
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      estimated: z.boolean(),
      fallback: z.string().max(200).optional(),
    }).optional(),
  }).optional(),
}))
export type DreamReport = z.infer<typeof DreamReport>

/** One Dream run (memory consolidation) in the ledger. */
export const DreamRun = lazySchema(() => z.strictObject({
  runId: z.number().int().positive(),
  directory: z.string(),
  status: z.enum(["running", "done", "skipped", "failed"]),
  /** Absent on runs recorded before triggers existed (they were manual or scheduled). */
  trigger: DreamTrigger.optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  proposed: z.number().int().nonnegative(),
  notes: z.string().max(2_000).optional(),
  error: z.string().max(500).optional(),
  /** Safety report; `dream.list` carries it for the newest runs only (ask for one by `runId` to get any). */
  report: DreamReport.optional(),
}))
export type DreamRun = z.infer<typeof DreamRun>

/** Exact artifact identity for explicit promotion and rollback; saved before publication. */
export const EvolutionReceipt = lazySchema(() => z.strictObject({
  kind: z.enum(["skill", "workflow"]),
  target: z.string().max(4096),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  promotedAt: z.number().int().nonnegative(),
  rolledBackAt: z.number().int().nonnegative().optional(),
  archive: z.string().max(4096).optional(),
}))
export type EvolutionReceipt = z.infer<typeof EvolutionReceipt>

/** Non-memory proposals; instruction text is accepted without touching the instructions file. */
export const EvolutionSuggestion = lazySchema(() => z.strictObject({
  suggestionId: z.number().int().positive(),
  directory: z.string(),
  kind: z.enum(["skill", "instruction", "workflow"]),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  description: z.string().max(300),
  content: z.string().max(4_000),
  /** How many corrections/preferences it rests on. */
  evidence: z.number().int().positive().max(5),
  status: z.enum(["pending", "accepted", "rejected", "blocked", "rolled_back"]),
  createdAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().optional(),
  runId: z.number().int().positive().optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  policyRevision: z.string().max(64).optional(),
  receipt: EvolutionReceipt.optional(),
}))
export type EvolutionSuggestion = z.infer<typeof EvolutionSuggestion>

/** Generated definitions cannot grant edits, run host checks or skip the next run's independent audit. */
export function parseEvolutionWorkflow(content: string): WorkflowPlan {
  const plan = WorkflowPlan.parse(JSON.parse(content))
  if (plan.permission !== "ask" || plan.tasks.some((task) => task.kind !== "agent" || task.mode !== "read")) throw new Error("Generated workflows require read tasks and ask permission")
  if (typeof plan.contract !== "object" || plan.contract.audit !== "independent" || plan.contract.checks.length) throw new Error("Generated workflows require an inline independent audit without host checks")
  const nodes = new Map(plan.tasks.map((task) => [task.id, task]))
  const seen = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Workflow dependency cycle")
    if (seen.has(id)) return
    const task = nodes.get(id)
    if (!task) throw new Error("Unknown workflow dependency")
    visiting.add(id)
    if (new Set(task.needs).size !== task.needs.length) throw new Error("Duplicate workflow dependency")
    task.needs.forEach(visit)
    visiting.delete(id)
    seen.add(id)
  }
  if (nodes.size !== plan.tasks.length) throw new Error("Duplicate workflow task")
  plan.tasks.forEach((task) => visit(task.id))
  if (plan.contract.criteria.some((criterion) => criterion.owners?.some((id) => !nodes.has(id)))) throw new Error("Unknown workflow criterion owner")
  return plan
}
