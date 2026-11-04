import { z } from "zod"
import { defineTool, fail, type PrReviewPort } from "@mendcode/tools"
import type { PrJobSummary } from "@mendcode/protocol"

/**
 * `pr_review`: the model's way to have MendCode's own PR reviewer review one pull request now (docs/pr-review.md), the same
 * `pr.review` `review` action `/pr review <n>` sends, for this session's checkout; and `status`, the reviewer's jobs of that
 * checkout. A review never starts with a comment on the forge: before this tool a session asked to review a PR posted
 * "@mendcode review" from the user's own account to trigger its reviewer. The reviewer applies the repository's filters, claims
 * the PR and posts only as the user's `/pr publish` consent allows; until that is given the review stays in this session.
 *
 * The session's port comes from the daemon (`createPrReviewPort`, bound to the session) through the tool context's `prReview`;
 * a host without it gets an answer saying the tool is unavailable there. Remote turns and review children never get the tool.
 */

export type { PrReviewPort }

/** The service's `control` as this port uses it (pr-review/service.ts): only `review` and `status`. */
export type PrReviewControl = (input: { sessionId: string; action: "review" | "status"; pr?: string | undefined; full?: boolean | undefined }) => Promise<
  | { ok: true; text: string; watches: ReadonlyArray<{ directory: string; publish: string }>; dashboard?: { jobs: readonly PrJobSummary[]; watches: ReadonlyArray<{ directory: string; repo?: string | undefined }> } | undefined }
  | { ok: false; message: string }
>

/** The rule every guidance text carries: a review is started by the reviewer itself, never by a comment from the user's account. */
export const NO_SELF_MENTION = "To review a PR now, call pr_review with action review (or the user runs /pr review <n>); never post an @mendcode comment, or anything else, on the forge from the user's account to trigger a review, and never post without the user's consent."

const STATUS_JOBS = 10

/** What happens to the review's post, from the watch row's consent for this checkout (`allowed`, `denied`, else not asked). */
export function postingLine(publish: string | undefined): string {
  if (publish === "allowed") return "Posting: allowed for this repository (/pr publish on), so the review is posted on the PR as one COMMENT review when it ends, if the repository's config lets this login post."
  if (publish === "denied") return "Posting: off for this repository (/pr publish off), so the review stays in this session and nothing is posted."
  return "Posting: not allowed for this repository yet, so the review stays in this session; the user is asked once, and only /pr publish on posts it. Nothing is posted without that consent."
}

const jobLine = (job: PrJobSummary) => {
  const found = job.findings.confirmed + job.findings.plausible
  return `  ${job.repo}#${job.number} ${job.coverage} (${job.reviewer}): ${job.state}${job.phase ? ` (${job.phase})` : ""}${found ? `, ${found} finding${found === 1 ? "" : "s"}` : ""}${job.stop ? `, stopped: ${job.stop.kind} (${job.stop.detail.slice(0, 160)})` : ""}${job.error ? `, ${job.error.slice(0, 160)}` : ""} [job ${job.id}]`
}

