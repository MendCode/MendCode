import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

/** Notices kept per session while it cannot take them; the oldest go first. */
export const MAX_HELD_NOTICES = 20
/** How often held notices are offered again when no idle session asks for them first. */
export const OUTBOX_RETRY_MS = 60_000

const File = z.object({ version: z.literal(1), sessions: z.record(z.string(), z.array(z.string().max(100_000)).max(MAX_HELD_NOTICES)) })

export type OutboxOptions = {
  /** `<dataDir>/pr-review/outbox.json`: held notices survive a daemon restart. */
  file: string
  /** Queues a notice when the session is free; `undefined` (or a throw) when it is busy, held, paused or gone. */
  notify(sessionId: string, text: string): unknown
  sessionExists(sessionId: string): boolean
  retryMs?: number
}

/**
 * The PR reviewer's notices on their way to a session (docs/pr-review.md). A session takes a notice only while it is free, so a
 * notice that arrives during a turn, behind queued messages, after a cancel or while paused is kept here, in order, and offered
 * again when the session goes idle or at the next retry: several held ones go as one message. Nothing here touches the session's
 * queue or its running turn.
 */
export function createOutbox(options: OutboxOptions) {
  const held = load()
  const sending = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  function load(): Map<string, string[]> {
    try {
      const parsed = File.safeParse(JSON.parse(readFileSync(options.file, "utf8")))
      return new Map(parsed.success ? Object.entries(parsed.data.sessions).filter(([, notices]) => notices.length) : [])
    } catch { return new Map() }
  }
  function save() {
    try {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 })
      const temp = `${options.file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, sessions: Object.fromEntries(held) }), { mode: 0o600, flag: "wx" })
      renameSync(temp, options.file)
    } catch { /* unsaved notices are still offered until the daemon stops */ }
  }
  function arm() {
    const needed = !stopped && held.size > 0
    if (needed && !timer) { timer = setInterval(() => void flushAll(), options.retryMs ?? OUTBOX_RETRY_MS); timer.unref?.() }
    if (!needed && timer) { clearInterval(timer); timer = undefined }
  }

  /** Offers the session's held notices, oldest first, as one message; they stay held when the session refuses it. */
  async function flush(sessionId: string) {
    const notices = held.get(sessionId)
    if (stopped || !notices?.length || sending.has(sessionId)) return
    if (!options.sessionExists(sessionId)) { held.delete(sessionId); save(); arm(); return }
    sending.add(sessionId)
    const count = notices.length
    const text = count === 1 ? notices[0]! : [`${count} PR review notices arrived while this session was busy:`, ...notices].join("\n\n")
    let queued: unknown
    try { queued = await options.notify(sessionId, text) } catch { queued = undefined }
    finally { sending.delete(sessionId) }
    if (queued === undefined || queued === false) return
    const rest = (held.get(sessionId) ?? []).slice(count)
    if (rest.length) held.set(sessionId, rest)
    else held.delete(sessionId)
    save()
    arm()
    // Notices that arrived while this one was offered go next; a session that just took one is usually busy and keeps them held.
    if (rest.length) await flush(sessionId)
  }

  async function flushAll() {
    for (const sessionId of [...held.keys()]) await flush(sessionId)
  }

  return {
    /** Sends `text` to the session now if it is free, otherwise holds it until it is. */
    async say(sessionId: string, text: string) {
      if (stopped) return
      const notices = [...(held.get(sessionId) ?? []), text].slice(-MAX_HELD_NOTICES)
      held.set(sessionId, notices)
      save()
      arm()
      await flush(sessionId)
    },
    flush,
    flushAll,
    held: (sessionId: string) => [...(held.get(sessionId) ?? [])],
    stop() { stopped = true; arm() },
  }
}
export type Outbox = ReturnType<typeof createOutbox>
