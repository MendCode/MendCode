import type { GlobalEvent } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { renderToolCard } from "./tool-card"

/**
 * A PR review at work, as the terminal shows it (docs/pr-review.md, "Seeing a review run"): in the session that watches the
 * repository, its steps as tool rows above the prompt and the activity status naming the PR, its phase and its time; in any other
 * session, one footer word. All of it comes from the daemon's `pr.review.activity` event and goes when the run ends, leaving the
 * session's final note. Pure.
 */

export type ReviewActivityJob = Extract<GlobalEvent, { type: "pr.review.activity" }>["jobs"][number]

/** The reviews whose watching session is `sessionId`. */
export const reviewsIn = (jobs: readonly ReviewActivityJob[], sessionId: string) => jobs.filter((job) => job.sessionId === sessionId)

/** `Eden-sudo/Symbex-1` #25 as the footer names it: the repository without its owner. */
const shortName = (job: ReviewActivityJob) => `${job.repo.split("/").at(-1) ?? job.repo}#${job.number}`

/** The footer's word for the reviews running in other sessions than `sessionId` (`reviewing Symbex-1#25 +1`), or undefined. */
export function reviewFooterWord(jobs: readonly ReviewActivityJob[], sessionId: string): string | undefined {
  const elsewhere = jobs.filter((job) => job.sessionId !== sessionId)
  if (!elsewhere.length) return undefined
  return `reviewing ${shortName(elsewhere[0]!)}${elsewhere.length > 1 ? ` +${elsewhere.length - 1}` : ""}`
}

/** The activity status's words for the review that started first: `Reviewing Eden-sudo/Symbex-1#25 · analysis...`. */
export function reviewPhase(jobs: readonly ReviewActivityJob[]): string {
  const job = jobs[0]!
  return `Reviewing ${job.repo}#${job.number} · ${job.phase}${jobs.length > 1 ? ` · +${jobs.length - 1}` : ""}...`
}

/** When the oldest of `jobs` started, for the activity status's time. */
export const reviewStartedAt = (jobs: readonly ReviewActivityJob[]) => Math.min(...jobs.map((job) => job.startedAt))

/**
 * Each review's steps as tool rows, the last one running with the spinner: `◆ Review Analysis · 112 files · incremental  1m 3s`.
 * Several reviews each get a muted line naming their PR first.
 */
export function reviewStepRows({ jobs, width, frame, now, ascii }: { jobs: readonly ReviewActivityJob[]; width: number; frame: number; now: number; ascii?: boolean }): Line[] {
  const rows: Line[] = []
  for (const job of jobs) {
    if (jobs.length > 1) rows.push([{ text: "   " }, { text: `${job.repo}#${job.number}`, fg: "muted" }])
    for (const step of job.steps) {
      const running = step.endedAt === undefined
      rows.push(...renderToolCard({
        title: `review: ${step.label}${step.detail ? ` · ${step.detail}` : ""}`,
        text: "",
        status: running ? "running" : "ok",
        width,
        expanded: false,
        frame,
        tailLines: 0,
        elapsedMs: (step.endedAt ?? now) - step.startedAt,
        ...(ascii ? { ascii } : {}),
      }).slice(0, 1))
    }
  }
  return rows
}
