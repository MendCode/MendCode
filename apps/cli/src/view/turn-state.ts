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

export type RunningItem = { kind: ItemKind; tool?: string; /** The model is still writing the call's input; the tool has not started. */ writing?: boolean; /** Input characters written so far. */ inputChars?: number }

/** A queued entry as the user typed it: its text (the original request when an extension rewrote it), attachments and what kind it is. */
export type QueuedPrompt = { text: string; attachments: BlobRef[]; kind: "message" | "shell" | "notice" | "compact" }
const QUEUED_KEPT = 64
/** Characters of streamed text per token, for the estimate shown until the provider reports the call's exact usage. */
const CHARS_PER_TOKEN = 4

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
  /** Characters of answer and reasoning streamed since the last reported usage: the call in flight, not counted yet. */
  let streamed = 0
  let startedAt: number | undefined
  let retry: RetryState | undefined
  const running = new Map<ItemId, RunningItem>()
  const requests = new Map<RequestId, RequestExtras>()
  const resolvedRequests = new Set<RequestId>()
  /** Queued entries that are the user's own `!command` (the queue preview does not say so). */
  const shellQueued = new Set<QueueId>()
  /** The full text of what is queued (the queue event carries only a 200-character preview), so a queued prompt can be pulled back to edit. Entries leave with the queue. */
  const queuedText = new Map<QueueId, QueuedPrompt>()
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
    startedAt = undefined
    retry = undefined
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
          output = 0
          input = 0
          streamed = 0
          startedAt = event.at
          totals.turns++
          break
        case "usage.recorded":
          // v1: input counts the cache, output counts the reasoning.
          totals.input += event.input + event.cacheRead + event.cacheWrite
          totals.output += event.output + event.reasoning
          if (startedAt !== undefined) {
            output += event.output + event.reasoning
            input += event.input + event.cacheRead + event.cacheWrite
            // The call's exact count replaces what its stream suggested.
            streamed = 0
          }
          break
        case "turn.retrying":
          retry = { attempt: event.attempt, nextAt: event.nextAt, message: event.message, ...(event.offlineSince !== undefined ? { offlineSince: event.offlineSince } : {}) }
          break
        case "item.started": {
          retry = undefined
          const tool = typeof event.meta?.tool === "string" ? event.meta.tool.split(":")[0]!.trim() : undefined
          running.set(event.itemId, { kind: event.kind, ...(tool ? { tool } : {}) })
          break
        }
        case "item.delta": {
          retry = undefined
          const item = running.get(event.itemId)
          if (startedAt !== undefined && (item?.kind === "agent_message" || item?.kind === "reasoning")) streamed += event.text.length
          if (item && event.input) {
            // A tool input counts toward the turn's streamed tokens as it is written.
            if (startedAt !== undefined) streamed += Math.max(0, event.input.chars - (item.inputChars ?? 0))
            running.set(event.itemId, { kind: item.kind, ...(item.tool ? { tool: item.tool } : {}), ...(event.input.done ? {} : { writing: true }), inputChars: event.input.chars })
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
          for (const queueId of queuedText.keys()) if (!queued.has(queueId)) queuedText.delete(queueId)
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
    /** Output tokens of this turn's finished calls (exact). */
    get output() {
      return output
    },
    /** Input tokens of this turn's finished calls (exact): what was sent, cache included. */
    get input() {
      return input
    },
    /** The output so far: the finished calls' exact count plus an estimate of the call still streaming. */
    get outputLive() {
      return output + Math.ceil(streamed / CHARS_PER_TOKEN)
    },
    /** True while part of `outputLive` is an estimate (a call is streaming, or the engine reports no usage). */
    get estimating() {
      return streamed > 0
    },
    get totals() {
      return totals as Readonly<typeof totals>
    },
    isShellQueued: (queueId: QueueId) => shellQueued.has(queueId),
    queuedPrompt: (queueId: QueueId): QueuedPrompt | undefined => queuedText.get(queueId),
    extras: (requestId: RequestId): RequestExtras => requests.get(requestId) ?? {},
  }
}
export type TurnState = ReturnType<typeof createTurnState>
