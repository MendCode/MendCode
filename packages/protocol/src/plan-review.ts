import { z } from "zod"
import { RequestId, SessionId, TurnId } from "./ids"
import { lazySchema } from "./lazy"

export const PlanReview = lazySchema(() => z.strictObject({
  markdown: z.string().min(1).max(30_000),
  title: z.string().max(200).optional(),
  phase: z.enum(["plan", "implementation"]),
  destination: z.string().min(1).max(64),
}))
export type PlanReview = z.infer<typeof PlanReview>

export const PlanReviewReply = lazySchema(() => z.strictObject({
  kind: z.literal("plan_review"),
  action: z.enum(["accept", "apply", "edit", "reject", "close"]),
  markdown: z.string().min(1).max(30_000).optional(),
  comments: z.string().max(4000).optional(),
  reason: z.string().max(2000).optional(),
  destination: z.string().min(1).max(64).optional(),
}))
export type PlanReviewReply = z.infer<typeof PlanReviewReply>

export const PlanReviewRecord = lazySchema(() => PlanReview.extend({
  requestId: RequestId,
  sessionId: SessionId,
  turnId: TurnId,
  createdAt: z.number(),
  repliedAt: z.number().optional(),
  reply: PlanReviewReply.optional(),
}))
export type PlanReviewRecord = z.infer<typeof PlanReviewRecord>
