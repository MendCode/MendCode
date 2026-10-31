/**
 * Named starting points for a reviewer's config (docs/pr-review.md, configuration layers). A preset is the lowest layer: the
 * repository's `.mendcode/review.yaml` (`preset: quiet`), then a personal profile, then a task, each set over it. `balanced` is
 * exactly the built-in defaults, so a file without `preset` behaves as it always did. No preset turns posting on (`enabled`),
 * adds checks, widens who may publish or ask, or pushes: those stay the repository's own explicit choice.
 *
 * Plain data and a merge only, with no import of the schema: config.ts applies presets while parsing and imports this module.
 */

export const REVIEW_PRESETS = ["balanced", "quiet", "strict", "on-request", "autofix"] as const
export type ReviewPresetName = typeof REVIEW_PRESETS[number]

export type ReviewPreset = { name: ReviewPresetName; summary: string; layer: Readonly<Record<string, unknown>> }

const PRESETS: Readonly<Record<ReviewPresetName, ReviewPreset>> = {
  balanced: { name: "balanced", summary: "the defaults: automatic reviews of ready PRs, normal profile, 8 comments, incremental, review only", layer: {} },
  quiet: {
    name: "quiet",
    summary: "critical and major findings only, at most 4 comments, a concise body, no visible stages",
    layer: { profile: "quiet", cap: 4, template: { tone: "concise" }, phases: { mode: "none" } },
  },
  strict: {
    name: "strict",
    summary: "also maintainability and plausible findings, up to 20 comments, the whole PR on every push, a detailed body",
    layer: { profile: "strict", cap: 20, coverage: "full", template: { tone: "detailed" } },
  },
  "on-request": {
    name: "on-request",
    summary: "reviews only when asked (@mendcode review, a requested reviewer, /pr review); nothing automatic",
    layer: { mode: "on-request" },
  },
  autofix: {
    name: "autofix",
    summary: "review, then fix the confirmed findings and review again, up to 3 rounds; the fix is never pushed by the preset",
    layer: { fix: { mode: "fix-loop", max_rounds: 3 } },
  },
}

export const isPresetName = (name: unknown): name is ReviewPresetName => typeof name === "string" && (REVIEW_PRESETS as readonly string[]).includes(name)
export const reviewPreset = (name: ReviewPresetName): ReviewPreset => PRESETS[name]
/** A fresh copy of a preset's keys, safe to merge into. */
export const presetLayer = (name: ReviewPresetName): Record<string, unknown> => structuredClone(PRESETS[name].layer) as Record<string, unknown>
export const listPresets = (): ReviewPreset[] => REVIEW_PRESETS.map((name) => PRESETS[name])

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/**
 * `over` set on `under`: objects merge key by key (so `fix: { mode: fix-once }` keeps the layer below's `fix.push`), arrays and
 * scalars replace. Neither input is changed. Layers never hold `null` (a patch's `null` removes the key before it is stored).
 */
export function overlay(under: unknown, over: unknown): unknown {
  if (!isRecord(under) || !isRecord(over)) return structuredClone(over)
  const merged: Record<string, unknown> = structuredClone(under)
  for (const [key, value] of Object.entries(over)) merged[key] = key in merged ? overlay(merged[key], value) : structuredClone(value)
  return merged
}
