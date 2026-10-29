import type { QueueId, SessionEvent, SessionId, TurnId } from "@mendcode/protocol"
import type { Clock } from "@mendcode/kernel"
import type { PeerPort, PeerSession } from "@mendcode/tools"

export const MAX_PEER_SESSIONS = 32
/** Messages one session may have waiting for an answer at once, and may send per hour (no ping-pong storms). */
export const MAX_WAITING_PER_SESSION = 3
export const MAX_TELLS_PER_HOUR = 20
const MAX_MESSAGE = 8_000
const MAX_REPLY = 8_000
const HOUR = 3_600_000

type Delivery = { from: SessionId; to: SessionId; turnId?: TurnId }
type Ending = "completed" | "failed" | "cancelled" | "interrupted"
const RECENT_TURNS = 200

/** The notice the target reads: who wrote, the message, and that its final answer goes back. */
export function peerMessage(input: { from: SessionId; title: string; text: string }) {
  return `[message from session ${input.from} "${input.title || "untitled"}" in this project]\n${input.text}\n\nYour final answer in this turn is sent back to that session automatically; do not use tell to reply.`
}

/** The notice the sender gets back: the target's final answer, or why there is none. */
export function peerReply(input: { to: SessionId; title: string; answer: string; ended: "completed" | "failed" | "cancelled" | "interrupted" }) {
  const head = `[reply from session ${input.to} "${input.title || "untitled"}"${input.ended === "completed" ? "" : ` · its turn ${input.ended}`}]`
  return `${head}\n${input.answer.trim() || "(no answer text)"}`
}

/**
 * Session-to-session messages inside one project (§ peers). `tell` queues a notice in the target, which answers at
 * its next free moment without being interrupted; when the turn that read it ends, its last answer is queued back to
 * the sender as a notice. Replies are never forwarded again, so there is no acknowledgement loop. Deliveries live in
 * memory: after a daemon restart a pending reply is dropped.
 */
