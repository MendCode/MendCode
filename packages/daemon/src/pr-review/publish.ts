import { createHash } from "node:crypto"
import type { PrFinding, PrReviewResult } from "@mendcode/protocol"
import { parseUnifiedDiff } from "./context"
import { effectKey, type EffectLedger, type ReviewProvider } from "./contracts"
import type { ReviewState } from "./state"
import { commentBody, reviewBody, type ReviewInfo, type ReviewTemplate } from "./template"

export { agentPrompt, commentBody, findingFromComment, reviewBody, reviewEffort, type ReviewInfo } from "./template"

/**
 * Publishing a review on GitHub (docs/pr-review.md): one `POST /pulls/{n}/reviews` with event COMMENT (never REQUEST_CHANGES), the
 * summary as its body and one inline comment per new finding, a ```suggestion block where the fix stays on the commented lines.
 * Every review and comment carries a hidden marker, so a finding already published is never posted again and a hosted runner
 * can rebuild the state from GitHub. A comment GitHub refuses (422: the line is not in its diff) moves into the summary and the
 * same single request is sent once more; any other failure posts nothing and the findings stay in the session.
 *
 * Idempotency (R03, "Seguridad operativa"): a review is one remote effect keyed by reviewer, config version, head, base and the
 * findings it carries (`effectKey`), and its body carries that key's hash in a reviewer marker (`reviewerMarker`). With an
 * `EffectLedger` the intent is recorded before the POST; a key already `done` is never sent again, and a key left `pending` (the
 * daemon died, or GitHub did not answer) is first looked up on the pull request. A failure that may still have gone through (a
 * timeout, a 5xx, gh killed, an exit with no clear 4xx) is reconciled the same way, by reading the PR's reviews for the marker,
 * and is never retried in the same call: GitHub may still be applying it. When the reviews cannot be read nothing is sent.
 * There is no exactly-once claim: two daemons without a shared ledger can still both post (ownership.ts keeps them apart).
 *
 * A head that moved during the review (`isCurrent` answers false) is never published: stale findings name lines that may no
 * longer exist, and the newer head gets its own review.
 */

/** `gh` with an argument array (no shell); `stdin` is the request body for `--input -`. */
export type GhCall = (input: { argv: string[]; stdin?: string }) => Promise<{ code: number; out: string; err?: string }>

export type PublishReport = {
  posted: boolean
  reviewId?: number
  comments: number
  movedToBody: number
  resolved: number
  state: ReviewState
  reason?: string
  /** The head moved: nothing was written. */
  stale?: boolean
  /** The same review was already on the pull request (ledger `done`, or its marker found): nothing was sent this time. */
  duplicate?: boolean
  /** The outcome of the POST is unknown and its marker could not be confirmed: the effect stays pending for the next attempt. */
  uncertain?: boolean
}

type Sent = { code: number; out: string; err?: string }
/** A line-anchored item GitHub may refuse to place inline (a finding, a provider comment). */
export type InlineItem = { path: string; line: number; endLine?: number | undefined }

// ── Markers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The reviewer marker: who posted, with which config version, and the hash of the effect's key. */
export const REVIEWER_MARKER = /<!-- mendcode:reviewer=(\S{1,120}) config=(\S{1,120}) effect=([0-9a-f]{16}) -->/
/** A marker value never closes the comment or breaks the pattern: anything but a small safe set becomes `_`. */
const markerSafe = (value: string) => value.replace(/[^A-Za-z0-9._:@/+-]/g, "_").replace(/--+/g, "-").slice(0, 120) || "_"
/** The first 16 hex characters of the key's SHA-256: unique enough per PR, and nothing of the key is readable from it. */
export const effectHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16)
export const reviewerMarker = ({ reviewer, configKey, key }: { reviewer: string; configKey: string; key: string }) => `<!-- mendcode:reviewer=${markerSafe(reviewer)} config=${markerSafe(configKey)} effect=${effectHash(key)} -->`
/** The reviewer marker a review body carries, or undefined (a human review, or one from before reviewer markers). */
export function reviewerFromBody(body: string | null | undefined): { reviewer: string; configKey: string; effect: string } | undefined {
  const match = REVIEWER_MARKER.exec(body ?? "")
  return match ? { reviewer: match[1]!, configKey: match[2]!, effect: match[3]! } : undefined
}
/** The reviewer a review is for when the caller names none: the repository's own. */
export const DEFAULT_REVIEWER = "global"
/** The config version when the caller names none (an older caller, the hosted runner). */
export const UNKNOWN_CONFIG = "unversioned"

