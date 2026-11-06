import type { PrPullRequestState } from "@mendcode/protocol"
import { bucketOf, type GhRun } from "../pr-watch"

/**
 * The reviews page's pull request states (docs/pr-review.md): one `gh pr list --state all` per GitHub repository, never one call
 * per pull request, kept in memory for `PR_STATES_TTL_MS`. Nothing runs on its own: the page asks when it opens and on `r`. A read
 * that fails keeps the last good one (or none), so the page shows the state as unknown and never breaks. Loaded on first use.
 */

export const PR_STATES_TTL_MS = 60_000
/** The newest pull requests one read covers; older ones show no state. */
export const PR_STATES_LIMIT = 100
const FIELDS = "number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup"
const MAX_REPOS = 50
const MAX_FAILING = 3
const REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/

type Rollup = Parameters<typeof bucketOf>[0]
type Entry = { at: number; prs: ReadonlyMap<number, PrPullRequestState> }

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined)
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** One pull request of `gh pr list --json FIELDS`; undefined when it does not have that shape. */
function stateOf(value: unknown): [number, PrPullRequestState] | undefined {
  const item = record(value)
  const number = item?.number
  if (!item || typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined
  const state = item.state === "MERGED" ? "merged" : item.state === "CLOSED" ? "closed" : item.state === "OPEN" ? "open" : undefined
  if (!state) return undefined
  const mergeable = item.mergeable === "CONFLICTING" || item.mergeStateStatus === "DIRTY" ? "conflicting" : item.mergeable === "MERGEABLE" ? "mergeable" : "unknown"
  const failing: string[] = []
  let pending = false
  let passed = false
  for (const raw of Array.isArray(item.statusCheckRollup) ? item.statusCheckRollup : []) {
    const check = record(raw)
    if (!check) continue
    const rollup: Rollup = { __typename: text(check.__typename), name: text(check.name), context: text(check.context), status: text(check.status), conclusion: text(check.conclusion), state: text(check.state) }
    const bucket = bucketOf(rollup)
    if (bucket === "fail") failing.push((rollup.name ?? rollup.context ?? "check").slice(0, 120))
    else if (bucket === "pending") pending = true
    else if (bucket === "pass") passed = true
  }
  const checks = failing.length ? "failing" : pending ? "pending" : passed ? "passing" : "none"
  return [number, { state, draft: item.isDraft === true, mergeable, checks, ...(failing.length ? { failing: [...new Set(failing)].slice(0, MAX_FAILING) } : {}) }]
}

/** `gh pr list` output as states by number; undefined when it is not a list. */
export function parsePrStates(out: string): Map<number, PrPullRequestState> | undefined {
  let value: unknown
  try { value = JSON.parse(out) } catch { return undefined }
  if (!Array.isArray(value)) return undefined
  const prs = new Map<number, PrPullRequestState>()
  for (const item of value.slice(0, PR_STATES_LIMIT)) {
    const parsed = stateOf(item)
    if (parsed) prs.set(parsed[0], parsed[1])
  }
  return prs
}

export type PrStates = {
  /** Reads the repository unless its last read is fresh (`refresh` reads it anyway); one read per repository at a time. */
  fetch(repo: string, directory: string, refresh: boolean): Promise<void>
  /** The last read states of a repository, whatever their age; nothing is fetched. */
  cached(repo: string): ReadonlyMap<number, PrPullRequestState> | undefined
}

export function createPrStates({ run, now = Date.now, ttlMs = PR_STATES_TTL_MS }: { run: GhRun; now?: () => number; ttlMs?: number }): PrStates {
  const cache = new Map<string, Entry>()
  const reading = new Map<string, Promise<void>>()

  async function read(repo: string, directory: string) {
    const result = await run({ argv: ["pr", "list", "--repo", repo, "--state", "all", "--limit", String(PR_STATES_LIMIT), "--json", FIELDS], cwd: directory }).catch(() => undefined)
    const prs = result?.code === 0 ? parsePrStates(result.out) : undefined
    if (!prs) return
    cache.delete(repo)
    cache.set(repo, { at: now(), prs })
    while (cache.size > MAX_REPOS) cache.delete(cache.keys().next().value!)
  }

  return {
    fetch(repo, directory, refresh) {
      if (!REPO.test(repo)) return Promise.resolve()
      const inFlight = reading.get(repo)
      if (inFlight) return inFlight
      const entry = cache.get(repo)
      if (!refresh && entry && now() - entry.at < ttlMs) return Promise.resolve()
      const started = read(repo, directory).finally(() => reading.delete(repo))
      reading.set(repo, started)
      return started
    },
    cached: (repo) => cache.get(repo)?.prs,
  }
}
