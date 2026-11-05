import type { ReviewProvider } from "./contracts"
import { listAll, type GhCall } from "./publish"
import { reviewMarker } from "./state"

/**
 * Who may post for MendCode on a repository (docs/pr-review.md, "Many reviewers on one repository"). Anyone can run a reviewer
 * against a public repository, so the repository decides on its base branch, in `.mendcode/review.yaml` `publishers`:
 * `maintainers` (the default) posts only from a `gh` login with write access, a list names the logins that may (contributors
 * included), `anyone` lets every reviewer post. A reviewer that may not post keeps its reviews in its own session and answers no
 * `@mendcode` comment, so a crowd of reviewers on one repository never floods it. A modified client can ignore this; GitHub's own
 * controls (interaction limits, blocking) are what stop it.
 *
 * Several reviewers that may post do not post twice: before posting, a reviewer looks for a MendCode review of the same head by
 * another publisher and stands down, and a `@mendcode` comment is answered once (`ANSWERS_MARKER`). Reviews and comments are read
 * page by page (`listAll`): on a busy pull request the earlier answer is often past the first hundred.
 */

export type PublishersRule = "maintainers" | "anyone" | readonly string[]
export type PublishCheck = { ok: true } | { ok: false; reason: string }

/** Marks the reply to one `@mendcode` comment, so a second reviewer does not answer it again. */
export const answersMarker = (commentId: number) => `<!-- mendcode:answers=${commentId} -->`
const ANSWERS = /<!-- mendcode:answers=(\d+) -->/
/** GitHub's author association of a repository owner, organisation member or collaborator. */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

const listed = (rule: readonly string[], login: string) => rule.some((entry) => entry.toLowerCase() === login.toLowerCase())

/** Whether this reviewer's own `gh` login may post to `repo`. Never throws: an unreadable permission is a no. */
export async function mayPublish({ gh, repo, login, rule }: { gh: GhCall; repo: string; login: string | undefined; rule: PublishersRule }): Promise<PublishCheck> {
  if (rule === "anyone") return { ok: true }
  if (!login) return { ok: false, reason: "gh did not say which login this reviewer posts as" }
  if (Array.isArray(rule)) return listed(rule, login) ? { ok: true } : { ok: false, reason: `@${login} is not in publishers of ${repo}'s .mendcode/review.yaml` }
  const done = await gh({ argv: ["api", `repos/${repo}`, "--jq", ".permissions | (.admin or .maintain or .push)"] }).catch(() => undefined)
  return done?.code === 0 && done.out.trim() === "true" ? { ok: true } : { ok: false, reason: `@${login} has no write access to ${repo}, and its .mendcode/review.yaml does not list it in publishers` }
}

/** Whether another reviewer's post counts: a listed login, anyone, or (for `maintainers`) an owner, member or collaborator. */
function counts(rule: PublishersRule, author: { login?: string | undefined; association?: string | undefined; bot?: boolean }) {
  if (author.bot) return true
  if (!author.login) return false
  if (rule === "anyone") return true
  if (Array.isArray(rule)) return listed(rule, author.login)
  return MAINTAINER_ASSOCIATIONS.has(author.association ?? "")
}

/**
 * Whether a submitted review is a review. GitHub wraps every reply in a review thread in a `COMMENTED` review with an empty
 * body (seen live on a pull request: three of them, one per thread an author answered with "Fixed in ..."): those are replies,
 * not a verdict on the head. An approval, a change request, or a comment review with a body is one.
 */
export function isReview({ state, body }: { state?: unknown; body?: unknown }): boolean {
  if (state !== "COMMENTED") return true
  return typeof body === "string" && body.trim().length > 0
}

type Posted = { body?: string | null; user?: { login?: string; type?: string } | null; author_association?: string }
const authorOf = (item: Posted) => ({ login: item.user?.login, association: item.author_association, bot: item.user?.type === "Bot" })

/** A review of a head: who posted it, whether this reviewer's own login did, and when it was submitted (where the forge says). */
export type ReviewedHead = { login: string; id: number; mine?: boolean; at?: string }

/**
 * Whether a review of the head posted by this same login at or after the comment that asked for it already answers that comment.
 * Without both times the request is not taken as answered.
 */
export function answersRequest({ done, asked }: { done: ReviewedHead | undefined; asked: string | undefined }): boolean {
  if (!done?.mine || !done.at || !asked) return false
  const reviewed = Date.parse(done.at)
  const requested = Date.parse(asked)
  return Number.isFinite(reviewed) && Number.isFinite(requested) && reviewed >= requested
}

/**
 * A submitted review of `head` by this login or by a publisher that counts, MendCode's or written by hand: an `@mendcode review`
 * of a head that already has one is answered (seen live: the user's own session reviewed #2, #12 and #15 itself while
 * their requests waited for `/pr publish on`). Undefined when there is none or the reviews cannot be read.
 */
export async function headReviewedBy({ gh, repo, number, head, rule, self }: { gh: GhCall; repo: string; number: number; head: string; rule: PublishersRule; self: string | undefined }): Promise<ReviewedHead | undefined> {
  const reviews = await listAll(gh, `repos/${repo}/pulls/${number}/reviews`)
  if (!reviews) return undefined
  for (const review of reviews as Array<Posted & { id?: number; commit_id?: string; state?: string; submitted_at?: string }>) {
    if (review.commit_id !== head || review.state === "PENDING" || review.state === "DISMISSED" || typeof review.id !== "number" || !isReview(review)) continue
    const author = authorOf(review)
    const mine = !!self && author.login?.toLowerCase() === self.toLowerCase()
    if (mine || counts(rule, author)) return { login: author.login ?? "a bot", id: review.id, mine, ...(review.submitted_at ? { at: review.submitted_at } : {}) }
  }
  return undefined
}

