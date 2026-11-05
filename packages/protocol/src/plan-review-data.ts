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
