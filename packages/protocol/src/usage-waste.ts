import { z } from "zod"
import { lazySchema } from "./lazy"

/**
 * The waste report (`usage.waste`, docs/usage.md "Waste"): where a range's tokens went, the moments that paid for the same
 * context twice, what to change and what a change already made did. Computed from MendCode's own call records only.
 */

const Count = z.number().int().nonnegative()
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Text = (max: number) => z.string().max(max)
/** A settings.set patch: each top-level key replaces the whole value, null resets it. */
const Patch = z.record(z.string(), z.unknown())

/** Tokens by what they paid for, and in micro-USD where a price is known. */
const Split = z.strictObject({ reread: Count, written: Count, fresh: Count, output: Count })

const SessionRef = z.strictObject({ sessionId: z.string(), title: Text(200) })

export const WasteFinding = lazySchema(() => z.strictObject({
  id: z.enum(["idle_compact", "wait_cache", "compact_earlier", "prompt_cache", "model_switch"]),
  /** `clear`: nothing to lose. `likely`: saves on this usage, at a small cost named in `detail`. `test`: an upper bound, worth measuring. */
  certainty: z.enum(["clear", "likely", "test"]),
  title: Text(120),
  detail: Text(400),
  /** Tokens it would have kept from being sent at the full price (or re-read) in this range; never summed with another finding's. */
  tokens: Count,
  costMicros: Count.optional(),
  /** What applying it saves: a settings.set patch and the words for it. Absent when the change is a habit, not a setting. */
  fix: z.strictObject({ label: Text(120), patch: Patch }).optional(),
}))
export type WasteFinding = z.infer<typeof WasteFinding>

/** The figures of a stretch of days, for the comparison around a change. Per-turn figures are averages of the turns in it. */
export const WasteWindow = lazySchema(() => z.strictObject({
  from: Count,
  to: Count,
  days: z.number().nonnegative(),
  turns: Count,
  calls: Count,
  promptPerTurn: Count,
  uncachedPerTurn: Count,
  /** Share of calls whose prompt was at least 200K tokens, 0 to 1. */
  over200k: z.number().min(0).max(1),
  compactionsPerDay: z.number().nonnegative(),
  waitMsPerDay: z.number().nonnegative(),
  costPerTurnMicros: Count.optional(),
}))
export type WasteWindow = z.infer<typeof WasteWindow>

export const WasteChange = lazySchema(() => z.strictObject({
  at: Count,
  /** The settings' keys, `features.<id>` for one feature; several when they changed together. */
  keys: z.array(Text(80)).min(1).max(12),
  /** `compactAtTokens 475K → 200K`, joined by ` · ` when several changed together. */
  label: Text(600),
  before: WasteWindow,
  after: WasteWindow,
  /** Either side has too few turns or days to say anything yet. */
  early: z.literal(true).optional(),
  /** Puts the setting back as it was before the change: a settings.set patch. */
  revert: Patch.optional(),
}))
export type WasteChange = z.infer<typeof WasteChange>

export const UsageWasteReport = lazySchema(() => z.strictObject({
  from: Day,
  to: Day,
  scope: z.strictObject({ kind: z.enum(["global", "project", "directory"]), directory: z.string().optional(), project: z.string().optional() }),
  calls: Count,
  turns: Count,
  sessions: Count,
  /** Calls with a known cost: `billed` by the provider, `list` priced from a public API price (a subscription's work at API prices). */
  priced: z.strictObject({ billed: Count, list: Count }),
  split: Split,
  splitMicros: Split.optional(),
  /** Calls by the size of their prompt: `min` inclusive, `max` exclusive (absent: no upper bound). */
  bands: z.array(z.strictObject({ min: Count, max: Count.optional(), calls: Count, prompt: Count })).max(8),
  /** A call after a pause that found its cache gone and sent the context again. `resent` tokens; `micros` what they cost, `warmMicros` what a warm read would have. */
  cold: z.strictObject({ count: Count, sessions: Count, resent: Count, micros: Count.optional(), warmMicros: Count.optional(), /** How many of `count` `micros` covers: the ones on a model with a price. */ priced: Count.optional(), worst: z.array(SessionRef.extend({ at: Count, gapMs: Count, tokens: Count })).max(5) }),
  /** A call that missed a cache that was still warm: the start of the prompt changed (native calls only). */
  breaks: z.strictObject({ count: Count, sessions: Count, resent: Count }),
  /** A call on another model than the one before it in the session, which caches nothing of it. */
  switches: z.strictObject({ count: Count, resent: Count }),
  compactions: z.strictObject({ auto: Count, manual: Count, idle: Count, failed: Count, waitMs: Count }),
  /** `cost` when every call of the range has a price, else `prompt`: an unpriced session is never ranked as cheap. */
  topBy: z.enum(["cost", "prompt"]),
  top: z.array(SessionRef.extend({ calls: Count, turns: Count, prompt: Count, costMicros: Count.optional(), cold: Count, peak: Count, lastAt: Count })).max(10),
  findings: z.array(WasteFinding).max(10),
  changes: z.array(WasteChange).max(12),
}))
export type UsageWasteReport = z.infer<typeof UsageWasteReport>
