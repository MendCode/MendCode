import { z } from "zod"
import { GOAL_MAX_OBJECTIVE_CHARS, GOAL_MAX_TOKEN_BUDGET, GOAL_STATUSES } from "./constants"
import { GoalId, SessionId } from "./ids"
import { lazySchema } from "./lazy"

export const GoalStatus = z.enum(GOAL_STATUSES)
export type GoalStatus = z.infer<typeof GoalStatus>

/** A token budget: a positive whole number of tokens (input + output of every goal turn). */
export const GoalTokenBudget = z.number().int().min(1).max(GOAL_MAX_TOKEN_BUDGET)

/** The objective text `goal.set` and `goal.update` take: what the user typed (a long one is saved as a file by the daemon). */
export const GoalObjective = z.string().trim().min(1).max(GOAL_MAX_OBJECTIVE_CHARS)

/**
 * A session's objective, worked on turn after turn until it is complete, blocked, over budget, usage-limited or paused.
 * One per session at a time; earlier ones stay in the history. `objective` is what the agent is told: for a long
 * objective (see GOAL_INLINE_OBJECTIVE_CHARS) that is a sentence pointing at `objectiveFile`.
 */
export const Goal = lazySchema(() => z.strictObject({
  goalId: GoalId,
  sessionId: SessionId,
  objective: z.string().min(1).max(8_000),
  /** Set when the objective the user gave was too long to inline: the file that holds it. */
  objectiveFile: z.string().min(1).max(4096).optional(),
  status: GoalStatus,
  tokenBudget: GoalTokenBudget.optional(),
  /** Input + output tokens of the model calls made while the goal was being worked on. */
  tokensUsed: z.number().int().nonnegative(),
  /** Wall time of the turns run while the goal was active, without the turn in progress (see `activeSince`). */
  timeUsedSeconds: z.number().int().nonnegative(),
  /** While a goal turn runs: when it started (ms since epoch), so clients can tick the elapsed time. */
  activeSince: z.number().int().nonnegative().optional(),
  /** Why the goal is not continuing on its own although it is active (a failed or cancelled turn, repeated empty output). */
  stalled: z.string().max(500).optional(),
  /** What the agent or the user said about the last status change (why it is blocked, what was achieved). */
  note: z.string().max(1_000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export type Goal = z.infer<typeof Goal>

/**
 * Why a `goal.changed` event was written. created: a new goal · edited: the objective changed · budget: the token
 * budget changed · status: the status changed · progress: usage moved · stalled: automatic continuation stopped (or
 * started again) · cleared: the goal was removed (the event carries its last state).
 */
export const GoalChange = z.enum(["created", "edited", "budget", "status", "progress", "stalled", "cleared"])
export type GoalChange = z.infer<typeof GoalChange>

/** Who made the change: the user (`/goal`), the agent (a goal tool) or the daemon (budget, quota, failed turns). */
export const GoalBy = z.enum(["user", "agent", "system"])
export type GoalBy = z.infer<typeof GoalBy>
