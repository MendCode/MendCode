import { z } from "zod"
import { SessionId, TurnId, RequestId } from "./ids"
import { QuestionBatch } from "./questions"
import { lazySchema } from "./lazy"

export const ContinuityId = z.string().min(1).max(200)
export const ContinuityRecord = lazySchema(() => z.strictObject({
  id: ContinuityId,
  sessionId: SessionId,
  turnId: TurnId,
  kind: z.enum(["job", "question"]),
  generation: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted", "pending", "answered", "dismissed"]),
  tool: z.string().max(200).optional(),
  requestId: RequestId.optional(),
  questions: QuestionBatch.optional(),
  output: z.string().max(50_000).optional(),
  error: z.string().max(4096).optional(),
  attachmentNotice: z.string().max(200).optional(),
  answers: z.array(z.array(z.string().max(4000)).max(10)).max(32).optional(),
  continuationCancelled: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export type ContinuityRecord = z.infer<typeof ContinuityRecord>
export const ContinuitySummary = lazySchema(() => ContinuityRecord.omit({ output: true, answers: true, questions: true }))
export type ContinuitySummary = z.infer<typeof ContinuitySummary>
