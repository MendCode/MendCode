import { z } from "zod"
import { RequestId, SessionId, TurnId } from "./ids"
import { lazySchema } from "./lazy"
import { PLAN_APPLY_PERMISSIONS } from "./plan-review-data"

export const PlanReview = lazySchema(() => z.strictObject({
  markdown: z.string().min(1).max(30_000),
  title: z.string().max(200).optional(),
  phase: z.enum(["plan", "implementation"]),
  destination: z.string().min(1).max(64),
  /** The file an engine already keeps this plan in (Claude Code's `~/.claude/plans/<name>.md`); MendCode then registers that path and keeps no second copy of the text. */
  file: z.string().min(1).max(1024).optional(),
}))
export type PlanReview = z.infer<typeof PlanReview>

export const PlanReviewReply = lazySchema(() => z.strictObject({
  kind: z.literal("plan_review"),
  action: z.enum(["accept", "apply", "edit", "reject", "close"]),
  markdown: z.string().min(1).max(30_000).optional(),
  comments: z.string().max(4000).optional(),
  reason: z.string().max(2000).optional(),
  destination: z.string().min(1).max(64).optional(),
  permission: z.enum(PLAN_APPLY_PERMISSIONS).optional(),
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

export { PLAN_APPLY_PERMISSIONS, PLAN_APPLY_DEFAULT, PLAN_APPLY_LABELS, PLAN_TURN_NOTES, PLAN_TURN_OFF_NOTE, createPlanTurnNotes, type PlanApplyPermission } from "./plan-review-data"