// ── gh helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const reviewComment = (finding: PrFinding) => ({
  path: finding.path, side: "RIGHT", body: commentBody(finding),
  ...(finding.endLine && finding.endLine > finding.line ? { start_line: finding.line, start_side: "RIGHT", line: finding.endLine } : { line: finding.line }),
})

const failureText = (result: Sent) => `${result.err ?? ""}\n${result.out}`
const unprocessable = (result: Sent) => /HTTP 422|Validation Failed|Unprocessable/i.test(failureText(result))
/** Bun's spawn error for a missing `gh` ("Executable not found in $PATH"), Go's and the shell's. */
const MISSING_GH = /executable (file )?not found|ENOENT|No such file or directory|command not found/i
/**
 * How a failed write reads: `unprocessable` (422, nothing applied), `refused` (another 4xx, gh missing or logged out: nothing
 * applied), or `uncertain` (a timeout, a 5xx, a killed or crashed gh, an exit with no status: it may have gone through).
 */
export function failureOf(result: Sent): "unprocessable" | "refused" | "uncertain" {
  if (unprocessable(result)) return "unprocessable"
  const text = failureText(result)
  const status = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? /"status"\s*:\s*"(\d{3})"/.exec(text)?.[1])
  if (status >= 400 && status < 500) return "refused"
  if (status >= 500) return "uncertain"
  if (result.code === 127 && MISSING_GH.test(text)) return "refused"
  if (/Bad credentials|gh auth login|not logged in|Resource not accessible/i.test(text)) return "refused"
  return "uncertain"
}
/** Whether a refused write is worth sending again later: a rate limit, a secondary rate limit, a 5xx or an unknown outcome. */
export const retryableFailure = (result: Sent) => failureOf(result) === "uncertain" || /HTTP 429|rate limit/i.test(failureText(result))
const firstLine = (result: Sent) => (result.err || result.out).split("\n").find((line) => line.trim())?.slice(0, 200) || `exit ${result.code}`

