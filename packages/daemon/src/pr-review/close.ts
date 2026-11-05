import type { ReviewContext } from "./context"
import type { PartialReview } from "./template"

/**
 * The closing of a review that reached its token budget (docs/pr-review.md, "A review that reaches the cap"). A review never ends
 * without a result: at the cap, or when what is left of the diff cannot fit under it, it makes ONE compact closing check of the
 * candidate findings it already has and publishes what it verified as a partial review that says what it covered and what it did not.
 *
 * The closing is bounded on its own and is not part of `budget.tokens_per_pr`: one verify call over at most `CLOSE_MAX_CANDIDATES`
 * candidates (one batch, no second batch), told to check only the cited lines and their direct callers, and stopped by the daemon
 * when it counts `CLOSE_TOKENS` (a turn is stopped after the request that passes it, so a little more can be counted). It never
 * reads the diff again and never reviews another part. This file holds the figures and the wording; `engine.ts` runs the call.
 */

/** The most tokens the closing check may count, over the cap. */
export const CLOSE_TOKENS = 30_000
/** The most candidate findings the closing check judges (one verify batch): the most severe first, the rest are counted, not published. */
export const CLOSE_MAX_CANDIDATES = 8
/** The closing check's extra instruction to the verifier: short, bounded, no re-review. */
export const CLOSE_INSTRUCTION = "This is a short closing check: the review's token budget is spent. Check each finding against the lines it cites and their direct callers only, do not review anything else, keep every evidence note to one line, and answer at once."

/** The end of the "could not afford the next part" explanation that is only true of a review that publishes nothing (engine.ts `shortText`). */
export const NOTHING_PUBLISHED_TAIL = " Nothing is published until the rest is reviewed and every candidate verified; raise budget.tokens_per_pr and resume."

const unique =(files: readonly string[]) => [...new Set(files)]

/**
 * What a partial review covered. With a diff in parts, the files of the first `done` parts were reviewed and the rest were not;
 * without parts, the whole diff was reviewed and only candidates are left unverified. `unverified`: candidates not judged.
 */
export function partialReview({ context, done, total, unverified, why, number }: { context: ReviewContext; done: number; total: number; unverified: number; why: string; number?: number | undefined }): PartialReview {
  const parts = context.parts && context.parts.length > 1 && context.parts.length === total ? context.parts : undefined
  const reviewed = parts ? unique(parts.slice(0, done).flatMap((part) => part.files)) : context.files.map((file) => file.path)
  const notReviewed = parts ? unique(parts.slice(done).flatMap((part) => part.files)) : []
  const where = parts ? `${done} of ${total} parts of the diff were reviewed` : "the whole diff was reviewed"
  return {
    reviewed, notReviewed, unverified, ...(number !== undefined ? { number } : {}),
    why: `${why.replace(NOTHING_PUBLISHED_TAIL, "").trim().replace(/[.!]*$/, ".")}${where[0]!.toUpperCase()}${where.slice(1)}, then one short closing check, bounded on its own, verified the strongest candidate findings.`,
  }
}

/** The line a partial review adds to the summary, for the session and for the notice. */
export function partialNote(partial: PartialReview): string {
  const files = partial.reviewed.length + partial.notReviewed.length
  return `Partial review: ${partial.notReviewed.length ? `${partial.reviewed.length} of ${files} files reviewed, ${partial.notReviewed.length} not` : `all ${files} files reviewed`}${partial.unverified ? `; ${partial.unverified} candidate finding${partial.unverified === 1 ? "" : "s"} not verified (not published)` : ""}. ${partial.why} Published as partial; the next /pr review continues from the checkpoint with what is missing.`
}
