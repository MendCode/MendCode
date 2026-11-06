import type { GlobalEvent } from "@mendcode/protocol"

/**
 * A PR review at work, as the terminal shows it (docs/pr-review.md, "Seeing a review run"): in the session that watches the
 * repository, one live line, the activity status naming the PR, its phase, the running step's detail and its time; in any other
 * session, or while the watching session's own turn holds the status, one footer word. All of it comes from the daemon's `pr.review.activity` event and goes when the run ends, leaving the
 * session's final note. Pure.
 */

export type ReviewActivityJob = Extract<GlobalEvent, { type: "pr.review.activity" }>["jobs"][number]

/** The reviews whose watching session is `sessionId`. */
export const reviewsIn = (jobs: readonly ReviewActivityJob[], sessionId: string) => jobs.filter((job) => job.sessionId === sessionId)

/** `Eden-sudo/Symbex-1` #25 as the footer names it: the repository without its owner. */
const shortName = (job: ReviewActivityJob) => `${job.repo.split("/").at(-1) ?? job.repo}#${job.number}`

/**
 * The footer's word for the reviews it should name (`reviewing Symbex-1#25 +1`), or undefined: those of other sessions, and this
 * session's own while its turn holds the activity status.
 */
export function reviewFooterWord(jobs: readonly ReviewActivityJob[], sessionId: string, ownBusy = false): string | undefined {
  const named = ownBusy ? jobs : jobs.filter((job) => job.sessionId !== sessionId)
  if (!named.length) return undefined
  return `reviewing ${shortName(named[0]!)}${named.length > 1 ? ` +${named.length - 1}` : ""}`
}

/** The one live line of the review that started first: `Reviewing #25 · analysis · 112 files · incremental...`. */
export function reviewPhase(jobs: readonly ReviewActivityJob[]): string {
  const job = jobs[0]!
  const detail = job.steps.find((step) => step.endedAt === undefined)?.detail
  return `Reviewing #${job.number} · ${job.phase}${detail ? ` · ${detail}` : ""}${jobs.length > 1 ? ` · +${jobs.length - 1}` : ""}...`
}

/** When the oldest of `jobs` started, for the activity status's time. */
export const reviewStartedAt = (jobs: readonly ReviewActivityJob[]) => Math.min(...jobs.map((job) => job.startedAt))
