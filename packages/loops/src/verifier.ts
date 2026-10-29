import type { Clock, TimerHandle } from "@mendcode/kernel"
import { startedQueueIds, type LoopGate, type QueueId, type SessionEvent, type SessionId, type TurnId } from "@mendcode/protocol"
import { runChecks, type CheckRunner } from "./checks"

/**
 * The shared verification step of loops and workflows: host checks first (cheap, deterministic), then, when the
 * caller wants one, an independent read-only audit in a fresh session. The verifier owns the auditor session's
 * lifecycle and the workspace fingerprint around it; the caller owns what the answer means (its verdict format).
 */
export type AuditRun = {
  sessionId: SessionId
  /** The auditor's last agent message (where its verdict block is). */
  answer: string
  /** Tool calls the auditor completed successfully: an audit that inspected nothing proves nothing. */
  inspections: number
  /** The workspace changed while the auditor ran (fingerprint before ≠ after): its verdict cannot be trusted. */
  workspaceChanged: boolean
}

export type VerifyOutcome =
  /** Aborted by the caller (pause, stop, accept) or no longer wanted; nothing to record. */
  | { kind: "aborted" }
  /** Host checks ran; at least one failed, so no audit was started. */
  | { kind: "checks-failed"; gates: LoopGate[] }
  /** Checks passed and no audit was asked for. */
  | { kind: "checked"; gates: LoopGate[] }
  /** The audit could not produce an answer (could not start, was cancelled, failed); `reason` says why. */
  | { kind: "unavailable"; gates: LoopGate[]; reason: string }
  /** The daemon is stopping mid-audit; verify again after the restart. */
  | { kind: "interrupted"; gates: LoopGate[] }
  | { kind: "audited"; gates: LoopGate[]; audit: AuditRun }

export type VerifyInput = {
  directory: string
  /** Title of the auditor's session. */
  title: string
  checks: readonly string[]
  keepOutput?: boolean
  onUsage?(event: Extract<SessionEvent, { type: "usage.recorded" }>): void
  onAuditSubmitted?(): void
  /** Per-check timeout in seconds, parallel to `checks` (none = the runner's default). */
  checkTimeouts?: readonly (number | undefined)[]
  /** Present when an audit is wanted: builds the auditor's prompt from the gate results. */
  audit?: { prompt(gates: LoopGate[]): string }
  signal: AbortSignal
  /** Asked after the checks: false stops before an audit is started (the subject went away). */
  stillWanted?(): boolean
}

type AuditWatch = {
  queueId?: QueueId
  turnId?: TurnId
  started: Map<string, TurnId>
  answerItems: Set<string>
  answer: string
  /** Called on every event of the auditor's session: it is working, so the idle limit starts again. */
  touch?(): void
  inspections: number
  toolItems: Set<string>
  onUsage?: VerifyInput["onUsage"]
  done(outcome: "completed" | "failed" | "cancelled" | "interrupted"): void
}

const TERMINAL = { "turn.completed": "completed", "turn.failed": "failed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted" } as const

/**
 * An auditor that shows no activity (no event of its session) for this long is cancelled and the verification reported
 * unavailable. It is an idle limit, not a total one: auditing a long workflow legitimately takes more than ten minutes.
 */
export const DEFAULT_AUDIT_TIMEOUT_MS = 10 * 60_000
/** The reason when the user cancelled the auditor's turn: the one unavailable audit that is not tried again. */
export const AUDIT_CANCELLED = "audit cancelled by the user"
/** An audit that could not finish (stalled, failed, could not start) is tried this many times, with the same check results. */
export const AUDIT_ATTEMPTS = 3
/** However active, an audit is stopped after this long (six idle limits, at least an hour). */
const auditCapMs = (idleMs: number) => Math.max(60 * 60_000, idleMs * 6)

