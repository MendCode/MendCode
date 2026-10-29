import { z } from "zod"
import { lazySchema } from "./lazy"

/**
 * The PR reviewer's findings (docs/pr-review.md): what a review child returns, what the verify pass judges and what a publish
 * turns into inline comments. One schema for the daemon's repo watch and the hosted-runner Action, so either can publish what the
 * other found. A finding names a line on the diff's new side; its `id` is the sha1 of path, line, category and summary, so the
 * same finding found again on a later head is recognised and never posted twice.
 */

export const PR_FINDING_SEVERITIES = ["critical", "major", "minor"] as const
export const PR_FINDING_CATEGORIES = ["correctness", "security", "performance", "reliability", "tests", "maintainability"] as const
export const PR_FINDING_VERDICTS = ["confirmed", "plausible", "rejected"] as const

export const PrFinding = lazySchema(() => z.strictObject({
  id: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "a repository-relative path"),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  side: z.literal("RIGHT"),
  severity: z.enum(PR_FINDING_SEVERITIES),
  category: z.enum(PR_FINDING_CATEGORIES),
  summary: z.string().min(1).max(160),
  detail: z.string().min(1).max(1200),
  /** `file:line` references the finding rests on. */
  evidence: z.array(z.string().min(1).max(300)).max(12),
  /** The text that replaces lines `line`..`endLine` (or `line` alone): only for a fix that stays inside them. */
  suggestion: z.strictObject({ replacement: z.string().max(4000) }).optional(),
  verdict: z.enum(PR_FINDING_VERDICTS).optional(),
}))
export type PrFinding = z.infer<typeof PrFinding>

export const PrReviewResult = lazySchema(() => z.strictObject({
  head: z.string().min(1).max(200),
  base: z.string().min(1).max(200),
  findings: z.array(PrFinding).max(200),
  /** Candidates left out: outside the diff, rejected by the verifier, or past the cap. */
  dropped: z.number().int().nonnegative(),
  summary: z.string().max(8000),
  tokens: z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  budgetHit: z.boolean(),
}))
export type PrReviewResult = z.infer<typeof PrReviewResult>
