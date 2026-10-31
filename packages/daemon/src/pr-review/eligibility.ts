import type { ReviewConfig } from "./config"
import type { Eligibility, EligibilityTrigger, PrFacts } from "./contracts"

/**
 * Whether one pull request is reviewed now, and why (docs/pr-review.md, "Which pull requests"; R01). Pure: the facts come from
 * the provider (`PrFacts`), the rules from the base branch's `.mendcode/review.yaml`, and the answer always carries a reason a
 * person can read, because "nothing happened" without one is indistinguishable from a broken watch.
 *
 * Three layers, checked in this order so the first reason given is the one that matters:
 *
 * 1. Exclusions (`filters.labels.exclude`, `filters.branches.exclude`, `filters.authors.exclude`) are the repository saying
 *    "never here". They hold for every trigger, a `/pr review` or an `@mendcode review` comment included: a request does not
 *    override what the maintainers excluded (they can remove the label or the entry).
 * 2. The mode (`auto`, `on-request`, `labels`), the trigger switches (`triggers.opened|synchronize|ready_for_review`) and drafts
 *    (`triggers.drafts`) decide which automatic events start a review.
 * 3. The narrowing filters (`filters.branches.include`, `filters.authors.include`, bots, `filters.paths`) keep automatic reviews to
 *    what the repository wants reviewed by itself.
 *
 * An `@mendcode review` or `@mendcode fix` comment (`comment`) skips layer 2 (someone asked, so the mode and the trigger switches
 * do not apply) but not layer 3: a mention is held to the same filters and draft rule as an automatic review, so a PR the
 * repository keeps out of review is not reviewed because someone typed a comment. There is no override key: to review such a PR a
 * maintainer changes the filter on the base branch (or removes the label). `/pr review` (`manual`) is the daemon owner's own
 * request in their own session and skips layers 2 and 3; exclusions still hold for it. Who may ask is decided before this
 * (`mayRequest`, the commenter's association, `publishers`), never here. `enabled` is not checked either: a watched repository
 * that has not enabled publishing is still reviewed into the watching session (run.ts decides about posting).
 *
 * `requested` is the provider saying a review was requested from (or the PR assigned to) `login`; it satisfies `on-request` but
 * still respects drafts and the narrowing filters, since nobody typed anything to MendCode. `label` is a label change: in
 * `labels` mode the label must be one of `filters.labels.include`, in `auto` it is one more event.
 */

const EXPLICIT: ReadonlySet<EligibilityTrigger> = new Set(["manual", "comment"])
const MENTION_REASON = "comment: asked with @mendcode"
const SWITCHED = ["opened", "synchronize", "ready_for_review"] as const
type SwitchedTrigger = typeof SWITCHED[number]
const isSwitched = (trigger: EligibilityTrigger): trigger is SwitchedTrigger => (SWITCHED as readonly string[]).includes(trigger)

/** Logins of well-known automation that GitHub does not always mark as `type: Bot` (a classic token used by a bot account). */
const KNOWN_BOTS = /^(dependabot|renovate|github-actions|mergify|snyk-bot|greenkeeper|depfu|pre-commit-ci|allcontributors|codecov)(\[bot\])?$/i

/** Whether `login` is automation: GitHub's `type: Bot`, an app login (`name[bot]`), or a well-known bot account. */
export function isBot(login: string | undefined, type?: string): boolean {
  if (type?.toLowerCase() === "bot") return true
  if (!login) return false
  return /\[bot\]$/i.test(login) || KNOWN_BOTS.test(login)
}

/** Whether `filters.paths` needs the changed files: the caller lists them (`ReviewProvider.view`) before asking. */
export const needsFiles = (config: ReviewConfig) => config.filters.paths.length > 0

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const among = (list: readonly string[], value: string) => list.some((entry) => same(entry, value))
const globMatch = (pattern: string, value: string) => { try { return new Bun.Glob(pattern).match(value) } catch { return false } }
const quoted = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(", ")

/** Whether `login` is a requested reviewer or an assignee of the PR. */
const requestedOf = (facts: PrFacts, login: string) => among(facts.requested, login) || among(facts.assignees, login)

