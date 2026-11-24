import type { ItemId, SessionId } from "@mendcode/protocol"
import type { Transcript } from "../../view/transcript"
import type { TurnState } from "../../view/turn-state"
import type { createCompactionFacts } from "../../view/compaction-facts"

/** How many chats left most recently keep what they showed: going back to one reads only the events that came after. A parent and three sub-agents all fit. */
export const KEPT_SESSIONS = 4
/** A chat holding more blocks than this (the reader paged far back) is not kept: going back opens its newest window again. */
export const KEPT_BLOCKS_MAX = 300
/** Nor one whose blocks hold more text than this many characters: a daemon page alone can carry 256 KB, so a sub-agent with big tool outputs must fit. */
export const KEPT_TEXT_MAX = 600_000
/** Nor one that read more events than this (the transcript holds each one it read, for paging back): about five windows. */
export const KEPT_EVENTS_MAX = 1_000

/** The events a kept chat catches up in one read on return (the daemon's page maximum); a longer gap opens it afresh. */
export const KEPT_CATCH_UP = 1_000

/** Where the reader was: at the bottom, or on a row of a block (`offsetForAnchor`), with the offset as a fallback. */
export type KeptScroll = { follow: true } | { follow: false; offset: number; unseen: number; anchor?: { itemId: ItemId; row: number; screenRow: number } }

/** A chat as it was left: its transcript whole (layout included), the state the prompt area reads, its paging cursor and scroll. */
export type KeptSession = {
  transcript: Transcript
  turnState: TurnState
  compactionFacts: ReturnType<typeof createCompactionFacts>
  paging: { firstSeq: number; more: boolean; loadedEarlier: boolean; loaded: number }
  scroll: KeptScroll
  /** The terminal profile it was laid out with: another one on return lays it out again with the current look. */
  profile: string
  /** It shows secret markers: their tails, dropped by the switch, are asked for again on return. */
  secrets: boolean
}

/** Whether a transcript is small enough to keep: the default window and a few pages back are; a long read-back is not. */
export function keepable(transcript: Transcript, loaded: number): boolean {
  if (loaded > KEPT_EVENTS_MAX) return false
  const blocks = transcript.blocks()
  if (blocks.length > KEPT_BLOCKS_MAX) return false
  let text = 0
  for (const block of blocks) {
    text += block.text.length
    if (text > KEPT_TEXT_MAX) return false
  }
  return true
}

/** The chats left most recently, newest last; the oldest goes when a fourth is kept. */
export function createSessionCache(limit = KEPT_SESSIONS) {
  const kept = new Map<SessionId, KeptSession>()
  return {
    keep(sessionId: SessionId, entry: KeptSession) {
      kept.delete(sessionId)
      kept.set(sessionId, entry)
      while (kept.size > limit) kept.delete(kept.keys().next().value!)
    },
    /** The kept chat, removed from the cache: it is on screen again and is kept anew when it is left. */
    take(sessionId: SessionId): KeptSession | undefined {
      const entry = kept.get(sessionId)
      kept.delete(sessionId)
      return entry
    },
    drop(sessionId: SessionId) {
      kept.delete(sessionId)
    },
    has: (sessionId: SessionId) => kept.has(sessionId),
    get size() {
      return kept.size
    },
  }
}
export type SessionCache = ReturnType<typeof createSessionCache>