async function api(gh: GhCall, endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<Sent> {
  return gh({ argv: ["api", endpoint, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], ...(body === undefined ? {} : { stdin: JSON.stringify(body) }) })
    .catch((error: unknown) => ({ code: -1, out: "", err: error instanceof Error ? error.message : String(error) }))
}
const json = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

export const PAGE_SIZE = 100
/** At most this many pages of a list (3,000 items): a pull request with more reviews than that is read in part. */
export const MAX_PAGES = 30
/**
 * Every item of a list endpoint, page by page (`page` 2 onwards only while a page comes back full), or undefined when a page
 * cannot be read: a partial list must never read as "the marker is not there".
 */
export async function listAll(gh: GhCall, endpoint: string, maxPages = MAX_PAGES): Promise<unknown[] | undefined> {
  const items: unknown[] = []
  for (let page = 1; page <= maxPages; page++) {
    const done = await gh({ argv: ["api", `${endpoint}?per_page=${PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`] }).catch(() => undefined)
    const list = done?.code === 0 ? json(done.out) : undefined
    if (!Array.isArray(list)) return undefined
    items.push(...list)
    if (list.length < PAGE_SIZE) return items
  }
  return items
}

/**
 * Whether a submitted review carrying `marker` is on the pull request (a dismissed one counts: it was posted). `self` restricts it
 * to reviews by that login, so a marker pasted into someone else's review cannot silence MendCode.
 */
export async function findReviewMarker({ gh, repo, number, marker, self }: { gh: GhCall; repo: string; number: number; marker: string; self?: string | undefined }): Promise<{ readable: false } | { readable: true; found: false } | { readable: true; found: true; reviewId?: number }> {
  const reviews = await listAll(gh, `repos/${repo}/pulls/${number}/reviews`)
  if (!reviews) return { readable: false }
  for (const review of reviews as Array<{ id?: unknown; body?: unknown; user?: { login?: unknown } | null; state?: unknown }>) {
    if (typeof review.body !== "string" || !review.body.includes(marker) || review.state === "PENDING") continue
    if (self && (typeof review.user?.login !== "string" || review.user.login.toLowerCase() !== self.toLowerCase())) continue
    return { readable: true, found: true, ...(typeof review.id === "number" ? { reviewId: review.id } : {}) }
  }
  return { readable: true, found: false }
}

/** RIGHT-side lines per file as GitHub's own diff of the PR shows them, to tell which comment a 422 was about. */
async function githubLines(gh: GhCall, repo: string, number: number): Promise<Map<string, Set<number>> | undefined> {
  const files = await listAll(gh, `repos/${repo}/pulls/${number}/files`)
  if (!files) return undefined
  const lines = new Map<string, Set<number>>()
  for (const file of files as Array<{ filename?: unknown; patch?: unknown }>) {
    if (typeof file.filename !== "string" || typeof file.patch !== "string") continue
    lines.set(file.filename, parseUnifiedDiff(`diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`)[0]?.right ?? new Set())
  }
  return lines
}

// ── The idempotent post ──────────────────────────────────────────────────────────────────────────────────────────────────

export type CurrentCheck = () => boolean | Promise<boolean>
export type PostOutcome<T> =
  | { outcome: "posted"; reviewId?: number; inline: T[]; moved: T[] }
  /** The same effect was already on the pull request: nothing sent now. */
  | { outcome: "duplicate"; reviewId?: number; reason: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "refused"; reason: string; retryable: boolean }
  | { outcome: "uncertain"; reason: string }

const STALE = "the head moved since this review; nothing was posted (the new head is reviewed on its own)"
/** Whether the head moved; a check that cannot answer (it throws) counts as moved: publishing is the irreversible side. */
async function isStale(isCurrent: CurrentCheck | undefined) {
  if (!isCurrent) return false
  try { return !(await isCurrent()) } catch { return true }
}

/**
 * One review POST made idempotent: ledger first, then the remote marker, then the request, then a reconciliation when its
 * outcome is unknown. `render` builds the body and comments from the items GitHub takes inline and the ones moved to the body
 * (after a 422); the body must carry `marker`. `precheck` reads the marker on the PR before sending even without a pending
 * effect (the provider adapter, which has no ledger).
 */
export async function postReviewOnce<T extends InlineItem>({ gh, repo, number, head, items, render, marker, key, effects, jobId, isCurrent, precheck = false, self }: {
  gh: GhCall; repo: string; number: number; head: string; items: readonly T[]
  render: (inline: readonly T[], moved: readonly T[]) => { body: string; comments: unknown[] }
  marker: string; key: string; effects?: EffectLedger | undefined; jobId?: string | undefined; isCurrent?: CurrentCheck | undefined; precheck?: boolean; self?: string | undefined
}): Promise<PostOutcome<T>> {
  const lookup = () => findReviewMarker({ gh, repo, number, marker, ...(self ? { self } : {}) })
  const earlier = effects?.byKey(key)
  if (earlier?.state === "done") return { outcome: "duplicate", ...(earlier.remote && /^\d+$/.test(earlier.remote) ? { reviewId: Number(earlier.remote) } : {}), reason: "already posted" }
  if (earlier?.state === "pending" || precheck) {
    const found = await lookup()
    if (!found.readable) return { outcome: "uncertain", reason: "an earlier attempt may have posted this review and the pull request's reviews could not be read; nothing was sent" }
    if (found.found) {
      if (earlier?.state === "pending") effects!.done(earlier.id, found.reviewId === undefined ? undefined : String(found.reviewId))
      return { outcome: "duplicate", ...(found.reviewId === undefined ? {} : { reviewId: found.reviewId }), reason: "already posted (its marker is on the pull request)" }
    }
  }
  if (await isStale(isCurrent)) return { outcome: "stale", reason: STALE }
  const effect = effects?.intend({ kind: "review", key, marker, ...(jobId ? { jobId } : {}) })
  if (effect?.state === "done") return { outcome: "duplicate", reason: "already posted" }
  let inline = [...items]
  let moved: T[] = []
  const send = () => { const { body, comments } = render(inline, moved); return api(gh, `repos/${repo}/pulls/${number}/reviews`, { commit_id: head, event: "COMMENT", body: body.includes(marker) ? body : `${body}\n\n${marker}`, comments }) }
  let done = await send()
  if (done.code !== 0 && failureOf(done) === "unprocessable" && inline.length) {
    // GitHub names no comment in a 422: its own diff of the PR says which lines it takes.
    const lines = await githubLines(gh, repo, number)
    const fits = (item: T) => { const right = lines?.get(item.path); if (!right) return false; for (let line = item.line; line <= (item.endLine ?? item.line); line++) if (!right.has(line)) return false; return true }
    moved = inline.filter((item) => !fits(item))
    inline = inline.filter(fits)
    if (!moved.length) { moved = inline; inline = [] }
    if (await isStale(isCurrent)) { if (effect) effects!.abandon(effect.id, "stale"); return { outcome: "stale", reason: STALE } }
    done = await send()
  }
  if (done.code === 0) {
    const review = json(done.out) as { id?: unknown } | undefined
    const reviewId = typeof review?.id === "number" ? review.id : undefined
    if (effect) effects!.done(effect.id, reviewId === undefined ? undefined : String(reviewId))
    return { outcome: "posted", ...(reviewId === undefined ? {} : { reviewId }), inline, moved }
  }
  const failure = failureOf(done)
  if (failure !== "uncertain") {
    const reason = `GitHub refused the review (${firstLine(done)}); nothing was posted`
    if (effect) effects!.abandon(effect.id, reason)
    return { outcome: "refused", reason, retryable: retryableFailure(done) }
  }
  // The request may have been applied: look for it before anything else; never resend it in this call.
  const found = await lookup()
  if (found.readable && found.found) {
    if (effect) effects!.done(effect.id, found.reviewId === undefined ? undefined : String(found.reviewId))
    return { outcome: "posted", ...(found.reviewId === undefined ? {} : { reviewId: found.reviewId }), inline, moved }
  }
  return { outcome: "uncertain", reason: `GitHub did not confirm the review (${firstLine(done)}) and ${found.readable ? "it is not on the pull request yet" : "the pull request's reviews could not be read"}; it is checked again before the next attempt` }
}

// ── publishReview ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Publishes `result` on pull request `number` of `repo` and returns the new state. Findings already in `previous.published` are
 * skipped; with nothing new on an unchanged head nothing is posted. `resolve` names previously published findings the new head
 * fixed: their threads are resolved after the review is posted. `effects`, `reviewer` and `configKey` make the post idempotent
 * across crashes and timeouts; `isCurrent` refuses a stale head; `self` is the login this reviewer posts as (marker lookups
 * then count only its own reviews). `template` and `sections` go to the body's renderer as they are (`renderReviewBody`).
 */
export async function publishReview({ repo, number, result, previous, process: gh, resolve = [], info, effects, reviewer = DEFAULT_REVIEWER, configKey = UNKNOWN_CONFIG, isCurrent, jobId, self, template, sections }: {
  repo: string; number: number; result: PrReviewResult; previous: ReviewState; process: GhCall; resolve?: readonly string[]; info?: ReviewInfo
  effects?: EffectLedger | undefined; reviewer?: string; configKey?: string; isCurrent?: CurrentCheck | undefined; jobId?: string | undefined; self?: string | undefined
  template?: ReviewTemplate | undefined; sections?: Readonly<Record<string, string>> | undefined
}): Promise<PublishReport> {
  const fresh = result.findings.filter((finding) => !previous.published[finding.id])
  const partial = info?.partial
  // A partial review is not a review of the head: the state keeps the last head that was whole, so the next `/pr review` is not answered as "already reviewed".
  const state: ReviewState = { ...previous, published: { ...previous.published }, ...(partial ? {} : { lastHead: result.head }) }
  // A later head (or the same one asked again) with nothing new posts no second notification; it only closes the threads it fixed.
  if (!fresh.length && previous.lastHead && !partial) {
    const same = previous.lastHead === result.head
    if (same && !resolve.length) return { posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason: "this head was already reviewed and nothing is new" }
    if (await isStale(isCurrent)) return { posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason: STALE, stale: true }
    const resolved = await resolveThreads({ gh, repo, number, ids: resolve, state, head: result.head })
    return { posted: false, comments: 0, movedToBody: 0, resolved, state, reason: same ? "this head was already reviewed and nothing is new" : "no new findings on this head" }
  }
  const key = effectKey({ kind: "review", repo, number, reviewer, configKey, head: result.head, base: result.base, payload: `${fresh.map((finding) => finding.id).sort().join(",")}${partial ? `;partial ${partial.reviewed.length}/${partial.notReviewed.length}/${partial.unverified}` : ""}` })
  const marker = reviewerMarker({ reviewer, configKey, key })
  const posted = await postReviewOnce({
    gh, repo, number, head: result.head, items: fresh, marker, key, effects, jobId, isCurrent, self,
    render: (inline, moved) => ({ body: `${reviewBody({ result, inline: inline.length, moved, repo, ...(info ? { info } : {}), ...(template ? { template } : {}), ...(sections ? { sections } : {}), ...(state.language ? { language: state.language } : {}) })}\n\n${marker}`, comments: inline.map(reviewComment) }),
  })
  const failed = (reason: string, flags: Partial<PublishReport>) => ({ posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason, ...flags })
  if (posted.outcome === "stale") return failed(posted.reason, { stale: true })
  if (posted.outcome === "refused") return failed(posted.reason, {})
  if (posted.outcome === "uncertain") return failed(posted.reason, { uncertain: true })
  for (const finding of fresh) state.published[finding.id] = { finding }
  const reviewId = posted.reviewId
  if (reviewId !== undefined) await recordCommentIds({ gh, repo, number, reviewId, state })
  const resolved = await resolveThreads({ gh, repo, number, ids: resolve, state, head: result.head })
  if (posted.outcome === "duplicate") return { posted: false, duplicate: true, ...(reviewId !== undefined ? { reviewId } : {}), comments: 0, movedToBody: 0, resolved, state, reason: posted.reason }
  return { posted: true, ...(reviewId !== undefined ? { reviewId } : {}), comments: posted.inline.length, movedToBody: posted.moved.length, resolved, state }
}

/** The inline comment ids of review `reviewId`, by the finding marker each carries, into `state`. */
async function recordCommentIds({ gh, repo, number, reviewId, state }: { gh: GhCall; repo: string; number: number; reviewId: number; state: ReviewState }) {
  const comments = await listAll(gh, `repos/${repo}/pulls/${number}/reviews/${reviewId}/comments`)
  for (const comment of (comments ?? []) as Array<{ id?: unknown; body?: unknown }>) {
    const id = typeof comment.body === "string" ? /<!-- mendcode:f=([0-9a-f]{40}) -->/.exec(comment.body)?.[1] : undefined
    if (id && state.published[id] && typeof comment.id === "number") state.published[id] = { ...state.published[id], commentId: comment.id }
  }
}

/** The marker of the reply that says a finding is fixed where its thread could not be resolved. */
export const fixedMarker = (id: string) => `<!-- mendcode:fixed=${id} -->`

/**
 * Review threads whose first comment carries a finding marker, by finding id (GraphQL: REST has no thread ids). `replied`: the
 * thread already holds the reply saying the finding is fixed.
 */
async function threadsByFinding(gh: GhCall, repo: string, number: number): Promise<Map<string, { id: string; resolved: boolean; replied: boolean }>> {
  const [owner, name] = repo.split("/")
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{body}} replies:comments(last:20){nodes{body}}}}}}}"
  const done = await gh({ argv: ["api", "graphql", "--input", "-"], stdin: JSON.stringify({ query, variables: { owner, name, number } }) }).catch(() => ({ code: -1, out: "" }))
  const nodes = (json(done.out) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } } } | undefined)?.data?.repository?.pullRequest?.reviewThreads?.nodes
  const threads = new Map<string, { id: string; resolved: boolean; replied: boolean }>()
  if (done.code !== 0 || !Array.isArray(nodes)) return threads
  type Bodies = { nodes?: Array<{ body?: unknown }> }
  for (const node of nodes as Array<{ id?: unknown; isResolved?: unknown; comments?: Bodies; replies?: Bodies }>) {
    const body = node.comments?.nodes?.[0]?.body
    const id = typeof body === "string" ? /<!-- mendcode:f=([0-9a-f]{40}) -->/.exec(body)?.[1] : undefined
    const replied = !!id && (node.replies?.nodes ?? []).some((reply) => typeof reply.body === "string" && reply.body.includes(fixedMarker(id)))
    if (id && typeof node.id === "string") threads.set(id, { id: node.id, resolved: node.isResolved === true, replied })
  }
  return threads
}

