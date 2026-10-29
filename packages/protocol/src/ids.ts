import { z } from "zod"
import { ID_PREFIXES, type IdKind } from "./id-factory"

export { createIdFactory, ID_PREFIXES, type IdKind } from "./id-factory"

const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}"


function idSchema<K extends IdKind>(kind: K) {
  return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_BODY}$`)).brand<K>()
}

export const SessionId = idSchema("session")
export const TurnId = idSchema("turn")
export const ItemId = idSchema("item")
export const JobId = idSchema("job")
export const ClientId = idSchema("client")
export const RequestId = idSchema("request")
export const QueueId = idSchema("queue")
export const CommandId = idSchema("command")
export const MemoryId = idSchema("memory")
export const LoopId = idSchema("loop")
export const WorkflowId = idSchema("workflow")
export const GoalId = idSchema("goal")

export type SessionId = z.infer<typeof SessionId>
export type TurnId = z.infer<typeof TurnId>
export type ItemId = z.infer<typeof ItemId>
export type JobId = z.infer<typeof JobId>
export type ClientId = z.infer<typeof ClientId>
export type RequestId = z.infer<typeof RequestId>
export type QueueId = z.infer<typeof QueueId>
export type CommandId = z.infer<typeof CommandId>
export type MemoryId = z.infer<typeof MemoryId>
export type LoopId = z.infer<typeof LoopId>
export type WorkflowId = z.infer<typeof WorkflowId>
export type GoalId = z.infer<typeof GoalId>


export const BlobRef = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(255),
  /** The file name the user attached it as, for display only (identity is the hash). */
  name: z.string().min(1).max(255).optional(),
  /** The token that stands for it in the message text (`[Image #1]`); the attachment belongs right after it. Absent: after the text. */
  label: z.string().min(1).max(80).optional(),
  /** The offset in the text, in UTF-16 units, right after that token as the client composed it (a hint; the label is the anchor). */
  at: z.number().int().nonnegative().optional(),
})
export type BlobRef = z.infer<typeof BlobRef>