/** Layer 1: what the repository never reviews, for any trigger. */
function excluded(facts: PrFacts, config: ReviewConfig): string | undefined {
  const label = facts.labels.find((name) => among(config.filters.labels.exclude, name))
  if (label !== undefined) return `label \`${label}\` excluded`
  const branch = config.filters.branches.exclude.find((pattern) => globMatch(pattern, facts.baseRef))
  if (branch !== undefined) return `base branch \`${facts.baseRef}\` excluded by \`${branch}\``
  if (among(config.filters.authors.exclude, facts.author)) return `author @${facts.author} excluded`
  return undefined
}

/** Layer 2: whether this automatic event starts a review in this mode, or why not. */
function modeAllows(facts: PrFacts, config: ReviewConfig, trigger: EligibilityTrigger, login: string | undefined): { ok: true; reason: string } | { ok: false; reason: string } {
  if (trigger === "requested" && login && !requestedOf(facts, login)) return { ok: false, reason: `requested: @${login} is neither a requested reviewer nor an assignee` }
  if (isSwitched(trigger) && !config.triggers[trigger]) return { ok: false, reason: `triggers.${trigger} is off` }
  if (config.mode === "on-request") {
    if (trigger !== "requested") return { ok: false, reason: "on-request: not requested" }
    return { ok: true, reason: `on-request: review requested${login ? ` from @${login}` : ""}` }
  }
  if (config.mode === "labels") {
    const include = config.filters.labels.include
    if (!include.length) return { ok: false, reason: "labels: filters.labels.include is empty, so no label starts a review" }
    const label = facts.labels.find((name) => among(include, name))
    if (label === undefined) return { ok: false, reason: `labels: none of ${quoted(include)} is on the pull request` }
    return { ok: true, reason: `labels: label \`${label}\`` }
  }
  return { ok: true, reason: `auto: ${trigger.replaceAll("_", " ")}` }
}

/** Layer 3: drafts and the narrowing filters of automatic reviews. */
function narrowed(facts: PrFacts, config: ReviewConfig, trigger: EligibilityTrigger): string | undefined {
  if (facts.draft && !config.triggers.drafts) return "draft: waits for ready for review"
  if (trigger === "ready_for_review" && facts.draft) return "ready for review: the pull request is still a draft"
  const branches = config.filters.branches.include
  if (branches.length && !branches.some((pattern) => globMatch(pattern, facts.baseRef))) return `base branch \`${facts.baseRef}\` not included (filters.branches.include: ${quoted(branches)})`
  const authors = config.filters.authors
  const listedAuthor = among(authors.include, facts.author)
  if (authors.include.length && !listedAuthor) return `author @${facts.author} not included (filters.authors.include)`
  if ((facts.authorIsBot || isBot(facts.author)) && !authors.bots && !listedAuthor) return `author @${facts.author} is a bot (filters.authors.bots is off)`
  const paths = config.filters.paths
  if (paths.length) {
    if (!facts.files) return "paths: the changed files were not listed, so filters.paths cannot be checked"
    if (!facts.files.some((file) => paths.some((pattern) => globMatch(pattern, file)))) return `paths: no changed file matches ${quoted(paths)}`
  }
  return undefined
}

/**
 * Whether `facts` is reviewed for `trigger` under `config`, with the reason. `login` is the reviewer's own provider login, which
 * a `requested` trigger must name (in the requested reviewers or the assignees).
 */
export function eligible({ facts, config, trigger, login }: { facts: PrFacts; config: ReviewConfig; trigger: EligibilityTrigger; login?: string | undefined }): Eligibility {
  const exclusion = excluded(facts, config)
  if (exclusion) return { ok: false, reason: exclusion }
  if (trigger === "manual") return { ok: true, reason: "manual: asked with /pr review" }
  if (EXPLICIT.has(trigger)) {
    const narrowing = narrowed(facts, config, trigger)
    return narrowing ? { ok: false, reason: narrowing } : { ok: true, reason: MENTION_REASON }
  }
  const mode = modeAllows(facts, config, trigger, login)
  if (!mode.ok) return mode
  const narrowing = narrowed(facts, config, trigger)
  return narrowing ? { ok: false, reason: narrowing } : mode
}
