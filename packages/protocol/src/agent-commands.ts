import { z } from "zod"
import { CommandId, QueueId, SessionId, TurnId } from "./ids"
import { AgentViewMetadata } from "./session-background"
import { lazySchema } from "./lazy"

export const AgentCommandKind = z.enum(["request_summary", "rename", "tag", "pause_after_turn", "stop", "send_message", "peer_message"])
export const AgentCommandState = z.enum(["pending", "accepted", "running", "completed", "rejected", "failed", "expired"])
export const AgentCommandPolicy = lazySchema(() => z.strictObject({
  decision: z.enum(["safe_auto", "same_workspace", "approval_required", "denied"]),
  permissions: z.array(z.string().max(100)).max(4),
  reason: z.string().max(500),
}))
export const AgentCommandRequest = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request_summary"), instructions: z.string().max(1000).optional() }),
  z.strictObject({ kind: z.literal("rename"), title: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal("tag"), tags: z.array(z.string().max(40)).max(20) }),
  z.strictObject({ kind: z.literal("pause_after_turn"), reason: z.string().max(1000).optional() }),
  z.strictObject({ kind: z.literal("stop"), reason: z.string().max(1000).optional() }),
  z.strictObject({ kind: z.literal("send_message"), text: z.string().min(1).max(4000) }),
  /** `mode`: `steer` joins the target's running turn after its next tool result (native engine; else queued); `queue` always waits for the turn to end; unset follows the target's queue policy. */
  z.strictObject({ kind: z.literal("peer_message"), text: z.string().min(1).max(4000), mode: z.enum(["queue", "steer"]).optional() }),
]))
export const AgentCommandRecord = lazySchema(() => z.strictObject({
  commandId: CommandId,
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
  request: AgentCommandRequest,
  state: AgentCommandState,
  policy: AgentCommandPolicy,
  error: z.string().max(4000).optional(),
  result: z.string().max(4000).optional(),
  queueId: QueueId.optional(),
  turnId: TurnId.optional(),
  expiresAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export const AgentCommandsReport = lazySchema(() => z.strictObject({
  commands: z.array(AgentCommandRecord).max(100),
  metadata: z.array(AgentViewMetadata).max(100),
}))
export const AgentCommandPolicyReport = lazySchema(() => z.strictObject({ matrix: z.array(z.strictObject({ kind: AgentCommandKind, ...AgentCommandPolicy.shape })).max(7) }))
export type AgentCommandPolicy = z.infer<typeof AgentCommandPolicy>
export type AgentCommandKind = z.infer<typeof AgentCommandKind>
export type AgentCommandState = z.infer<typeof AgentCommandState>
export type AgentCommandRequest = z.infer<typeof AgentCommandRequest>
export type AgentCommandRecord = z.infer<typeof AgentCommandRecord>
export type AgentCommandsReport = z.infer<typeof AgentCommandsReport>
export type AgentCommandPolicyReport = z.infer<typeof AgentCommandPolicyReport>
