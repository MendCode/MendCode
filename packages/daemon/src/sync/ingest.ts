import { MAX_SYNC_BLOB_BYTES, SessionEvent, type SessionId } from "@mendcode/protocol"

/** One synced event stays inside one stored event (80 KiB). */
const MAX_EVENT_BYTES = 80 * 1024

export class SyncRefusal extends Error {
  constructor(readonly code: "conflict" | "invalid" | "forbidden" | "busy", message: string) { super(`[SYNC]: ${message}`) }
}

/** Events received from the other machine, checked: one session, valid native events, rising seqs after `after`. */
export function parseSyncEvents(sessionId: SessionId, raw: readonly unknown[], after: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let previous = after
  for (const value of raw) {
    const parsed = SessionEvent.safeParse(value)
    if (!parsed.success) throw new SyncRefusal("invalid", "an event of the history is not a valid session event")
    const event = parsed.data
    if (event.sessionId !== sessionId) throw new SyncRefusal("invalid", "an event belongs to another session")
    if (event.seq <= previous) throw new SyncRefusal("invalid", `events must rise after seq ${previous}`)
    if (event.type === "session.created" && (event.seq !== 1 || event.parentId)) throw new SyncRefusal("invalid", "only a root session's own creation, at seq 1, can be synced")
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new SyncRefusal("invalid", "an event exceeds the stored event size")
    previous = event.seq
    events.push(event)
  }
  return events
}

/**
 * How many leading events end at a settled point: no turn running, no item open. A session is copied only up to such a point,
 * so the receiving machine never holds a half turn (it would look like a crashed run there). Returns 0 when none is settled yet.
 */
export function settledPrefix(events: readonly SessionEvent[]): number {
  let turn: string | undefined
  const items = new Set<string>()
  let settled = 0
  for (const [index, event] of events.entries()) {
    if (event.type === "turn.started") turn = event.turnId
    else if (event.type === "item.started") items.add(event.itemId)
    else if (event.type === "item.completed") items.delete(event.itemId)
    else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted") { turn = undefined; items.clear() }
    if (turn === undefined && items.size === 0) settled = index + 1
  }
  return settled
}

/** The model messages a settled run of events adds: what the receiving machine's native engine continues from (a portable handoff, as REST replay). */
export function syncedMessages(events: readonly SessionEvent[]) {
  const kinds = new Map<string, string>()
  const deltas = new Map<string, string>()
  const messages: Array<{ role: "user"; content: string } | { role: "assistant"; content: string; toolCalls: [] }> = []
  for (const event of events) {
    if (event.type === "item.started") kinds.set(event.itemId, event.kind)
    if (event.type === "item.delta") deltas.set(event.itemId, (deltas.get(event.itemId) ?? "") + event.text)
    if (event.type !== "item.completed") continue
    const kind = kinds.get(event.itemId)
    const content = event.text ?? deltas.get(event.itemId) ?? ""
    if (kind === "user_message") messages.push({ role: "user", content })
    if (kind === "agent_message" || kind === "tool_call") messages.push({ role: "assistant", content: kind === "tool_call" ? `[Synced tool result]\n${content}` : content, toolCalls: [] })
  }
  return messages
}

/** The blobs these events reference, each once; those over the sync cap are listed apart (they are not copied). */
export function blobRefs(events: readonly SessionEvent[]) {
  const all = new Map<string, { sha256: string; bytes: number; mime: string }>()
  for (const event of events) {
    const refs = event.type === "item.completed" ? [...(event.blob ? [event.blob] : []), ...(event.attachments ?? [])] : event.type === "queue.added" ? event.attachments : []
    for (const ref of refs) all.set(ref.sha256, { sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime })
  }
  const copied = [...all.values()].filter((ref) => ref.bytes <= MAX_SYNC_BLOB_BYTES)
  return { copied, skipped: all.size - copied.length }
}

/** JSON with sorted keys: a stored event read back and the same event as sent compare equal whatever their key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}

/** Directories inside events are the other machine's: they become this machine's own (deterministic, so a resend matches). */
export function withDirectory(events: readonly SessionEvent[], map: (directory: string) => string): SessionEvent[] {
  return events.map((event) => event.type === "session.created" || event.type === "session.workspace.changed" ? { ...event, directory: map(event.directory) } : event)
}
