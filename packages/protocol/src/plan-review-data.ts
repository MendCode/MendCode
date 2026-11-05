/** Plan review constants with no imports, so the thin terminal client can use them without loading the protocol schemas. */
/**
 * The permission mode a session takes when a plan is applied (docs/plan-review.md): `full` by default, like leaving plan mode with
 * acceptance in Claude Code, and `edits` or `ask` when the reviewer wants to keep approving.
 */
export const PLAN_APPLY_PERMISSIONS = ["full", "edits", "ask"] as const
export type PlanApplyPermission = (typeof PLAN_APPLY_PERMISSIONS)[number]
export const PLAN_APPLY_DEFAULT: PlanApplyPermission = "full"
/** The words the page, the notice and the model use for each (the same names the footer shows). */
export const PLAN_APPLY_LABELS: Readonly<Record<PlanApplyPermission, string>> = { full: "full access", edits: "auto edits", ask: "ask before edits" }

const PLAN_NOTE_BASE = "Plan mode is on: read-only. Investigate with read tools; change nothing."
/** What a model that runs its own tools is told on every turn in plan mode, by how it presents a plan (the native engine has `PLAN_MODE_NOTE` in its system prompt). */
export const PLAN_TURN_NOTES = {
  tool: `${PLAN_NOTE_BASE} Present the complete plan for the user's review with ExitPlanMode.`,
  reply: `${PLAN_NOTE_BASE} Present the complete plan as your reply; the user reviews it before anything changes.`,
} as const
/** The first turn after plan mode ends says so, once. */
export const PLAN_TURN_OFF_NOTE = "Plan mode is off: you may edit and run commands again, as permissions allow."

/**
 * The note a turn carries: the plan note on each turn in plan mode, the off note on the first turn after it, nothing otherwise.
 * One per engine; it remembers only which sessions were told, so a session never planning costs nothing.
 */
export function createPlanTurnNotes(style: keyof typeof PLAN_TURN_NOTES): { next(sessionId: string, planning: boolean, internal?: boolean): string | undefined } {
  const told = new Set<string>()
  return {
    next(sessionId, planning, internal = false) {
      // An internal read-only run (a PR review, a report-only loop) is in plan mode only to stay read-only: no plan to present, nothing to remember.
      if (internal) return undefined
      if (planning) {
        told.add(sessionId)
        return `[MendCode: ${PLAN_TURN_NOTES[style]}]`
      }
      return told.delete(sessionId) ? `[MendCode: ${PLAN_TURN_OFF_NOTE}]` : undefined
    },
  }
}
