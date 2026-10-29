import { z } from "zod"

/**
 * A turn that hit the provider's usage limit is paused, not failed (docs/usage-limit.md). `paused`: waiting for the
 * user's choice (no reset time known, auto-resume cancelled, or a safeguard asked instead) · `scheduled`: Resume at
 * reset is armed (by default whenever the reset time is known), the daemon continues the turn when the window resets
 * (survives a daemon restart) · `snoozed`: the bar is hidden until the reset · `ready`: the window reset and the turn
 * waits for a Resume · `resumed` and `cleared`: nothing is pending any more.
 */
export const USAGE_LIMIT_STATES = ["paused", "scheduled", "snoozed", "ready", "resumed", "cleared"] as const
export const UsageLimitState = z.enum(USAGE_LIMIT_STATES)
export type UsageLimitState = z.infer<typeof UsageLimitState>

/** The states in which a pause is still open: the transcript keeps its bar for them (a snoozed one is hidden until the reset). */
export const USAGE_LIMIT_OPEN_STATES = ["paused", "scheduled", "snoozed", "ready"] as const satisfies readonly UsageLimitState[]

/** What the user can do with an open pause: arm Resume at reset, Cancel the armed auto-resume (back to `paused`), Snooze until reset, Resume now, or Dismiss it. */
export const USAGE_LIMIT_ACTIONS = ["schedule", "cancel", "snooze", "resume", "dismiss"] as const
export const UsageLimitAction = z.enum(USAGE_LIMIT_ACTIONS)
export type UsageLimitAction = z.infer<typeof UsageLimitAction>
