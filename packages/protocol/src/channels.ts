import { z } from "zod"
import { lazySchema } from "./lazy"

/** Remote chat channels (docs/channels.md): a paired Telegram chat or Discord channel drives sessions from a phone. Off by default. */
export const ChannelChat = lazySchema(() => z.strictObject({
  /** Telegram chat id or Discord channel id, as a decimal string. */
  id: z.string().regex(/^-?\d{1,20}$/),
  name: z.string().max(100).optional(),
  directory: z.string().min(1).max(4096),
  pairedAt: z.number().int().nonnegative(),
}))
export type ChannelChat = z.infer<typeof ChannelChat>

/** `channels.status` ack. Local clients only; it names chats, never tokens or pair codes. */
const ChannelServiceReport = () => z.strictObject({
  enabled: z.boolean(),
  /** A bot token exists (env `MENDCODE_TELEGRAM_TOKEN` / `MENDCODE_DISCORD_TOKEN` or a private token file). */
  tokenConfigured: z.boolean(),
  running: z.boolean(),
  botName: z.string().max(100).optional(),
  chats: z.array(ChannelChat).max(16),
  pairingExpiresAt: z.number().int().nonnegative().optional(),
  error: z.string().max(300).optional(),
})
export const ChannelsReport = lazySchema(() => z.strictObject({
  telegram: ChannelServiceReport(),
  /** Absent from daemons that predate the Discord bridge. */
  discord: ChannelServiceReport().optional(),
}))
export type ChannelsReport = z.infer<typeof ChannelsReport>

/** Which bridge a change is for; Telegram when absent. */
const channel = () => z.enum(["telegram", "discord"]).optional()
export const ChannelsChange = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["enable", "disable"]), channel: channel() }),
  /** Ack: `{ code, expiresAt }`. Chats paired with it work in `directory`, in `sessionId` when given (the terminal's open session). */
  z.strictObject({ action: z.literal("pair"), directory: z.string().min(1).max(4096), sessionId: z.string().min(1).max(100).optional(), channel: channel() }),
  /** Without `chatId`, every chat is unpaired. */
  z.strictObject({ action: z.literal("unpair"), chatId: z.string().regex(/^-?\d{1,20}$/).optional(), channel: channel() }),
]))
export type ChannelsChange = z.infer<typeof ChannelsChange>
