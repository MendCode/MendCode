import { z } from "zod"
import type { GitRun } from "./context"
import { DEFAULT_REVIEWER, reviewerFromBody, reviewerMarker, type GhCall } from "./publish"
import { FULL_REVIEW_MARKER, RANGE_REVIEW_MARKER, REVIEW_MARKER } from "./state"

const Sha = z.string().regex(/^[0-9a-f]{40,64}$/)
const Pull = z.object({ number: z.number().int().positive(), merged_at: z.string().nullable(), merge_commit_sha: Sha.nullable(), head: z.object({ sha: Sha }), base: z.object({ sha: Sha }) })
const Review = z.object({ body: z.string().nullable(), state: z.string(), commit_id: z.string().nullable(), submitted_at: z.string().nullable(), user: z.object({ login: z.string() }).nullable() })

/** Two pages at most, never GitHub's unbounded --paginate. Failed reads prove no coverage. */
async function page(gh: GhCall, endpoint: string): Promise<unknown[] | undefined> {
  try {
    const done = await gh({ argv: ["api", endpoint] })
    const value: unknown = done.code === 0 ? JSON.parse(done.out) : undefined
    return Array.isArray(value) && value.length <= 100 ? value : undefined
  } catch { return undefined }
}

/**
 * A contiguous prefix of reviewed trees, not merely the newest reviewed merge: a direct push, an
 * unreviewed PR or merge-only edits must stay in the diff. Loaded only when a GitHub review chooses
 * its range. Accounting records calls, not completion; the published head + reviewer markers are
 * completion evidence only with a full-review base, restricted to the reviewer's account as in findReviewMarker.
 */