/**
 * Resolves the threads of `ids` that are still open and records it in `state`; returns how many it closed. Resolving twice is
 * harmless. GitHub lets only writers and the PR author resolve a thread: where it refuses (seen live: a publisher with read access to
 * the repository), one reply in the thread says the finding is fixed at `head`, so the author sees it; the marker keeps it to one.
 */
async function resolveThreads({ gh, repo, number, ids, state, head }: { gh: GhCall; repo: string; number: number; ids: readonly string[]; state: ReviewState; head: string }) {
  const open = ids.filter((id) => state.published[id] && !state.published[id]!.resolved)
  if (!open.length) return 0
  const threads = await threadsByFinding(gh, repo, number)
  let resolved = 0
  for (const id of open) {
    const thread = threads.get(id)
    if (!thread) continue
    if (!thread.resolved) {
      const answer = await resolveThread(gh, thread.id)
      if (answer.code !== 0 && !thread.replied && !await replyFixed({ gh, repo, number, id, commentId: state.published[id]!.commentId, head })) continue
      resolved++
    }
    state.published[id] = { ...state.published[id], threadId: thread.id, resolved: true }
  }
  return resolved
}

const resolveThread = (gh: GhCall, thread: string) =>
  gh({ argv: ["api", "graphql", "--input", "-"], stdin: JSON.stringify({ query: "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}", variables: { thread } }) }).catch(() => ({ code: -1, out: "" }))

