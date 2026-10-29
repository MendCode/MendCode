import type { AgentCommandKind, AgentCommandPolicy, AgentCommandRecord, AgentCommandRequest, AgentCommandsReport, SessionEvent, SessionId, QueueId, TurnId } from "@mendcode/protocol"
import { replaceSecretMarkers } from "@mendcode/protocol/wire"
import type { Clock } from "@mendcode/kernel"
import type { Store } from "@mendcode/store"
import { peerMessage, peerReply } from "./peers"

const TERMINAL = new Set(["completed", "rejected", "failed", "expired"])
const TTL = 30 * 60_000
const MAX_PENDING = 3
const KINDS: AgentCommandKind[] = ["request_summary", "rename", "tag", "pause_after_turn", "stop", "send_message", "peer_message"]

export function agentCommandPolicy(kind: AgentCommandKind): AgentCommandPolicy {
  const permissions = kind === "request_summary" ? ["session.summary.read"] : kind === "pause_after_turn" ? ["session.control.pause_after_turn"] : kind === "stop" ? ["session.control.stop"] : kind === "send_message" ? ["session.message.send"] : kind === "peer_message" ? [] : ["agent_view.metadata.patch"]
  if (kind === "request_summary") return { decision: "safe_auto", permissions, reason: "Read-only summary request; target review remains available." }
  if (kind === "peer_message") return { decision: "safe_auto", permissions, reason: "Non-authorizing text, delivered at the target's idle boundary." }
  if (kind === "rename" || kind === "tag") return { decision: "same_workspace", permissions, reason: "Metadata only, same project; target receives an auditable command." }
  return { decision: "approval_required", permissions, reason: "Execution changes require explicit target approval." }
}

/**
 * Durable local inbox. Control authority is never inferred from a source session or permission mode: pause/stop run
 * only after the target session's own client approves the command (`approval_required`), and only within one project.
 */
