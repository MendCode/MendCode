/**
 * How far a session is from its compaction and what to say about it (docs/compaction.md, "Notice before a compaction").
 * Pure and zod-free: the terminal's footer forecast and transcript notice, and the daemon's `context.recent` report, share it.
 */

/** The context size at the end of one turn. */
export type ContextSample = { turnId: string; tokens: number }

/** Fewer turns than this and the growth is a guess, so nothing is shown. */
const MIN_SAMPLES = 3
/** Beyond this many turns the number says nothing useful. */
const MAX_TURNS = 99
/** A fall of more than a tenth between turns means the history was rewritten (compaction, undo): older samples no longer describe it. */
const REWRITE_DROP = 0.9

export type ContextForecast = { turns: number; perTurn: number }

/**
 * Turns left before the context reaches `threshold`, from the average growth of the last turns. Undefined with too little history,
 * a context that is not growing, or more than 99 turns of room. `0` means the next turn crosses it.
 */
export function forecastTurns(samples: readonly ContextSample[], threshold: number): ContextForecast | undefined {
  if (threshold <= 0) return undefined
  let start = 0
  for (let i = 1; i < samples.length; i++) if (samples[i]!.tokens < samples[i - 1]!.tokens * REWRITE_DROP) start = i
  const window = samples.slice(start)
  if (window.length < MIN_SAMPLES) return undefined
  const growth = (window.at(-1)!.tokens - window[0]!.tokens) / (window.length - 1)
  if (!(growth > 0)) return undefined
  const turns = Math.max(0, Math.floor((threshold - window.at(-1)!.tokens) / growth))
  return turns > MAX_TURNS ? undefined : { turns, perTurn: Math.round(growth) }
}

/** The share of the limit at which the notice is shown when `compactNoticePercent` is unset. */
export const DEFAULT_COMPACT_NOTICE_PERCENT = 80
export const COMPACT_NOTICE_RANGE = { min: 10, max: 99 } as const
/** The notice is armed again once the context is back under this share of its own threshold (an engine packed it, turns were undone). */
const REARM_SHARE = 0.75

/** The `compactNoticePercent` setting as a number, or undefined for `off`. */
export const compactNoticePercent = (setting: number | "off" | undefined): number | undefined => (setting === "off" ? undefined : setting ?? DEFAULT_COMPACT_NOTICE_PERCENT)

/**
 * What is left before the limit. `limit` says what the context is measured against: `compaction` is where MendCode packs the
 * history, `window` is the model window of an engine that compacts on its own. `turns` and `perTurn` are present only with at
 * least three turns of growth to go by.
 */
export type CompactEstimate = { limit: "compaction" | "window"; auto: boolean; tokensLeft: number; turns?: number | undefined; perTurn?: number | undefined }

export function compactEstimate(input: { tokens: number; limitTokens: number; limit: CompactEstimate["limit"]; auto: boolean; samples: readonly ContextSample[] }): CompactEstimate {
  const forecast = forecastTurns(input.samples, input.limitTokens)
  return { limit: input.limit, auto: input.auto, tokensLeft: Math.max(0, input.limitTokens - input.tokens), ...(forecast ? { turns: forecast.turns, perTurn: forecast.perTurn } : {}) }
}

/** One line: what happens, how far away it is, and what the user can do. `count` writes a token count. */
export function compactEstimateText(estimate: CompactEstimate, count: (tokens: number) => string): string {
  const left = count(estimate.tokensLeft)
  const turns = estimate.turns === undefined ? "" : estimate.turns === 0 ? " · next turn" : ` · about ${estimate.turns} turn${estimate.turns === 1 ? "" : "s"} (${count(estimate.perTurn ?? 0)} a turn)`
  if (estimate.limit === "window") return `${left} tokens to the model window${turns} · the engine compacts it by itself`
  if (!estimate.auto) return `${left} tokens to the compaction point${turns} · automatic compaction is off · /compact to pack it`
  return `compaction in ${left} tokens${turns} · /compact to pack it now`
}

/**
 * Says once that the context crossed `percent` of its limit. Armed again by `packed()` (a compaction rewrote the history) or
 * when the context falls well under the threshold; a context that wobbles around it (old tool results pruned) says nothing twice.
 */
export function createCompactNotice() {
  let said = false
  return {
    crossed(tokens: number, limitTokens: number, percent: number): boolean {
      if (limitTokens <= 0) return false
      const share = (tokens / limitTokens) * 100
      if (share < percent * REARM_SHARE) said = false
      if (said || share < percent) return false
      said = true
      return true
    },
    packed() {
      said = false
    },
  }
}