export function createPeers(input: {
  clock: Clock
  waiting?(sessionId: SessionId): number
  deliver?(from: SessionId, to: SessionId, text: string, mode?: "queue" | "steer"): ReturnType<PeerPort["tell"]>
  sessions(directory: string, limit: number): Array<{ sessionId: string; title: string; updatedAt: number }>
  info(sessionId: SessionId): { title: string; directory: string } | undefined
  state(sessionId: SessionId): string
  notify(sessionId: SessionId, text: string, delivery?: "queue" | "steer"): Promise<QueueId | undefined>
  /** A session's figures as text (`session stats`), or undefined when it is gone. */
  stats?(sessionId: SessionId): string | undefined
}) {
  /** Answers by sender, target and `clientRequestId` (bounded): a retried `tell` returns the first answer and sends nothing. */
  const requests = new Map<string, Awaited<ReturnType<PeerPort["tell"]>>>()
  const byQueue = new Map<QueueId, Delivery>()
  const byTurn = new Map<TurnId, Delivery>()
  const sent = new Map<SessionId, number[]>()
  // Recent turns of every session, so a message whose turn started (or even ended) before `notify` returned still
  // gets its answer: which queue entry started each turn, its last answer text and how it ended.
  const startedBy = new Map<QueueId, TurnId>()
  const turns = new Map<TurnId, { answer: string; ended?: Ending }>()
  const answerItems = new Map<string, TurnId>()

  const trim = <K, V>(map: Map<K, V>) => {
    while (map.size > RECENT_TURNS) map.delete(map.keys().next().value!)
  }

  function attach(delivery: Delivery, turnId: TurnId) {
    delivery.turnId = turnId
    const ended = turns.get(turnId)?.ended
    if (ended) finish(delivery, ended)
    else byTurn.set(turnId, delivery)
  }

  function waiting(from: SessionId) {
    if (input.waiting) return input.waiting(from)
    let count = 0
    for (const delivery of [...byQueue.values(), ...byTurn.values()]) if (delivery.from === from) count++
    return count
  }

  function finish(delivery: Delivery, ended: Ending) {
    if (delivery.turnId) byTurn.delete(delivery.turnId)
    const answer = (delivery.turnId && turns.get(delivery.turnId)?.answer) || ""
    const title = input.info(delivery.to)?.title ?? ""
    void input.notify(delivery.from, peerReply({ to: delivery.to, title, answer: answer.slice(-MAX_REPLY), ended }))
  }

  const ENDINGS: Partial<Record<SessionEvent["type"], Ending>> = { "turn.completed": "completed", "turn.failed": "failed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted" }

  return {
    /** Follows turns: which queue entry started each, its answer text, and how it ended. */
    observe(event: SessionEvent) {
      if (event.type === "turn.started") {
        turns.set(event.turnId, { answer: "" })
        startedBy.set(event.queueId, event.turnId)
        trim(turns)
        trim(startedBy)
        const delivery = byQueue.get(event.queueId)
        if (delivery) {
          byQueue.delete(event.queueId)
          attach(delivery, event.turnId)
        }
        return
      }
      if (event.type === "item.started" && event.kind === "agent_message") {
        answerItems.set(event.itemId, event.turnId)
        trim(answerItems)
        return
      }
      if (event.type === "item.completed") {
        const turnId = answerItems.get(event.itemId)
        const turn = turnId && turns.get(turnId)
        if (turn && typeof event.text === "string" && event.text.trim()) turn.answer = event.text
        return
      }
      const ending = ENDINGS[event.type]
      if (!ending || !("turnId" in event)) return
      const turnId = event.turnId as TurnId
      const turn = turns.get(turnId)
      if (turn) turn.ended = ending
      const delivery = byTurn.get(turnId)
      if (delivery) finish(delivery, ending)
    },
    port(from: SessionId): PeerPort {
      return {
        stats(target) {
          const id = (target === "self" || target === from ? from : target) as SessionId
          const origin = input.info(from)
          const info = input.info(id)
          if (!origin || !info || info.directory !== origin.directory) return { ok: false, message: `no session ${target} in this project; use sessions to list them` }
          const text = input.stats?.(id)
          return text ? { ok: true, output: text } : { ok: false, message: "session figures are not available here" }
        },
        list(limit = MAX_PEER_SESSIONS): PeerSession[] {
          const directory = input.info(from)?.directory
          if (!directory) return []
          const count = Math.min(MAX_PEER_SESSIONS, Math.max(1, Math.floor(limit)))
          return input
            .sessions(directory, count + 1)
            .filter((session) => session.sessionId !== from)
            .slice(0, count)
            .map((session) => ({ sessionId: session.sessionId, title: session.title.slice(0, 160), state: input.state(session.sessionId as SessionId), updatedAt: session.updatedAt }))
        },
        async tell(target, text, options) {
          const requestKey = options?.clientRequestId ? `${from}>${target}:${options.clientRequestId}` : undefined
          const earlier = requestKey ? requests.get(requestKey) : undefined
          if (earlier) return earlier
          const answer = await sendTell(from, target, text, options?.mode === "steer" ? "steer" : options?.mode === "queue" ? "queue" : undefined)
          if (requestKey && answer.ok) {
            requests.set(requestKey, answer)
            if (requests.size > 500) requests.delete(requests.keys().next().value!)
          }
          return answer
        },
      }
    },
  }

  async function sendTell(from: SessionId, target: string, text: string, mode: "queue" | "steer" | undefined): ReturnType<PeerPort["tell"]> {
    const to = target as SessionId
    const source = input.info(from)
    const destination = input.info(to)
    if (to === from) return { ok: false, message: "that is this session" }
    if (!destination) return { ok: false, message: `no session ${target}; use sessions to list this project's sessions` }
    if (!source || destination.directory !== source.directory) return { ok: false, message: "that session belongs to another project" }
    if (!text.trim()) return { ok: false, message: "the message is empty" }
    if (waiting(from) >= MAX_WAITING_PER_SESSION) return { ok: false, message: `${MAX_WAITING_PER_SESSION} messages are already waiting for answers; wait for a reply first` }
    const now = input.clock.now()
    const recent = (sent.get(from) ?? []).filter((at) => now - at < HOUR)
    if (recent.length >= MAX_TELLS_PER_HOUR) return { ok: false, message: `at most ${MAX_TELLS_PER_HOUR} messages per hour` }
    const busy = input.state(to) !== "idle"
    if (input.deliver) {
      const delivered = await input.deliver(from, to, text, mode)
      if (delivered.ok) sent.set(from, [...recent, now])
      return delivered
    }
    const queueId = await input.notify(to, peerMessage({ from, title: source.title, text: text.slice(0, MAX_MESSAGE) }), mode)
    if (!queueId) return { ok: false, message: "the session could not take the message" }
    sent.set(from, [...recent, now])
    const delivery: Delivery = { from, to }
    const turnId = startedBy.get(queueId)
    if (turnId) attach(delivery, turnId)
    else byQueue.set(queueId, delivery)
    return { ok: true, waiting: busy }
  }
}
