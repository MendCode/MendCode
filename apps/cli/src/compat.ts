import type { SessionEvent } from "@mendcode/protocol"

export const COMPAT = "mendcode.cli.v1"
const sensitiveKey = /(?:api[_-]?key|authorization|credential|password|secret|(?:access|refresh|id)?[_-]?token(?:$|[_-])|bearer|private[_-]?key|cookie)/i
let sequence = 0

/** v1's field redaction preserves ordinary usage counters such as tokens.input. */
function redact(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redact(entry))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name === "sessionId" ? "sessionID" : name, redact(entry, name)]))
}

type Output = { kind: "result"; command: string; data: Record<string, unknown> } | { kind: "error"; command: string; error: { code: string; message: string; [key: string]: unknown } } | { kind: "event"; event: SessionEvent }
const lifecycle: Record<string, string> = { "turn.started": "session.started", "turn.completed": "session.completed", "turn.cancelled": "session.cancelled", "turn.interrupted": "session.cancelled", "turn.failed": "error" }

/** Envelope alias only: v2 event payloads and daemon semantics remain authoritative. */
export function compatEnvelope(output: Output, now = Date.now()) {
  const event = output.kind === "event" ? output.event : undefined
  const data = output.kind === "event" ? { ...output.event, sequence: output.event.seq } : output.kind === "error" ? output.error : output.data
  const sessionID = event?.sessionId ?? ("sessionId" in data && typeof data.sessionId === "string" ? data.sessionId : undefined)
  const timestamp = event?.at ?? now
  return {
    protocol: COMPAT,
    kind: output.kind,
    event: output.kind === "event" ? lifecycle[output.event.type] ?? output.event.type : output.kind === "error" ? "error" : output.command,
    eventID: event ? `evt_${event.sessionId}_${event.seq}` : `evt_${timestamp.toString(36)}_${(++sequence).toString(36)}`,
    timestamp,
    ...(sessionID ? { sessionID } : {}),
    data: redact(data),
  }
}
