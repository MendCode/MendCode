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

export const PR_CHANGE_TYPES = ["bug fix", "feature", "refactor", "performance", "tests", "docs", "build", "chore"] as const
export const PR_MERGE_RISKS = ["low", "medium", "high"] as const
export const PR_CHECK_STATUSES = ["passed", "warning", "failed"] as const

/** One group of the walkthrough's changes table: related files (a layer or a purpose) and what changed in them. */
export const PrWalkthroughChange = lazySchema(() => z.strictObject({
  layer: z.string().min(1).max(80),
  files: z.array(z.string().min(1).max(500)).min(1).max(40),
  summary: z.string().min(1).max(400),
}))
export type PrWalkthroughChange = z.infer<typeof PrWalkthroughChange>

/** A pre-merge check: whether the title, description and linked issues match the change, and what is out of scope. */
export const PrPreMergeCheck = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(40),
  status: z.enum(PR_CHECK_STATUSES),
  explanation: z.string().min(1).max(600),
}))
export type PrPreMergeCheck = z.infer<typeof PrPreMergeCheck>

/**
 * What the change is, for a reader who has not opened it: an overview, the changes grouped by layer, a sequence diagram when the
 * change alters how components call each other, its type, the merge risk with its reason, and the pre-merge checks. Written by the
 * review pass; the risk is never below what the confirmed findings show (`docs/pr-review.md`).
 */
export const PrWalkthrough = lazySchema(() => z.strictObject({
  overview: z.string().min(1).max(1500),
  changes: z.array(PrWalkthroughChange).max(12),
  /** A Mermaid `sequenceDiagram` or `flowchart`, without its fence. */
  diagram: z.string().min(1).max(3000).optional(),
  type: z.enum(PR_CHANGE_TYPES),
  risk: z.strictObject({ level: z.enum(PR_MERGE_RISKS), reason: z.string().min(1).max(600) }),
  checks: z.array(PrPreMergeCheck).max(6),
}))
export type PrWalkthrough = z.infer<typeof PrWalkthrough>

export const PrReviewResult = lazySchema(() => z.strictObject({
  head: z.string().min(1).max(200),
  base: z.string().min(1).max(200),
  findings: z.array(PrFinding).max(200),
  /** Candidates left out: outside the diff, rejected by the verifier, or past the cap. */
  dropped: z.number().int().nonnegative(),
  summary: z.string().max(8000),
  /** `cached`: the part of `input` the provider served from its cache; the PR budget does not count it. */
  tokens: z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cached: z.number().int().nonnegative().optional() }),
  budgetHit: z.boolean(),
  walkthrough: PrWalkthrough.optional(),
}))
export type PrReviewResult = z.infer<typeof PrReviewResult>
