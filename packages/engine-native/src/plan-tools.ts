import { z } from "zod"
import { isPlanningOnlyPacket, redactSecrets, type PlanReview } from "@mendcode/protocol"

const phase = z.enum(["plan", "implementation"]).optional().describe("Use plan for a planning-only packet: acceptance never starts implementation")
export const PLAN_REVIEW_TOOL = {
  name: "plan_review",
  description: "Show a complete Markdown plan for interactive approval, editing, comments or rejection. Apply starts implementation only after explicit user authorization. Set phase=plan for planning-only packets.",
  args: z.object({ title: z.string().max(200).optional(), markdown: z.string().min(1).max(30_000), phase }),
}
export const PLAN_EXIT_TOOL = {
  name: "plan_exit",
  description: "Ask the user to continue with the latest reviewed plan and the configured planExitAgent. Never exits a planning-only packet into implementation.",
  args: z.object({}),
}
export const PLAN_TOOL_NAMES = new Set(["plan_submit", "plan_review", "plan_exit"])

/** Review text is display-only: credentials never belong in its persisted tool arguments. */
export function safePlanArgs(args: unknown, mask: (text: string) => string): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const next = { ...args } as Record<string, unknown>
  for (const field of ["plan", "markdown", "title"] as const) if (typeof next[field] === "string") next[field] = redactSecrets(mask(next[field])).text
  return next
}

/** Explicit packet markers and the user's planning-only instruction override a model's implementation phase. */
export function planPhase(markdown: string, prompt: string, requested?: PlanReview["phase"]): PlanReview["phase"] {
  const instruction = /\b(?:only (?:a )?plan|plan only|do not implement|don't implement|solo (?:elaborar (?:un )?)?plan|s[oó]lo plan|no implementes|no implementar)\b/i
  return requested === "plan" || isPlanningOnlyPacket(markdown) || instruction.test(prompt) ? "plan" : "implementation"
}

/** Appended to the system prompt of a call made in plan mode, and to no other (docs/plan-review.md). */
/** What a report-only loop run gets instead of the plan mode note: it has no plan to submit. */
/** What a read-only internal run is told when it tries a tool that changes something: no plan, no plan mode, just the rule. */
export const READ_ONLY_RUN_REFUSAL = "this run is read-only: only read tools are allowed; answer from what you can read"
// No word of plans: the plan tools are not offered to it, and a PR reviewer told about plans read it as a restriction on its review.
export const REPORT_ONLY_NOTE = "Report-only: write the report as your answer. The session is read-only, so investigate with read tools and change nothing."

export const PLAN_MODE_NOTE = "Plan mode is on: the session is read-only, so investigate with read tools and do not edit, write or run commands that change anything. Finish by calling plan_review with the complete plan as Markdown (goal, steps with files, risks, how to verify); the user reviews it there and decides whether to implement. Do not write the final plan as a plain reply."

/** A plain-text reply that reads as a plan (a list or headings, enough text): the host offers it for review when the model did not. */
export function looksLikePlan(text: string): boolean {
  const body = text.trim()
  if (body.length < 120) return false
  const structure = body.split("\n").filter((line) => /^\s*(?:[-*]\s+\S|\d+[.)]\s+\S|#{1,4}\s+\S)/.test(line)).length
  return structure >= 3
}
