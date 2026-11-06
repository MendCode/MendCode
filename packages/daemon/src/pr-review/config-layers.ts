import type { z } from "zod"
import { DEFAULT_REVIEW_CONFIG, ReviewConfig } from "./config"
import { isPresetName, overlay, presetLayer, type ReviewPresetName } from "./presets"

/**
 * The effective config of one reviewer (docs/pr-review.md, configuration layers): preset → repository (`.mendcode/review.yaml` on
 * the base branch, the trust root) → personal profile (the developer's own, under the data directory) → task (`/pr review` flags).
 * Each top-level key records the layer it came from, so a user sees why a value is what it is.
 *
 * The repository decides what could be abused or what other people rely on. A personal or task layer may narrow and restyle
 * (profile, cap, template, phases, coverage, added path instructions and ignores, a lower budget, a fix mode up to the
 * repository's, stricter filters and cooldown) but never turn on what the repository has off nor change what it controls
 * (`enabled`, `fixes`, `fix.push`, `fix.personal`, `checks`, `publishers`, `reviewers`, `preset`, `backlog`, `status`, `template.language`, wider triggers or filters). Such a
 * value is not applied and becomes a problem naming its key path; it is never a silent change. A PR's own head config is not a
 * layer here: it still only adds path instructions (`mergeReviewConfigs`).
 */

export type ConfigOrigin = "preset" | "repository" | "personal" | "task"
export type ConfigKey = keyof ReviewConfig
/** A layer as stored or written: only the keys it sets, each valid on its own; nested objects may be partial. */
export type ConfigLayer = Record<string, unknown>
export type EffectiveConfig = { config: ReviewConfig; origins: Record<ConfigKey, ConfigOrigin>; problems: string[]; preset: ReviewPresetName }

const SHAPE = ReviewConfig.shape as unknown as Record<ConfigKey, z.ZodType>
export const CONFIG_KEYS = Object.keys(SHAPE) as ConfigKey[]
const MAX_PROBLEMS_PER_LAYER = 20

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const kind = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "a list" : typeof value

/**
 * A layer checked key by key: an unknown key, a wrong type or a value out of range is a problem with its key path
 * (`personal budget.tokens_per_pr: …`) and that top-level key is left out; the other keys stand. Valid keys are kept as written
 * (not filled with defaults), so a partial `fix` merges over the layer below instead of resetting its siblings.
 */
export function checkLayer(raw: unknown, label: string): { layer: ConfigLayer; problems: string[] } {
  if (raw === undefined || raw === null) return { layer: {}, problems: [] }
  if (!isRecord(raw)) return { layer: {}, problems: [`[PR_REVIEW]: ${label} config: expected a mapping of keys, got ${kind(raw)}`] }
  const layer: ConfigLayer = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const schema = SHAPE[key as ConfigKey]
    if (!schema) { problems.push(`[PR_REVIEW]: ${label} ${key}: unknown key (known: ${CONFIG_KEYS.join(", ")})`); continue }
    const parsed = schema.safeParse(value)
    if (parsed.success) { layer[key] = structuredClone(value); continue }
    for (const issue of parsed.error.issues) {
      const at = [key, ...issue.path.map(String)]
      if (issue.code === "unrecognized_keys") for (const extra of issue.keys) problems.push(`[PR_REVIEW]: ${label} ${[...at, extra].join(".")}: unknown key`)
      else problems.push(`[PR_REVIEW]: ${label} ${at.join(".")}: ${issue.message}`)
    }
  }
  return { layer, problems: problems.slice(0, MAX_PROBLEMS_PER_LAYER) }
}

/** A patch over a stored layer: each top-level key replaces the layer's, `null` removes it. The result is not checked here. */
export function patchLayer(layer: ConfigLayer, patch: Record<string, unknown>): ConfigLayer {
  const next: ConfigLayer = structuredClone(layer)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = structuredClone(value)
  }
  return next
}

const MODE_RANK: Record<ReviewConfig["mode"], number> = { "on-request": 0, labels: 1, auto: 2 }
const FIX_RANK: Record<ReviewConfig["fix"]["mode"], number> = { review: 0, "fix-once": 1, "fix-loop": 2 }
/** Keys only the repository sets; a personal or task layer may repeat the value, never change it. */
const CONTROLLED = new Set<ConfigKey>(["checks", "publishers", "reviewers", "preset", "backlog", "commands", "fallback_models", "status"])
/** Keys a personal or task layer sets freely: they change how a review reads, not what it may do or whose PRs it takes. */
const RESTYLE = new Set<ConfigKey>(["profile", "cap", "min_score", "template", "phases", "coverage", "readers"])

const globWithin = (inner: string, outer: string) => inner === outer || (() => { try { return new Bun.Glob(outer).match(inner) } catch { return false } })()

/**
 * The part of a personal or task layer the repository allows over `current` (the config up to the repository), plus a problem
 * for each value that would widen it. Every accepted value is complete for its top-level key except the restyle keys, which
 * merge over `current` like any layer.
 */
