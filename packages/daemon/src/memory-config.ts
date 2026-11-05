import type { Settings } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"

/**
 * What the full tier (`memory_auto`) sets for a memory switch the user never set: facts reach prompts, a post-turn extractor
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
} as const satisfies Partial<Settings>

/** Categories nightly consolidation may save by itself; the other tiers keep the four standing-rule ones. */
export const STANDING_CONSOLIDATION_CATEGORIES = ["commands", "stack", "constraints", "conventions"] as const
export const FULL_CONSOLIDATION_CATEGORIES = [...STANDING_CONSOLIDATION_CATEGORIES, "preferences", "architecture", "objective", "release"] as const

/** Project overrides affect the same retrieval, generation and Dream paths as global settings; the full tier fills the switches nobody set. */
export function memorySettings(settings: Settings, directory?: string): Settings {
  const merged = { ...settings, ...(directory ? settings.memoryProjects?.[directory] : {}) }
  return featureOn(merged, "memory_auto") ? { ...FULL_MEMORY_DEFAULTS, ...merged } : merged
}

/** The categories consolidation may apply by itself for these (already effective) settings. */
export const consolidationCategories = (settings: Settings): readonly string[] => featureOn(settings, "memory_auto") ? FULL_CONSOLIDATION_CATEGORIES : STANDING_CONSOLIDATION_CATEGORIES
