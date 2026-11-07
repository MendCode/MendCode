import type { Settings } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"

/**
 * What the balanced tier (`memory_auto`) sets for a memory switch the user never set: saved facts reach prompts and one selective
 * review per session proposes new ones (into Pending: approval stays on). No Dream or consolidation default, smaller caps.
 */
export const BALANCED_MEMORY_DEFAULTS = {
  memoryUse: true,
  memoryGenerate: true,
  memoryProjectMaxEntries: 10,
  memoryMaxEntries: 50,
  memoryReviewEveryTurns: 10,
  memoryReviewDailyCap: 12,
} as const satisfies Partial<Settings>

/**
 * What the full tier (`memory_auto`) sets for a memory switch the user never set: facts reach prompts, a selective per-session review
 * proposes them without a per-item approval, Dream consolidates Pending every night and the caps fit a real project.
 * A switch present in the settings (global or project) always wins.
 */
export const FULL_MEMORY_DEFAULTS = {
  memoryUse: true,
  memoryGenerate: true,
  memoryRequireApproval: false,
  memoryMaintenance: "auto-consolidate",
  dreamConsolidationPolicy: "auto-consolidate",
  memoryProjectMaxEntries: 20,
  memoryMaxEntries: 100,
  memoryReviewEveryTurns: 6,
  memoryReviewDailyCap: 30,
} as const satisfies Partial<Settings>

/** Categories nightly consolidation may save by itself; the other tiers keep the four standing-rule ones. */
export const STANDING_CONSOLIDATION_CATEGORIES = ["commands", "stack", "constraints", "conventions"] as const
export const FULL_CONSOLIDATION_CATEGORIES = [...STANDING_CONSOLIDATION_CATEGORIES, "preferences", "architecture", "objective", "release"] as const

/** Project overrides affect the same retrieval, generation and Dream paths as global settings; balanced and full fill the switches nobody set. Minimalist fills none. */
export function memorySettings(settings: Settings, directory?: string): Settings {
  const merged = { ...settings, ...(directory ? settings.memoryProjects?.[directory] : {}) }
  if (!featureOn(merged, "memory_auto")) return merged
  return { ...(merged.tier === "full" ? FULL_MEMORY_DEFAULTS : BALANCED_MEMORY_DEFAULTS), ...merged }
}

/** Whether the full tier's extras (scores in the extractor prompt, nightly Dream defaults) apply. */
export const fullMemoryTier = (settings: Settings): boolean => settings.tier === "full" && featureOn(settings, "memory_auto")

/** The categories consolidation may apply by itself for these (already effective) settings. */
export const consolidationCategories = (settings: Settings): readonly string[] => fullMemoryTier(settings) ? FULL_CONSOLIDATION_CATEGORIES : STANDING_CONSOLIDATION_CATEGORIES

/** When a session's memory is reviewed (effective settings; a user who only turned generation on gets the balanced figures). */
export function reviewPolicy(settings: Settings): { everyTurns: number; idleMs: number; dailyCap: number } {
  return {
    everyTurns: settings.memoryReviewEveryTurns ?? BALANCED_MEMORY_DEFAULTS.memoryReviewEveryTurns,
    idleMs: (settings.memoryReviewIdleMinutes ?? 10) * 60_000,
    dailyCap: settings.memoryReviewDailyCap ?? BALANCED_MEMORY_DEFAULTS.memoryReviewDailyCap,
  }
}
