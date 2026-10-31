import type { JobLedger, ReviewJob } from "./contracts"

/**
 * Taking a job over (docs/pr-review.md, R06): the user opens the job's fix session from the reviews page and becomes its only
 * writer. `takeOver` sets `control: "user"` and pauses the job, so no automatic fix or push runs; the fix loop and `runFix` read
 * `controlOf` right before they write and stop with a `user` stop reason. `release` hands control back to the reviewer and puts
 * the job back in the queue (`pending`), where it resumes from its checkpoint. A single writer: a second take-over of a job already
 * held is refused with who holds it, and only the holder releases it. This is a guard inside one daemon's ledger; across devices
 * the job's ownership lease (ownership.ts) decides which daemon may run it at all.
 */

export type ControlResult = { ok: true; job: ReviewJob } | { ok: false; reason: string; holder?: string | undefined }

/** States with no automatic writer left to stop: a take-over has nothing to pause there (open the session directly). */
const FINISHED: ReadonlySet<ReviewJob["state"]> = new Set(["done", "failed", "cancelled", "stale"])
const HOLDER = /^taken over by (.+?) at \d{4}-/

/**
 * Who holds a job taken over: recorded in its stop reason (`taken over by <who> at <time>`), since the job has no field of its own
 * for it. `user` when it is held but the stop reason was replaced.
 */
export function holderOf(job: ReviewJob): string | undefined {
  if (job.control !== "user") return undefined
  return job.stop?.kind === "user" ? HOLDER.exec(job.stop.detail)?.[1] ?? "user" : "user"
}

/** Who may write to the job now: `user` after a take-over (or while the job sits paused by one), else the reviewer. */
export function controlOf(ledger: JobLedger, jobId: string): "reviewer" | "user" {
  return ledger.get(jobId)?.control === "user" ? "user" : "reviewer"
}

/** Gives `by` (the user's login or name) control of the job and pauses its automatic writes. */
export function takeOver({ ledger, jobId, now, by = "user" }: { ledger: JobLedger; jobId: string; now: () => number; by?: string }): ControlResult {
  const job = ledger.get(jobId)
  if (!job) return { ok: false, reason: `[PR_REVIEW]: no job ${jobId}` }
  const holder = holderOf(job)
  if (holder) return { ok: false, reason: `[PR_REVIEW]: the job is already taken over by ${holder}`, holder }
  if (FINISHED.has(job.state)) return { ok: false, reason: `[PR_REVIEW]: the job is ${job.state}: nothing runs automatically on it, so open its session directly` }
  const patch = { control: "user" as const, stop: { kind: "user" as const, detail: `taken over by ${by} at ${new Date(now()).toISOString()}`, resumable: true } }
  // A job paused for another reason (`@mendcode pause`) cannot move to paused again: it passes through pending, synchronously,
  // so no scheduler sees it there.
  if (job.state === "paused") ledger.transition(jobId, "pending")
  return { ok: true, job: ledger.transition(jobId, "paused", patch) }
}

/** Hands the job back to the reviewer and queues it again; only the holder (or `force`) may. */
export function release({ ledger, jobId, by = "user", force = false }: { ledger: JobLedger; jobId: string; now?: () => number; by?: string; force?: boolean }): ControlResult {
  const job = ledger.get(jobId)
  if (!job) return { ok: false, reason: `[PR_REVIEW]: no job ${jobId}` }
  const holder = holderOf(job)
  if (!holder) return { ok: false, reason: "[PR_REVIEW]: the job is not taken over" }
  if (!force && holder !== "user" && holder !== by) return { ok: false, reason: `[PR_REVIEW]: the job is held by ${holder}, not ${by}`, holder }
  if (job.state !== "paused") return { ok: false, reason: `[PR_REVIEW]: the job is ${job.state}, not paused by the take-over`, holder }
  return { ok: true, job: ledger.transition(jobId, "pending", { control: "reviewer", stop: undefined }) }
}