/**
 * `@mendcode resolve`: closes the open threads of MendCode's own findings that the last review marked fixed, those with its
 * "Fixed in" reply (left where the reviewing account could not resolve) or recorded resolved in `state`. A thread of a finding
 * still open, or one a person wrote, is never touched. `failed`: threads GitHub refused to resolve for this account.
 */
export async function resolveFixedThreads({ gh, repo, number, state }: { gh: GhCall; repo: string; number: number; state: ReviewState }): Promise<{ resolved: number; failed: number; state: ReviewState }> {
  const threads = await threadsByFinding(gh, repo, number)
  const next: ReviewState = { ...state, published: { ...state.published } }
  let resolved = 0, failed = 0
  for (const [id, thread] of threads) {
    if (thread.resolved || !(thread.replied || state.published[id]?.resolved)) continue
    if ((await resolveThread(gh, thread.id)).code === 0) { resolved++; if (next.published[id]) next.published[id] = { ...next.published[id], threadId: thread.id, resolved: true } } else failed++
  }
  return { resolved, failed, state: resolved ? next : state }
}

/** `resolveFixedThreads` through a provider adapter: the threads its finding markers name that the state records as fixed. */
export async function resolveFixedThroughProvider({ provider, repo, number, state }: { provider: ReviewProvider; repo: string; number: number; state: ReviewState }): Promise<{ resolved: number; failed: number; state: ReviewState }> {
  if (!provider.capabilities.resolveThreads || !provider.threads || !provider.resolve) return { resolved: 0, failed: 0, state }
  const next: ReviewState = { ...state, published: { ...state.published } }
  let resolved = 0, failed = 0
  for (const thread of await provider.threads({ repo, number }).catch(() => undefined) ?? []) {
    const id = /<!-- mendcode:f=([0-9a-f]{40}) -->/.exec(thread.body)?.[1]
    if (!id || thread.resolved || !state.published[id]?.resolved) continue
    if (await provider.resolve({ repo, number, discussion: thread.id }).catch(() => false)) { resolved++; next.published[id] = { ...next.published[id], threadId: thread.id, resolved: true } } else failed++
  }
  return { resolved, failed, state: resolved ? next : state }
}

