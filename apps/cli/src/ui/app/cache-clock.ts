import type { CommandInput, CommandReply } from "@mendcode/client"
import type { RecentContextReport, SessionId } from "@mendcode/protocol"
import type { FooterInput } from "../../view/footer"

/** A context smaller than this costs little to send again: the countdown says nothing about it. */
const MIN_TOKENS = 20_000
/** The footer redraws this often while the countdown shows, so the minutes stay true on an idle screen. */
const TICK_MS = 15_000

type Usage = { contextTokens: number | undefined; callAt?: number | undefined }

/**
 * The `warm` footer segment's data (docs/layout.md, "Cache countdown"). The lifetime is the daemon's, the one the compaction while
 * idle uses (`context.recent` → `limits.idleCompaction`), asked for once per call after its turn ended: only an idle session has a
 * compaction scheduled. A provider whose lifetime nobody states shows nothing, never a guessed time; an assumed one is marked `~`.
 */
export function createCacheClock(input: { send(command: CommandInput): Promise<CommandReply>; requestFrame(): void }) {
  let known: { key: string; lifetimeMs?: number; assumed?: true; idleAt?: number } | undefined
  let asking: string | undefined
  let tick: ReturnType<typeof setInterval> | undefined

  async function ask(key: string, sessionId: SessionId) {
    if (asking === key) return
    asking = key
    const reply = await input.send({ type: "context.recent", sessionId, limit: 1 })
    if (asking !== key) return
    asking = undefined
    const idle = reply.ok ? (reply.result as RecentContextReport | undefined)?.limits?.idleCompaction : undefined
    known = { key, ...(idle?.lifetimeMinutes ? { lifetimeMs: idle.lifetimeMinutes * 60_000 } : {}), ...(idle?.lifetimeSource === "assumed" ? { assumed: true as const } : {}), ...(idle?.scheduled && idle.at !== undefined ? { idleAt: idle.at } : {}) }
    input.requestFrame()
  }

  return {
    /** The countdown for the session's last call, or undefined while there is nothing to count (asking the daemon when the call is new). */
    read(sessionId: SessionId | undefined, usage: Usage | undefined, busy: boolean): FooterInput["warm"] | undefined {
      if (!sessionId || busy || usage?.callAt === undefined || (usage.contextTokens ?? 0) < MIN_TOKENS) return undefined
      const key = `${sessionId}:${usage.callAt}`
      if (known?.key !== key) {
        void ask(key, sessionId)
        return undefined
      }
      if (known.lifetimeMs === undefined) return undefined
      return { expiresAt: usage.callAt + known.lifetimeMs, tokens: usage.contextTokens!, ...(known.assumed ? { assumed: true as const } : {}), ...(known.idleAt !== undefined ? { idleAt: known.idleAt } : {}) }
    },
    /** Redraws on a timer while the segment shows; nothing runs otherwise. */
    ticking(on: boolean) {
      if (on && !tick) {
        tick = setInterval(input.requestFrame, TICK_MS)
        tick.unref?.()
      }
      if (!on && tick) {
        clearInterval(tick)
        tick = undefined
      }
    },
  }
}
export type CacheClock = ReturnType<typeof createCacheClock>
