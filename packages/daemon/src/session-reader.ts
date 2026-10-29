import { MAX_FRAME_BYTES, redactSecrets, type HistoryItem, type HistoryReport, type HistoryTurn, type SessionId, type TurnId } from "@mendcode/protocol"
import type { Store, TurnRecord } from "@mendcode/store"
import type { Outcome } from "./session-history"

const PAGE = 200
const TEXT = 40_000
const TOOL = 6_000
const ITEMS = 200
const BUDGET = MAX_FRAME_BYTES - 16_000

/** Reads one complete turn by event sequence, with bounded text and a visible cut marker. */
function readTurn(store: Store, sessionId: SessionId, record: TurnRecord, end: number): HistoryTurn {
  const turn: HistoryTurn = { turnId: record.turnId as TurnId, at: record.at, seq: record.seq, preview: redactSecrets(record.preview.slice(0, 1024)).text, outcome: record.status, items: [] }
  const items = new Map<string, HistoryItem>()
  let bytes = 0
  let events = 0
  for (let cursor = record.seq - 1; cursor < end - 1;) {
    const page = store.readAfter(sessionId, cursor, PAGE)
    if (!page.length) break
    for (const event of store.messages.project(page)) {
      if (event.seq >= end) return turn
      cursor = event.seq
      if (++events > 20_000) { turn.truncated = true; return turn }
      if (event.type === "item.started" && event.kind !== "reasoning") {
        if (turn.items.length >= ITEMS) { turn.truncated = true; continue }
        const tool = typeof event.meta?.tool === "string" ? redactSecrets(event.meta.tool.slice(0, 256)).text : undefined
        const title = typeof event.meta?.title === "string" ? redactSecrets(event.meta.title.slice(0, 512)).text : undefined
        const item: HistoryItem = { itemId: event.itemId, kind: event.kind, text: "", status: "running", ...(tool ? { tool } : {}), ...(title ? { title } : {}) }
        if (bytes + Buffer.byteLength(JSON.stringify(item)) > BUDGET) { turn.truncated = true; continue }
        turn.items.push(item)
        items.set(event.itemId, item)
        bytes += Buffer.byteLength(JSON.stringify(item))
      } else if (event.type === "item.delta" || event.type === "item.completed") {
        const item = items.get(event.itemId)
        if (!item) continue
        const cap = item.kind === "tool_call" ? TOOL : TEXT
        const text = event.type === "item.delta" ? item.text + event.text : event.text ?? item.text
        bytes -= Buffer.byteLength(JSON.stringify(item))
        const room = Math.max(0, Math.min(cap, Math.floor((BUDGET - bytes) / 6)))
        item.text = redactSecrets(text.slice(0, room)).text
        if (text.length > room) item.truncated = true
        if (event.type === "item.completed") {
          item.status = event.status
          if (event.blob) item.truncated = true
          if (event.attachments?.length) {
            item.attachmentRefs = event.attachments.slice(0, 20).map((ref) => ({ ...ref, ...(ref.name ? { name: redactSecrets(ref.name).text.slice(0, 255) } : {}) }))
            item.attachments = item.attachmentRefs.map((ref) => ref.name ?? ref.sha256.slice(0, 12))
            if (event.attachments.length > 20) item.truncated = true
          }
        }
        while (item.attachments?.length && bytes + Buffer.byteLength(JSON.stringify(item)) > BUDGET) { item.attachments.pop(); item.attachmentRefs?.pop(); item.truncated = true }
        bytes += Buffer.byteLength(JSON.stringify(item))
      }
    }
    cursor = Math.min(end - 1, page.at(-1)!.seq)
    if (page.length < PAGE) break
  }
  return turn
}

export function readSessionHistory(store: Store, input: { sessionId: SessionId; before?: number | undefined; after?: number | undefined; limit?: number | undefined; turnId?: TurnId | undefined }): Outcome<HistoryReport> {
  if (!store.hasSession(input.sessionId)) return { ok: false, code: "unknown_session", message: "[DAEMON]: unknown session" }
  const all = store.turns.list(input.sessionId)
  const visible = all.filter((turn) => !turn.reverted && !turn.notice && turn.itemId)
  const eligible = visible.filter((turn) => input.turnId ? turn.turnId === input.turnId : (input.before === undefined || turn.seq < input.before) && (input.after === undefined || turn.seq > input.after))
  if (input.turnId && !eligible.length) return { ok: false, code: "target_mismatch", message: "[DAEMON]: history turn unavailable" }
  const selected = input.after !== undefined ? eligible.slice(0, input.limit ?? 20) : eligible.slice(-(input.limit ?? 20))
  const report: HistoryReport = { turns: [] }
  // Fill toward the requested cursor. A large turn shrinks the page rather than splitting a turn across pages.
  for (const record of input.after !== undefined ? selected : [...selected].reverse()) {
    const index = all.indexOf(record)
    const turn = readTurn(store, input.sessionId, record, all[index + 1]?.seq ?? (store.lastSeq(input.sessionId) ?? 0) + 1)
    const proposed = { turns: [...report.turns, turn] }
    if (Buffer.byteLength(JSON.stringify(proposed)) > MAX_FRAME_BYTES - 4_096) break
    report.turns.push(turn)
  }
  report.turns.sort((a, b) => a.seq - b.seq)
  const first = report.turns[0]?.seq
  const last = report.turns.at(-1)?.seq
  if (first !== undefined && visible.some((turn) => turn.seq < first)) report.older = first
  if (last !== undefined && visible.some((turn) => turn.seq > last)) report.newer = last
  return { ok: true, result: report }
}
