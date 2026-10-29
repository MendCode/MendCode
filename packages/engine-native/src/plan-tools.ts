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
