/**
 * The reviews this daemon runs now, as a watching terminal shows them (docs/pr-review.md, "Seeing a review run"): per job, its
 * watching session, its PR, when it started and its steps so far. Held in memory only, for running jobs only: a job's entry goes
 * when its run ends, and the session's final note stays the record. Every change hands the whole list to `emit` (a few jobs of a
 * few steps), so a terminal that missed one has the full picture with the next; nothing runs between changes.
 */

export type ReviewActivityStep = { label: string; detail?: string; startedAt: number; endedAt?: number }
export type ReviewActivityJob = { jobId: string; sessionId: string; repo: string; number: number; phase: string; startedAt: number; steps: ReviewActivityStep[] }

/** Jobs and steps the list keeps (the wire's bounds); the oldest finished steps go first. */
const MAX_JOBS = 16
const MAX_STEPS = 12
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function createReviewActivity({ now, emit }: { now: () => number; emit: (jobs: ReviewActivityJob[]) => void }) {
  const jobs = new Map<string, ReviewActivityJob>()

  const snapshot = (): ReviewActivityJob[] => [...jobs.values()].slice(0, MAX_JOBS).map((job) => ({ ...job, steps: job.steps.map((step) => ({ ...step })) }))
  const changed = () => { try { emit(snapshot()) } catch { /* a terminal that cannot hear it is not the review's problem */ } }

  /** A run of `jobId` starts (again: a retry starts its steps over). */
  function begin({ jobId, sessionId, repo, number }: { jobId: string; sessionId: string; repo: string; number: number }) {
    jobs.set(jobId, { jobId, sessionId, repo: clip(repo, 200), number, phase: "fetch", startedAt: now(), steps: [] })
    changed()
  }

  /** The next step of `jobId`'s run: the one before it ends now. Unknown jobs (no `begin`) are ignored. */
  function step(jobId: string, { phase, label, detail }: { phase: string; label: string; detail?: string | undefined }) {
    const job = jobs.get(jobId)
    if (!job) return
    const at = now()
    const last = job.steps.at(-1)
    if (last && last.endedAt === undefined) last.endedAt = at
    job.steps.push({ label: clip(label, 120), ...(detail ? { detail: clip(detail, 200) } : {}), startedAt: at })
    while (job.steps.length > MAX_STEPS) job.steps.shift()
    job.phase = clip(phase, 60)
    changed()
  }

  /** `jobId`'s run is over, whatever its outcome: it leaves the list. */
  function end(jobId: string) {
    if (jobs.delete(jobId)) changed()
  }

  return { begin, step, end, snapshot }
}
export type ReviewActivity = ReturnType<typeof createReviewActivity>
