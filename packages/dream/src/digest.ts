import { redactSecrets, type SessionEvent } from "@mendcode/protocol"
import { z } from "zod"

/** Bump when the digest's shape or rules change: cached digests of another version are built again. */
export const DIGEST_VERSION = 1

/** `chars` bounds the conversation lines of one digest; signals are extra but bounded too, so a digest stays a few KB. */
export const DIGEST_LIMITS = { chars: 3_000, lines: 60, lineChars: 400, signals: 8, signalChars: 200 } as const

export const SessionDigest = z.strictObject({
  version: z.literal(DIGEST_VERSION),
  /** User and agent messages the session had (the digest keeps only some of them). */
  messages: z.number().int().nonnegative(),
  /** `user: …` and `agent: …` lines: the first prompt and the newest exchange that fits DIGEST_LIMITS.chars. */
  lines: z.array(z.string().max(DIGEST_LIMITS.lineChars + 8)).max(DIGEST_LIMITS.lines),
  /** Sentences where the user corrected the agent. */
  corrections: z.array(z.string().max(DIGEST_LIMITS.signalChars)).max(DIGEST_LIMITS.signals),
  /** Sentences where the user stated a standing preference or rule. */
  preferences: z.array(z.string().max(DIGEST_LIMITS.signalChars)).max(DIGEST_LIMITS.signals),
  /** Test, typecheck or build outcomes mentioned in the conversation. */
  validations: z.array(z.string().max(DIGEST_LIMITS.signalChars)).max(DIGEST_LIMITS.signals),
  /** Secrets replaced by redaction markers while building it. */
  redactions: z.number().int().nonnegative(),
})
export type SessionDigest = z.infer<typeof SessionDigest>

const CORRECTION = /\b(actually|correction|not that|instead|that'?s wrong|that is wrong|wrong|no,|stop (?:using|doing)|don'?t|do not|en realidad|corrijo|no era|eso no|no hagas|no uses|en vez de|mejor usa)\b/i
const PREFERENCE = /\b(always|never|prefer|i like|i want|must|should|from now on|siempre|nunca|prefiero|quiero que|debes|de ahora en adelante)\b/i
const VALIDATION = /\b(tests?|typecheck|build|lint|passed|failed|validated)\b/i

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** Sentences worth a signal: long enough to mean something, short enough to be one idea. */
function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(squash)
    .filter((sentence) => sentence.length >= 12 && sentence.length <= DIGEST_LIMITS.signalChars)
}

function unique(values: string[]) {
  return [...new Set(values)].slice(0, DIGEST_LIMITS.signals)
}

/**
 * A short digest of one session from its events: what the user asked, what the agent concluded, and the user's
 * corrections and preferences. No tool output and no reasoning; secrets are redacted before anything is kept. Pure.
 */
export function buildDigest(events: readonly SessionEvent[]): SessionDigest {
  const kinds = new Map<string, string>()
  const turns: Array<{ role: "user" | "agent"; text: string }> = []
  let redactions = 0
  for (const event of events) {
    if (event.type === "item.started") kinds.set(event.itemId, event.kind)
    if (event.type !== "item.completed" || !event.text) continue
    const kind = kinds.get(event.itemId)
    if (kind !== "user_message" && kind !== "agent_message") continue
    const redacted = redactSecrets(event.text)
    redactions += redacted.count
    const text = squash(redacted.text)
    if (text) turns.push({ role: kind === "user_message" ? "user" : "agent", text })
  }
  const userSentences = turns.filter((turn) => turn.role === "user").flatMap((turn) => sentences(turn.text))
  const corrections = unique(userSentences.filter((sentence) => CORRECTION.test(sentence)))
  const preferences = unique(userSentences.filter((sentence) => !CORRECTION.test(sentence) && PREFERENCE.test(sentence)))
  const validations = unique(turns.flatMap((turn) => sentences(turn.text)).filter((sentence) => VALIDATION.test(sentence)))
  return { version: DIGEST_VERSION, messages: turns.length, lines: fitLines(turns.map((turn) => `${turn.role}: ${turn.text.slice(0, DIGEST_LIMITS.lineChars)}`)), corrections, preferences, validations, redactions }
}

/** The first line (the request) plus the newest lines that fit: the end of a conversation says what was concluded. */
function fitLines(all: string[]) {
  if (all.length === 0) return []
  let used = all[0]!.length
  const tail: string[] = []
  for (let index = all.length - 1; index > 0 && tail.length < DIGEST_LIMITS.lines - 1; index--) {
    if (used + all[index]!.length > DIGEST_LIMITS.chars) break
    tail.unshift(all[index]!)
    used += all[index]!.length
  }
  return [all[0]!, ...tail]
}

/** The cache a digest lives in (the store's `digests`): valid only for the session state and format it was built from. */
export type DigestCache = {
  get(sessionId: string, input: { sourceSeq: number; version: number }): string | undefined
  put(sessionId: string, input: { sourceSeq: number; version: number; payload: string }): void
}

/** The digest of a session, reused from `cache` while the session has not changed (same `seq`), otherwise built and cached. */
export function sessionDigest(input: { sessionId: string; seq?: number | undefined; events: SessionEvent[] | (() => SessionEvent[]); cache?: DigestCache | undefined }): { digest: SessionDigest; origin: "built" | "reused" } {
  const { cache, seq } = input
  if (cache && seq !== undefined) {
    const payload = cache.get(input.sessionId, { sourceSeq: seq, version: DIGEST_VERSION })
    if (payload) {
      const cached = SessionDigest.safeParse(parseJson(payload))
      if (cached.success) return { digest: cached.data, origin: "reused" }
    }
  }
  const digest = buildDigest(typeof input.events === "function" ? input.events() : input.events)
  if (cache && seq !== undefined) cache.put(input.sessionId, { sourceSeq: seq, version: DIGEST_VERSION, payload: JSON.stringify(digest) })
  return { digest, origin: "built" }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
