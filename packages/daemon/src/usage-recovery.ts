import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import type { Store } from "@mendcode/store"
import type { SessionId } from "@mendcode/protocol"

type Engine = "claude" | "codex" | "pi"
type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Day = Counts & { day: string }
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const dayOf = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }

/** Pure, metadata-only JSONL extraction. Never returns prompts, tool input/output or credentials. */
export function parseRecovery(text: string, engine: Engine) {
  const ids = new Set<string>()
  const calls = new Map<string, Day>()
  let cumulative = zero()
  let skipped = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let row: any
    try { row = JSON.parse(line) } catch { skipped++; continue }
    if (!row || typeof row !== "object") { skipped++; continue }
    if (engine === "claude" && typeof row.sessionId === "string") ids.add(row.sessionId)
    if (engine === "codex" && row.type === "session_meta" && typeof row.payload?.id === "string") ids.add(row.payload.id)
    if (engine === "pi" && row.type === "session" && typeof row.id === "string") ids.add(row.id)
    const at = typeof row.timestamp === "number" ? row.timestamp : Date.parse(row.timestamp)
    let key: string | undefined
    let values: Counts | undefined
    if (engine === "claude" && row.type === "assistant" && row.message?.usage && row.message.model !== "<synthetic>") {
      key = row.message.id
      const u = row.message.usage
      values = { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) }
    } else if (engine === "pi" && row.type === "message" && row.message?.role === "assistant" && row.message.usage) {
      key = row.id
      const u = row.message.usage
      values = { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) }
    } else if (engine === "codex" && row.type === "event_msg" && row.payload?.type === "token_count") {
      const u = row.payload.info?.total_token_usage
      if (!u) { skipped++; continue }
      const total = { input: Math.max(0, count(u.input_tokens) - count(u.cached_input_tokens)), output: count(u.output_tokens), cacheRead: count(u.cached_input_tokens), cacheWrite: 0 }
      values = zero()
      for (const k of Object.keys(values) as (keyof Counts)[]) {
        values[k] = Math.max(0, total[k] - cumulative[k])
        cumulative[k] = Math.max(cumulative[k], total[k])
      }
      key = `codex:${calls.size}`
    }
    if (!values) continue
    if (typeof key !== "string" || !key || !Number.isFinite(at)) { skipped++; continue }
    const old = calls.get(key)
    if (old) for (const k of Object.keys(values) as (keyof Counts)[]) values[k] = Math.max(values[k], old[k])
    calls.set(key, { ...values, day: old?.day ?? dayOf(at) })
  }
  const days = new Map<string, Day>()
  for (const call of calls.values()) {
    const day = days.get(call.day) ?? { day: call.day, ...zero() }
    for (const k of Object.keys(zero()) as (keyof Counts)[]) day[k] += call[k]
    days.set(call.day, day)
  }
  return { ids: [...ids], days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), skipped }
}

export async function recoverUsage(store: Store, command: { sessionId: SessionId; engine: Engine; action: "preview" | "apply" | "undo"; file?: string | undefined; fingerprint?: string | undefined }) {
  if (!store.hasSession(command.sessionId)) throw new Error("Unknown MendCode session")
  if (store.sessionsWithActiveTurn().some((s) => s.sessionId === command.sessionId)) throw new Error("Stop the session before recovering usage")
  if (command.action === "undo") { store.usageRecovery.undo(command.sessionId, command.engine); return { undone: true } }
  const binding = store.engineBindings.get(command.sessionId, command.engine)
  if (!binding) throw new Error("This session has no binding for the selected harness")
  if (store.engineBindings.owners(command.engine, binding).length !== 1) throw new Error("Shared harness binding is ambiguous; recovery refused")
  if (!command.file?.endsWith(".jsonl")) throw new Error("Select a harness session .jsonl file")
  const file = await open(command.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let text: string
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Session file must be a regular file of at most 32 MiB")
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > stat.size) throw new Error("Session file changed; preview again")
    text = buffer.subarray(0, offset).toString("utf8")
  } finally { await file.close() }
  const parsed = parseRecovery(text, command.engine)
  const matches = command.engine === "pi" ? command.file === binding : parsed.ids.length === 1 && parsed.ids[0] === binding
  if (!matches) throw new Error("Log does not match this session's harness binding")
  if (!parsed.days.length) throw new Error("No supported usage records found")
  if (store.engineBindings.get(command.sessionId, command.engine) !== binding) throw new Error("Harness binding changed; preview again")
  if (store.sessionsWithActiveTurn().some((s) => s.sessionId === command.sessionId)) throw new Error("Session became active; preview again")
  const rows = store.usageRecovery.preview(command.sessionId, command.engine, parsed.days)
  const fingerprint = createHash("sha256").update(JSON.stringify({ binding, sessionId: command.sessionId, engine: command.engine, rows })).digest("hex")
  if (command.action === "apply") {
    if (command.fingerprint !== fingerprint) throw new Error("Preview changed or missing; preview again before applying")
    store.usageRecovery.save(rows.map((row) => row.observed))
  }
  return { action: command.action, fingerprint, engine: command.engine, rows, skipped: parsed.skipped, warning: "Conservative daily reconciliation; partial logs may undercount. No costs, reasoning or call counts are inferred." }
}
