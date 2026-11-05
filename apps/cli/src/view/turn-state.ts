import type { BlobRef, ItemId, ItemKind, QueueId, RequestId, SessionEvent } from "@mendcode/protocol"

export type RetryState = { attempt: number; nextAt: number; message: string; offlineSince?: number }

/** What a pending request carries beyond title and detail (the transcript keeps only those two). */
export type RequestExtras = {
  turnId?: import("@mendcode/protocol").TurnId
  tool?: string
  permission?: "read" | "write" | "execute"
  /** What the approval is about (the rule name and the patterns it matched): the "always allow" rule comes from it. */
  permissionContext?: { name: string; patterns: string[]; always: string[] }
  /** The engine itself flagged this call although the session is in full access. */
  engineFlagged?: true
  itemId?: ItemId
  options?: Array<{ label: string; description?: string }>
  multiple?: boolean
  questions?: import("@mendcode/protocol").QuestionInfo[]
  planReview?: import("@mendcode/protocol").PlanReview
}

export type RunningItem = { kind: ItemKind; tool?: string; /** What the call acts on (a shell call's command), from its title. */ detail?: string; /** The model is still writing the call's input; the tool has not started. */ writing?: boolean; /** Input characters written so far. */ inputChars?: number }

/** A queued entry as the user typed it: its text (the original request when an extension rewrote it), attachments and what kind it is. */
export type QueuedPrompt = { text: string; attachments: BlobRef[]; kind: "message" | "shell" | "notice" | "compact" }
const QUEUED_KEPT = 64

/**
 * What the prompt area needs from a session's events and the transcript does not keep: when the turn
 * started, the running item (for the working row's phase), the provider retry, and the extra request
 * fields. Pure data fed by `apply`; events at or below the last seen `seq` are ignored.
 */