export function restrictLayer(current: ReviewConfig, layer: ConfigLayer, label: "personal" | "task"): { accepted: ConfigLayer; problems: string[] } {
  const accepted: ConfigLayer = {}
  const problems: string[] = []
  const refuse = (at: string, why: string) => problems.push(`[PR_REVIEW]: ${label} ${at}: ${why}; not applied`)
  const offOnly = (at: string, value: unknown, base: boolean) => {
    if (value === true && !base) { refuse(at, "the repository has it off, and only the repository may turn it on"); return base }
    return value === true || value === false ? value : base
  }
  const atMost = (at: string, value: unknown, base: number, unit = "") => {
    if (typeof value !== "number") return base
    if (value > base) { refuse(at, `${value}${unit} is above the repository's ${base}${unit}`); return base }
    return value
  }
  const atLeast = (at: string, value: unknown, base: number) => {
    if (typeof value !== "number") return base
    if (value < base) { refuse(at, `${value} is below the repository's ${base}`); return base }
    return value
  }
  /** An include list narrows: empty in the repository takes any list; otherwise only entries inside the repository's. */
  const include = (at: string, value: unknown, base: readonly string[], within: (inner: string, outer: string) => boolean) => {
    if (!Array.isArray(value)) return [...base]
    if (!base.length) return value as string[]
    if (!value.length) { refuse(at, "an empty list takes everything, wider than the repository's list"); return [...base] }
    const inside = (value as string[]).filter((entry) => base.some((outer) => within(entry, outer)))
    const outside = (value as string[]).filter((entry) => !inside.includes(entry))
    if (outside.length) refuse(at, `${outside.map((entry) => JSON.stringify(entry)).join(", ")} is outside the repository's list`)
    return inside.length ? inside : [...base]
  }
  /** An exclude list only grows: the repository's entries stay. */
  const exclude = (value: unknown, base: readonly string[]) => Array.isArray(value) ? [...base, ...(value as string[]).filter((entry) => !base.includes(entry))] : [...base]
  const exact = (inner: string, outer: string) => inner.toLowerCase() === outer.toLowerCase()

  for (const [name, value] of Object.entries(layer)) {
    const key = name as ConfigKey
    // The review language is public (reviews of one PR read in one language): a restyle keeps the repository's.
    if (key === "template" && isRecord(value) && "language" in value) {
      const { language, ...rest } = value
      if (language !== current.template.language) refuse("template.language", `only the repository sets the review language (${current.template.language})`)
      if (Object.keys(rest).length) accepted[key] = rest
      continue
    }
    if (RESTYLE.has(key)) { accepted[key] = value; continue }
    if (CONTROLLED.has(key)) {
      if (!same(value, current[key])) refuse(key, `only the repository sets ${key}`)
      continue
    }
    const part = isRecord(value) ? value : {}
    const refusedBefore = problems.length
    switch (key) {
      case "enabled":
      case "fixes":
        accepted[key] = offOnly(key, value, current[key])
        break
      case "mode":
        if (MODE_RANK[value as ReviewConfig["mode"]] > MODE_RANK[current.mode]) refuse(key, `${String(value)} reviews more PRs by itself than the repository's ${current.mode}`)
        else accepted[key] = value
        break
      case "ignore":
        accepted[key] = exclude(value, current.ignore).slice(0, 100)
        break
      case "paths": {
        const known = new Set(current.paths.map((entry) => `${entry.glob}\n${entry.instructions}`))
        accepted[key] = [...current.paths, ...(value as ReviewConfig["paths"]).filter((entry) => !known.has(`${entry.glob}\n${entry.instructions}`))].slice(0, 50)
        break
      }
      case "triggers": {
        const triggers = { ...current.triggers }
        for (const [trigger, on] of Object.entries(part)) triggers[trigger as keyof typeof triggers] = offOnly(`triggers.${trigger}`, on, current.triggers[trigger as keyof typeof triggers])
        accepted[key] = triggers
        break
      }
      case "cooldown":
        accepted[key] = { pr_minutes: atLeast("cooldown.pr_minutes", part.pr_minutes, current.cooldown.pr_minutes), repo_per_hour: atMost("cooldown.repo_per_hour", part.repo_per_hour, current.cooldown.repo_per_hour) }
        break
      case "budget": {
        const budget = { ...current.budget }
        if ("tokens_per_pr" in part) {
          if (part.tokens_per_pr === null) { if (current.budget.tokens_per_pr !== null) refuse("budget.tokens_per_pr", `no cap is above the repository's ${current.budget.tokens_per_pr}`) }
          else budget.tokens_per_pr = current.budget.tokens_per_pr === null ? part.tokens_per_pr as number : atMost("budget.tokens_per_pr", part.tokens_per_pr, current.budget.tokens_per_pr)
        }
        if ("tokens_per_diff_token" in part) budget.tokens_per_diff_token = atMost("budget.tokens_per_diff_token", part.tokens_per_diff_token, current.budget.tokens_per_diff_token)
        if ("context_tokens" in part) budget.context_tokens = current.budget.context_tokens === undefined ? part.context_tokens as number : atMost("budget.context_tokens", part.context_tokens, current.budget.context_tokens)
        if (part.on_quota === "wait" && current.budget.on_quota === "stop") refuse("budget.on_quota", "the repository stops at a quota; waiting for it is longer")
        else if (part.on_quota !== undefined) budget.on_quota = part.on_quota as ReviewConfig["budget"]["on_quota"]
        if ("max_wait_minutes" in part) budget.max_wait_minutes = atMost("budget.max_wait_minutes", part.max_wait_minutes, current.budget.max_wait_minutes, " minutes")
        accepted[key] = budget
        break
      }
      case "fix": {
        const fix = { ...current.fix }
        if (part.mode !== undefined) {
          if (FIX_RANK[part.mode as ReviewConfig["fix"]["mode"]] > FIX_RANK[current.fix.mode]) refuse("fix.mode", `${String(part.mode)} does more than the repository's ${current.fix.mode}`)
          else fix.mode = part.mode as ReviewConfig["fix"]["mode"]
        }
        fix.push = offOnly("fix.push", part.push, current.fix.push)
        fix.personal = offOnly("fix.personal", part.personal, current.fix.personal)
        fix.max_rounds = atMost("fix.max_rounds", part.max_rounds, current.fix.max_rounds)
        accepted[key] = fix
        break
      }
      case "filters": {
        const base = current.filters
        const labels = isRecord(part.labels) ? part.labels : {}
        const branches = isRecord(part.branches) ? part.branches : {}
        const authors = isRecord(part.authors) ? part.authors : {}
        accepted[key] = {
          labels: { include: include("filters.labels.include", labels.include, base.labels.include, exact), exclude: exclude(labels.exclude, base.labels.exclude).slice(0, 50) },
          branches: { include: include("filters.branches.include", branches.include, base.branches.include, globWithin), exclude: exclude(branches.exclude, base.branches.exclude).slice(0, 50) },
          authors: { include: include("filters.authors.include", authors.include, base.authors.include, exact), exclude: exclude(authors.exclude, base.authors.exclude).slice(0, 100), bots: offOnly("filters.authors.bots", authors.bots, base.authors.bots) },
          paths: include("filters.paths", part.paths, base.paths, globWithin),
        }
        break
      }
      default:
        refuse(key, "not a setting a personal or task layer may change")
    }
    // Wholly refused (nothing of it changed the value): the key keeps the repository's value and its origin.
    if (problems.length > refusedBefore && key in accepted && same(accepted[key], current[key])) delete accepted[key]
  }
  return { accepted, problems: problems.slice(0, MAX_PROBLEMS_PER_LAYER) }
}

