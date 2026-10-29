import { z } from "zod"
import { ItemId, SessionId } from "./ids"
import { lazySchema } from "./lazy"

export const SessionRecallReadInput = lazySchema(() => z.strictObject({
  session_id: SessionId.optional(),
  before: ItemId.optional(),
  limit: z.number().finite().optional(),
  query: z.string().max(16_000).optional(),
  message_id: ItemId.optional(),
  offset: z.number().finite().optional(),
}))
export type SessionRecallReadInput = z.infer<typeof SessionRecallReadInput>
export const SessionRecallSearchInput = lazySchema(() => SessionRecallReadInput.extend({ query: z.string().min(1).max(16_000) }))
export type SessionRecallSearchInput = z.infer<typeof SessionRecallSearchInput>

export const SessionRecallPage = lazySchema(() => z.strictObject({
  session_id: SessionId,
  messages: z.array(z.strictObject({
    message_id: ItemId,
    role: z.enum(["user", "assistant"]),
    /** When the message was sent, local time with its UTC offset (`2026-10-28T17:25:03-05:00`); absent from an older daemon. */
    at: z.string().max(40).optional(),
    text: z.string().max(2000),
    truncated: z.boolean(),
  })).max(10),
  next_cursor: ItemId.optional(),
  more: z.boolean(),
}))
export type SessionRecallPage = z.infer<typeof SessionRecallPage>
export const SessionRecallMessage = lazySchema(() => z.strictObject({
  session_id: SessionId,
  message_id: ItemId,
  at: z.string().max(40).optional(),
  text: z.string().max(16_000),
  next_offset: z.number().int().nonnegative().optional(),
}))
export type SessionRecallMessage = z.infer<typeof SessionRecallMessage>

export const SessionNotesInput = lazySchema(() => z.strictObject({
  action: z.enum(["read", "write"]),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  text: z.string().max(16_000).optional(),
}))
export type SessionNotesInput = z.infer<typeof SessionNotesInput>
export const SessionNotesReport = lazySchema(() => z.strictObject({
  version: z.number().int().nonnegative(),
  text: z.string().max(16_000),
  current_version: z.number().int().nonnegative(),
}))
export type SessionNotesReport = z.infer<typeof SessionNotesReport>