export function createVerifier(options: {
  /** `readOnly` sessions start in plan mode: the auditor can read and search, never change anything. */
  createSession(input: { directory: string; title: string; readOnly?: boolean }): SessionId
  submit(input: { sessionId: SessionId; text: string }): Promise<{ queueId: QueueId } | { error: string }>
  runCheck?: CheckRunner
  /** A digest of the workspace, or undefined when it cannot tell. */
  fingerprint?(directory: string): Promise<string | undefined>
  /** For the audit timeout: a timer (the daemon's clock) and a way to cancel the auditor's turn. */
  clock?: Clock
  cancelTurn?(input: { sessionId: SessionId; turnId: TurnId }): unknown
  auditTimeoutMs?: number
  /** How many times an unfinished audit is asked (default `AUDIT_ATTEMPTS`). */
  auditAttempts?: number
}) {
  const audits = new Map<SessionId, AuditWatch>()
  const timeoutMs = options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS
  const attempts = Math.max(1, options.auditAttempts ?? AUDIT_ATTEMPTS)

  async function audit(input: VerifyInput, gates: LoopGate[]): Promise<VerifyOutcome> {
    const before = await options.fingerprint?.(input.directory).catch(() => undefined)
    if (input.signal.aborted) return { kind: "aborted" }
    const sessionId = options.createSession({ directory: input.directory, title: input.title, readOnly: true })
    let finish!: (outcome: "completed" | "failed" | "cancelled" | "interrupted") => void
    const finished = new Promise<"completed" | "failed" | "cancelled" | "interrupted">((resolve) => (finish = resolve))
    const watch: AuditWatch = { started: new Map(), answerItems: new Set(), toolItems: new Set(), answer: "", inspections: 0, onUsage: input.onUsage, done: finish }
    audits.set(sessionId, watch)
    const sent = await options.submit({ sessionId, text: input.audit!.prompt(gates) })
    if ("error" in sent) {
      audits.delete(sessionId)
      return { kind: "unavailable", gates, reason: `audit could not start: ${sent.error}` }
    }
    input.onAuditSubmitted?.()
    watch.queueId = sent.queueId
    const turnId = watch.started.get(sent.queueId)
    if (turnId) watch.turnId = turnId
    // An abort (pause, stop, accept) stops waiting; the auditor's own turn is left to finish or be cancelled by its session.
    const aborted = new Promise<"aborted">((resolve) => input.signal.addEventListener("abort", () => resolve("aborted"), { once: true }))
    // A hung auditor (FC-19) is cancelled by its tracked turn and reported, never left holding the verification.
    let timer: TimerHandle | undefined
    let cap: TimerHandle | undefined
    const timedOut = options.clock
      ? new Promise<"idle" | "cap">((resolve) => {
        const clock = options.clock!
        watch.touch = () => { timer?.cancel(); timer = clock.setTimer(timeoutMs, () => resolve("idle")) }
        watch.touch()
        cap = clock.setTimer(auditCapMs(timeoutMs), () => resolve("cap"))
      })
      : new Promise<never>(() => {})
    const outcome = await Promise.race([finished, aborted, timedOut])
    timer?.cancel()
    cap?.cancel()
    audits.delete(sessionId)
    if (outcome === "idle" || outcome === "cap") {
      if (watch.turnId) options.cancelTurn?.({ sessionId, turnId: watch.turnId })
      const minutes = (ms: number) => Math.round(ms / 60_000)
      return { kind: "unavailable", gates, reason: outcome === "idle" ? `audit stalled: no activity for ${minutes(timeoutMs)} min` : `audit still running after ${minutes(auditCapMs(timeoutMs))} min` }
    }
    if (outcome === "aborted") return { kind: "aborted" }
    if (outcome === "interrupted") return { kind: "interrupted", gates }
    if (outcome !== "completed") return { kind: "unavailable", gates, reason: outcome === "cancelled" ? AUDIT_CANCELLED : "audit run failed" }
    const after = before === undefined ? undefined : await options.fingerprint?.(input.directory).catch(() => undefined)
    const workspaceChanged = before !== undefined && after !== undefined && after !== before
    return { kind: "audited", gates, audit: { sessionId, answer: watch.answer, inspections: watch.inspections, workspaceChanged } }
  }

  return {
    async run(input: VerifyInput): Promise<VerifyOutcome> {
      const gates: LoopGate[] = !input.checks.length
        ? []
        : options.runCheck
          ? await runChecks({ checks: [...input.checks], cwd: input.directory, signal: input.signal, run: options.runCheck, ...(input.keepOutput ? { keepOutput: true } : {}), ...(input.checkTimeouts ? { timeouts: input.checkTimeouts } : {}) })
          : input.checks.map((id) => ({ id, status: "fail" as const, detail: "checks cannot run in this daemon" }))
      if (input.signal.aborted || input.stillWanted?.() === false) return { kind: "aborted" }
      if (gates.some((gate) => gate.status === "fail")) return { kind: "checks-failed", gates }
      if (!input.audit) return { kind: "checked", gates }
      // A stalled or failed auditor (rate limit, network, a hung turn) is asked again before the subject blocks; only the user's
      // own cancel is final at once. The checks are not run again.
      let outcome = await audit(input, gates)
      for (let tries = 2; tries <= attempts && outcome.kind === "unavailable" && outcome.reason !== AUDIT_CANCELLED; tries++) {
        if (input.signal.aborted || input.stillWanted?.() === false) return { kind: "aborted" }
        outcome = await audit({ ...input, title: `${input.title} (attempt ${tries})` }, gates)
      }
      return attempts > 1 && outcome.kind === "unavailable" && outcome.reason !== AUDIT_CANCELLED ? { ...outcome, reason: `${outcome.reason} (${attempts} attempts)` } : outcome
    },
    /** Session events; returns true when the event belonged to one of its auditor sessions. */
    observe(event: SessionEvent): boolean {
      const watch = audits.get(event.sessionId)
      if (!watch) return false
      watch.touch?.()
      if (event.type === "turn.started") {
        if (watch.queueId === undefined) for (const queueId of startedQueueIds(event)) watch.started.set(queueId, event.turnId)
        else if (startedQueueIds(event).includes(watch.queueId)) watch.turnId = event.turnId
      }
      if (!watch.turnId) return true
      if (event.type === "usage.recorded" && event.turnId === watch.turnId) watch.onUsage?.(event)
      if (event.type === "item.started" && event.turnId === watch.turnId) {
        if (event.kind === "agent_message") watch.answerItems.add(event.itemId)
        if (event.kind === "tool_call") watch.toolItems.add(event.itemId)
      }
      if (event.type === "item.completed") {
        if (event.text && watch.answerItems.has(event.itemId)) watch.answer = event.text
        if (event.status === "ok" && watch.toolItems.has(event.itemId)) watch.inspections++
      }
      if (event.type in TERMINAL && "turnId" in event && event.turnId === watch.turnId) watch.done(TERMINAL[event.type as keyof typeof TERMINAL])
      return true
    },
    /** Auditor sessions being watched (for diagnostics and tests). */
    active: () => [...audits.keys()],
  }
}
export type Verifier = ReturnType<typeof createVerifier>