export async function alreadyReviewed({ gh, git, directory, repo, number, base, head, reviewer = DEFAULT_REVIEWER, self }: {
  gh: GhCall; git: GitRun; directory: string; repo: string; number: number; base: string; head: string; reviewer?: string | undefined; self?: string | undefined
}): Promise<{ base: string; prs: number[] } | undefined> {
  try {
    const chain = await git(["rev-list", "--first-parent", "--reverse", `${base}..${head}`], directory, 128 * 1024)
    if (chain.code !== 0 || chain.cut || !chain.out.trim()) return undefined
    const commits = chain.out.trim().split("\n")
    if (![base, head, ...commits].every((sha) => Sha.safeParse(sha).success)) return undefined
    const inRange = new Set(commits)
    const pulls = new Map<string, z.infer<typeof Pull>>()
    for (let n = 1; n <= 2; n++) {
      const list = await page(gh, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${n}`)
      if (!list) return undefined
      for (const item of list) {
        const parsed = Pull.safeParse(item)
        if (!parsed.success) continue
        const pr = parsed.data
        if (pr.number !== number && pr.merged_at && pr.merge_commit_sha && inRange.has(pr.merge_commit_sha)) pulls.set(pr.merge_commit_sha, pr)
      }
      if (list.length < 100) break
    }
    if (!pulls.size) return undefined
    if (!self) {
      const done = await gh({ argv: ["api", "user"] })
      const user = done.code === 0 ? z.object({ login: z.string().min(1) }).safeParse(JSON.parse(done.out)) : undefined
      if (!user?.success) return undefined
      self = user.data.login
    }
    const identity = reviewerFromBody(reviewerMarker({ reviewer, configKey: "", key: "" }))!.reviewer
    // At most one merge-base per candidate in the bounded PR lookup, never per history commit.
    const starts = new Map<string, string>()
    for (const [commit, pr] of pulls) {
      if (pr.head.sha === commit) continue
      const start = await git(["merge-base", `${commit}^1`, pr.head.sha], directory, 128)
      if (start.code === 0 && !start.cut && Sha.safeParse(start.out.trim()).success) starts.set(commit, start.out.trim())
    }
    const refs = [...new Set([base, ...commits, ...starts.values(), ...[...pulls.values()].map((pr) => pr.head.sha)])]
    const resolved = await git(["rev-parse", ...refs.map((ref) => `${ref}^{tree}`)], directory, refs.length * 65 + 1)
    const values = resolved.out.trim().split("\n")
    if (resolved.code !== 0 || resolved.cut || values.length !== refs.length || !values.every((sha) => Sha.safeParse(sha).success)) return undefined
    const trees = new Map(refs.map((ref, i) => [ref, values[i]!]))
    let cursorTree = trees.get(base)
    if (!cursorTree) return undefined
    let baseline: string | undefined
    const prs: number[] = []
    // Commits since the covered prefix that no merged PR has claimed yet: a fast-forward merge brings the PR's own commits.
    let pending: string[] = []
    for (const commit of commits) {
      const mergedTree = trees.get(commit)
      if (!mergedTree) break
      if (mergedTree === cursorTree && !pending.length) continue
      const pr = pulls.get(commit)
      if (!pr) { pending.push(commit); continue }
      if (pr.head.sha === commit) {
        // Fast-forward: the commits since the covered prefix must be exactly the PR's own, so no direct push hides among them.
        const own = await page(gh, `repos/${repo}/pulls/${pr.number}/commits?per_page=100`)
        const shas = own?.flatMap((item) => { const parsed = z.object({ sha: Sha }).safeParse(item); return parsed.success ? [parsed.data.sha] : [] })
        if (!shas || shas.length >= 100 || shas.join(" ") !== [...pending, commit].join(" ")) break
      } else {
        // A merge commit: the PR's reviewed diff must start at the prefix we have already covered, not after a gap.
        if (pending.length) break
        const start = starts.get(commit)
        if (!start || trees.get(start) !== cursorTree) break
      }
      const reviews: z.infer<typeof Review>[] = []
      let complete = false
      for (let n = 1; n <= 2; n++) {
        const list = await page(gh, `repos/${repo}/pulls/${pr.number}/reviews?per_page=100&page=${n}`)
        if (!list) break
        const parsed = z.array(Review).safeParse(list)
        if (!parsed.success) break
        reviews.push(...parsed.data)
        if (list.length < 100) { complete = true; break }
      }
      // A full second page cannot prove which review was last. Partial reviews have no head marker.
      if (!complete) break
      const ordered = reviews.filter((review) => review.state !== "PENDING" && review.submitted_at && review.user?.login.toLowerCase() === self!.toLowerCase()
        && reviewerFromBody(review.body)?.reviewer === identity).sort((a, b) => a.submitted_at!.localeCompare(b.submitted_at!))
      const last = ordered.at(-1)
      if (!last || last.commit_id !== pr.head.sha || REVIEW_MARKER.exec(last.body ?? "")?.[1] !== pr.head.sha) break
      let coveredHead: string | undefined
      for (const review of ordered) {
        const reviewedHead = REVIEW_MARKER.exec(review.body ?? "")?.[1]
        if (!reviewedHead || review.commit_id !== reviewedHead) { coveredHead = undefined; continue }
        const fullBase = FULL_REVIEW_MARKER.exec(review.body ?? "")?.[1]
        if (fullBase) {
          let tree = trees.get(fullBase)
          if (!tree) {
            const resolvedBase = await git(["rev-parse", `${fullBase}^{tree}`], directory, 128)
            if (resolvedBase.code === 0 && !resolvedBase.cut && Sha.safeParse(resolvedBase.out.trim()).success) tree = resolvedBase.out.trim()
          }
          coveredHead = tree === cursorTree ? reviewedHead : undefined
        } else if (RANGE_REVIEW_MARKER.exec(review.body ?? "")?.[1] === coveredHead && coveredHead) coveredHead = reviewedHead
        else coveredHead = undefined
      }
      if (coveredHead !== pr.head.sha) break
      const reviewedTree = trees.get(pr.head.sha)
      if (!reviewedTree) break
      if (mergedTree === reviewedTree) {
        // Also handles squash merges: use the equivalent tree on the first-parent chain.
        baseline = commit
        cursorTree = mergedTree
        pending = []
        prs.push(pr.number)
      } else {
        // A merge resolution was not reviewed: leave it (and everything after it) in the remainder.
        if ((await git(["merge-base", "--is-ancestor", pr.head.sha, head], directory, 128)).code === 0) {
          baseline = pr.head.sha
          prs.push(pr.number)
        }
        break
      }
    }
    return baseline ? { base: baseline, prs } : undefined
  } catch { return undefined }
}