/** One reply under a finding's inline comment: the finding is fixed at `head`. False when it could not be posted. */
async function replyFixed({ gh, repo, number, id, commentId, head }: { gh: GhCall; repo: string; number: number; id: string; commentId: number | undefined; head: string }) {
  if (commentId === undefined) return false
  const body = `Fixed in \`${head.slice(0, 12)}\`: MendCode's re-check of this head no longer finds this defect. This account cannot resolve the thread; the author or a maintainer can.\n\n${fixedMarker(id)}`
  const done = await gh({ argv: ["api", `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) }).catch(() => ({ code: -1, out: "" }))
  return done.code === 0
}

// ── GitLab and Gitea: the same review through a provider adapter ─────────────────────────────────────────────────────────

/**
 * `publishReview` for a forge whose adapter posts the review itself (GitLab: one summary note and a diff discussion per comment;
 * Gitea: one COMMENT review). The same effect key, reviewer marker, ledger order and stale guard as on GitHub: a key already
 * `done` is never sent again, the intent is recorded before the post, and the adapter looks for the marker on the pull request
 * before it posts (so a pending effect after a crash is reconciled there). A post whose outcome the adapter cannot tell leaves the
 * effect pending (`uncertain`); a refusal abandons it. Findings link to nothing (the body's links are GitHub's) and threads are
 * resolved only where the adapter can (`capabilities.resolveThreads`).
 */
export async function publishThroughProvider({ provider, repo, number, result, previous, resolve = [], info, effects, reviewer = DEFAULT_REVIEWER, configKey = UNKNOWN_CONFIG, isCurrent, jobId, template, sections }: {
  provider: ReviewProvider; repo: string; number: number; result: PrReviewResult; previous: ReviewState; resolve?: readonly string[]; info?: ReviewInfo
  effects?: EffectLedger | undefined; reviewer?: string; configKey?: string; isCurrent?: CurrentCheck | undefined; jobId?: string | undefined
  template?: ReviewTemplate | undefined; sections?: Readonly<Record<string, string>> | undefined
}): Promise<PublishReport> {
  const fresh = result.findings.filter((finding) => !previous.published[finding.id])
  const partial = info?.partial
  // A partial review is not a review of the head: the state keeps the last head that was whole, so the next `/pr review` is not answered as "already reviewed".
  const state: ReviewState = { ...previous, published: { ...previous.published }, ...(partial ? {} : { lastHead: result.head }) }
  const name = provider.kind === "gitlab" ? "GitLab" : provider.kind === "gitea" ? "Gitea" : "GitHub"
  if (!fresh.length && previous.lastHead && !partial) {
    const same = previous.lastHead === result.head
    if (same && !resolve.length) return { posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason: "this head was already reviewed and nothing is new" }
    if (await isStale(isCurrent)) return { posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason: STALE, stale: true }
    const resolved = await resolveThroughProvider({ provider, repo, number, ids: resolve, state })
    return { posted: false, comments: 0, movedToBody: 0, resolved, state, reason: same ? "this head was already reviewed and nothing is new" : "no new findings on this head" }
  }
  const key = effectKey({ kind: "review", repo, number, reviewer, configKey, head: result.head, base: result.base, payload: `${fresh.map((finding) => finding.id).sort().join(",")}${partial ? `;partial ${partial.reviewed.length}/${partial.notReviewed.length}/${partial.unverified}` : ""}` })
  const marker = reviewerMarker({ reviewer, configKey, key })
  const failed = (reason: string, flags: Partial<PublishReport>): PublishReport => ({ posted: false, comments: 0, movedToBody: 0, resolved: 0, state: previous, reason, ...flags })
  const remoteId = (remote: string | undefined) => { const id = Number(/(\d+)$/.exec(remote ?? "")?.[1]); return Number.isSafeInteger(id) && id > 0 ? id : undefined }
  const finish = async (flags: { posted: boolean; duplicate?: boolean; remote?: string | undefined; comments: number; moved: number; reason?: string }): Promise<PublishReport> => {
    for (const finding of fresh) state.published[finding.id] = { finding }
    const resolved = await resolveThroughProvider({ provider, repo, number, ids: resolve, state })
    const reviewId = remoteId(flags.remote)
    return { posted: flags.posted, ...(flags.duplicate ? { duplicate: true } : {}), ...(reviewId !== undefined ? { reviewId } : {}), comments: flags.comments, movedToBody: flags.moved, resolved, state, ...(flags.reason ? { reason: flags.reason } : {}) }
  }
  const earlier = effects?.byKey(key)
  if (earlier?.state === "done") return finish({ posted: false, duplicate: true, remote: earlier.remote, comments: 0, moved: 0, reason: "already posted" })
  if (await isStale(isCurrent)) return failed(STALE, { stale: true })
  const effect = effects?.intend({ kind: "review", key, marker, ...(jobId ? { jobId } : {}) })
  if (effect?.state === "done") return finish({ posted: false, duplicate: true, remote: effect.remote, comments: 0, moved: 0, reason: "already posted" })
  const body = `${reviewBody({ result, inline: fresh.length, moved: [], ...(info ? { info } : {}), ...(template ? { template } : {}), ...(sections ? { sections } : {}), ...(state.language ? { language: state.language } : {}) })}\n\n${marker}`
  const comments = fresh.map((finding) => ({ path: finding.path, line: finding.line, ...(finding.endLine && finding.endLine > finding.line ? { endLine: finding.endLine } : {}), body: commentBody(finding) }))
  const sent = await provider.publish({ repo, number, head: result.head, body, marker, comments })
    .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error), retryable: true }))
  if (sent.ok) {
    if (effect) effects!.done(effect.id, sent.remote.slice(0, 100) || undefined)
    // The adapter found its marker already on the pull request: an earlier attempt posted it, nothing was sent now.
    const duplicate = sent.duplicate === true
    return finish({ posted: !duplicate, ...(duplicate ? { duplicate: true, reason: "already posted (its marker is on the pull request)" } : {}), remote: sent.remote, comments: sent.comments, moved: sent.movedToBody })
  }
  if (/head moved/i.test(sent.reason)) { if (effect) effects!.abandon(effect.id, "stale"); return failed(sent.reason, { stale: true }) }
  if (sent.retryable) return failed(`${name} did not confirm the review (${sent.reason.slice(0, 300)}); it is checked again before the next attempt`, { uncertain: true })
  if (effect) effects!.abandon(effect.id, sent.reason.slice(0, 300))
  return failed(`${name} refused the review (${sent.reason.slice(0, 300)}); nothing was posted`, {})
}

/** Resolves the threads of `ids` the adapter finds by their finding marker and records it in `state`; how many it resolved. */
async function resolveThroughProvider({ provider, repo, number, ids, state }: { provider: ReviewProvider; repo: string; number: number; ids: readonly string[]; state: ReviewState }) {
  const open = ids.filter((id) => state.published[id] && !state.published[id]!.resolved)
  if (!open.length || !provider.capabilities.resolveThreads || !provider.threads || !provider.resolve) return 0
  const threads = new Map<string, { id: string; resolved: boolean }>()
  for (const thread of await provider.threads({ repo, number }).catch(() => undefined) ?? []) {
    const id = /<!-- mendcode:f=([0-9a-f]{40}) -->/.exec(thread.body)?.[1]
    if (id) threads.set(id, thread)
  }
  let resolved = 0
  for (const id of open) {
    const thread = threads.get(id)
    if (!thread) continue
    if (!thread.resolved) {
      if (!await provider.resolve({ repo, number, discussion: thread.id }).catch(() => false)) continue
      resolved++
    }
    state.published[id] = { ...state.published[id], threadId: thread.id, resolved: true }
  }
  return resolved
}
