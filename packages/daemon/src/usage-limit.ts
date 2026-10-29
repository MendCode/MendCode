import type { Clock, SessionEventDraft } from "@mendcode/kernel"
import { redactSecrets, type Command, type ErrorCode, type GlobalEvent, type SessionEvent, type SessionId, type UsageLimitState } from "@mendcode/protocol"
import type { Store, UsagePause } from "@mendcode/store"
import { isUsageLimitFailure } from "./goals-signals"
import { exhaustedReset, parseResetTime } from "./usage-limit-reset"

export type UsageLimitCommand = Extract<Command, { type: "usage.limit" }>
export type UsageLimitReply = { ok: true; result: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }

export type UsageLimitOptions = {
  store: Store
  clock: Clock
  /** Appends a session event (the daemon's sink: redaction, store, broadcast). */
  emit(event: SessionEventDraft): void
  /** Continues the paused work in the session; false when nothing could start it right now. */
  resume(sessionId: SessionId): Promise<boolean>
  /** The provider quota snapshots the daemon last saw: the reset time when the failure message has none. */
  quotas(): readonly Extract<GlobalEvent, { type: "quota.snapshot" }>[]
  log(level: "info" | "warn" | "error", message: string): void
  /** Whether a new pause with a known reset arms itself (the `usage_resume` feature); on when absent. Switching it off never overrides the user's own Resume at reset. */
  armed?(sessionId: SessionId): boolean
  /** The session's effective model now, as a comparable string: a resume into a different one asks first (never silently into another provider). */
  model?(sessionId: SessionId): string | undefined
  /** Effective provider before the first successful usage record (a quota from another account is never a fallback). */
  provider?(sessionId: SessionId): string | undefined
  /** True when the session has an unsent draft written after `since`: the user is typing something else, so the resume asks instead. */
  draftSince?(sessionId: SessionId, since: number): boolean
}

/** The timer fires a little after the window resets: a request at the exact second can still be refused. */
export const RESET_GRACE_MS = 3_000
/** `setTimeout` cannot wait longer than this; a longer wait is re-armed when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1
const MAX_REMEMBERED = 512
/** Automatic resumes in a row that each hit another window: past this the daemon asks instead of waiting again. */
const MAX_CHAINED = 3

const MESSAGE_CHARS = 500
const clip = (text: string) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text)
const cleaned = (message: string) => clip(redactSecrets(message).text.replace(/^\[[A-Z]+\]:\s*/, "").replace(/\s+/g, " ").trim())

/** What a user-typed message looks like among a session's user items: not a notice, a `!command` or one of the daemon's own steerings. */
const typedByUser = (meta: Record<string, unknown> | undefined) => !meta || (meta.notice !== true && meta.shell !== true && meta.goal === undefined && meta.usageLimit === undefined)

/**
 * Turns paused by the provider's usage limit (docs/usage-limit.md). A turn that fails with a spent quota is kept as an
 * open pause (a row in the store, so it survives a restart) and announced with `usage.limit` events. When the reset
 * time is known the pause is armed at once (`scheduled`: the user's intent was to finish the turn), and the client
 * offers Cancel, Snooze and Resume now. Safeguards at the reset: only the paused turn resumes, once; the reported reset
 * is re-checked against the latest quota first; a typed draft or another model make the daemon ask (`ready`) instead of
 * sending. A pause without a reset time, a cancelled one and a snoozed one never resume alone.
 */
