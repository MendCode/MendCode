import { isPlanningOnlyPacket, MAX_INLINE_TEXT, MAX_JOINED_QUEUE_ENTRIES, MAX_QUEUE_ENTRIES } from "@mendcode/protocol"
import type {
  BlobRef,
  Command,
  ErrorCode,
  ForegroundState,
  ItemId,
  PermissionMode,
  QueueDelivery,
  QueueId,
  RequestId,
  SessionId,
  Settings,
  TurnId,
} from "@mendcode/protocol"
import type { createIdFactory } from "@mendcode/protocol"
import type { Clock, TimerHandle } from "./clock"
import type { EngineEvent, EnginePort, EngineRequest, EngineResolution, SessionEventDraft, SessionEventSink, TurnInput, TurnOutcome } from "./ports"
import type { Scope } from "./scope"

type IdFactory = ReturnType<typeof createIdFactory>
type ActorCommand = Extract<
  Command,
  { type: "user.submit" | "user.shell" | "queue.promote" | "queue.remove" | "queue.reorder" | "queue.edit" | "queue.steer" | "queue.list" | "turn.cancel" | "request.resolve" | "session.permission.set" | "session.compact" | "session.compaction.set" }
>

export type ActorResult = { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }
export type InterruptReason = "restart" | "transport" | "stream_idle"

/**
 * A steering turn: `text` goes to the engine as the user message, but the transcript shows only `label` (a thin
 * marker), tagged with `meta`. It is never queued or persisted: it starts at once or not at all (see `steer`).
 */
export type Steering = { text: string; label: string; meta: Record<string, string>; /** The user asked for it: it may start although a user cancel left the session held. */ force?: boolean }

type QueueEntry = { queueId: QueueId; text: string; displayText?: string; authorityText?: string; attachments: BlobRef[]; messageId?: ItemId; selection?: TurnInput["selection"]; turnOptions?: TurnInput["turnOptions"]; compact?: true; /** With `compact`: started by the daemon in an idle session (`compactIdle`), never queued or persisted. */ idle?: true; instructions?: string; notice?: true; shell?: true; local?: true; steer?: Pick<Steering, "label" | "meta">; /** Per-message override of the queue policy; not persisted (a restored queue is held). */ delivery?: QueueDelivery; /** A notice nobody waits on for a reply (a background task ended): held after a cancel, it goes with the user's next message. Not persisted. */ rides?: true; /** When a `rides` notice arrived, to keep it in order with notices held outside the queue. */ at?: number; /** True once the model was shown what this notice says by another way: it is then dropped unread. Not persisted. */ unless?: () => boolean; /** Sent now on its own (send now, restart, idle steer): no other queued message joins its turn. Not persisted. */ alone?: true }
type Phase = "turn" | "compaction"

type ActiveTurn = {
  turnId: TurnId
  phase: Phase
  abort: AbortController
  scope: Scope
  openItems: Set<ItemId>
  pending: Map<RequestId, (resolution: EngineResolution) => void>
  questions: Map<RequestId, NonNullable<EngineRequest["questions"]>>
  plans: Map<RequestId, NonNullable<EngineRequest["planReview"]>>
  /** Set by a cancel, which ends the turn for everyone at once (`turn.cancelled`, idle) while the engine stops behind it. */
  cancelBy?: "user" | "promotion"
  interruptReason?: InterruptReason
  grace?: TimerHandle
  /** The engine's way to take a promoted message without a cancel (`TurnInput.onSendNow`). */
  sendNow?: (message: Pick<TurnInput, "text" | "attachments">) => boolean
  /** Set once a promoted message was handed to the engine: another promotion then waits for this turn to end. */
  handedOff?: boolean
  /** When the current run of network failures began; cleared by the next item event. */
  offlineSince?: number | undefined
  compaction?: { reason: "auto" | "manual"; idle?: true; followUp: string }
  /** Started alone (send now, restart) or with an explicit model/agent selection or turn options: no message joins it after its answer. */
  alone?: true
}

/** Open items a session's background sub-agents may hold at once after their turn ended. */
const MAX_AGENT_ITEMS = 500

type Message =
  | { kind: "command"; command: ActorCommand; authorityText?: string; reply(result: ActorResult): void }
  | { kind: "interrupt"; reason: InterruptReason; reply(): void }
  | { kind: "pause"; paused: boolean; reply(paused: boolean): void }
  | { kind: "engine.event"; turnId: TurnId; event: EngineEvent }
  | { kind: "agent.event"; turnId: TurnId; event: EngineEvent }
  | { kind: "engine.request"; turnId: TurnId; request: EngineRequest; resolve(resolution: EngineResolution): void }
  | { kind: "engine.done"; turnId: TurnId; phase: Phase; outcome: TurnOutcome }
  | { kind: "engine.permission"; turnId: TurnId; mode: PermissionMode }
  | { kind: "notice"; text: string; queueId?: QueueId; idleOnly?: boolean; delivery?: "queue" | "steer"; rides?: boolean; unless?: () => boolean; reply(queueId: QueueId | undefined): void }
  | { kind: "steer"; steering: Steering; reply(started: boolean): void }
  | { kind: "compact.idle"; reply(started: boolean): void }
  | { kind: "engine.queue"; turnId: TurnId; userOnly?: boolean; reply(entry: Pick<TurnInput, "text" | "attachments" | "authority"> | undefined): void }
  | { kind: "engine.request.cancel"; turnId: TurnId; requestId: RequestId }

export type SessionActorOptions = {
  sessionId: SessionId
  clock: Clock
  scope: Scope
  engine: EnginePort
  sink: SessionEventSink
  ids: IdFactory
  /** After an abort, the turn is force-finished if the engine has not returned within this time (I6). */
  cancelGraceMs?: number
  onForeground?(state: ForegroundState): void
  /** The pause flag changed (`pause`/`resume`), so panels can show it even when the foreground state did not move. */
  onPause?(paused: boolean): void
  /** Queue recovered after a restart. It starts held: nothing runs until the user acts. */
  restoredQueue?: Array<{ queueId: QueueId; text: string; displayText?: string; authorityText?: string; attachments: BlobRef[]; messageId?: ItemId; selection?: TurnInput["selection"]; turnOptions?: TurnInput["turnOptions"]; compact?: true; instructions?: string; notice?: true; shell?: true; local?: true; rides?: true }>
  /** Persisted mode of the session (default "ask"). */
  permissionMode?: PermissionMode
  /** Read live: a settings change affects the next submission/tool boundary without recreating the actor. */
  queueMode?(): NonNullable<Settings["queue"]>["mode"]
  /** False when this session's engine has no injection boundary (Claude Code, Codex, ACP): `steer` then queues. Default true. */
  canSteer?(): boolean
  /**
   * A notice about this session's own background work that another part keeps outside the queue (finished sub-agents). Asked at each
   * boundary where a running turn can take a queued notice; what it returns joins that turn like a `rides` notice, in order of `at`, and
   * `taken` runs once it is in the log under `queueId`. Never asked while the session is held, paused or not steerable: the owner of the
   * notice then delivers it its own way, so a cancel or a turn that ends first changes nothing for it.
   */
  waitingNotice?(): { queueId: QueueId; text: string; at: number; taken(): void } | undefined
}

