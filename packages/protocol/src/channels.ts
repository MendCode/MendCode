import { z } from "zod"
import { lazySchema } from "./lazy"

/** Remote chat channels (docs/channels.md): a paired Telegram chat drives sessions from a phone. Off by default. */
export const ChannelChat = lazySchema(() => z.strictObject({
  /** Telegram chat id as a decimal string. */
  id: z.string().regex(/^-?\d{1,20}$/),
  name: z.string().max(100).optional(),
  directory: z.string().min(1).max(4096),
  pairedAt: z.number().int().nonnegative(),
}))
export type ChannelChat = z.infer<typeof ChannelChat>

/** `channels.status` ack. Local clients only; it names chats, never tokens or pair codes. */
export const ChannelsReport = lazySchema(() => z.strictObject({
  telegram: z.strictObject({
    enabled: z.boolean(),
    /** A bot token exists (env `MENDCODE_TELEGRAM_TOKEN` or a private token file). */
    tokenConfigured: z.boolean(),
    running: z.boolean(),
    botName: z.string().max(100).optional(),
    chats: z.array(ChannelChat).max(16),
    pairingExpiresAt: z.number().int().nonnegative().optional(),
    error: z.string().max(300).optional(),
  }),
}))
export type ChannelsReport = z.infer<typeof ChannelsReport>

export const ChannelsChange = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["enable", "disable"]) }),
  /** Ack: `{ code, expiresAt }`. Chats paired with it work in `directory`. */
  z.strictObject({ action: z.literal("pair"), directory: z.string().min(1).max(4096) }),
  /** Without `chatId`, every chat is unpaired. */
  z.strictObject({ action: z.literal("unpair"), chatId: z.string().regex(/^-?\d{1,20}$/).optional() }),
]))
export type ChannelsChange = z.infer<typeof ChannelsChange>