/** The login of another publisher whose MendCode review of `head` is already on the pull request, or undefined. */
export async function reviewedBy({ gh, repo, number, head, rule, self }: { gh: GhCall; repo: string; number: number; head: string; rule: PublishersRule; self: string | undefined }): Promise<string | undefined> {
  const reviews = await listAll(gh, `repos/${repo}/pulls/${number}/reviews`)
  if (!reviews) return undefined
  const marker = reviewMarker(head)
  for (const review of reviews as Posted[]) {
    const author = authorOf(review)
    if (!review.body?.includes(marker) || (self && author.login?.toLowerCase() === self.toLowerCase())) continue
    if (counts(rule, author)) return author.login ?? "a bot"
  }
  return undefined
}

// ── GitLab and Gitea: the same rules through a provider adapter ──────────────────────────────────────────────────────────

/**
 * Whether another reviewer's post counts on a forge without GitHub's author associations: a listed login, anyone, or (for
 * `maintainers`) a login the provider says may write. One permission read per author, cached for the call.
 */
function countsThrough(provider: ReviewProvider, repo: string, rule: PublishersRule) {
  const levels = new Map<string, Promise<boolean>>()
  return (login: string) => {
    if (rule === "anyone") return Promise.resolve(true)
    if (Array.isArray(rule)) return Promise.resolve(listed(rule, login))
    const key = login.toLowerCase()
    let known = levels.get(key)
    if (!known) { known = provider.permission({ repo, login }).then((level) => level === "admin" || level === "write", () => false); levels.set(key, known) }
    return known
  }
}
const sameLogin = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** `mayPublish` on GitLab or Gitea: `maintainers` reads this login's permission from the provider (write or admin). */
export async function mayPublishThrough({ provider, repo, login, rule }: { provider: ReviewProvider; repo: string; login: string | undefined; rule: PublishersRule }): Promise<PublishCheck> {
  if (rule === "anyone") return { ok: true }
  const name = provider.kind === "gitlab" ? "GitLab" : "Gitea"
  if (!login) return { ok: false, reason: `${name} did not say which login this reviewer posts as` }
  if (Array.isArray(rule)) return listed(rule, login) ? { ok: true } : { ok: false, reason: `@${login} is not in publishers of ${repo}'s .mendcode/review.yaml` }
  const level = await provider.permission({ repo, login }).catch(() => "unknown" as const)
  return level === "admin" || level === "write" ? { ok: true } : { ok: false, reason: `@${login} has no write access to ${repo}, and its .mendcode/review.yaml does not list it in publishers` }
}

/** A post on `head` (its commit, or the head marker of a MendCode review) by this login or a publisher that counts; `headReviewedBy`. */
export async function headReviewedThrough({ provider, repo, number, head, rule, self }: { provider: ReviewProvider; repo: string; number: number; head: string; rule: PublishersRule; self: string | undefined }): Promise<{ login: string; id: number } | undefined> {
  const read = await provider.markers?.({ repo, number }).catch(() => undefined)
  if (!read?.ok) return undefined
  const counts = countsThrough(provider, repo, rule)
  for (const post of read.posts) {
    if (post.state === "PENDING" || post.state === "DISMISSED" || post.state === "REQUEST_REVIEW") continue
    if (post.commit !== head && !post.body.includes(reviewMarker(head))) continue
    if (!isReview(post)) continue
    if (sameLogin(post.author, self) || await counts(post.author)) return { login: post.author, id: post.id }
  }
  return undefined
}

/** The login of another publisher whose MendCode review of `head` is already there; `reviewedBy`. */
export async function reviewedThrough({ provider, repo, number, head, rule, self }: { provider: ReviewProvider; repo: string; number: number; head: string; rule: PublishersRule; self: string | undefined }): Promise<string | undefined> {
  const read = await provider.markers?.({ repo, number }).catch(() => undefined)
  if (!read?.ok) return undefined
  const counts = countsThrough(provider, repo, rule)
  for (const post of read.posts) {
    if (!post.body.includes(reviewMarker(head)) || sameLogin(post.author, self)) continue
    if (await counts(post.author)) return post.author
  }
  return undefined
}

/** The login of a publisher that already answered `commentId` (`self` when it was this login); `answeredBy`. */
export async function answeredThrough({ provider, repo, number, commentId, rule, self }: { provider: ReviewProvider; repo: string; number: number; commentId: number; rule: PublishersRule; self: string | undefined }): Promise<string | undefined> {
  const read = await provider.comments?.({ repo, number }).catch(() => undefined)
  if (!read?.ok) return undefined
  const counts = countsThrough(provider, repo, rule)
  for (const comment of read.comments) {
    if (Number(ANSWERS.exec(comment.body)?.[1]) !== commentId) continue
    if (sameLogin(comment.author, self)) return self
    if (await counts(comment.author)) return comment.author
  }
  return undefined
}

/** The login of a publisher that already answered `commentId` (its reply carries `answersMarker`): `self` when it was this login, else undefined. */
export async function answeredBy({ gh, repo, number, commentId, rule, self }: { gh: GhCall; repo: string; number: number; commentId: number; rule: PublishersRule; self: string | undefined }): Promise<string | undefined> {
  for (const endpoint of [`repos/${repo}/issues/${number}/comments`, `repos/${repo}/pulls/${number}/comments`]) {
    const items = await listAll(gh, endpoint)
    if (!items) continue
    for (const item of items as Posted[]) {
      const author = authorOf(item)
      if (Number(ANSWERS.exec(item.body ?? "")?.[1]) !== commentId) continue
      if (self && author.login?.toLowerCase() === self.toLowerCase()) return self
      if (counts(rule, author)) return author.login ?? "a bot"
    }
  }
  return undefined
}