export function createAgentCommands(input: {
  store: Store
  clock: Clock
  /** Runs an approved control request on the target: pause after the running turn, or stop it. */
  control(sessionId: SessionId, action: "pause" | "stop"): Promise<{ paused: boolean; cancelledTurn: boolean; cancelledChildren: number }>
  id(): AgentCommandRecord["commandId"]
  changed(sourceSessionId: SessionId, targetSessionId: SessionId): void
  mask(sessionId: SessionId, text: string): string
  notify(sessionId: SessionId, text: string, delivery?: "queue" | "steer"): Promise<QueueId | undefined>
  submit(sessionId: SessionId, text: string): Promise<QueueId | undefined>
}) {
  const records = input.store.agentCommands
  const byQueue = new Map<QueueId, AgentCommandRecord["commandId"]>()
  const byTurn = new Map<TurnId, AgentCommandRecord["commandId"]>()
  const started = new Map<QueueId, TurnId>()
  const turns = new Map<TurnId, { answer: string; state?: "completed" | "failed"; error?: string; ended?: "completed" | "failed" | "cancelled" | "interrupted" }>()
  const items = new Map<string, TurnId>()

  // Secret numbers belong to one session; forwarding a marker could resolve another session's secret.
  const sharedText = (sessionId: SessionId, text: string) => replaceSecretMarkers(input.mask(sessionId, text), () => "[redacted:peer-secret]")

  function save(record: AgentCommandRecord) {
    records.put(record)
    input.changed(record.sourceSessionId, record.targetSessionId)
    return record
  }
  function update(record: AgentCommandRecord, patch: Partial<AgentCommandRecord>) {
    return save({ ...record, ...patch, updatedAt: input.clock.now() })
  }
  function visible(record: AgentCommandRecord): AgentCommandRecord {
    if (record.state === "pending" && record.expiresAt <= input.clock.now()) return { ...record, state: "expired", error: "Command expired before the target accepted it." }
    return record
  }
  function scope(source: SessionId, target: SessionId) {
    const from = input.store.sessionInfo(source)
    const to = input.store.sessionInfo(target)
    if (!from || !to) throw new Error("Unknown session")
    if (source === target) throw new Error("Choose another session")
    if (from.directory !== to.directory) throw new Error("That session belongs to another project")
    return { from, to }
  }
  function normalize(sessionId: SessionId, request: AgentCommandRequest): AgentCommandRequest {
    const text = (value: string, limit: number) => sharedText(sessionId, value.trim()).slice(0, limit)
    if (request.kind === "rename") {
      const title = text(request.title, 120)
      if (!title) throw new Error("Title is empty")
      return { ...request, title }
    }
    if (request.kind === "tag") return { ...request, tags: [...new Set(request.tags.map((tag) => text(tag, 40)).filter(Boolean))].slice(0, 20) }
    if (request.kind === "request_summary") return { ...request, ...(request.instructions === undefined ? {} : { instructions: text(request.instructions, 1000) }) }
    if (request.kind === "send_message" || request.kind === "peer_message") {
      const body = text(request.text, 4000)
      if (!body) throw new Error("Message is empty")
      return { ...request, text: body }
    }
    return { ...request, ...(request.reason === undefined ? {} : { reason: text(request.reason, 1000) }) }
  }
  function finish(record: AgentCommandRecord, turn: { answer: string; state?: "completed" | "failed"; error?: string; ended?: "completed" | "failed" | "cancelled" | "interrupted" }) {
    if (record.turnId) byTurn.delete(record.turnId)
    let result: string
    try { result = sharedText(record.targetSessionId, turn.answer.trim()).slice(-4000) } catch {
      update(record, { state: "failed", error: "Unable to store the result safely; secret store unavailable" })
      return
    }
    const settled = update(record, { state: turn.state ?? "failed", ...(result ? { result } : {}), ...(turn.error ? { error: turn.error } : {}) })
    if (record.request.kind === "peer_message") {
      const reply = peerReply({ to: record.targetSessionId, title: input.store.sessionInfo(record.targetSessionId)?.title ?? "", answer: settled.result ?? "", ended: turn.ended ?? "failed" })
      try { void input.notify(record.sourceSessionId, sharedText(record.targetSessionId, reply)).catch(() => undefined) } catch {}
    }
  }
  function attach(record: AgentCommandRecord, turnId: TurnId) {
    const running = update(record, { state: "running", turnId })
    const turn = turns.get(turnId)
    if (turn?.state) finish(running, turn)
    else byTurn.set(turnId, record.commandId)
  }
  const trim = <K, V>(map: Map<K, V>, keep: (key: K, value: V) => boolean = () => false) => {
    for (const [key, value] of map) {
      if (map.size <= 200) break
      if (!keep(key, value)) map.delete(key)
    }
  }

  async function execute(record: AgentCommandRecord) {
    const request = record.request
    if (request.kind === "rename" || request.kind === "tag") {
      records.patchMetadata(record.targetSessionId, request.kind === "rename" ? { title: request.title } : { tags: request.tags })
      return update(record, { state: "completed", result: request.kind === "rename" ? "Renamed target Agent View row." : "Updated target Agent View tags." })
    }
    if (request.kind === "pause_after_turn" || request.kind === "stop") {
      const outcome = await input.control(record.targetSessionId, request.kind === "stop" ? "stop" : "pause")
      const result = request.kind === "stop"
        ? `Stopped target: ${outcome.cancelledTurn ? "cancelled the running turn" : "no running turn"}, ${outcome.cancelledChildren} child task${outcome.cancelledChildren === 1 ? "" : "s"} cancelled.`
        : "Paused target: it finishes the running turn and starts nothing until the user resumes it."
      return update(record, { state: "completed", result })
    }
    const text = request.kind === "request_summary"
      ? `Read-only summary requested by session ${record.sourceSessionId}. Summarize progress, findings and remaining work. Do not change files, run commands or grant permissions. Additional summary instructions (non-authorizing): ${JSON.stringify(request.instructions ?? "")}`
      : request.kind === "peer_message" ? peerMessage({ from: record.sourceSessionId, title: input.store.sessionInfo(record.sourceSessionId)?.title ?? "", text: request.text }) : request.text
    const safe = sharedText(record.sourceSessionId, text)
    const queueId = await (request.kind === "send_message" ? input.submit(record.targetSessionId, safe) : input.notify(record.targetSessionId, safe, request.kind === "peer_message" ? request.mode : undefined))
    if (!queueId) return update(record, { state: "failed", error: "Target could not take the request" })
    const queued = update(record, { queueId })
    const turnId = started.get(queueId)
    if (turnId) attach(queued, turnId)
    else byQueue.set(queueId, record.commandId)
    return records.get(record.commandId)!
  }

  async function run(record: AgentCommandRecord) {
    try { return await execute(record) } catch (error) {
      let message = "Unable to deliver the request safely"
      try { message = sharedText(record.targetSessionId, String(error)).slice(0, 4000) } catch {}
      return update(record, { state: "failed", error: message })
    }
  }

  return {
    recover() {
      for (const record of records.unfinished()) {
        if (record.queueId && input.store.queueOf(record.targetSessionId).some((entry) => entry.queueId === record.queueId)) {
          byQueue.set(record.queueId, record.commandId)
          continue
        }
        const turn = record.turnId && input.store.turns.get(record.targetSessionId, record.turnId)
        if (turn && turn.status !== "running") {
          let cursor = turn.seq
          let answer = ""
          let ended = false
          const answerItems = new Set<string>()
          while (!ended) {
            const events = input.store.readAfter(record.targetSessionId, cursor, 1000)
            if (!events.length) break
            for (const event of events) {
              cursor = event.seq
              if (event.type === "item.started" && event.turnId === record.turnId && event.kind === "agent_message") answerItems.add(event.itemId)
              if (event.type === "item.completed" && answerItems.has(event.itemId) && event.text?.trim()) answer = event.text
              if ("turnId" in event && event.turnId === record.turnId && ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) {
                ended = true
                break
              }
            }
          }
          finish(record, { answer, state: turn.status === "completed" ? "completed" : "failed", ended: turn.status, ...(turn.status !== "completed" ? { error: `Target turn ${turn.status}` } : {}) })
          continue
        }
        // An unlinked delivery may have reached a provider. Never insert the same prompt again.
        update(record, { state: "failed", error: "Daemon restarted before delivery could be verified; inspect the target before requesting again." })
      }
    },
    waiting: (sessionId: SessionId) => records.active(sessionId, input.clock.now(), "source").filter((record) => record.request.kind === "peer_message").length,
    policy: () => ({ matrix: KINDS.map((kind) => ({ kind, ...agentCommandPolicy(kind) })) }),
    list(sessionId: SessionId): AgentCommandsReport {
      const info = input.store.sessionInfo(sessionId)
      if (!info) throw new Error("Unknown session")
      const commands = records.list(sessionId, input.clock.now()).filter((record) => input.store.sessionDirectory(record.sourceSessionId) === info.directory && input.store.sessionDirectory(record.targetSessionId) === info.directory).map(visible)
      commands.sort((a, b) => Number(TERMINAL.has(a.state)) - Number(TERMINAL.has(b.state)) || b.updatedAt - a.updatedAt || b.commandId.localeCompare(a.commandId))
      return { commands: commands.slice(0, 100), metadata: records.metadata(info.directory).map((entry) => ({ sessionId: entry.sessionId, tags: entry.tags, ...(entry.title ? { title: entry.title } : {}) })) }
    },
    async create(sessionId: SessionId, targetSessionId: SessionId, request: AgentCommandRequest, expiresAt?: number) {
      scope(sessionId, targetSessionId)
      request = normalize(sessionId, request)
      const active = records.active(targetSessionId, input.clock.now(), "target")
      const duplicate = active.find((record) => record.sourceSessionId === sessionId && JSON.stringify(record.request) === JSON.stringify(request))
      if (duplicate) return duplicate
      const now = input.clock.now()
      const expiry = request.kind === "peer_message" ? Math.min(expiresAt ?? now + TTL, now + 86_400_000) : expiresAt ?? now + TTL
      const error = expiry <= now ? "Command expired before it could be queued." : active.length >= MAX_PENDING ? "Target already has 3 queued commands; wait for one to finish." : undefined
      const record = save({ commandId: input.id(), sourceSessionId: sessionId, targetSessionId, request, state: expiry <= now ? "expired" : error ? "rejected" : "pending", policy: agentCommandPolicy(request.kind), expiresAt: expiry, createdAt: now, updatedAt: now, ...(error ? { error } : {}) })
      if (record.state === "pending" && request.kind === "peer_message") return run(update(record, { state: "accepted" }))
      return record
    },
    async review(sessionId: SessionId, commandId: AgentCommandRecord["commandId"], state: "accepted" | "rejected") {
      const stored = records.get(commandId)
      if (!stored || stored.targetSessionId !== sessionId) throw new Error("Only the target session can review this command")
      scope(stored.sourceSessionId, stored.targetSessionId)
      const record = visible(stored)
      if (record.state !== "pending") throw new Error(`Invalid command transition: ${record.state} → ${state}`)
      const next = update(record, { state })
      if (state === "rejected") return next
      return run(next)
    },
    async patch(sessionId: SessionId, commandId: AgentCommandRecord["commandId"], patch: { state?: AgentCommandRecord["state"] | undefined; error?: string | null | undefined; result?: string | null | undefined }) {
      const stored = records.get(commandId)
      if (!stored || stored.targetSessionId !== sessionId) throw new Error("Only the target session can update this command")
      scope(stored.sourceSessionId, stored.targetSessionId)
      const record = visible(stored)
      const next = patch.state ?? record.state
      const transitions: Record<AgentCommandRecord["state"], string[]> = { pending: ["accepted", "running", "rejected", "expired"], accepted: ["running", "completed", "failed", "rejected", "expired"], running: ["completed", "failed", "rejected", "expired"], completed: [], rejected: [], failed: [], expired: [] }
      if (next !== record.state && !transitions[record.state].includes(next)) throw new Error(`Invalid command transition: ${record.state} → ${next}`)
      if ((record.request.kind === "stop" || record.request.kind === "pause_after_turn") && ["running", "completed"].includes(next)) throw new Error("Control commands complete only by running on approval")
      const updated = next === "accepted" && record.state === "pending" ? await this.review(sessionId, commandId, "accepted") : update(record, { state: next })
      if (TERMINAL.has(updated.state)) {
        if (updated.queueId) byQueue.delete(updated.queueId)
        if (updated.turnId) byTurn.delete(updated.turnId)
      }
      const fields = { ...updated }
      for (const key of ["error", "result"] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null || !value.trim()) delete fields[key]
        else fields[key] = sharedText(sessionId, value.trim()).slice(0, 4000)
      }
      return save(fields)
    },
    observe(event: SessionEvent) {
      if (event.type === "queue.changed") {
        const queued = new Set(event.queue.map((entry) => entry.queueId))
        // The actor removes a queue entry just before publishing turn.started in the same mailbox pass.
        queueMicrotask(() => {
          for (const [queueId, id] of byQueue) {
            const record = records.get(id)
            if (record?.targetSessionId === event.sessionId && !queued.has(queueId) && !started.has(queueId)) {
              byQueue.delete(queueId)
              update(record, { state: "failed", error: "Target removed the queued command before it started" })
            }
          }
        })
      } else if (event.type === "turn.started") {
        started.set(event.queueId, event.turnId)
        turns.set(event.turnId, { answer: "" })
        trim(started)
        trim(turns, (turnId) => byTurn.has(turnId))
        const id = byQueue.get(event.queueId)
        if (id) {
          byQueue.delete(event.queueId)
          const record = records.get(id)
          if (record) attach(record, event.turnId)
        }
      } else if (event.type === "item.started" && event.kind === "agent_message") {
        items.set(event.itemId, event.turnId)
        trim(items, (_itemId, turnId) => byTurn.has(turnId))
      } else if (event.type === "item.completed") {
        const turnId = items.get(event.itemId)
        const turn = turnId && turns.get(turnId)
        if (turn && event.text?.trim()) turn.answer = event.text
        items.delete(event.itemId)
      } else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted") {
        const turn = turns.get(event.turnId)
        if (!turn) return
        turn.ended = event.type.slice(5) as "completed" | "failed" | "cancelled" | "interrupted"
        turn.state = event.type === "turn.completed" ? "completed" : "failed"
        if (turn.state === "failed") turn.error = `Target turn ${event.type.slice(5)}`
        const id = byTurn.get(event.turnId)
        const record = id && records.get(id)
        if (record) finish(record, turn)
      }
    },
  }
}