export function createUsageLimit(options: UsageLimitOptions) {
  const { store, clock } = options
  const timers = new Map<SessionId, { cancel(): void }>()
  /** The provider each session's last model call used, to pick the right quota window. */
  const providers = new Map<SessionId, string>()
  /** Automatic resumes of a session whose resumed turn failed again: if it hits another window, the daemon waits for that one too (up to MAX_CHAINED). */
  const chained = new Map<SessionId, number>()
  /** Sessions whose resume is being sent: a second trigger (timer and click) never sends it twice. */
  const resuming = new Set<SessionId>()
  const armedFor = (sessionId: SessionId) => options.armed?.(sessionId) ?? true
  let disposed = false

  function publish(pause: Pick<UsagePause, "sessionId" | "message"> & Partial<UsagePause>, state: UsageLimitState, by: "system" | "user") {
    options.emit({
      type: "usage.limit",
      sessionId: pause.sessionId,
      ...(pause.turnId ? { turnId: pause.turnId } : {}),
      state,
      ...(pause.provider ? { provider: pause.provider } : {}),
      message: pause.message,
      ...(pause.resetsAt !== undefined ? { resetsAt: pause.resetsAt } : {}),
      by,
    })
  }

  /** A change of pause the user sees, with a reason the log keeps. */
  function ask(pause: UsagePause, state: Extract<UsagePause["state"], "paused" | "ready">, reason: string) {
    options.log("info", `[USAGE-LIMIT]: ${pause.sessionId} not resumed by itself: ${reason}`)
    return save(pause, state, "system")
  }

  function disarm(sessionId: SessionId) {
    timers.get(sessionId)?.cancel()
    timers.delete(sessionId)
  }

  /** Waits for the reset of an open pause: at that time a scheduled one resumes and any other becomes `ready`. */
  function arm(pause: UsagePause) {
    disarm(pause.sessionId)
    if (disposed || pause.resetsAt === undefined) return
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, pause.resetsAt + RESET_GRACE_MS - clock.now()))
    timers.set(pause.sessionId, clock.setTimer(wait, () => void due(pause.sessionId)))
  }

  function save(pause: UsagePause, state: UsagePause["state"], by: "system" | "user"): UsagePause {
    const next: UsagePause = { ...pause, state, updatedAt: clock.now() }
    store.usagePauses.put(next)
    publish(next, state, by)
    arm(next)
    return next
  }

  /** The pause is over: forgotten, announced, its timer stopped. */
  function settle(pause: UsagePause, state: Extract<UsageLimitState, "resumed" | "cleared">, by: "system" | "user") {
    disarm(pause.sessionId)
    if (state === "cleared") chained.delete(pause.sessionId)
    if (!store.usagePauses.delete(pause.sessionId)) return
    publish(pause, state, by)
  }

  /** Persist a conservative dispatch receipt before sending. Delete only after ACK; an interrupted dispatch asks on recovery. */
  async function resume(pause: UsagePause, by: "system" | "user"): Promise<boolean> {
    if (resuming.has(pause.sessionId)) return false
    resuming.add(pause.sessionId)
    try {
      disarm(pause.sessionId)
      store.usagePauses.put({ ...pause, state: "ready", updatedAt: clock.now() })
      if (by === "system" || pause.state === "scheduled") chained.set(pause.sessionId, (chained.get(pause.sessionId) ?? 0) + 1)
      let started = false
      try {
        started = await options.resume(pause.sessionId)
      } catch (error) {
        options.log("warn", `[USAGE-LIMIT]: could not resume ${pause.sessionId}: ${cleaned(error instanceof Error ? error.message : String(error))}`)
      }
      const current = disposed ? undefined : store.usagePauses.get(pause.sessionId)
      if (!disposed && current?.turnId === pause.turnId && current?.createdAt === pause.createdAt) {
        if (started) settle(pause, "resumed", by)
        else save(pause, "ready", "system")
      }
      return started
    } finally {
      resuming.delete(pause.sessionId)
    }
  }

  /** Why an armed pause must not send by itself at the reset, if anything: what the user did meanwhile or changed. */
  function reasonToAsk(pause: UsagePause): string | undefined {
    if (options.draftSince?.(pause.sessionId, pause.createdAt)) return "the user typed a draft meanwhile"
    const model = options.model?.(pause.sessionId)
    if (options.model && model !== pause.model) return "the model changed or is no longer available"
    return undefined
  }

  async function due(sessionId: SessionId) {
    timers.delete(sessionId)
    const pause = store.usagePauses.get(sessionId)
    if (disposed || !pause || pause.resetsAt === undefined) return
    // A timer that fires early (a clock change) waits again.
    if (clock.now() < pause.resetsAt + RESET_GRACE_MS) return arm(pause)
    if (pause.state === "scheduled") {
      // The reported reset is re-checked first: a quota the provider still reports spent (another window) waits for its own reset.
      const later = pause.provider ? exhaustedReset(options.quotas(), clock.now(), pause.provider) : undefined
      if (later !== undefined && later > pause.resetsAt) {
        options.log("info", `[USAGE-LIMIT]: ${sessionId} still limited; waiting for the next reset`)
        save({ ...pause, resetsAt: later }, "scheduled", "system")
        return
      }
      const reason = reasonToAsk(pause)
      if (reason) {
        ask(pause, "ready", reason)
        return
      }
      options.log("info", `[USAGE-LIMIT]: the window reset; resuming ${sessionId}`)
      await resume(pause, "system")
      return
    }
    if (pause.state !== "ready") save(pause, "ready", "system")
  }

  /** A failed turn that says the quota is spent opens a pause; any earlier one of the session is replaced. */
  function onFailed(event: Extract<SessionEvent, { type: "turn.failed" }>) {
    if (disposed || !isUsageLimitFailure(event.error.code, event.error.message)) return
    // A child task's failure goes to its parent as the task result; only a session the user works in pauses.
    if (store.sessionInfo(event.sessionId)?.parentId) return
    const now = clock.now()
    const provider = options.provider?.(event.sessionId) ?? providers.get(event.sessionId)
    const resetsAt = parseResetTime(event.error.message, now) ?? (provider ? exhaustedReset(options.quotas(), now, provider) : undefined)
    const existing = store.usagePauses.get(event.sessionId)
    // Armed by default when the reset is known; a reset the provider did not give is never guessed, so it asks. After a few
    // automatic resumes in a row that each hit a new window the daemon asks as well.
    const chain = chained.get(event.sessionId) ?? 0
    const state = resetsAt !== undefined && (armedFor(event.sessionId) || chain > 0) && chain < MAX_CHAINED ? "scheduled" : "paused"
    const model = options.model?.(event.sessionId)
    const pause: UsagePause = {
      sessionId: event.sessionId,
      turnId: event.turnId,
      state,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      message: cleaned(event.error.message),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    save(pause, state, "system")
  }

  async function resumeReply(pause: UsagePause): Promise<UsageLimitReply> {
    if (await resume(pause, "user")) return { ok: true, result: { state: "resumed" } }
    return { ok: false, code: "busy", message: "[USAGE-LIMIT]: the session could not start the turn right now (a turn is running or the queue is held)" }
  }

  async function handle(command: UsageLimitCommand): Promise<UsageLimitReply> {
    const { sessionId } = command
    if (!store.hasSession(sessionId)) return { ok: false, code: "unknown_session", message: "[USAGE-LIMIT]: unknown session" }
    const pause = store.usagePauses.get(sessionId)
    if (!pause) return { ok: false, code: "target_mismatch", message: "[USAGE-LIMIT]: this session has no turn paused by a usage limit" }
    if (resuming.has(sessionId)) return { ok: false, code: "busy", message: "[USAGE-LIMIT]: resume dispatch is awaiting acknowledgement" }
    switch (command.action) {
      case "schedule": {
        if (pause.resetsAt === undefined) return { ok: false, code: "unsupported", message: "[USAGE-LIMIT]: the provider did not say when the limit resets; use resume" }
        // The window already reset: there is nothing to wait for.
        if (clock.now() >= pause.resetsAt + RESET_GRACE_MS) return resumeReply(pause)
        const next = save(pause, "scheduled", "user")
        return { ok: true, result: { state: next.state, resetsAt: pause.resetsAt } }
      }
      case "cancel": {
        // Disarms an armed auto-resume; the pause stays open for Resume at reset, Resume now or Dismiss.
        if (pause.state !== "scheduled") return { ok: true, result: { state: pause.state, ...(pause.resetsAt !== undefined ? { resetsAt: pause.resetsAt } : {}) } }
        const next = save(pause, "paused", "user")
        chained.delete(sessionId)
        return { ok: true, result: { state: next.state, ...(pause.resetsAt !== undefined ? { resetsAt: pause.resetsAt } : {}) } }
      }
      case "snooze": {
        const next = save(pause, "snoozed", "user")
        return { ok: true, result: { state: next.state, ...(pause.resetsAt !== undefined ? { resetsAt: pause.resetsAt } : {}) } }
      }
      case "dismiss":
        settle(pause, "cleared", "user")
        return { ok: true, result: { state: "cleared" } }
      case "resume":
        return resumeReply(pause)
    }
  }

  return {
    /** `usage.limit` from a client: Resume at reset (`schedule`), Snooze until reset, Resume now or Dismiss. */
    handle,
    /** Sessions with an automatic resume waiting for their usage window to reset: a daemon has to be there at that time. */
    scheduled: () => timers.size,
    /** Every session event, as the store appended it. */
    observe(event: SessionEvent) {
      if (disposed) return
      switch (event.type) {
        case "usage.recorded":
          if (providers.size >= MAX_REMEMBERED && !providers.has(event.sessionId)) providers.delete(providers.keys().next().value!)
          providers.set(event.sessionId, event.provider)
          return
        case "turn.failed":
          return onFailed(event)
        case "turn.completed":
          chained.delete(event.sessionId)
          return
        case "turn.started": {
          // Another turn began while the pause was open (a queued message, a goal): only the paused turn is ever resumed, so the pause is stale.
          const pause = store.usagePauses.get(event.sessionId)
          if (pause?.turnId && pause.turnId !== event.turnId && !resuming.has(event.sessionId)) settle(pause, "cleared", "system")
          return
        }
        case "item.started": {
          // The user went on with something else: what was paused is theirs to forget.
          if (event.kind !== "user_message" || !typedByUser(event.meta)) return
          const pause = store.usagePauses.get(event.sessionId)
          if (pause) settle(pause, "cleared", "user")
          return
        }
      }
    },
    /** Re-arms every open pause after a daemon restart; a scheduled one whose window already reset resumes now. */
    recover() {
      for (const pause of store.usagePauses.all()) {
        if (pause.state === "ready") { publish(pause, "ready", "system"); continue }
        if (pause.resetsAt === undefined) continue
        if (clock.now() >= pause.resetsAt + RESET_GRACE_MS) void due(pause.sessionId)
        else arm(pause)
      }
    },
    /** The user switched the session's model (or the auto-resume setting changed): an armed resume asks instead of sending into another model. */
    revalidate(sessionId: SessionId) {
      if (disposed) return
      const pause = store.usagePauses.get(sessionId)
      if (!pause || pause.state !== "scheduled") return
      const reason = reasonToAsk(pause)
      if (reason) ask(pause, "paused", reason)
    },
    forget(sessionId: SessionId) {
      disarm(sessionId)
      providers.delete(sessionId)
      chained.delete(sessionId)
      resuming.delete(sessionId)
    },
    dispose() {
      disposed = true
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
    },
  }
}
