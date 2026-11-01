import { MAX_DRAFT_CHARS, type BlobRef, type ModelChoice, type RequestId, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { parseResetTime } from "../usage-limit-reset"
import { classifyStop } from "./budget"
import type { ReviewSession, ReviewSessionFactory, ReviewTurn } from "./engine"
import { languageInstruction } from "./template"

/**
 * A review prompt as a message the session stores: one longer than a message may be (a large pull request's diff and
 * files) goes whole into a text attachment, which the native engine reads itself and other engines get put back in.
 */
export function reviewMessage(prompt: string, putText: (bytes: Uint8Array) => BlobRef): { text: string; attachments: BlobRef[] } {
  if (prompt.length <= MAX_DRAFT_CHARS) return { text: prompt, attachments: [] }
  return { text: "The review request (instructions and the pull request) is the attached text. Follow it.", attachments: [putText(new TextEncoder().encode(prompt))] }
}

/**
 * The review children the daemon runs (docs/pr-review.md): each `ReviewSession` is a hidden session in plan mode on the read-only
 * `explore` agent, so a review reads and searches but never edits or runs commands. A request for approval is refused (nobody is
 * there to answer), a turn is stopped when its child goes silent (`TURN_IDLE_MS`) or passes `TURN_CAP_MS` (`ReviewTurnStalled`),
 * and the answer is the turn's last message with the provider-reported tokens
 * of its calls. The session is removed once the review is done.
 *
 * A fix session (`editing`) is kept instead: its id comes back on the session (`id`), the job records it as `fixSessionId`, and the
 * user opens it from the reviews page to see what happened, take over and continue. Resuming it continues the same harness's
 * session (native, Claude Code or Codex, whichever ran it). Continuing it on a different harness is an explicit handoff, a new
 * session given the job's findings, checkpoint and diff, never a claim that one harness resumes another's internal transcript.
 */

export const REVIEW_AGENT = "explore"
/**
 * Tools a review child is not offered. `explore` has `shell`, but plan mode refuses every command, so a model that read with
 * `git show` or `sed` got only refusals and reported that its repository reads were denied; `read`, `grep` and `glob` remain.
 * `skill` loaded the user's own review skill, whose files live outside the checkout: the read that named them asked for
 * approval, was refused as a whole, and the in-repository files it also named were never read (a live review).
 * `memory`, `memory_graph` and `remember` read and write the user's native memory: a review child gets only the review context
 * review-memory.ts chose for its reviewer (the global reviewer never sees user-scope memory), never the store itself.
 */
export const REVIEW_EXCLUDED_TOOLS: readonly string[] = ["shell*", "skill", "memory", "memory_graph", "remember", "review_config", "pr_review"]
/** Why a review child's approval request is refused: what it may still read, so it reads that instead of giving up. */
export const REVIEW_APPROVAL_REFUSED = "A PR review cannot ask for approval, so files outside the pull request's checkout cannot be read. Read the files of the checkout itself, with paths relative to it (each call only those), and answer from them."
/**
 * How long a review, verify or fix turn may go without any event from its child (a streamed delta, a tool call, a usage report)
 * before it counts as stalled and is stopped. A turn that keeps streaming is never stopped by this: a large pull request's review
 * can rightly take longer than any fixed wall time (a 15-minute wall-time limit stopped a live review of a large ML pull request
 * mid-work). A fix session waiting for the user's approval is not idle.
 */
export const TURN_IDLE_MS = 10 * 60_000
/** The hard cap on one turn's wall time, however active it is: a child that never ends cannot hold a job forever. */
export const TURN_CAP_MS = 2 * 3_600_000

/**
 * Why a review or fix turn failed, from the engine's error: `quota` when the account's usage is spent until a reset (Claude Code's
 * "Claude AI usage limit reached|<epoch>" or "You've hit your limit · resets 9pm", Codex's "You've hit your usage limit", the native
 * engine's `429 usage_limit_reached` / `insufficient_quota`), `rate_limit` for a throttle that a short wait cures (a 429 or 529 the
 * engine gave up retrying, `rate_limit_error`, "Too Many Requests", "overloaded"), else `error`. The quota wording is checked first:
 * a spent quota also arrives as a 429. The budget front checkpoints the job on the first two instead of failing it.
 */
export type TurnFailureKind = "quota" | "rate_limit" | "error"
/** One classifier for the platform: budget.ts's `classifyStop` (a context overflow is not a quota; Claude Code's "5-hour limit reached"). */
export const turnFailureKind = (message: string, code = ""): TurnFailureKind => classifyStop(message, { code }).kind

/** A review or fix turn that did not complete: its `kind` (and the reset the message names, if any) lets the caller checkpoint. */
export class ReviewTurnError extends Error {
  readonly kind: TurnFailureKind
  readonly resetsAt: number | undefined
  /** What the provider reported for this turn before it failed or was stopped (a partial report), when it reported anything. */
  spent: ReviewTurn["tokens"] | undefined
  constructor(message: string, kind: TurnFailureKind, resetsAt?: number | undefined) {
    super(message)
    this.name = "ReviewTurnError"
    this.kind = kind
    this.resetsAt = resetsAt
    this.spent = undefined
  }
}
/** `error` carrying what `tokens` holds, when the turn reported any usage before it ended. */
const withSpent = <T extends ReviewTurnError>(error: T, tokens: ReviewTurn["tokens"], reported: boolean): T => { if (reported) error.spent = { ...tokens }; return error }

/**
 * A turn the daemon stopped because its child went silent for `TURN_IDLE_MS` (`idle`) or ran past `TURN_CAP_MS` (`cap`). Its kind
 * is `error` (it is not a provider limit), but it is retryable: run.ts checkpoints what the job finished before it and the retry
 * continues from there. The words avoid "timeout": a stall is not a network outage, so each retry spends one of the job's attempts.
 */
export class ReviewTurnStalled extends ReviewTurnError {
  readonly stalled: "idle" | "cap"
  readonly afterMs: number
  constructor(stalled: "idle" | "cap", afterMs: number) {
    super(stalled === "idle"
      ? `[PR_REVIEW]: the review turn stalled: no activity from the model for ${durationText(afterMs)}, so it was stopped`
      : `[PR_REVIEW]: the review turn was still running at its ${durationText(afterMs)} cap, so it was stopped`, "error")
    this.name = "ReviewTurnStalled"
    this.stalled = stalled
    this.afterMs = afterMs
  }
}
export const isStalled = (error: unknown): error is ReviewTurnStalled => error instanceof ReviewTurnStalled
/** The approval was answered, or the child works again: its items, its turn, its usage, or a state other than waiting for one. */
const endsApprovalWait = (event: SessionEvent) =>
  event.type === "server.request.resolved" || event.type.startsWith("item.") || event.type.startsWith("turn.") || event.type === "usage.recorded"
  || (event.type === "foreground.state" && event.state !== "waiting_approval")
/**
 * A model child that never answered its start handshake (seen live as `[CLAUDE]: no answer to initialize` with the machine under
 * heavy load). Nothing about the job caused it, so it is retryable like a stall: each retry spends an attempt, with backoff.
 */
export const childNotStarted = (reason: string) => /no answer to initialize/i.test(reason)
function durationText(ms: number) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  const minutes = Math.round(ms / 60_000)
  return minutes < 120 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`
}

/** A review session with the id of the hidden session behind it (a fix session's id is what the job records). */
export type IdentifiedReviewSession = ReviewSession & { id: SessionId }
export type IdentifiedSessionFactory = (input: { purpose: "review" | "verify"; language?: string | undefined }) => Promise<IdentifiedReviewSession>

/**
 * A factory whose every prompt ends with the repository's review language (`template.language`), for prompts built outside the
 * review engine: a fix session's commit message and its reply on the pull request are public, like the review. The language also
 * goes to the factory, which hands it to the harness of a review child (a fix session keeps the user's own settings).
 */
export function inLanguage(factory: ReviewSessionFactory, language: string): ReviewSessionFactory {
  return async (input) => {
    const session = await factory({ ...input, language })
    return { ...session, send: (prompt: string) => session.send(`${prompt}\n\n${languageInstruction(language)}`) }
  }
}

type Ended = { ok: true; turn: ReviewTurn } | { ok: false; error: ReviewTurnError }
/** `last`: when the child last sent any event; `asking`: a fix session's approval is with the user, so silence is not a stall. */
type Waiting = { text: string; message?: string; tokens: ReviewTurn["tokens"]; reported: boolean; last: number; asking: boolean; done(result: Ended): void }

export function createReviewSessions(deps: {
  /**
   * A hidden session in `directory` (a child of `owner` when given) on `REVIEW_AGENT`, with `model`, else the owner's model. `language`:
   * the repository's review language, which overrides a harness's own language setting in a review child.
   */
  create(input: { owner?: string | undefined; directory: string; title: string; model?: ModelChoice | undefined; editing?: boolean; language?: string | undefined }): SessionId
  /** Sets plan mode (unless `editing`) and submits `text` as the user's message. */
  submit(id: SessionId, text: string, editing?: boolean): Promise<void>
  deny(id: SessionId, requestId: RequestId, reason: string): void
  cancel(id: SessionId): Promise<void>
  remove(id: SessionId): void
  /** No event from the child for this long stops the turn (`TURN_IDLE_MS`). */
  idleMs?: number
  /** No turn runs longer than this, active or not (`TURN_CAP_MS`). */
  capMs?: number
  now?: () => number
  /** The clock the idle and cap limits read: monotonic by default, so a change of the wall clock never stops a turn. */
  clock?: () => number
}) {
  const waiting = new Map<SessionId, Waiting>()
  const messages = new Map<SessionId, Set<string>>()
  const mine = new Set<SessionId>()
  const editors = new Set<SessionId>()
  const now = deps.now ?? Date.now
  const clock = deps.clock ?? (() => performance.now())
  const idleMs = Math.max(1, deps.idleMs ?? TURN_IDLE_MS)
  const capMs = Math.max(1, deps.capMs ?? TURN_CAP_MS)

  /**
   * Watches one turn: it ends the turn as stalled once the child has been silent for `idleMs` (not while a fix session waits for
   * the user) or the turn passed `capMs`. One timer per turn, re-armed for the remaining time: streamed deltas only move `last`.
   */
  function watchTurn(id: SessionId, started: number): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: ReviewTurnStalled) => { void deps.cancel(id); const entry = waiting.get(id); entry?.done({ ok: false, error: withSpent(error, entry.tokens, entry.reported) }) }
    const check = () => {
      const entry = waiting.get(id)
      if (!entry) return
      const at = clock()
      if (at - started >= capMs) return stop(new ReviewTurnStalled("cap", capMs))
      if (!entry.asking && at - entry.last >= idleMs) return stop(new ReviewTurnStalled("idle", idleMs))
      const untilCap = capMs - (at - started)
      timer = setTimeout(check, Math.max(5, entry.asking ? untilCap : Math.min(untilCap, idleMs - (at - entry.last))))
    }
    timer = setTimeout(check, Math.min(idleMs, capMs))
    return () => clearTimeout(timer)
  }

  /**
   * `editing` is `@mendcode fix`: a child on the default agent under the user's normal permission mode, whose approvals go to the
   * user like any session's instead of being refused, and which is kept (not removed) so its edits can be inspected.
   */
  function factory({ owner, directory, model, editing = false }: { owner?: string | undefined; directory: string; model?: ModelChoice | undefined; editing?: boolean }): IdentifiedSessionFactory {
    return async ({ purpose, language }) => {
      const id = deps.create({ owner, directory, model, editing, ...(language ? { language } : {}), title: editing ? "PR fix" : purpose === "review" ? "PR review" : "PR review (verify)" })
      mine.add(id)
      if (editing) editors.add(id)
      return {
        id,
        async send(prompt) {
          const started = clock()
          const ended = new Promise<Ended>((resolve) => waiting.set(id, { text: "", tokens: { input: 0, output: 0, cached: 0 }, reported: false, last: started, asking: false, done: resolve }))
          const unwatch = watchTurn(id, started)
          try {
            await deps.submit(id, prompt, editing)
            const result = await ended
            if (!result.ok) throw result.error
            return result.turn
          } finally { unwatch(); waiting.delete(id) }
        },
        async close() { waiting.delete(id); messages.delete(id); mine.delete(id); if (!editors.delete(id)) deps.remove(id) },
      }
    }
  }

  function observe(event: SessionEvent) {
    const entry = waiting.get(event.sessionId)
    if (!entry) return
    // Any event is the child at work. A fix session's wait for the user ends with the approval's answer or the work after it, not
    // with the session's own report that it waits (seen live: `waiting_approval` right after the request cleared the wait, and the
    // idle watch stopped the fix after 10 minutes of waiting for the user).
    entry.last = clock()
    if (endsApprovalWait(event)) entry.asking = false
    switch (event.type) {
      case "item.started":
        if (event.kind === "agent_message") { const set = messages.get(event.sessionId) ?? new Set(); set.add(event.itemId); messages.set(event.sessionId, set) }
        return
      case "item.completed":
        if (messages.get(event.sessionId)?.has(event.itemId) && event.status === "ok" && typeof event.text === "string") entry.text = event.text
        return
      case "usage.recorded":
        entry.tokens = { input: entry.tokens.input + event.input + event.cacheRead + event.cacheWrite, output: entry.tokens.output + event.output, cached: (entry.tokens.cached ?? 0) + event.cacheRead }
        entry.reported = true
        return
      case "server.request":
        if (editors.has(event.sessionId)) { entry.asking = true; return }
        deps.deny(event.sessionId, event.requestId, REVIEW_APPROVAL_REFUSED)
        return
      case "turn.completed":
        return entry.done({ ok: true, turn: { text: entry.text, tokens: entry.tokens } })
      case "turn.failed": {
        const kind = turnFailureKind(event.error.message, event.error.code)
        const resetsAt = kind === "error" ? undefined : parseResetTime(event.error.message, now())
        return entry.done({ ok: false, error: withSpent(new ReviewTurnError(`[PR_REVIEW]: the review turn failed: ${event.error.message.slice(0, 300)}`, kind, resetsAt), entry.tokens, entry.reported) })
      }
      case "turn.cancelled":
      case "turn.interrupted":
        return entry.done({ ok: false, error: withSpent(new ReviewTurnError("[PR_REVIEW]: the review turn stopped", "error"), entry.tokens, entry.reported) })
    }
  }

  return { factory, observe, isReview: (id: SessionId) => mine.has(id) }
}
export type ReviewSessions = ReturnType<typeof createReviewSessions>
