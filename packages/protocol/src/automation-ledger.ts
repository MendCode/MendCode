import { z } from "zod"
import { LoopAudit, LoopCheckpoint, LoopGate, LoopRubricResult, LoopUsage } from "./loops"
import { WorkflowVerification } from "./workflows"
import { lazySchema } from "./lazy"

export const LedgerScope = z.enum(["workflow", "loop"])
export type LedgerScope = z.infer<typeof LedgerScope>
export const LedgerCategory = z.enum(["event", "artifact", "receipt"])
export type LedgerCategory = z.infer<typeof LedgerCategory>
export const LedgerQuery = lazySchema(() => z.strictObject({
  run: z.number().int().nonnegative().optional(),
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}))
export type LedgerQuery = z.infer<typeof LedgerQuery>

export const CompletionReceipt = lazySchema(() => z.strictObject({
  state: z.string().max(40),
  verified: z.boolean(),
  planHash: z.string().length(64).optional(),
  done: z.number().int().min(0).max(32).optional(),
  total: z.number().int().min(0).max(32).optional(),
  verification: WorkflowVerification.omit({ gates: true, audit: true }).optional(),
  checkpoint: LoopCheckpoint.optional(),
  checkpointHash: z.string().length(64).optional(),
  gates: z.array(LoopGate).max(10).optional(),
  audit: LoopAudit.optional(),
  rubric: LoopRubricResult.optional(),
  usage: LoopUsage.optional(),
  override: z.strictObject({ at: z.number().int().nonnegative(), reason: z.string().min(1).max(500) }).optional(),
  reviewInvalidatedAt: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
}))
export type CompletionReceipt = z.infer<typeof CompletionReceipt>

/** Immutable evidence, separate from the current run projection. Sequence is monotonic per owner. */
export const LedgerEntry = lazySchema(() => z.strictObject({
  sequence: z.number().int().positive(),
  run: z.number().int().nonnegative(),
  category: LedgerCategory,
  kind: z.string().max(120),
  title: z.string().max(200),
  summary: z.string().max(2_000),
  at: z.number().int().nonnegative(),
  taskId: z.string().max(40).optional(),
  sessionId: z.string().max(200).optional(),
  data: z.record(z.string(), z.unknown()),
}))
export type LedgerEntry = z.infer<typeof LedgerEntry>
export const LedgerPage = lazySchema(() => z.strictObject({
  scope: LedgerScope,
  ownerId: z.string().max(200),
  entries: z.array(LedgerEntry).max(100),
  nextBefore: z.number().int().positive().optional(),
  retained: z.number().int().nonnegative(),
  latestSequence: z.number().int().nonnegative(),
  /** Retention removed entries or runs. An empty historical page is not proof of no activity. */
  truncated: z.boolean(),
  historical: z.boolean(),
}))
export type LedgerPage = z.infer<typeof LedgerPage>
export const LedgerExport = lazySchema(() => z.strictObject({
  format: z.enum(["json", "markdown"]),
  text: z.string().max(2_000_000),
  page: LedgerPage.omit({ entries: true }),
}))
export type LedgerExport = z.infer<typeof LedgerExport>
