import type { QueueId, SessionEvent, SessionId } from "@mendcode/protocol"
import type { PendingResume } from "@mendcode/store"

/** Turns one start resumes; the rest are reported to their launchers instead of all starting together. */
export const RESUME_MAX_PER_START = 16
/** A turn that a shutdown interrupted again after being resumed this many times is left alone. */
export const RESUME_MAX_ATTEMPTS = 3
/** A turn interrupted longer ago than this (the daemon stayed down) is not carried on by surprise. */
export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000
const PAGE = 32

export const RESUME_TEXT = "The daemon restarted and interrupted your previous turn. Pick the work back up where it stopped; check what is already done before repeating anything."

/**
 * Turns that an orderly daemon shutdown interrupted (`turn.interrupted` with `cause: "daemon_shutdown"`) are carried on by the next
 * start: each gets one steering turn, never a re-run of the old one. A session that cannot be resumed (deleted, a shell command, the
 * user already moved on, resumed too often, too old, too many at once) tells the session that started it from its shell, if any.
 * The only read at start is the bounded page of `restart_resumes`; nothing runs per frame or per event.
 */
export function createRestartResume(deps: {
  store: {
    resumes: { put(entry: PendingResume): void; list(limit: number): PendingResume[]; remove(sessionId: string): void }
    launchers: { get(child: string): string | undefined }
    hasSession(sessionId: SessionId): boolean
    queueOf(sessionId: SessionId): unknown[]
  }
  enabled(): boolean
  now(): number
  /** The events from the session's last `turn.started` on; undefined when it never started a turn. */
  lastTurn(sessionId: SessionId): SessionEvent[] | undefined
  /** Starts the steering turn; false when the session is busy, held or has queued messages. */
  resume(sessionId: SessionId, text: string): Promise<boolean>
  /** Tells the model of the launching session; resolves once queued. */
  tell(launcher: SessionId, text: string, queueId: QueueId): Promise<unknown>
  title(sessionId: SessionId): string
  queueId(): QueueId
  log(level: "info" | "warn", message: string): void
}) {
  let stopped = false
  /** Sessions this daemon resumed and the attempt each is on; forgotten when the resumed turn ends in any way but a shutdown. */
  const resumed = new Map<SessionId, number>()

  const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text)

  function tell(entry: PendingResume, reason: string) {
    const session = entry.sessionId as SessionId
    deps.log("warn", `[DAEMON]: session ${entry.sessionId} was interrupted by a daemon shutdown and not resumed: ${reason}`)
    const launcher = (entry.launcher ?? deps.store.launchers.get(entry.sessionId)) as SessionId | undefined
    if (!launcher || launcher === session || !deps.store.hasSession(launcher)) return
    const title = deps.store.hasSession(session) ? JSON.stringify(clip(deps.title(session))) : "(deleted)"
    const text = `Internal notification. A session you started, ${entry.sessionId} ${title}, was interrupted when the daemon stopped and was not resumed: ${reason}. Its work stopped where it was; look at it with the session logs and decide whether to start it again.`
    void deps.tell(launcher, text, deps.queueId()).catch(() => undefined)
  }

  /** Why this turn is not carried on, or undefined when it is. */
  function blocker(entry: PendingResume): { reason: string; quiet?: true } | undefined {
    if (!deps.store.hasSession(entry.sessionId as SessionId)) return { reason: "the session was deleted" }
    const events = deps.lastTurn(entry.sessionId as SessionId)
    const started = events?.[0]
    // The user (or another turn) went on after the shutdown, or the turn finished before it took effect: nothing is left to resume.
    if (started?.type !== "turn.started" || started.turnId !== entry.turnId) return { reason: "a later turn started", quiet: true }
    if (!events!.some((event) => event.type === "turn.interrupted" && event.turnId === entry.turnId)) return { reason: "the turn had ended", quiet: true }
    if (events!.some((event) => event.type === "item.started" && event.kind === "user_message" && event.meta?.shell)) return { reason: "a shell command is never run again" }
    if (!deps.enabled()) return { reason: "resumeAfterRestart is off in the settings" }
    if (entry.attempts >= RESUME_MAX_ATTEMPTS) return { reason: `it was already resumed ${entry.attempts} times and a shutdown stopped it each time` }
    if (deps.now() - entry.at > RESUME_MAX_AGE_MS) return { reason: "the daemon stayed down for hours" }
    if (deps.store.queueOf(entry.sessionId as SessionId).length > 0) return { reason: "messages are waiting in its queue" }
    return undefined
  }

  return {
    /** An orderly shutdown is interrupting this session's turn: keep it for the next start. */
    record(sessionId: SessionId, turnId: string) {
      deps.store.resumes.put({ sessionId, turnId, launcher: deps.store.launchers.get(sessionId), attempts: resumed.get(sessionId) ?? 0, at: deps.now() })
    },
    /** A turn of a session this daemon resumed ended on its own: it counts as done. */
    observe(event: SessionEvent) {
      if (resumed.size === 0 || !resumed.has(event.sessionId)) return
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") resumed.delete(event.sessionId)
    },
    /** Resumes what the previous daemon's shutdown interrupted. Runs once, after start. */
    async start() {
      let carried = 0
      for (let page = deps.store.resumes.list(PAGE); page.length > 0 && !stopped; page = deps.store.resumes.list(PAGE)) {
        for (const entry of page) {
          if (stopped) return
          // Claimed before anything else: a crash while resuming never resumes it twice.
          deps.store.resumes.remove(entry.sessionId)
          const blocked = blocker(entry)
          if (blocked) {
            if (!blocked.quiet) tell(entry, blocked.reason)
            continue
          }
          if (carried >= RESUME_MAX_PER_START) { tell(entry, `more than ${RESUME_MAX_PER_START} sessions were interrupted at once`); continue }
          resumed.set(entry.sessionId as SessionId, entry.attempts + 1)
          if (await deps.resume(entry.sessionId as SessionId, RESUME_TEXT)) {
            carried++
            deps.log("info", `[DAEMON]: session ${entry.sessionId} resumed after the daemon restart`)
          } else {
            resumed.delete(entry.sessionId as SessionId)
            tell(entry, "the session was busy or held")
          }
        }
      }
    },
    stop() { stopped = true },
  }
}
