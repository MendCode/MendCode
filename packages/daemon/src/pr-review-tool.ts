import type { PrReviewPort } from "@mendcode/tools"
import type { PrJobSummary } from "@mendcode/protocol"
export { createPrReviewTool, NO_SELF_MENTION, PrReviewToolArgs } from "./pr-review-tool-definition"

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