/** The daemon's port for one session: `directory` is the session's checkout, `control` the PR review service's. */
export function createPrReviewPort({ sessionId, directory, control }: { sessionId: string; directory: () => string | undefined; control: PrReviewControl }): PrReviewPort {
  const consent = async () => {
    const status = await control({ sessionId, action: "status" }).catch(() => undefined)
    const here = directory()
    return status?.ok ? status.watches.find((row) => row.directory === here)?.publish : undefined
  }
  return {
    async preview({ pr }) {
      return [
        `Review ${pr ? `pull request ${pr}` : "the pull request of the current branch"} of ${directory() ?? "this session's checkout"} now with MendCode's own reviewer: two passes in read-only child sessions, spending model calls, as /pr review does. The repository's filters apply.`,
        "Nothing is commented on the pull request to start it.",
        postingLine(await consent()),
      ].join("\n")
    },
    async review({ pr, full }) {
      const done = await control({ sessionId, action: "review", ...(pr ? { pr } : {}), ...(full ? { full } : {}) }).catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
      if (!done.ok) return done
      return { ok: true, text: `${done.text}\n${postingLine(done.watches.find((row) => row.directory === directory())?.publish ?? await consent())}` }
    },
    async status() {
      const done = await control({ sessionId, action: "status" }).catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
      if (!done.ok) return done
      const here = directory()
      // A job names its repository, not its checkout: this checkout's repository is its watch's, else every job is shown.
      const repo = done.dashboard?.watches.find((row) => row.directory === here)?.repo
      const jobs = (done.dashboard?.jobs ?? []).filter((job) => !repo || job.repo.toLowerCase() === repo.toLowerCase())
      const shown = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, STATUS_JOBS)
      return {
        ok: true,
        text: [
          done.text,
          ...(shown.length ? [`${repo ? `Jobs of ${repo}` : "Jobs of this daemon"}, newest first:`, ...shown.map(jobLine)] : [`No review jobs${repo ? ` of ${repo}` : ""}.`]),
          ...(jobs.length > shown.length ? [`  … ${jobs.length - shown.length} older jobs (/reviews lists them all)`] : []),
          postingLine(done.watches.find((row) => row.directory === here)?.publish),
        ].join("\n"),
      }
    },
  }
}

export const PrReviewToolArgs = z.strictObject({
  action: z.enum(["review", "status"]),
  pr: z.string().trim().min(1).max(300).optional().describe("review: the PR number or URL; omitted, the PR of the checkout's current branch"),
  // No description: every prompt that lists the tool would pay for it. The answer to a review of an already reviewed head names it.
  full: z.boolean().optional(),
})

/** `enabled`: `experimental.pr_review` is on (checked on every call). */
export function createPrReviewTool({ enabled }: { enabled(): boolean }) {
  return defineTool({
    name: "pr_review",
    tier: "balanced",
    description: [
      "Have MendCode's own PR reviewer review one pull request of this checkout now (action review, pr: number or URL; omitted, the current branch's PR), exactly as the user's /pr review does: two passes in read-only child sessions, the repository's filters and claims apply, and the findings arrive in this session.",      "It posts on the PR only as the user's /pr publish consent allows; until then the review stays in this session. action status lists this checkout's review jobs and the posting consent.",
      NO_SELF_MENTION,
      "To review every new PR from now on, the user runs /pr watch-repo; to set up or configure the reviewer, use review_config (setup first).",
    ].join(" "),
    // A review spends model calls and may post (as `/pr publish` allows), but runs no code the model wrote: it follows the session's
    // permission mode like a command (full access runs it, accept-edits and default ask, and a grant for the session or always holds).
    permission: "execute",
    permissionFor: (args) => (args.action === "review" ? "execute" : "read"),
    args: PrReviewToolArgs,
    async preview(args, context) {
      const port = context.prReview
      if (args.action !== "review" || !port || !enabled()) return undefined
      return port.preview({ pr: args.pr }).catch(() => undefined)
    },
    async execute(args, context) {
      const title = `pr_review ${args.action}${args.pr ? ` ${args.pr}` : ""}`
      if (!enabled()) return fail({ title, message: "The PR reviewer is off: the user turns it on with /pr on (experimental.pr_review)." })
      const port = context.prReview
      if (!port) return fail({ title, message: "MendCode's PR reviewer is not available in this session (it runs only in a local session of the daemon's machine). Ask the user to run /pr review <n>; do not comment on the PR to trigger it." })
      const done = args.action === "review" ? await port.review({ pr: args.pr, full: args.full }) : await port.status()
      if (!done.ok) return fail({ title, message: `[PR_REVIEW]: ${done.message}` })
      return { output: done.text, truncated: false, title, isError: false }
    },
  })
}
