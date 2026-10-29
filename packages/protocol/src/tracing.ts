import { z } from "zod"
import { CommandId, SessionId, TurnId } from "./ids"
import { MODEL_ROLES } from "./constants"
import { lazySchema } from "./lazy"

export const TraceName = z.enum(["daemon.command", "daemon.event", "session.turn", "session.llm", "client.command", "client.event", "tui.frame"])
export const TraceStatus = z.enum(["ok", "error", "cancelled"])
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Deliberately no text, paths, model names, tool arguments, headers or errors. */
export const TraceMetadata = lazySchema(() => z.strictObject({
  sessionId: SessionId.optional(),
  turnId: TurnId.optional(),
  commandId: CommandId.optional(),
  seq: count.optional(),
  role: z.enum(MODEL_ROLES).optional(),
  attempt: count.optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  firstTokenMs: count.optional(),
  cols: count.optional(),
  rows: count.optional(),
  backlog: count.optional(),
}))
export type TraceMetadata = z.infer<typeof TraceMetadata>
export const TraceSample = lazySchema(() => z.strictObject({
  name: z.enum(["client.command", "client.event", "tui.frame"]),
  metadata: TraceMetadata,
  durationMs: z.number().finite().min(0).max(86_400_000),
  status: TraceStatus,
}))
export type TraceSample = z.infer<typeof TraceSample>
export const TraceSpan = lazySchema(() => z.strictObject({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  name: TraceName,
  /** Daemon-generated protocol discriminator; client samples cannot supply it. */
  operation: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/).optional(),
  metadata: TraceMetadata,
  startedAt: count,
  durationMs: z.number().finite().nonnegative(),
  status: TraceStatus,
}))
export type TraceSpan = z.infer<typeof TraceSpan>
export const TraceReport = lazySchema(() => z.strictObject({
  enabled: z.boolean(),
  openTelemetry: z.boolean(),
  exporter: z.enum(["off", "loopback"]),
  dropped: count,
  exportErrors: count,
  writeErrors: count,
  spans: z.array(TraceSpan).max(512),
}))
export type TraceReport = z.infer<typeof TraceReport>
export interface TracePort {
  start(name: z.infer<typeof TraceName>, metadata?: TraceMetadata, operation?: import("./commands").CommandType | import("./events").SessionEvent["type"]): { end(status?: z.infer<typeof TraceStatus>, metadata?: TraceMetadata): void }
}