const PREVIEW_CHARS = 200
/** Between the messages of one turn that several queued messages started together. */
const JOINED_SEPARATOR = "\n\n"

/**
 * The only owner of a session's foreground state, queue and active turn (P1).
 * Every mutation happens inside a synchronous mailbox handler, so no two transitions interleave.
 * Engine callbacks are messages too; stale ones (wrong turn or phase, or after abort) are dropped.
 */
/** A tool result's meta as the event log accepts it: at most 16 short fields, long strings cut. */
function displayMeta(meta: Record<string, string | number | boolean>) {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(meta).slice(0, 16)) {
    if (typeof value === "number" && !Number.isFinite(value)) continue
    out[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, 200) : value
  }
  return out
}

export function createSessionActor(options: SessionActorOptions) {
  const { sessionId, engine, sink, ids, scope } = options
  const cancelGraceMs = options.cancelGraceMs ?? 5_000
  const mailbox: Message[] = []
  const queue: QueueEntry[] = [...(options.restoredQueue ?? [])]
  let foreground: ForegroundState = "idle"
  let active: ActiveTurn | undefined
  let held = queue.length > 0
  /** Pause after the running turn: nothing new starts until `resume`, whatever is queued or submitted meanwhile. */
  let paused = false
  let permissionMode: PermissionMode = options.permissionMode ?? "ask"
  let draining = false
  let disposed = false

  function post(message: Message) {
    if (disposed) {
      if (message.kind === "command") message.reply({ ok: false, code: "unknown_session", message: "[ACTOR]: session disposed" })
      else if (message.kind === "interrupt") message.reply()
      else if (message.kind === "pause") message.reply(false)
      else if (message.kind === "engine.request") message.resolve({ kind: "abandoned" })
      else if (message.kind === "notice") message.reply(undefined)
      else if (message.kind === "steer" || message.kind === "compact.idle") message.reply(false)
      else if (message.kind === "engine.queue") message.reply(undefined)
      return
    }
    mailbox.push(message)
    if (!draining) queueMicrotask(drain)
  }

  function drain() {
    if (draining) return
    draining = true
    try {
      for (let message = mailbox.shift(); message; message = mailbox.shift()) handleMessage(message)
    } finally {
      draining = false
    }
  }

  function emit(event: SessionEventDraft) {
    return sink.append(event)
  }

  function setForeground(state: ForegroundState) {
    if (state === foreground) return
    foreground = state
    emit({ type: "foreground.state", sessionId, state, ...(active && !active.cancelBy ? { turnId: active.turnId } : {}) })
    options.onForeground?.(state)
  }

  const kindOf = (entry: QueueEntry) => (entry.compact ? "compact" : entry.notice ? "notice" : entry.shell ? "shell" : "message") as "compact" | "notice" | "shell" | "message"
  /** Only what the user typed as is: an entry another part expanded (files, extensions) or compacts and notices are not editable. */
  const editable = (entry: QueueEntry) => (entry.shell || kindOf(entry) === "message") && entry.displayText === undefined && entry.authorityText === undefined
  /** A running native turn takes a steered message after its next tool result; anything else keeps it queued. */
  const steerable = () => Boolean(active && active.phase === "turn" && !active.cancelBy && !active.interruptReason && !paused && (options.canSteer?.() ?? true))
  /** Steered messages go ahead of the plain queue, in the order they were steered. */
  function placeSteered(entry: QueueEntry) {
    const from = queue.indexOf(entry)
    if (from >= 0) queue.splice(from, 1)
    let at = 0
    while (queue[at]?.delivery === "steer") at++
    queue.splice(at, 0, entry)
  }

  function emitQueue() {
    emit({
      type: "queue.changed",
      sessionId,
      queue: queue.map((entry) => ({
        queueId: entry.queueId,
        preview: entry.compact ? "compact context" : (entry.displayText ?? entry.text).slice(0, PREVIEW_CHARS),
        attachments: entry.attachments.length,
        kind: kindOf(entry),
        ...(entry.delivery ? { delivery: entry.delivery } : {}),
      })),
    })
  }

  /** Notices whose news the model already read another way leave the queue unread, before anything is taken from it. */
  function dropShown() {
    const shown = queue.filter((entry) => entry.unless?.())
    if (!shown.length) return
    for (const entry of shown) queue.splice(queue.indexOf(entry), 1)
    emitQueue()
  }

  function settleIdle() {
    // A cancelled turn whose engine has not stopped yet: nothing starts until it has, and what waits shows as queued.
    if (active?.cancelBy) return setForeground(queue.length > 0 ? "queued" : "idle")
    if (active) return
    dropShown()
    const next = held || paused ? undefined : queue.shift()
    if (next) return start(next, joining(next))
    setForeground(queue.length > 0 ? "queued" : "idle")
  }

  /**
   * Plain messages waiting right behind a plain message start in its turn, so the model reads them as one request
   * instead of answering each in a turn of its own. Shells, notices, compactions, a different model/agent selection or
   * turn options, and a message sent now on its own keep their boundary; order is never changed.
   */
  function joining(first: QueueEntry): QueueEntry[] {
    if (first.alone || first.steer || kindOf(first) !== "message") return []
    const selection = JSON.stringify(first.selection ?? null)
    const turnOptions = JSON.stringify(first.turnOptions ?? null)
    const joins = (entry: QueueEntry) => !entry.alone && kindOf(entry) === "message" && JSON.stringify(entry.selection ?? null) === selection && JSON.stringify(entry.turnOptions ?? null) === turnOptions
    const joined: QueueEntry[] = []
    while (joined.length < MAX_JOINED_QUEUE_ENTRIES && queue[0] && joins(queue[0])) joined.push(queue.shift()!)
    return joined
  }

  function start(entry: QueueEntry, joined: QueueEntry[] = []) {
    const turnId = ids("turn")
    const turn: ActiveTurn = {
      turnId,
      phase: "turn",
      abort: new AbortController(),
      scope: scope.child(`turn:${turnId}`),
      openItems: new Set(),
      pending: new Map(),
      questions: new Map(),
      plans: new Map(),
      ...(entry.alone || entry.selection || entry.turnOptions ? { alone: true as const } : {}),
    }
    active = turn
    // A steering turn and a compaction while idle were never in the queue: nothing changed there.
    if (!entry.steer && !entry.idle) emitQueue()
    emit({ type: "turn.started", sessionId, turnId, queueId: entry.queueId, ...(joined.length ? { joinedQueueIds: joined.map((other) => other.queueId) } : {}) })
    if (entry.compact) {
      // A compaction the user asked for, or one the daemon starts while idle, is a turn of its own: no user message, only the compaction phase.
      turn.phase = "compaction"
      turn.compaction = entry.idle ? { reason: "auto", idle: true, followUp: "" } : { reason: "manual", followUp: "" }
      compactionUpdated(turn, "writing")
      setForeground("compacting")
      return run(turn, "compaction", () =>
        engine.compact({ sessionId, turnId, signal: turn.abort.signal, newItemId: () => ids("item"), emit: (event) => post({ kind: "engine.event", turnId, event }), ...(entry.instructions ? { instructions: entry.instructions } : {}), ...(entry.selection ? { selection: entry.selection } : {}), ...(entry.idle ? { idle: true as const } : {}) }),
      )
    }
    const userItem = entry.messageId ?? ids("item")
    // A steering turn reads as a system notice (undo treats it like one) carrying the steering's own tags.
    const meta = entry.steer ? { meta: { notice: true, ...entry.steer.meta } } : entry.notice ? { meta: { notice: true } } : entry.shell ? { meta: { shell: true, ...(entry.local ? { local: true } : {}) } } : {}
    emit({ type: "item.started", sessionId, turnId, itemId: userItem, kind: "user_message", ...meta })
    emit({
      type: "item.completed",
      sessionId,
      itemId: userItem,
      status: "ok",
      text: entry.steer ? entry.steer.label : entry.displayText ?? entry.text,
      ...(entry.authorityText !== undefined ? { authorityText: entry.authorityText } : {}),
      ...(entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
    })
    // Each joined message keeps its own transcript item; the engine receives them as one request, in order.
    for (const other of joined) {
      const itemId = other.messageId ?? ids("item")
      emit({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
      emit({
        type: "item.completed",
        sessionId,
        itemId,
        status: "ok",
        text: other.displayText ?? other.text,
        ...(other.authorityText !== undefined ? { authorityText: other.authorityText } : {}),
        ...(other.attachments.length > 0 ? { attachments: other.attachments } : {}),
      })
    }
    setForeground(entry.shell ? "tool" : "generating")
    const all = [entry, ...joined]
    const input: TurnInput = {
      sessionId,
      turnId,
      text: all.map((part) => part.text).join(JOINED_SEPARATOR),
      attachments: all.flatMap((part) => part.attachments),
      ...(entry.shell && entry.local ? { localShell: true as const } : {}),
      authority: { sourceId: userItem, text: all.map((part) => part.authorityText ?? part.text).join(JOINED_SEPARATOR), ...(entry.notice || entry.steer ? { synthetic: true } : {}) },
      ...(entry.selection ? { selection: entry.selection } : {}),
      ...(entry.turnOptions ? { turnOptions: entry.turnOptions } : {}),
      signal: turn.abort.signal,
      newItemId: () => ids("item"),
      emit: (event) => post({ kind: "engine.event", turnId, event }),
      ask: (request) => new Promise((resolve) => post({ kind: "engine.request", turnId, request, resolve })),
      permissionMode: () => permissionMode,
      setPermissionMode: (mode) => post({ kind: "engine.permission", turnId, mode }),
      takeQueued: (take) => new Promise((reply) => post({ kind: "engine.queue", turnId, reply, ...(take?.userOnly ? { userOnly: true } : {}) })),
      onSendNow: (handler) => { turn.sendNow = handler },
    }
    // A shell entry is only queued when the engine has runShell (checked at user.shell).
    run(turn, "turn", () => (entry.shell && engine.runShell ? engine.runShell(input) : engine.runTurn(input)))
  }

  function run(turn: ActiveTurn, phase: Phase, task: () => Promise<TurnOutcome>) {
    turn.phase = phase
    let promise: Promise<TurnOutcome>
    try {
      promise = task()
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise.then(
      (outcome) => post({ kind: "engine.done", turnId: turn.turnId, phase, outcome }),
      (error: unknown) =>
        post({
          kind: "engine.done",
          turnId: turn.turnId,
          phase,
          outcome: { status: "error", code: "engine_exception", message: error instanceof Error ? error.message : String(error) },
        }),
    )
  }

  function isLive(turnId: TurnId) {
    return active !== undefined && active.turnId === turnId && !active.abort.signal.aborted
  }

  /** A pending request whose turn stops or ends has lost its owner: close it explicitly (I7, FC-02). */
  function abandonPending(turn: ActiveTurn) {
    for (const [requestId, resolve] of turn.pending) {
      emit({ type: "server.request.resolved", sessionId, requestId, resolution: "abandoned", ...(turn.plans.has(requestId) ? { planReview: { kind: "plan_review", action: "close" } } : {}) })
      resolve({ kind: "abandoned" })
    }
    turn.pending.clear()
  }

  function stopTurn(turn: ActiveTurn) {
    abandonPending(turn)
    turn.abort.abort()
    turn.grace = turn.scope.timer(cancelGraceMs, () =>
      post({
        kind: "engine.done",
        turnId: turn.turnId,
        phase: turn.phase,
        outcome: { status: "error", code: "cancel_timeout", message: "[ACTOR]: engine did not stop within the grace period" },
      }),
    )
  }

  /**
   * The turn ends now for the user: its items close, `turn.cancelled` goes out and the session reads idle (or queued). The engine
   * stops behind it (some take seconds, Claude Code finishing its step); the turn stays active until then, so nothing new starts
   * and the daemon keeps waiting on it (undo, restart), and whatever the engine still sends is dropped.
   */
  function cancel(turn: ActiveTurn, by: "user" | "promotion") {
    turn.cancelBy = by
    stopTurn(turn)
    compactionUpdated(turn, "cancelled")
    closeOpenItems(turn, "cancelled")
    emit({ type: "turn.cancelled", sessionId, turnId: turn.turnId, by })
    settleIdle()
  }

  function finish(turn: ActiveTurn) {
    turn.scope.dispose()
    active = undefined
    settleIdle()
  }

  function closeOpenItems(turn: ActiveTurn, status: "cancelled" | "interrupted" | "unknown") {
    for (const itemId of turn.openItems) emit({ type: "item.completed", sessionId, itemId, status })
    turn.openItems.clear()
  }

  function onEngineDone(turnId: TurnId, phase: Phase, outcome: TurnOutcome) {
    const turn = active
    if (!turn || turn.turnId !== turnId || turn.phase !== phase) return
    turn.grace?.cancel()
    abandonPending(turn)
    // Already announced at the cancel: the engine has now stopped, so what waits can start.
    if (turn.cancelBy) return finish(turn)
    if (turn.interruptReason) {
      compactionUpdated(turn, "interrupted")
      closeOpenItems(turn, "interrupted")
      emit({ type: "turn.interrupted", sessionId, turnId, reason: turn.interruptReason })
      return finish(turn)
    }
    closeOpenItems(turn, "unknown")
    if (outcome.status === "error") {
      compactionUpdated(turn, "failed")
      emit({ type: "turn.failed", sessionId, turnId, error: { code: outcome.code.slice(0, 64), message: outcome.message.slice(0, 4000) } })
      turn.scope.dispose()
      active = undefined
      if (queue.length > 0 && !held && !paused) return settleIdle()
      return setForeground("error")
    }
    if (phase === "turn" && engine.needsCompaction(sessionId)) {
      turn.compaction = { reason: "auto", followUp: "" }
      compactionUpdated(turn, "writing")
      setForeground("compacting")
      return run(turn, "compaction", () =>
        engine.compact({
          sessionId,
          turnId,
          signal: turn.abort.signal,
          newItemId: () => ids("item"),
          emit: (event) => post({ kind: "engine.event", turnId, event }),
        }),
      )
    }
    if (phase === "compaction") {
      const text = turn.compaction?.followUp.trim()
      const followUpQueueId = outcome.compacted && outcome.continueAfterCompact !== false && text ? ids("queue") : undefined
      if (followUpQueueId && text) {
        // Persist the queue entry before completion. A recovered queue remains held after a restart.
        queue.unshift({ queueId: followUpQueueId, text, attachments: [], alone: true })
        emit({ type: "queue.added", sessionId, queueId: followUpQueueId, text, attachments: [] })
        emitQueue()
      }
      compactionUpdated(turn, outcome.compacted ? "packed" : "skipped", followUpQueueId, outcome.compacted ? undefined : outcome.note)
    }
    emit({ type: "turn.completed", sessionId, turnId })
    finish(turn)
  }

  function compactionUpdated(turn: ActiveTurn, state: "writing" | "packed" | "skipped" | "failed" | "cancelled" | "interrupted", followUpQueueId?: QueueId, note?: string) {
    if (!turn.compaction) return
    emit({ type: "compaction.updated", sessionId, turnId: turn.turnId, ...turn.compaction, state, ...(followUpQueueId ? { followUpQueueId } : {}), ...(note ? { note: note.slice(0, 500) } : {}) })
  }

  function onEngineEvent(turnId: TurnId, event: EngineEvent) {
    if (!isLive(turnId) || !active) return
    const turn = active
    if (event.type === "usage") {
      const { type: _type, ...usage } = event
      emit({ type: "usage.recorded", sessionId, turnId, ...usage })
      return
    }
    if (event.type === "retrying") {
      const now = options.clock.now()
      turn.offlineSince = event.offline ? (turn.offlineSince ?? now) : undefined
      emit({ type: "turn.retrying", sessionId, turnId, attempt: event.attempt, nextAt: now + event.delayMs, message: event.message.slice(0, 500), ...(turn.offlineSince !== undefined ? { offlineSince: turn.offlineSince } : {}) })
      return
    }
    turn.offlineSince = undefined
    if (event.type === "item.started") {
      turn.openItems.add(event.itemId)
      emit({ type: "item.started", sessionId, turnId, itemId: event.itemId, kind: event.kind, ...(event.meta ? { meta: event.meta } : {}) })
      if (turn.phase === "turn") setForeground(event.kind === "tool_call" ? "tool" : "generating")
      return
    }
    if (!turn.openItems.has(event.itemId)) return
    if (event.type === "item.delta") {
      emit({ type: "item.delta", sessionId, itemId: event.itemId, text: event.text, ...(event.input ? { input: event.input } : {}) })
      return
    }
    turn.openItems.delete(event.itemId)
    emit({
      type: "item.completed",
      sessionId,
      itemId: event.itemId,
      status: event.status,
      ...(event.text !== undefined ? { text: event.text } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput.slice(0, 4000) } : {}),
      ...(event.blob ? { blob: event.blob } : {}),
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
      ...(event.render ? { render: event.render } : {}),
      ...(event.meta ? { meta: displayMeta(event.meta) } : {}),
    })
    if (turn.phase === "turn" && foreground === "tool") setForeground("generating")
  }

  /** Items a background sub-agent opened after the turn that started it ended, until each completes (bounded). */
  const agentItems = new Set<ItemId>()

  /**
   * What an engine's background sub-agent does after the turn that started it ended: its items (each marked with its `agentParent`, the
   * call that started it) are recorded under that turn, so the agent's thread goes on filling in. Nothing else is taken this way.
   */
  function onAgentEvent(turnId: TurnId, event: EngineEvent) {
    if (event.type === "item.started") {
      if (typeof event.meta?.agentParent !== "string" || agentItems.size >= MAX_AGENT_ITEMS) return
      agentItems.add(event.itemId)
      emit({ type: "item.started", sessionId, turnId, itemId: event.itemId, kind: event.kind, meta: event.meta })
      return
    }
    if (event.type === "item.delta") {
      if (agentItems.has(event.itemId)) emit({ type: "item.delta", sessionId, itemId: event.itemId, text: event.text })
      return
    }
    if (event.type !== "item.completed" || !agentItems.delete(event.itemId)) return
    emit({ type: "item.completed", sessionId, itemId: event.itemId, status: event.status, ...(event.text !== undefined ? { text: event.text } : {}), ...(event.meta ? { meta: displayMeta(event.meta) } : {}) })
  }

  function onEngineRequest(turnId: TurnId, request: EngineRequest, resolve: (resolution: EngineResolution) => void) {
    if (!isLive(turnId) || !active || request.signal?.aborted) return resolve({ kind: "abandoned" })
    const requestId = ids("request")
    const cancelRequest = () => post({ kind: "engine.request.cancel", turnId, requestId })
    request.signal?.addEventListener("abort", cancelRequest, { once: true })
    active.pending.set(requestId, (resolution) => {
      request.signal?.removeEventListener("abort", cancelRequest)
      resolve(resolution)
    })
    if (request.questions) active.questions.set(requestId, request.questions)
    if (request.planReview) active.plans.set(requestId, request.planReview)
    emit({
      type: "server.request",
      sessionId,
      requestId,
      turnId,
      kind: request.kind,
      title: request.title.slice(0, 500),
      detail: request.detail,
      ...(request.itemId ? { itemId: request.itemId } : {}),
      ...(request.tool ? { tool: request.tool.slice(0, 200) } : {}),
      ...(request.permission ? { permission: request.permission } : {}),
      ...(request.options?.length
        ? { options: request.options.slice(0, 9).map((o) => ({ label: o.label.slice(0, 120), ...(o.description ? { description: o.description.slice(0, 300) } : {}) })) }
        : {}),
      ...(request.multiple && request.options?.length ? { multiple: true } : {}),
      ...(request.questions ? { questions: request.questions } : {}),
      ...(request.planReview ? { planReview: request.planReview } : {}),
      ...(request.permissionContext ? { permissionContext: request.permissionContext } : {}),
      ...(request.engineFlagged ? { engineFlagged: true as const } : {}),
    })
    setForeground("waiting_approval")
  }

  /** A refusal when `store` throws (the sink refused the event), else undefined. */
  function attempt(store: () => void): ActorResult | undefined {
    try {
      store()
      return undefined
    } catch (error) {
      return { ok: false, code: "invalid_command", message: `[ACTOR]: the message could not be stored: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const queueFull = (): ActorResult => ({ ok: false, code: "busy", message: `[ACTOR]: the queue already holds ${MAX_QUEUE_ENTRIES} messages; send this one after some of them ran` })

  function onCommand(command: ActorCommand, authorityText?: string): ActorResult {
    if (command.sessionId !== sessionId) return { ok: false, code: "unknown_session", message: "[ACTOR]: command for another session" }
    switch (command.type) {
      case "user.submit": {
        if (queue.length >= MAX_QUEUE_ENTRIES) return queueFull()
        const queueId = ids("queue")
        const authority = authorityText !== undefined && authorityText !== command.text ? { authorityText } : {}
        const display = command.displayText !== undefined ? { displayText: command.displayText } : {}
        const stable = command.messageId ? { messageId: command.messageId } : {}
        const turnOptions = command.turnOptions && Object.keys(command.turnOptions).length ? { turnOptions: command.turnOptions } : {}
        // Steer needs a running turn that can take it; otherwise it is an ordinary queued message (never an interrupt).
        const delivery: QueueDelivery | undefined = command.delivery === "steer" ? (active ? (steerable() ? "steer" : "queue") : undefined) : command.delivery
        // After a user cancel the notices that waited (background tasks that ended) go with this message, as context the model reads
        // before it, instead of each taking a turn of its own first. What the user wrote stays what is shown and what carries authority.
        dropShown()
        const waited = held ? queue.filter((queued) => queued.rides) : []
        const folded = waited.length
          ? { text: `[while the session was stopped, this happened]\n${waited.map((notice) => notice.text).join("\n\n")}\n\n[the user's message]\n${command.text}`, displayText: command.displayText ?? command.text, authorityText: authorityText ?? command.text }
          : {}
        // Stored first: a message the store refuses (too large once serialized) changes nothing and is answered as refused.
        const stored = attempt(() => emit({ type: "queue.added", sessionId, queueId, text: command.text, attachments: command.attachments, ...authority, ...display, ...folded, ...stable, ...turnOptions, ...(command.selection ? { selection: command.selection } : {}) }))
        if (stored) return stored
        for (const notice of waited) queue.splice(queue.indexOf(notice), 1)
        const entry: QueueEntry = { queueId, text: command.text, attachments: command.attachments, ...authority, ...display, ...folded, ...stable, ...turnOptions, ...(command.selection ? { selection: command.selection } : {}), ...(delivery ? { delivery } : {}) }
        if (delivery === "steer") placeSteered(entry)
        else if (delivery === "restart") queue.unshift({ ...entry, alone: true })
        else queue.push(entry)
        held = false
        emitQueue()
        const interrupts = delivery === "restart" || (delivery === undefined && options.queueMode?.() === "immediate")
        if (interrupts && !paused && active && !active.cancelBy && !active.interruptReason) cancel(active, "promotion")
        settleIdle()
        return { ok: true, result: { queueId, ...(command.delivery ? { delivery: delivery ?? command.delivery, steered: delivery === "steer" } : {}) } }
      }
      case "user.shell": {
        if (!engine.runShell) return { ok: false, code: "invalid_command", message: "[ACTOR]: this engine cannot run shell commands" }
        if (queue.length >= MAX_QUEUE_ENTRIES) return queueFull()
        const queueId = ids("queue")
        const local = command.local ? { local: true as const } : {}
        const stored = attempt(() => emit({ type: "queue.added", sessionId, queueId, text: command.command, attachments: [], shell: true, ...local, ...(command.messageId ? { messageId: command.messageId } : {}) }))
        if (stored) return stored
        queue.push({ queueId, text: command.command, attachments: [], shell: true, ...local, ...(command.messageId ? { messageId: command.messageId } : {}) })
        held = false
        emitQueue()
        settleIdle()
        return { ok: true, result: { queueId } }
      }
      case "queue.promote": {
        const index = queue.findIndex((entry) => entry.queueId === command.queueId)
        if (index < 0) return { ok: false, code: "target_mismatch", message: "[ACTOR]: queued message not found" }
        const [entry] = queue.splice(index, 1)
        if (entry) queue.unshift({ ...entry, alone: true })
        held = false
        emitQueue()
        if (active && !paused && !active.cancelBy && !active.interruptReason) {
          // An engine that takes the message mid-turn keeps what the turn started running; the message's own turn follows this one.
          const plain = entry && !entry.shell && !entry.compact && !entry.selection && !entry.turnOptions && !entry.notice
          if (active.handedOff) {} else if (plain && active.phase === "turn" && active.sendNow?.({ text: entry.text, attachments: entry.attachments })) active.handedOff = true
          else cancel(active, "promotion")
        } else settleIdle()
        return { ok: true }
      }
      case "queue.remove": {
        const index = queue.findIndex((entry) => entry.queueId === command.queueId)
        if (index < 0) return { ok: false, code: "target_mismatch", message: "[ACTOR]: queued message not found" }
        queue.splice(index, 1)
        emitQueue()
        settleIdle()
        return { ok: true }
      }
      case "queue.reorder": {
        const from = queue.findIndex((entry) => entry.queueId === command.queueId)
        if (from < 0) return { ok: false, code: "target_mismatch", message: "[ACTOR]: queued message not found" }
        const last = queue.length - 1
        const wanted = command.to === "up" ? from - 1 : command.to === "down" ? from + 1 : command.to === "top" ? 0 : command.to === "bottom" ? last : command.to
        const to = Math.max(0, Math.min(last, wanted))
        if (to !== from) {
          const [entry] = queue.splice(from, 1)
          queue.splice(to, 0, entry!)
          emitQueue()
        }
        return { ok: true, result: { position: to } }
      }
      case "queue.edit": {
        const entry = queue.find((candidate) => candidate.queueId === command.queueId)
        if (!entry) return { ok: false, code: "target_mismatch", message: "[ACTOR]: queued message not found" }
        if (!editable(entry)) return { ok: false, code: "invalid_command", message: "[ACTOR]: this queued entry cannot be edited" }
        entry.text = command.text
        emit({ type: "queue.edited", sessionId, queueId: entry.queueId, text: command.text, byClientId: command.clientId })
        emitQueue()
        return { ok: true }
      }
      case "queue.steer": {
        const entry = queue.find((candidate) => candidate.queueId === command.queueId)
        if (!entry) return { ok: false, code: "target_mismatch", message: "[ACTOR]: queued message not found" }
        if (kindOf(entry) !== "message") return { ok: false, code: "invalid_command", message: "[ACTOR]: only a queued message can be steered" }
        if (!active) {
          // Nothing running: steering is sending now.
          queue.splice(queue.indexOf(entry), 1)
          queue.unshift({ ...entry, alone: true })
          held = false
          emitQueue()
          settleIdle()
          return { ok: true, result: { steered: false } }
        }
        if (!steerable()) {
          entry.delivery = "queue"
          emitQueue()
          return { ok: true, result: { steered: false } }
        }
        entry.delivery = "steer"
        placeSteered(entry)
        held = false
        emitQueue()
        return { ok: true, result: { steered: true } }
      }
      case "queue.list":
        return { ok: true, result: { held, paused, entries: queue.map((entry) => ({ queueId: entry.queueId, kind: kindOf(entry), text: entry.compact ? "" : entry.text, ...(entry.displayText !== undefined ? { displayText: entry.displayText } : {}), attachments: entry.attachments.length, editable: editable(entry), ...(entry.delivery ? { delivery: entry.delivery } : {}) })) } }
      case "turn.cancel": {
        if (!active || active.turnId !== command.turnId) {
          return { ok: false, code: "target_mismatch", message: "[ACTOR]: turn is not active" }
        }
        if (active.cancelBy || active.interruptReason) return { ok: true, result: { alreadyStopping: true } }
        held = true
        cancel(active, "user")
        return { ok: true }
      }
      case "request.resolve": {
        const resolve = active?.pending.get(command.requestId)
        if (!active || !resolve) {
          return { ok: false, code: "request_already_resolved", message: "[ACTOR]: request is not pending" }
        }
        const decision = command.decision
        const plan = active.plans.get(command.requestId)
        if (decision.kind === "plan_review" && !plan) return { ok: false, code: "target_mismatch", message: "[ACTOR]: this request is not a plan review" }
        if (plan && decision.kind === "answer") return { ok: false, code: "invalid_command", message: "[ACTOR]: a plan review needs a review decision" }
        if ((plan?.phase === "plan" || decision.kind === "plan_review" && decision.markdown && isPlanningOnlyPacket(decision.markdown)) && (decision.kind === "approve" || decision.kind === "plan_review" && decision.action === "apply")) return { ok: false, code: "invalid_command", message: "[ACTOR]: this packet permits planning only; accept without applying" }
        const review = decision.kind === "plan_review" ? decision : plan ? { kind: "plan_review" as const, action: decision.kind === "approve" ? "apply" as const : "reject" as const, ...(decision.kind === "deny" && decision.reason ? { reason: decision.reason } : {}) } : undefined
        const questions = active.questions.get(command.requestId)
        if (questions && decision.kind !== "deny") {
          if (decision.kind !== "answer" || !decision.answers || decision.answers.length !== questions.length || decision.answers.some((answers, i) => {
            const question = questions[i]!
            return (!question.multiple && answers.length > 1) || new Set(answers).size !== answers.length || (question.custom === false && answers.some((answer) => !question.options.some((option) => option.label === answer)))
          })) return { ok: false, code: "invalid_command", message: "[ACTOR]: answers must match the questions in order" }
        }
        active.pending.delete(command.requestId)
        active.questions.delete(command.requestId)
        active.plans.delete(command.requestId)
        emit({
          type: "server.request.resolved",
          sessionId,
          requestId: command.requestId,
          resolution: review ? review.action === "close" ? "abandoned" : review.action === "reject" ? "denied" : review.action === "edit" ? "answered" : "approved" : decision.kind === "approve" ? "approved" : decision.kind === "deny" ? "denied" : "answered",
          ...(review ? { planReview: { ...review, destination: review.destination ?? plan!.destination } } : {}),
          byClientId: command.clientId,
        })
        resolve(review ?? decision)
        if (active.pending.size === 0) setForeground("generating")
        return { ok: true }
      }
      case "session.compact": {
        if (queue.length >= MAX_QUEUE_ENTRIES) return queueFull()
        const queueId = ids("queue")
        const extra = {
          ...(command.instructions ? { instructions: command.instructions } : {}),
          ...(command.model ? { selection: { model: command.model } } : {}),
        }
        queue.push({ queueId, text: "", attachments: [], compact: true, ...extra })
        emit({ type: "queue.added", sessionId, queueId, text: "", attachments: [], compact: true, ...extra })
        held = false
        emitQueue()
        settleIdle()
        return { ok: true, result: { queueId } }
      }
      case "session.permission.set": {
        if (command.mode === permissionMode) return { ok: true }
        permissionMode = command.mode
        emit({ type: "session.permission", sessionId, mode: command.mode, byClientId: command.clientId })
        return { ok: true }
      }
      case "session.compaction.set": {
        if (!active || active.turnId !== command.turnId || active.phase !== "compaction" || !active.compaction || active.abort.signal.aborted) return { ok: false, code: "target_mismatch", message: "[ACTOR]: compaction is no longer active" }
        if (active.compaction.followUp === command.text) return { ok: true }
        active.compaction.followUp = command.text
        compactionUpdated(active, "writing")
        return { ok: true }
      }
    }
  }

  function onInterrupt(reason: InterruptReason) {
    held = true
    if (!active || active.cancelBy || active.interruptReason) return settleIdle()
    active.interruptReason = reason
    stopTurn(active)
  }

  /**
   * Starts a steering turn when nothing else wants the session: no turn running, nothing queued (queued messages always
   * go first), and not held by a user cancel or an interrupt, unless the steering is `force` (and then only with an empty queue).
   */
  function onSteer(steering: Steering): boolean {
    if (active || queue.length > 0 || paused || (held && !steering.force)) return false
    held = false
    start({ queueId: ids("queue"), text: steering.text, attachments: [], steer: { label: steering.label, meta: steering.meta } })
    return true
  }

  function handleMessage(message: Message) {
    switch (message.kind) {
      case "command": {
        // A command always gets its answer: one that throws is refused instead of leaving its caller waiting.
        let result: ActorResult
        try {
          result = onCommand(message.command, message.authorityText)
        } catch (error) {
          result = { ok: false, code: "internal", message: `[ACTOR]: ${error instanceof Error ? error.message : String(error)}` }
        }
        return message.reply(result)
      }
      case "interrupt":
        onInterrupt(message.reason)
        return message.reply()
      case "engine.event":
        return onEngineEvent(message.turnId, message.event)
      case "agent.event":
        return onAgentEvent(message.turnId, message.event)
      case "engine.request":
        return onEngineRequest(message.turnId, message.request, message.resolve)
      case "engine.done":
        return onEngineDone(message.turnId, message.phase, message.outcome)
      case "engine.permission":
        // Only the live turn may change the mode; a late request from a finished turn is dropped.
        if (!isLive(message.turnId) || message.mode === permissionMode) return
        permissionMode = message.mode
        emit({ type: "session.permission", sessionId, mode: message.mode })
        return
      case "engine.request.cancel": {
        if (!active || active.turnId !== message.turnId) return
        const resolve = active.pending.get(message.requestId)
        if (!resolve) return
        active.pending.delete(message.requestId)
        active.questions.delete(message.requestId)
        active.plans.delete(message.requestId)
        emit({ type: "server.request.resolved", sessionId, requestId: message.requestId, resolution: "abandoned" })
        resolve({ kind: "abandoned" })
        if (!active.pending.size && foreground === "waiting_approval") setForeground("generating")
        return
      }
      case "notice": {
        // A full queue takes no more notices: the daemon hears `undefined`, as for a notice that could not wait.
        if ((message.idleOnly && (active || held || paused || queue.length)) || queue.length >= MAX_QUEUE_ENTRIES) return message.reply(undefined)
        // Queued like a message but never clears `held`: after a user cancel it waits for the user (FC-13).
        const queueId = message.queueId ?? ids("queue")
        // A notice nobody waits on that asks to join the running turn keeps its place in the queue, and stays a plain notice when the
        // turn cannot take it: a turn that ends before its next boundary leaves the order and the policy a queued notice always had.
        const joins = message.delivery === "steer" && message.rides === true
        const delivery: QueueDelivery | undefined = message.delivery === "steer" ? (active ? (steerable() ? "steer" : joins ? undefined : "queue") : undefined) : message.delivery
        const entry: QueueEntry = { queueId, text: message.text, attachments: [], notice: true, ...(delivery ? { delivery } : {}), ...(message.rides ? { rides: true as const, at: options.clock.now() } : {}), ...(message.unless ? { unless: message.unless } : {}) }
        if (delivery === "steer" && !joins) placeSteered(entry)
        else queue.push(entry)
        emit({ type: "queue.added", sessionId, queueId, text: message.text, attachments: [], notice: true })
        emitQueue()
        settleIdle()
        return message.reply(queueId)
      }
      case "steer":
        return message.reply(onSteer(message.steering))
      case "compact.idle": {
        // Only a session nothing else wants: a message or a turn that got here first wins, and a hold (user cancel, restart) stays as it is.
        if (active || queue.length > 0 || paused) return message.reply(false)
        start({ queueId: ids("queue"), text: "", attachments: [], compact: true, idle: true })
        return message.reply(true)
      }
      case "pause": {
        const changed = paused !== message.paused
        paused = message.paused
        // Resuming also releases a user-cancel or restart hold: it is the user's explicit "go on".
        if (!paused) held = false
        if (changed) options.onPause?.(paused)
        if (!paused) settleIdle()
        else if (!active && queue.length > 0) setForeground("queued")
        return message.reply(paused)
      }
      case "engine.queue": {
        const turn = active
        // Never bypass a held queue.
        if (!isLive(message.turnId) || !turn || turn.phase !== "turn" || held || paused || turn.pending.size || turn.openItems.size) return message.reply(undefined)
        // After its answer, such a turn is done: the next message gets a turn of its own (and no selection made for another one).
        if (turn.alone && message.userOnly) return message.reply(undefined)
        dropShown()
        // A steered message goes first; otherwise the policy decides, and a message marked `queue` always waits for the response.
        const steered = queue.find((candidate) => candidate.delivery === "steer")
        const first = steered ?? (options.queueMode?.() === "after-tools" && queue[0]?.delivery !== "queue" ? queue[0] : undefined)
        // Shell, compaction and explicit model/agent selections need their own turn.
        // After an answer without tools (`userOnly`) only the user's own message joins: a notice then gets its own turn, once the answer ended.
        const entry = first && !first.shell && !first.compact && !first.selection && !first.turnOptions && !(message.userOnly && (first.notice || first.rides)) ? first : undefined
        // A notice kept outside the queue joins when no message of the user's is due at this boundary (that one goes alone, first).
        const outside = !message.userOnly && (!entry || entry.rides) && steerable() ? options.waitingNotice?.() : undefined
        if (!entry && !outside) return message.reply(undefined)
        const itemId = entry?.messageId ?? ids("item")
        // Notices about the session's own background work that wait together are one message, in the order they arrived (what fits in one).
        const batch: Array<{ text: string; at: number; queued?: QueueEntry }> = (entry ? (entry.rides ? queue.filter((candidate) => candidate.rides) : [entry]) : []).map((queued) => ({ text: queued.text, at: queued.at ?? 0, queued }))
        if (outside) batch.push({ text: outside.text, at: outside.at })
        batch.sort((a, b) => a.at - b.at)
        const taken: typeof batch = []
        let text = ""
        for (const each of batch) {
          if (taken.length && text.length + each.text.length + 2 > MAX_INLINE_TEXT) break
          text += `${taken.length ? "\n\n" : ""}${each.text}`
          taken.push(each)
        }
        const joined = outside && taken.some((each) => !each.queued) ? outside : undefined
        // In the log under its own queue id first: whoever kept it finds it there after a crash and does not send it again.
        if (joined) emit({ type: "queue.added", sessionId, queueId: joined.queueId, text: joined.text, attachments: [], notice: true })
        emit({ type: "item.started", sessionId, turnId: turn.turnId, itemId, kind: "user_message", ...(!entry || entry.notice ? { meta: { notice: true } } : {}) })
        emit({ type: "item.completed", sessionId, itemId, status: "ok", text, ...(entry?.authorityText !== undefined ? { authorityText: entry.authorityText } : {}), ...(entry?.attachments.length ? { attachments: entry.attachments } : {}) })
        for (const each of taken) if (each.queued) queue.splice(queue.indexOf(each.queued), 1)
        emitQueue()
        joined?.taken()
        // Such a notice reports work this turn's session started, like a tool result: it carries no authority, so the turn keeps the one it has.
        return message.reply({ text, attachments: entry?.attachments ?? [], ...(!entry || entry.rides ? {} : { authority: { sourceId: itemId, text: entry.authorityText ?? entry.text, ...(entry.notice ? { synthetic: true } : {}) } }) })
      }
    }
  }

  scope.onDispose(() => {
    disposed = true
    active?.abort.abort()
    for (const resolve of active?.pending.values() ?? []) resolve({ kind: "abandoned" })
    // Every message still in the mailbox is answered as a disposed actor answers it: a command left unanswered would hang its sender.
    const left = mailbox.splice(0)
    for (const message of left) post(message)
  })

  if (queue.length > 0) setForeground("queued")

  return {
    sessionId,
    handle(command: ActorCommand, authorityText?: string) {
      return new Promise<ActorResult>((reply) => post({ kind: "command", command, ...(authorityText !== undefined ? { authorityText } : {}), reply }))
    },
    interrupt(reason: InterruptReason) {
      return new Promise<void>((reply) => post({ kind: "interrupt", reason, reply }))
    },
    /** Pause (true) or resume (false): a paused session finishes its running turn and then starts nothing until resumed. */
    pause(value: boolean) {
      return new Promise<boolean>((reply) => post({ kind: "pause", paused: value, reply }))
    },
    /**
     * A system notice the agent should answer (a background task finished). It starts a turn when the
     * session is free, waits behind a running turn, and after a user cancel stays queued until the user acts.
     * `delivery: "steer"`: a running turn that can take it reads it after its next tool result instead; a turn that ends first leaves it queued.
     * `rides`: nobody waits on a reply to it, so after a cancel it goes with the user's next message instead of taking a turn first;
     * steered, it keeps its place in the queue, joins together with the others like it as one message, and leaves the turn's authority as it is.
     * `unless`: asked just before the notice would be read; true means the model already has its news (it read the task's exit itself), and the notice is dropped.
     */
    notify(text: string, queueId?: QueueId, idleOnly = false, delivery?: "queue" | "steer", rides = false, unless?: () => boolean) {
      return new Promise<QueueId | undefined>((reply) => post({ kind: "notice", text, ...(queueId ? { queueId } : {}), ...(idleOnly ? { idleOnly } : {}), ...(delivery ? { delivery } : {}), ...(rides ? { rides } : {}), ...(unless ? { unless } : {}), reply }))
    },
    /**
     * A turn the daemon starts on its own to steer the agent (a goal's continuation): shown in the transcript as a thin
     * marker, never queued. True when it started; false when the session was busy, had queued messages or was held, so
     * the caller tries again when the next turn ends.
     */
    steer(steering: Steering) {
      return new Promise<boolean>((reply) => post({ kind: "steer", steering, reply }))
    },
    /**
     * A compaction the daemon starts on its own in an idle session (before the provider's prompt cache expires): a turn of its
     * own, like `/compact`, but never queued. True when it started; false when a turn runs, something is queued or the session is
     * paused. A message sent while it runs waits behind it, as behind any compaction.
     */
    /** An item of an engine's background sub-agent that reports after its turn ended (see `onAgentEvent`). */
    agentEvent(turnId: TurnId, event: EngineEvent) {
      post({ kind: "agent.event", turnId, event })
    },
    compactIdle() {
      return new Promise<boolean>((reply) => post({ kind: "compact.idle", reply }))
    },
    snapshot() {
      return {
        foreground,
        turnId: active?.turnId,
        /** The turn was cancelled and has ended for the user; its engine has not stopped yet. */
        stopping: active?.cancelBy !== undefined,
        phase: active?.phase,
        queue: queue.map((entry) => entry.queueId),
        held,
        paused,
        permissionMode,
        openItems: active?.openItems.size ?? 0,
        pendingRequests: active?.pending.size ?? 0,
        /** Messages posted and not handled yet: an actor with any is not idle, whatever its state says. */
        mailbox: mailbox.length,
      }
    },
  }
}
export type SessionActor = ReturnType<typeof createSessionActor>
