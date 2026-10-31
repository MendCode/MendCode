import type { PrFinding, PrStopReason } from "@mendcode/protocol"
import type { FixResult } from "./commands"
import { JOB_TRANSITIONS, type JobLedger, type JobState, type ReviewJob } from "./contracts"
import { normalizeSummary } from "./fingerprint"
import { ReviewTurnError } from "./sessions"

/**
 * The fix modes after a review (docs/pr-review.md, R06/R08): `fix-once` is one round, `fix-loop` repeats rounds until no confirmed
 * finding is open. A round fixes the open findings (`fixing`), then validates the result and reviews again (`validating`). The
 * loop ends `done` only when the review finds nothing open and the validation passed: a failed validation never ends `done`. It
 * stops early, with the reason as a `PrStopReason`, when the open set does not shrink for `maxNoProgress` rounds (`no_progress`),
 * at `maxRounds` (`max_rounds`), when the user holds the job (`user`, the job is left `paused`) or on a quota or rate limit (the job
 * is `checkpointed`, resumable). Every round is recorded in the job's checkpoint (`rounds`), so a resumed loop counts the rounds it
 * already spent and continues from the head the last round pushed.
 *
 * A round counts as resolving findings only when the review of the head it pushed ran: a review that could not run there (the forge
 * never reported the pushed head, or the head moved past it) says so (`unreviewed`) and the loop ends `failed` (or `stale`) with
 * the findings it set out to fix still listed, never `done`. When it ran, the round resolves only the findings its re-check closed
 * (`openAfterRound`): the rest stay open for the next round, or for the stop that names them. A round the user interrupted by taking the job over before its push is
 * recorded `interrupted` with its kept commit and does not count against `max_rounds` or the no-progress guard: after the release
 * the loop pushes that kept fix (`resumeKept`) instead of a second fix, or redoes the round when the kept fix no longer applies.
 */

export type FixMode = "review" | "fix-once" | "fix-loop"
/** Rounds a fix mode runs: none for `review`, one for `fix-once`, `max_rounds` for `fix-loop`. */
export const roundsFor = (mode: FixMode, maxRounds: number) => mode === "review" ? 0 : mode === "fix-once" ? 1 : maxRounds

export type ReviewAnswer = { open: PrFinding[]; unreviewed?: { reason: string; stale?: boolean | undefined } | undefined }
type Round = ReviewJob["checkpoint"]["rounds"][number]
/** Rounds that count against `max_rounds` and the no-progress guard: a round interrupted by a take-over before its push does not. */
export const countedRounds = (rounds: readonly Round[]) => rounds.filter((round) => !round.interrupted)

export type FixLoopInput = {
  jobId: string
  ledger: JobLedger
  /**
   * Reviews the PR's current head; `open` are the confirmed findings still open. `unreviewed`: the review of the head a round
   * pushed could not run (why, and `stale` when the head moved past the pushed fix), so nothing is known about what it resolved.
   */
  review(fixing: readonly PrFinding[]): Promise<ReviewAnswer>
  /** Fixes `findings` in one commit (`runFix`), pushed or kept by its own revalidation. */
  fix(findings: PrFinding[]): Promise<FixResult>
  /** Pushes the kept fix of a round the user interrupted (`pushKept`); undefined when it no longer applies and the round is redone. */
  resumeKept?(round: { commit: string; kept: string }): Promise<FixResult | undefined>
  /** The repository's checks on the result (and anything else that must pass before the job may close). */
  validate(): Promise<{ ok: boolean; detail: string }>
  maxRounds: number
  maxNoProgress: number
  /** Who holds the job, read right before each write: `user` after a take-over. */
  controlOf(): "reviewer" | "user"
  now?: () => number
}

