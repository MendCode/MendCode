import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ChannelChat } from "@mendcode/protocol"

export const MAX_CHANNEL_CHATS = 16
const StoredChat = ChannelChat.extend({ sessionId: z.string().max(100).optional() })
export type StoredChat = z.infer<typeof StoredChat>
const Stored = z.strictObject({
  telegram: z.strictObject({
    enabled: z.boolean().default(false),
    /** Path of a private file holding the bot token; defaults to `<dir>/telegram-token`. */
    tokenFile: z.string().min(1).max(4096).optional(),
    chats: z.array(StoredChat).max(MAX_CHANNEL_CHATS).default([]),
  }).default(() => ({ enabled: false, chats: [] })),
})
export type StoredChannels = z.infer<typeof Stored>

/** `<dir>/channels.json` (mode 0600): off by default; holds the paired chat ids, never the bot token. */
export function createChannelsConfig(dir: string) {
  const file = path.join(dir, "channels.json")
  function read(): StoredChannels {
    if (!existsSync(file)) return Stored.parse({})
    const parsed = Stored.safeParse(JSON.parse(readFileSync(file, "utf8")))
    if (!parsed.success) throw new Error("[CHANNELS]: invalid channels.json")
    return parsed.data
  }
  function write(value: StoredChannels) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  }
  function update(change: (value: StoredChannels) => void) {
    const value = read()
    change(value)
    write(value)
    return value
  }
  return { file, read, write, update }
}
export type ChannelsConfig = ReturnType<typeof createChannelsConfig>

/** The bot token: `MENDCODE_TELEGRAM_TOKEN`, else a token file that only its owner can read. Never returned by any command. */
export function resolveTelegramToken({ dir, tokenFile, env }: { dir: string; tokenFile?: string | undefined; env: Record<string, string | undefined> }): { token: string } | { error: string } | undefined {
  const fromEnv = env.MENDCODE_TELEGRAM_TOKEN?.trim()
  if (fromEnv) return validToken(fromEnv)
  const file = tokenFile ?? path.join(dir, "telegram-token")
  if (!existsSync(file)) return undefined
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) return { error: "the Telegram token file must be private (chmod 600)" }
  return validToken(readFileSync(file, "utf8").trim())
}
const validToken = (token: string) => /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/.test(token) ? { token } : { error: "the Telegram bot token has an unexpected format" }

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
export const PAIR_TTL_MS = 10 * 60_000
const MAX_FAILURES = 5
const BLOCK_MS = 15 * 60_000

/** One live code at a time, single use, expiring, and a chat that guesses wrong five times is ignored for 15 minutes. */
export function createPairing({ now }: { now(): number }) {
  let current: { code: string; directory: string; expiresAt: number } | undefined
  const failures = new Map<string, { count: number; until: number }>()
  return {
    create(directory: string) {
      const bytes = randomBytes(8)
      const code = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")
      current = { code, directory, expiresAt: now() + PAIR_TTL_MS }
      return { code, expiresAt: current.expiresAt }
    },
    get expiresAt() { return current && current.expiresAt > now() ? current.expiresAt : undefined },
    cancel() { current = undefined },
    blocked(chatId: string) { return (failures.get(chatId)?.until ?? 0) > now() },
    claim(chatId: string, given: string): { ok: true; directory: string } | { ok: false } {
      if (this.blocked(chatId)) return { ok: false }
      const live = current && current.expiresAt > now() ? current : undefined
      const want = Buffer.from(live?.code ?? "!".repeat(8)), have = Buffer.from(given.trim().toUpperCase().padEnd(8, "!").slice(0, 8))
      if (live && timingSafeEqual(want, have) && given.trim().length === 8) {
        current = undefined
        failures.delete(chatId)
        return { ok: true, directory: live.directory }
      }
      const failed = failures.get(chatId) ?? { count: 0, until: 0 }
      failed.count++
      if (failed.count >= MAX_FAILURES) { failed.until = now() + BLOCK_MS; failed.count = 0 }
      failures.set(chatId, failed)
      if (failures.size > 256) failures.delete(failures.keys().next().value!)
      return { ok: false }
    },
  }
}
