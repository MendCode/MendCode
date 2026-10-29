import { z } from "zod"
import { BlobRef, ItemId, SessionId } from "./ids"
import { MAX_INLINE_TEXT } from "./states"
import { lazySchema } from "./lazy"

/** An item is a v2 message. Its body and each attachment are independently addressable parts. */
export const MessagePartId = lazySchema(() => z.union([z.literal("body"), z.string().regex(/^file:[a-f0-9]{64}$/)]))
export const MessagePart = lazySchema(() => z.discriminatedUnion("type", [
  z.strictObject({ id: z.literal("body"), type: z.literal("text"), text: z.string().max(MAX_INLINE_TEXT) }),
  z.strictObject({ id: z.string().regex(/^file:[a-f0-9]{64}$/), type: z.literal("file"), attachment: BlobRef }),
]))
export type MessagePart = z.infer<typeof MessagePart>
export const MessageTarget = { sessionId: SessionId, messageId: ItemId, expectedRevision: z.number().int().nonnegative().default(0) }