export type FixLoopOutcome = {
  state: Extract<JobState, "done" | "failed" | "checkpointed" | "paused" | "stale" | "cancelled">
  rounds: number
  /** Ids of the confirmed findings still open when the loop ended. */
  open: string[]
  stop?: PrStopReason | undefined
  /** The local ref of a fix that was committed but not pushed. */
  kept?: string | undefined
  /** The last pushed fix was not reviewed (`ReviewAnswer.unreviewed`): `open` are the findings it set out to fix, not re-checked. */
  unreviewed?: boolean | undefined
}

/** States the loop works in; any other state means someone else moved the job (a take-over, a cancel, a stale head). */
const ACTIVE: ReadonlySet<JobState> = new Set(["running", "fixing", "validating"])
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const SHOWN_PLACES = 5
/** Where the open findings are (`path:line`, the first five), so a stop names what is left, not only how many. */
const where = (findings: readonly PrFinding[]) => `${findings.slice(0, SHOWN_PLACES).map((finding) => `${finding.path}:${finding.line}`).join(", ").slice(0, 300)}${findings.length > SHOWN_PLACES ? `, ${findings.length - SHOWN_PLACES} more` : ""}`

/** The same defect reported again on a later head: its line (and so its id) moved, what it says did not. */
const sameDefect = (a: PrFinding, b: PrFinding) => a.id === b.id || a.path === b.path && a.category === b.category && normalizeSummary(a.summary) === normalizeSummary(b.summary)

/**
 * The confirmed findings open after the review of a round's pushed fix: what that review confirmed, plus every finding the round
 * set out to fix (`fixing`) that its re-check did not close (`fixed`, run.ts) and the review did not report again. The review of a
 * pushed fix is incremental (only the fix's commits), so its own findings never include an old one the fix missed: without the
 * re-check's answer, a fix that inserted a line next to the flagged one counted as resolving a finding nothing closed (seen live).
 * Without `fixed` (a whole-PR review, which finds again whatever is still there) it is what the review confirmed.
 */
export function openAfterRound({ fixing, found, fixed }: { fixing: readonly PrFinding[]; found: readonly PrFinding[]; fixed?: readonly string[] | undefined }): PrFinding[] {
  if (!fixed) return [...found]
  const closed = new Set(fixed)
  return [...found, ...fixing.filter((finding) => !closed.has(finding.id) && !found.some((again) => sameDefect(again, finding)))]
}

/** Trailing rounds of `history` (open counts, oldest first, starting with the review before round one) whose open set did not shrink. */
function stalled(counts: readonly number[]) {
  let run = 0
  for (let index = counts.length - 1; index > 0 && counts[index]! >= counts[index - 1]!; index--) run++
  return run
}

