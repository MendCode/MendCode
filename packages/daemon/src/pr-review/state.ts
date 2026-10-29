import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { PrFinding } from "@mendcode/protocol"

/**
 * What the reviewer remembers about one pull request (docs/pr-review.md): the head it last reviewed and the findings it published,
 * so a re-run on the same head posts nothing and a new push reviews only the commits since. The daemon keeps it at
 * `<dataDir>/pr-review/<owner>/<repo>/<n>.json` (0600, written atomically); a hosted runner has no data dir to keep, so it reads the
 * same facts back from the hidden markers every review and comment carries.
 */

export const REVIEW_MARKER = /<!-- mendcode:review head=([0-9a-f]{7,64}) -->/
export const FINDING_MARKER = /<!-- mendcode:f=([0-9a-f]{40}) -->/
export const reviewMarker = (head: string) => `<!-- mendcode:review head=${head} -->`
export const findingMarker = (id: string) => `<!-- mendcode:f=${id} -->`

const Published = z.object({ commentId: z.number().int().optional(), threadId: z.string().max(200).optional(), finding: PrFinding.optional(), resolved: z.boolean().optional() })
export const ReviewState = z.object({
  version: z.literal(1),
  lastHead: z.string().max(64).optional(),
  published: z.record(z.string(), Published),
  /** `@mendcode pause`: new pushes are not reviewed until `@mendcode resume`. */
  paused: z.boolean().optional(),
  /** The failing checks a follow-up already explained, so the same failure is explained once. */
  explainedFailures: z.string().max(4000).optional(),
  /** Comment ids a PR command was already answered for. */
  handled: z.array(z.string().max(100)).max(400).optional(),
})
export type ReviewState = z.infer<typeof ReviewState>
export const emptyState = (): ReviewState => ({ version: 1, published: {} })

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** `owner/repo` split and checked, so a state path can never leave the data directory. */
export function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/")
  if (!owner || !name || rest.length || !SEGMENT.test(owner) || !SEGMENT.test(name) || owner.includes("..") || name.includes("..")) throw new Error(`[PR_REVIEW]: invalid repository ${JSON.stringify(repo.slice(0, 120))}`)
  return { owner, name }
}
export const statePath = (dataDir: string, repo: string, number: number) => {
  const { owner, name } = repoParts(repo)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("[PR_REVIEW]: invalid pull request number")
  return path.join(dataDir, "pr-review", owner, name, `${number}.json`)
}

/** The saved state, or an empty one when there is none or it is damaged. */
export function readReviewState(dataDir: string, repo: string, number: number): ReviewState {
  try {
    const parsed = ReviewState.safeParse(JSON.parse(readFileSync(statePath(dataDir, repo, number), "utf8")))
    return parsed.success ? parsed.data : emptyState()
  } catch { return emptyState() }
}

export function writeReviewState(dataDir: string, repo: string, number: number, state: ReviewState) {
  const file = statePath(dataDir, repo, number)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(ReviewState.parse(state)), { mode: 0o600, flag: "wx" })
  renameSync(temp, file)
}

/** The state as GitHub shows it: the newest review's head marker and every finding marker in review comments. */
export function stateFromMarkers({ reviews, comments }: { reviews: ReadonlyArray<{ body?: string | null; submitted_at?: string | null }>; comments: ReadonlyArray<{ id?: number; body?: string | null; path?: string; line?: number | null }> }): ReviewState {
  const heads = reviews.flatMap((review) => { const head = REVIEW_MARKER.exec(review.body ?? "")?.[1]; return head ? [{ head, at: review.submitted_at ?? "" }] : [] })
  const lastHead = heads.sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.head
  const published: ReviewState["published"] = {}
  for (const comment of comments) {
    const id = FINDING_MARKER.exec(comment.body ?? "")?.[1]
    if (id && !published[id]) published[id] = { ...(Number.isSafeInteger(comment.id) ? { commentId: comment.id } : {}) }
  }
  return { version: 1, ...(lastHead ? { lastHead } : {}), published }
}

/**
 * The range a review covers: everything from the merge base on the first review or after a force push, only the commits since
 * the last reviewed head otherwise (`isAncestor` says whether that head is still in the branch).
 */
export function reviewRange({ state, base, head, isAncestor }: { state: ReviewState; base: string; head: string; isAncestor: boolean }): { base: string; head: string; incremental: boolean } | undefined {
  if (state.lastHead === head) return undefined
  return state.lastHead && isAncestor ? { base: state.lastHead, head, incremental: true } : { base, head, incremental: false }
}
