import type { SessionEvent } from "@mendcode/protocol"
import { DEFAULT_COMPACT_AT_TOKENS, compactEstimate, compactEstimateText, compactNoticePercent, createCompactNotice, featureOn, usageContext, type ContextSample, type TierSettings } from "@mendcode/protocol/wire"
import { compact } from "./format"

/** What a session has used so far, from the usage events this client has seen (the loaded window). */
export type SessionUsage = { calls: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
export type ModelUsage = SessionUsage & { provider: string; model: string }

/**
 * A line the transcript can show between blocks: why the cache missed, thinking was left off, what a compaction cost
 * (drawn while the `cacheNotices` profile key is on), and `context`: a compaction is near (feature `compact_notice`).
 */
export type UsageNote = { kind: "cache" | "thinking" | "compaction" | "context"; text: string }

/** What the notice before a compaction reads from the settings; undefined while it is off. */
export type CompactNoticeConfig = { percent: number; autoCompact: boolean; compactAtTokens?: number | undefined }
export function compactNoticeConfig(settings: TierSettings & { compactNoticePercent?: number | "off" | undefined; compactAtTokens?: number | undefined; compaction?: { auto?: boolean | undefined } | undefined }): CompactNoticeConfig | undefined {
  const percent = compactNoticePercent(settings.compactNoticePercent)
  if (percent === undefined || !featureOn(settings, "compact_notice")) return undefined
  return { percent, autoCompact: settings.compaction?.auto !== false, compactAtTokens: settings.compactAtTokens }
}

type Call = { provider: string; model: string; at: number; input: number; cacheRead: number; cacheWrite: number; context: number; longTtl?: true }

/** One model call's timing, from the engine's request profile (absent for engines that do not report one). */
export type CallStats = { at: number; model: string; output: number; reasoning: number; firstTokenMs: number | null; durationMs: number | undefined; toolCount: number }
const RECENT_CALLS = 12
export type { ContextSample }
const RECENT_CONTEXTS = 8

/** Output tokens per second after the first token; undefined when the call has no usable timing. */
export function callSpeed(call: Pick<CallStats, "output" | "reasoning" | "firstTokenMs" | "durationMs">): number | undefined {
  if (call.durationMs === undefined || call.firstTokenMs === null) return undefined
  const generating = call.durationMs - call.firstTokenMs
  const tokens = call.output + call.reasoning
  return generating >= 200 && tokens > 0 ? tokens / (generating / 1000) : undefined
}

/** Below this prompt size providers do not cache, so a zero read is not a miss. */
const MIN_PROMPT_TOKENS = 2_048
/** Anthropic-style caches live about five minutes; a longer pause explains a miss. */
const CACHE_TTL_MS = 5 * 60_000
/** A call written with `ttl: "1h"` (`promptCacheTtl`, `wait_cache`) is kept an hour. */
const CACHE_TTL_1H_MS = 60 * 60_000
/** A read under this share of what the previous call cached counts as a miss. */
const MISS_SHARE = 0.1

/** Share of prompt tokens served from the cache (0..100), or undefined when nothing was sent. */
export function cacheHitPercent({ input, cacheRead, cacheWrite }: Pick<SessionUsage, "input" | "cacheRead" | "cacheWrite">): number | undefined {
  const prompt = input + cacheRead + cacheWrite
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : undefined
}

const empty = (): SessionUsage => ({ calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Folds usage and compaction events into session totals and the notes worth a transcript line. Pure data; events at
 * or below the last seen `seq` are ignored. `compacting` says the usage event belongs to a compaction in progress, so
 * its call is counted as the compaction's cost and never compared with the conversation's own calls.
 *
 * `notice` (read at each call) turns on the line before a compaction: said once when a main call leaves the context at the
 * configured share of its limit, with the tokens left and, from three turns of growth on, the turns left (the footer
 * forecast's own number). The limit is the one the call states, as the context meter reads it: the engine's window when it
 * compacts on its own, else where MendCode packs. A call that states neither (plan mode, a sub-agent) says nothing, and
 * neither does a session with automatic compaction off whose point is only the default for an unknown window.
 */
export function createUsageNotes(options: { notice?: () => CompactNoticeConfig | undefined } = {}) {
  const notice = createCompactNotice()
  let lastSeq = 0
  let totals = empty()
  const models = new Map<string, ModelUsage>()
  let spent: number | undefined
  const recent: CallStats[] = []
  const contexts: ContextSample[] = []
  const turnStarts = new Map<string, number>()
  const turnTimes: number[] = []
  let previous: Call | undefined
  /** A compaction rewrote the prompt: the next call's miss is expected. */
  let expectMiss = false
  let tally: { input: number; output: number; before?: number } | undefined
  const thinkingNoted = new Set<string>()

  return {
    apply(event: SessionEvent, compacting = false): UsageNote[] {
      if (event.seq <= lastSeq) return []
      lastSeq = event.seq
      if (event.type === "turn.started") {
        turnStarts.set(event.turnId, event.at)
        if (turnStarts.size > 16) turnStarts.delete(turnStarts.keys().next().value!)
      }
      if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type) && "turnId" in event && event.turnId) {
        const started = turnStarts.get(event.turnId)
        if (started !== undefined) {
          turnTimes.push(Math.max(0, event.at - started))
          if (turnTimes.length > 12) turnTimes.shift()
          turnStarts.delete(event.turnId)
        }
      }
      if (event.type === "compaction.updated") {
        if (event.state === "writing") tally ??= { input: 0, output: 0, ...(previous ? { before: previous.context } : {}) }
        if (event.state !== "packed") {
          if (event.state !== "writing") tally = undefined
          return []
        }
        const spent = tally
        tally = undefined
        expectMiss = true
        contexts.length = 0
        notice.packed()
        if (!spent || spent.input + spent.output === 0) return []
        const was = spent.before ? ` · context was ${compact(spent.before)}` : ""
        return [{ kind: "compaction", text: `compaction used ${compact(spent.input)} in, ${compact(spent.output)} out${was}` }]
      }
      if (event.type !== "usage.recorded") return []
      totals = { calls: totals.calls + 1, input: totals.input + event.input, output: totals.output + event.output, reasoning: totals.reasoning + event.reasoning, cacheRead: totals.cacheRead + event.cacheRead, cacheWrite: totals.cacheWrite + event.cacheWrite }
      const key = JSON.stringify([event.provider, event.model])
      // Preserve exact sums while bounding adversarial histories to 64 named models and one overflow bucket.
      const bucket = models.has(key) || models.size < 64 ? key : "other"
      const model = models.get(bucket) ?? { ...empty(), provider: bucket === "other" ? "" : event.provider, model: bucket === "other" ? "Other models" : event.model }
      for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) model[field] += event[field]
      model.calls++
      models.set(bucket, model)
      if (event.costMicros !== undefined) spent = (spent ?? 0) + event.costMicros
      recent.push({ at: event.at, model: event.model, output: event.output, reasoning: event.reasoning, firstTokenMs: event.profile?.firstTokenMs ?? null, durationMs: event.profile?.durationMs, toolCount: event.profile?.toolCount ?? 0 })
      if (recent.length > RECENT_CALLS) recent.shift()
      if (compacting) {
        tally ??= { input: 0, output: 0, ...(previous ? { before: previous.context } : {}) }
        tally.input += event.input + event.cacheRead + event.cacheWrite
        tally.output += event.output + event.reasoning
        return []
      }
      const notes: UsageNote[] = []
      const call: Call = { provider: event.provider, model: event.model, at: event.at, input: event.input, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite, context: usageContext(event) ?? 0, ...(event.cacheTtl === "1h" ? { longTtl: true as const } : {}) }
      const prompt = event.input + event.cacheRead + event.cacheWrite
      const cached = previous ? previous.cacheRead + previous.cacheWrite : 0
      const sameModel = previous?.provider === event.provider && previous.model === event.model
      if (previous && sameModel && !expectMiss && cached > 0 && prompt >= MIN_PROMPT_TOKENS && event.cacheRead < cached * MISS_SHARE) {
        const idle = event.at - previous.at
        const why = idle > (previous.longTtl ? CACHE_TTL_1H_MS : CACHE_TTL_MS) ? `idle ${Math.round(idle / 60_000)}m, past the cache lifetime` : "prompt prefix changed"
        notes.push({ kind: "cache", text: `cache miss · ${cacheHitPercent({ input: event.input, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite }) ?? 0}% of ${compact(prompt)} prompt tokens read from cache · ${why}` })
      }
      expectMiss = false
      if (event.thinkingDropped && !thinkingNoted.has(event.turnId)) {
        thinkingNoted.add(event.turnId)
        if (thinkingNoted.size > 64) thinkingNoted.delete(thinkingNoted.values().next().value!)
        notes.push({ kind: "thinking", text: "thinking off for this call · earlier steps carry no thinking from this model" })
      }
      previous = call
      // One sample per turn (its last call): the forecast is in turns, and a tool loop's many calls are one turn.
      // An event that cannot say its context (Claude Code sessions recorded before it reported one) adds no sample.
      if (usageContext(event) === undefined) return notes
      const last = contexts.at(-1)
      if (last?.turnId === event.turnId) last.tokens = call.context
      else contexts.push({ turnId: event.turnId, tokens: call.context })
      if (contexts.length > RECENT_CONTEXTS) contexts.shift()
      const config = options.notice?.()
      const limitTokens = event.contextWindow ?? event.compactAt
      const unknownWindow = !event.contextWindow && config?.compactAtTokens === undefined && event.compactAt === DEFAULT_COMPACT_AT_TOKENS
      if (config && limitTokens && (config.autoCompact || !unknownWindow) && notice.crossed(call.context, limitTokens, config.percent)) {
        const estimate = compactEstimate({ tokens: call.context, limitTokens, limit: event.contextWindow ? "window" : "compaction", auto: config.autoCompact, samples: contexts })
        notes.push({ kind: "context", text: compactEstimateText(estimate, compact) })
      }
      return notes
    },
    /** The context size at the end of each recent turn, oldest first; emptied when a compaction rewrites the history. */
    get contexts(): readonly ContextSample[] {
      return contexts
    },
    get turnTimes(): readonly number[] {
      return turnTimes
    },
    get totals(): Readonly<SessionUsage> {
      return totals
    },
    get models(): readonly Readonly<ModelUsage>[] {
      return [...models.values()]
    },
    /** The last conversation call, for a per-call hit rate. */
    get last() {
      return previous
    },
    /** Estimated cost of the calls seen, in micro-USD; undefined while none had a known price. */
    get cost() {
      return spent
    },
    /** The last calls' timings, oldest first (compaction calls included: they are calls the session paid for). */
    get calls(): readonly CallStats[] {
      return recent
    },
    reset() {
      lastSeq = 0
      totals = empty()
      models.clear()
      spent = undefined
      recent.length = 0
      contexts.length = 0
      turnTimes.length = 0
      turnStarts.clear()
      previous = undefined
      expectMiss = false
      tally = undefined
      thinkingNoted.clear()
      notice.packed()
    },
  }
}
export type UsageNotes = ReturnType<typeof createUsageNotes>