export async function runFixLoop(input: FixLoopInput): Promise<FixLoopOutcome> {
  const { ledger, jobId } = input
  const now = input.now ?? Date.now
  const job = () => { const found = ledger.get(jobId); if (!found) throw new ReferenceError(`[PR_REVIEW]: no job ${jobId}`); return found }
  let open: PrFinding[] = []
  let rounds = countedRounds(job().checkpoint.rounds).length
  let kept: string | undefined
  let unreviewed = false
  /** The kept fix of a round a take-over interrupted before its push: the first round after the release pushes it. */
  const last = job().checkpoint.rounds.at(-1)
  let carried = last?.interrupted && last.commit && last.kept ? { commit: last.commit, kept: last.kept } : undefined
  /** The newest fix session, recorded on the job with its next move so the user can open it. */
  let fixSessionId: string | undefined
  const ids = () => open.map((finding) => finding.id)
  const outcome = (state: FixLoopOutcome["state"], stop?: PrStopReason): FixLoopOutcome => ({ state, rounds, open: ids(), ...(stop ? { stop } : {}), ...(kept ? { kept } : {}), ...(unreviewed ? { unreviewed } : {}) })
  const remaining = () => open.length ? `${plural(open.length, "confirmed finding")} still open (${where(open)})` : undefined
  const stopWith = (stop: Omit<PrStopReason, "remaining">): PrStopReason => { const left = remaining(); return left ? { ...stop, remaining: left } : stop }

  /** The job as someone else left it, when it is no longer the loop's to move (taken over, cancelled, stale). */
  const interrupted = (): FixLoopOutcome | undefined => {
    const current = job()
    if (current.control === "user" || current.state === "paused") return outcome("paused", current.stop ?? { kind: "user", detail: "the job was paused while the fix loop ran", resumable: true })
    if (current.state === "cancelled" || current.state === "stale") return outcome(current.state, current.stop)
    return undefined
  }
  /**
   * Moves the job (with the newest fix session's id), skipping a move to the state it is already in: `JOB_TRANSITIONS` has no
   * self-transition, so the id then waits for the next move.
   */
  const move = (state: JobState, patch: Partial<Omit<ReviewJob, "id" | "state">> = {}) => {
    if (job().state === state) return job()
    return ledger.transition(jobId, state, fixSessionId && job().fixSessionId !== fixSessionId ? { ...patch, fixSessionId } : patch)
  }
  /** The loop's last move, unless someone else moved the job meanwhile (a take-over during the validation): then theirs stands. */
  const end = (state: "done" | "failed" | "checkpointed" | "stale", stop?: PrStopReason): FixLoopOutcome => {
    const stopped = held()
    if (stopped) return stopped
    move(state, { stop })
    return outcome(state, stop)
  }
  /** The user holds the job: nothing more is written, and a job not paused yet by `takeOver` is paused here. */
  const yieldToUser = () => {
    const stop: PrStopReason = stopWith({ kind: "user", detail: "the user holds the job's fix session; automatic fixes wait until it is released", resumable: true })
    const current = job()
    if (current.state !== "paused" && JOB_TRANSITIONS[current.state].includes("paused")) ledger.transition(jobId, "paused", { stop, control: "user" })
    return outcome("paused", current.stop?.kind === "user" ? current.stop : stop)
  }
  /**
   * Read after every await, before the next transition or write: the job as a take-over, cancel or stale head left it, or the
   * user's control as `controlOf` reports it. Undefined: the loop still owns the job.
   */
  const held = (): FixLoopOutcome | undefined => interrupted() ?? (input.controlOf() === "user" ? yieldToUser() : undefined)

  try {
    const first = held()
    if (first) return first
    if (job().state === "checkpointed") ledger.transition(jobId, "pending")
    if (job().state === "pending" || job().state === "waiting") ledger.transition(jobId, "running", { stop: undefined })
    if (!ACTIVE.has(job().state)) throw new RangeError(`[PR_REVIEW]: the fix loop cannot run a ${job().state} job`)

    open = (await input.review([])).open
    const counts = [...countedRounds(job().checkpoint.rounds).map((round) => round.open.length).slice(-input.maxNoProgress - 1)]
    if (!counts.length || counts.at(-1) !== open.length) counts.push(open.length)
    let validation: { ok: boolean; detail: string } | undefined

    for (;;) {
      const stopped = held()
      if (stopped) return stopped
      if (!open.length) {
        move("validating")
        validation ??= await input.validate()
        if (validation.ok) return end("done")
        return end("failed", { kind: "error", detail: `no confirmed finding is open, but the validation failed: ${validation.detail}`.slice(0, 600), resumable: false })
      }
      if (rounds >= input.maxRounds) {
        const stop = stopWith({ kind: "max_rounds", detail: `${plural(rounds, "fix round")} of ${input.maxRounds} used${validation && !validation.ok ? `; the last validation failed: ${validation.detail}` : ""}`.slice(0, 600), unit: "rounds", used: rounds, limit: input.maxRounds, resumable: false })
        return end("failed", stop)
      }
      const still = stalled(counts)
      if (still >= input.maxNoProgress) {
        return end("failed", stopWith({ kind: "no_progress", detail: `the open findings did not shrink for ${plural(still, "round")}`, unit: "rounds", used: still, limit: input.maxNoProgress, resumable: false }))
      }

      move("fixing")
      const reused = carried && input.resumeKept ? await input.resumeKept(carried) : undefined
      carried = undefined
      const fixed = reused ?? await input.fix(open)
      if (fixed.kept) kept = fixed.kept
      if (fixed.sessionId) fixSessionId = fixed.sessionId

      /**
       * The round in the checkpoint, once. One the user interrupted before its push (a take-over) is kept with its commit and ref
       * and does not count: the release continues from it. Every other round counts, pushed or not.
       */
      const record = (interrupted = false) => {
        if (!interrupted) rounds++
        ledger.checkpoint(jobId, { rounds: [...job().checkpoint.rounds, { at: now(), open: ids(), ...(fixed.commit ? { commit: fixed.commit } : {}), ...(interrupted ? { interrupted: true as const, ...(fixed.kept ? { kept: fixed.kept } : {}) } : {}) }] })
      }
      const pushed = fixed.ok && fixed.pushed
      // Taken over (or cancelled) while the fix ran: its round is recorded and the job is left as the user put it.
      const during = held()
      if (!fixed.ok || during) {
        record(!!during && !pushed)
        if (during) return during
      }
      if (!fixed.ok) {
        if (fixed.stale) return end("stale", stopWith({ kind: "superseded", detail: fixed.reason.slice(0, 600), resumable: false }))
        return end("failed", stopWith({ kind: "error", detail: `the fix did not land: ${fixed.reason}`.slice(0, 600), resumable: false }))
      }

      move("validating")
      validation = await input.validate()
      const validated = held()
      if (validated || !fixed.pushed) record(!!validated && !fixed.pushed)
      if (validated) return validated
      if (!fixed.pushed) {
        // Kept locally (not pushed): the PR's head does not have it, so reviewing again would only see the same findings.
        if (!validation.ok) return end("failed", stopWith({ kind: "error", detail: `the fix was kept locally, and its validation failed: ${validation.detail}`.slice(0, 600), resumable: false }))
        return end("done", stopWith({ kind: "permission", detail: `${fixed.notPushed ?? "`fix.push` is off"}: the fix is committed as ${fixed.commit.slice(0, 12)} and kept as ${fixed.kept ?? "a local ref"}, not pushed`.slice(0, 600), resumable: false }))
      }
      let after: ReviewAnswer
      // A review that throws (a quota stop checkpoints the job) leaves the round unrecorded, as before: the resume reviews first.
      try { after = await input.review(open) } catch (error) { rounds++; throw error }
      if (after.unreviewed) {
        // Pushed but not reviewed: the round counts (its commit is on the branch), and the findings it set out to fix stay listed.
        record()
        unreviewed = true
        const detail = `the fix ${fixed.commit.slice(0, 12)} was pushed but not reviewed: ${after.unreviewed.reason}`.slice(0, 600)
        const notChecked = open.length ? { remaining: `${plural(open.length, "confirmed finding")} not checked again after the fix` } : {}
        if (after.unreviewed.stale) return end("stale", { kind: "superseded", detail, resumable: false, ...notChecked })
        return end("failed", { kind: "error", detail, resumable: false, ...notChecked })
      }
      open = after.open
      counts.push(open.length)
      record()
    }
  } catch (error) {
    // A turn that failed because the user took the job over (its session cancelled) ends as the user left it, not as a failure.
    const stopped = error instanceof ReferenceError ? undefined : held()
    if (stopped) return stopped
    if (error instanceof ReviewTurnError && error.kind !== "error") {
      const stop = stopWith({ kind: error.kind, detail: error.message.replace(/^\[PR_REVIEW\]:\s*/, "").slice(0, 600), ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}), resumable: true })
      move("checkpointed", { stop, ...(error.resetsAt ? { notBefore: error.resetsAt } : {}) })
      return outcome("checkpointed", stop)
    }
    if (error instanceof RangeError || error instanceof ReferenceError) throw error
    const message = error instanceof Error ? error.message : String(error)
    return end("failed", stopWith({ kind: "error", detail: message.replace(/^\[PR_REVIEW\]:\s*/, "").slice(0, 600) || "the fix loop failed", resumable: false }))
  }
}