export function createTurnState() {
  let lastSeq = 0
  let output = 0
  /** Tokens this turn's calls sent (input, cache read and cache written), exact from each call's reported usage. */
  let input = 0
  /** The part of `input` the provider read from its prompt cache: already sent by an earlier call, not new this turn. */
  let cached = 0
  /** Output tokens the engine reported for the turn in flight that no usage record holds yet (`turn.tokens`): shown, never stored; a record replaces it. */
  let liveOutput = 0
  let turnId: string | undefined
  let startedAt: number | undefined
  let retry: RetryState | undefined
  const running = new Map<ItemId, RunningItem>()
  const requests = new Map<RequestId, RequestExtras>()
  const resolvedRequests = new Set<RequestId>()
  /** Queued entries that are the user's own `!command` (the queue preview does not say so). */
  const shellQueued = new Set<QueueId>()
  /** The full text of what is queued (the queue event carries only a 200-character preview), so a queued prompt can be pulled back to edit. Entries leave with the queue. */
  const queuedText = new Map<QueueId, QueuedPrompt>()
  /** Entries the last queue change took out (they start a turn next), until `turn.started` claims one. */
  let departed = new Map<QueueId, QueuedPrompt>()
  /** What the running turn's message was as typed (text and attachments), so Esc Esc can hand it back without asking the daemon. Gone with the turn. */
  let sent: QueuedPrompt | undefined
  /** Turns started and tokens used in this session since the client attached (for the exit summary). */
  const totals = { turns: 0, input: 0, output: 0 }

  function restoreRequest(event: Extract<SessionEvent, { type: "server.request" }>) {
    if (resolvedRequests.has(event.requestId)) return
    requests.set(event.requestId, {
      ...(event.planReview ? { turnId: event.turnId } : {}),
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.permission ? { permission: event.permission } : {}),
      ...(event.permissionContext ? { permissionContext: structuredClone(event.permissionContext) } : {}),
      ...(event.engineFlagged ? { engineFlagged: true as const } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.options?.length ? { options: event.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
      ...(event.multiple ? { multiple: true } : {}),
      ...(event.questions ? { questions: structuredClone(event.questions) } : {}),
      ...(event.planReview ? { planReview: structuredClone(event.planReview) } : {}),
    })
  }

  function endTurn() {
    liveOutput = 0
    startedAt = undefined
    retry = undefined
    sent = undefined
    running.clear()
  }

  return {
    restoreAsyncRequests(events: readonly Extract<SessionEvent, { type: "server.request" }>[]) { for (const event of events) restoreRequest(event) },
    apply(event: SessionEvent) {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      switch (event.type) {
        case "turn.started":
          endTurn()
          sent = event.joinedQueueIds?.length ? undefined : departed.get(event.queueId)
          departed = new Map()
          output = 0
          input = 0
          cached = 0
          turnId = event.turnId
          startedAt = event.at
          totals.turns++
          break
        case "usage.recorded":
          liveOutput = 0
          // v1: input counts the cache, output counts the reasoning.
          totals.input += event.input + event.cacheRead + event.cacheWrite
          totals.output += event.output + event.reasoning
          if (startedAt !== undefined) {
            output += event.output + event.reasoning
            input += event.input + event.cacheRead + event.cacheWrite
            cached += event.cacheRead
          }
          break
        case "turn.retrying":
          retry = { attempt: event.attempt, nextAt: event.nextAt, message: event.message, ...(event.offlineSince !== undefined ? { offlineSince: event.offlineSince } : {}) }
          break
        case "item.started": {
          retry = undefined
          // A sub-agent's step shows in its own thread and row: the working row names what the main agent does, steady while agents work.
          if (typeof event.meta?.agentParent === "string") break
          const tool = typeof event.meta?.tool === "string" ? event.meta.tool.split(":")[0]!.trim() : undefined
          const full = typeof event.meta?.tool === "string" ? event.meta.tool : ""
          const detail = tool === "shell" && full.includes(":") ?full.slice(full.indexOf(":") + 1).trim() : ""
          running.set(event.itemId, { kind: event.kind, ...(tool ? { tool } : {}), ...(detail ? { detail } : {}) })
          break
        }
        case "item.delta": {
          retry = undefined
          const item = running.get(event.itemId)
          if (item && event.input) {
            running.set(event.itemId, { kind: item.kind, ...(item.tool ? { tool: item.tool } : {}), ...(item.detail ? { detail: item.detail } : {}), ...(event.input.done ? {} : { writing: true }), inputChars: event.input.chars })
          }
          break
        }
        case "item.completed":
          running.delete(event.itemId)
          break
        case "turn.completed":
        case "turn.cancelled":
        case "turn.interrupted":
        case "turn.failed":
          endTurn()
          break
        case "server.request":
          restoreRequest(event)
          break
        case "server.request.resolved":
          resolvedRequests.add(event.requestId)
          if (resolvedRequests.size > 256) resolvedRequests.delete(resolvedRequests.values().next().value!)
          requests.delete(event.requestId)
          break
        case "queue.added":
          if (event.shell) shellQueued.add(event.queueId)
          queuedText.set(event.queueId, { text: event.shell ? `${event.local ? "!" : ""}${event.text}` : event.authorityText ?? event.displayText ?? event.text, attachments: event.attachments, kind: event.shell ? "shell" : event.notice ? "notice" : event.compact ? "compact" : "message" })
          if (queuedText.size > QUEUED_KEPT) queuedText.delete(queuedText.keys().next().value!)
          break
        case "queue.edited": {
          // An edit from any terminal: the prompt pulled back for editing is the edited text.
          const known = queuedText.get(event.queueId)
          if (known) queuedText.set(event.queueId, { ...known, text: `${known.kind === "shell" ? /^!*/.exec(known.text)![0] : ""}${event.text}` })
          break
        }
        case "queue.changed": {
          const queued = new Set(event.queue.map((entry) => entry.queueId))
          for (const queueId of shellQueued) if (!queued.has(queueId)) shellQueued.delete(queueId)
          departed = new Map()
          for (const [queueId, prompt] of queuedText) if (!queued.has(queueId)) { departed.set(queueId, prompt); queuedText.delete(queueId) }
          break
        }
      }
    },
    /** `at` of the running turn's `turn.started`; undefined between turns. */
    get startedAt() {
      return startedAt
    },
    /** The provider retry being waited out; cleared by the next item event or the end of the turn. */
    get retry() {
      return retry
    },
    /** The most recently started item that has not completed. */
    get current(): RunningItem | undefined {
      return [...running.values()].at(-1)
    },
    /** Output tokens of this turn's finished calls: what each call's usage reported, never an estimate. */
    get output() {
      return output
    },
    /** The output so far: the finished calls' reported count plus what the engine has reported for the work no usage record holds yet. Never an estimate. */
    get outputLive() {
      return output + liveOutput
    },
    /** `turn.tokens`: the engine's running output count for the turn in flight; a push for another turn, or between turns, is dropped. Returns whether it changed. */
    noteLive(event: { turnId: string; output: number }) {
      if (startedAt === undefined || event.turnId !== turnId || event.output === liveOutput) return false
      liveOutput = event.output
      return true
    },
    /** Input tokens of this turn's finished calls (exact): what was sent, cache included. */
    get input() {
      return input
    },
    /** The part of `input` read from the provider's prompt cache (exact): resent context, not new tokens. */
    get cached() {
      return cached
    },
    get totals() {
      return totals as Readonly<typeof totals>
    },
    isShellQueued: (queueId: QueueId) => shellQueued.has(queueId),
    /** The running turn's own message as typed, when this client saw it start; undefined otherwise (several joined, or attached mid-turn). */
    get sentPrompt() {
      return sent
    },
    queuedPrompt: (queueId: QueueId): QueuedPrompt | undefined => queuedText.get(queueId),
    extras: (requestId: RequestId): RequestExtras => requests.get(requestId) ?? {},
  }
}
export type TurnState = ReturnType<typeof createTurnState>