const plain = (config: ReviewConfig): Record<string, unknown> => structuredClone(config) as Record<string, unknown>

/** `layer` over `current`, parsed; a result the schema refuses (not expected after the checks) keeps `current` with a problem. */
function stack(current: ReviewConfig, layer: ConfigLayer, label: string, problems: string[]): ReviewConfig {
  const parsed = ReviewConfig.safeParse(overlay(plain(current), layer))
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]!
  problems.push(`[PR_REVIEW]: ${label} ${issue.path.join(".") || "config"}: ${issue.message}; the ${label} layer was not applied`)
  return current
}

/**
 * The effective config. `repository`, `personal` and `task` are raw layers (a YAML file's parsed object, a stored profile, flags);
 * `preset` is the caller's default when the repository names none (the repository's own `preset` wins). Problems are in layer
 * order, each with its key path, and never stop the layers that are valid.
 */
export function effectiveConfig({ preset, repository, personal, task }: { preset?: ReviewPresetName | undefined; repository?: unknown; personal?: unknown; task?: unknown }): EffectiveConfig {
  const problems: string[] = []
  const repo = checkLayer(repository, "repository")
  problems.push(...repo.problems)
  const name: ReviewPresetName = isPresetName(repo.layer.preset) ? repo.layer.preset : preset ?? "balanced"
  const origins = Object.fromEntries(CONFIG_KEYS.map((key) => [key, "preset"])) as Record<ConfigKey, ConfigOrigin>
  let config = stack(DEFAULT_REVIEW_CONFIG, { ...presetLayer(name), ...(name === "balanced" ? {} : { preset: name }) }, "preset", problems)
  config = stack(config, repo.layer, "repository", problems)
  for (const key of Object.keys(repo.layer)) origins[key as ConfigKey] = "repository"
  for (const [label, raw] of [["personal", personal], ["task", task]] as const) {
    if (raw === undefined) continue
    const checked = checkLayer(raw, label)
    const restricted = restrictLayer(config, checked.layer, label)
    problems.push(...checked.problems, ...restricted.problems)
    const before = config
    config = stack(config, restricted.accepted, label, problems)
    if (config !== before) for (const key of Object.keys(restricted.accepted)) origins[key as ConfigKey] = label
  }
  return { config, origins, problems, preset: name }
}
