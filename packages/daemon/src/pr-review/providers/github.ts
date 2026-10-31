import { z } from "zod"
import type { GhRun } from "../../pr-watch"
import type { CommandRun, PrFacts, ProviderCapabilities, ReviewProvider } from "../contracts"
import { isBot } from "../eligibility"
import { createPermissions, type Permission, type Permissions } from "../permissions"
import { findReviewMarker, listAll, MAX_PAGES, PAGE_SIZE, postReviewOnce, type GhCall } from "../publish"
import { repoParts } from "../state"

/**
 * The GitHub adapter of the review platform (docs/pr-review.md, "Providers"): everything through the user's own `gh`, started
 * with an argument array (no shell), so MendCode holds no token. GitHub has every capability the platform uses: inline comments
 * with suggestions, resolvable threads, COMMENT review events, requested reviewers, labels, drafts and pushes to a fork whose
 * author allows edits from maintainers.
 *
 * `listOpen` reads every open PR, newest update first, 100 a page (at most `MAX_PAGES`). With an `etag` the first page is a
 * conditional request: GitHub answers 304 (which costs no rate limit) when no open PR was updated, and the adapter says
 * `notModified` with an empty `prs` that the caller must read as "keep the previous list". A PR closed deep in the list does not
 * always change the first page, so a caller still lists in full now and then. `publish` posts one COMMENT review made idempotent
 * by its marker: looked up before the POST, and again after a POST whose outcome is unknown, never resent in the same call.
 * `permission` revalidates against GitHub on every call (the platform asks right before a write); `permissions` keeps the cached
 * reads for display.
 *
 * Verified against fixtures of GitHub's REST shapes only (`verified: "contract"`); the lead decides when a live run promotes it.
 */

export const GITHUB_CAPABILITIES: ProviderCapabilities = {
  inlineComments: true, suggestions: true, resolveThreads: true, reviewEvents: true, requestedReviewers: true, labels: true, draft: true, forkPush: true, conditionalRequests: true,
  verified: "contract",
}

const SHA = z.string().regex(/^[0-9a-f]{7,64}$/)
const User = z.object({ login: z.string().min(1).max(100), type: z.string().max(40).optional() })
const Repo = z.object({ full_name: z.string().max(200) })
/** One pull request as `GET /repos/{repo}/pulls` and `GET /repos/{repo}/pulls/{n}` return it (only the fields read here). */
export const GithubPull = z.object({
  number: z.number().int().positive(),
  title: z.string().max(2000).optional(),
  html_url: z.string().max(500).optional(),
  updated_at: z.string().max(40).optional(),
  draft: z.boolean().optional(),
  /** Null for a deleted account ("ghost"). */
  user: User.nullable().optional(),
  labels: z.array(z.object({ name: z.string().max(200) })).optional(),
  requested_reviewers: z.array(User).optional(),
  assignees: z.array(User).nullable().optional(),
  maintainer_can_modify: z.boolean().optional(),
  /** `head.repo` is null when the fork was deleted. */
  head: z.object({ sha: SHA, ref: z.string().max(300), repo: Repo.nullable().optional() }),
  base: z.object({ sha: SHA, ref: z.string().max(300), repo: Repo.nullable().optional() }),
})
export type GithubPull = z.infer<typeof GithubPull>

/** The platform's facts of one GitHub pull request. A head in another repository (or a deleted one) is a fork. */
export function factsOf(pull: GithubPull, files?: string[]): PrFacts {
  const author = pull.user?.login ?? "ghost"
  const baseRepo = pull.base.repo?.full_name.toLowerCase()
  const headRepo = pull.head.repo?.full_name.toLowerCase()
  return {
    number: pull.number,
    ...(pull.title !== undefined ? { title: pull.title } : {}),
    head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, headRef: pull.head.ref,
    draft: pull.draft === true,
    labels: (pull.labels ?? []).map((label) => label.name),
    author, authorIsBot: isBot(author, pull.user?.type),
    fork: !headRepo || (!!baseRepo && headRepo !== baseRepo),
    ...(pull.maintainer_can_modify !== undefined ? { maintainerCanModify: pull.maintainer_can_modify } : {}),
    requested: (pull.requested_reviewers ?? []).map((user) => user.login),
    assignees: (pull.assignees ?? []).map((user) => user.login),
    ...(files ? { files } : {}),
    ...(pull.html_url !== undefined ? { url: pull.html_url } : {}),
    ...(pull.updated_at !== undefined ? { updatedAt: pull.updated_at } : {}),
  }
}

/** The platform's coarser level: maintain counts as write, triage as read (neither changes what MendCode may do). */
export function providerPermission(level: Permission): Awaited<ReturnType<ReviewProvider["permission"]>> {
  if (level === "maintain") return "write"
  if (level === "triage") return "read"
  return level
}

/** `gh api --include` output split into its status, its headers (lower-case names) and its body. Without a status line, all body. */
export function splitInclude(out: string): { status?: number; headers: Map<string, string>; body: string } {
  const headers = new Map<string, string>()
  const text = out.replace(/\r\n/g, "\n")
  const statusLine = /^HTTP\/[\d.]+ (\d{3})/.exec(text)
  if (!statusLine) return { headers, body: out }
  const end = text.indexOf("\n\n")
  const head = end < 0 ? text : text.slice(0, end)
  for (const line of head.split("\n").slice(1)) {
    const colon = line.indexOf(":")
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(statusLine[1]), headers, body: end < 0 ? "" : text.slice(end + 2) }
}

const AUTH = /HTTP 401|Bad credentials|gh auth login|not logged in|authentication/i
const MISSING = /executable (file )?not found|ENOENT|command not found/i
const ETAG = /^(W\/)?"[^"\n]{1,200}"$/
const LIST = (repo: string) => `repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`
const validRepo = (repo: string) => { try { repoParts(repo); return true } catch { return false } }
const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.slice(0, 200)
const json = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
const pulls = (value: unknown): GithubPull[] | undefined => { const parsed = z.array(GithubPull).safeParse(value); return parsed.success ? parsed.data : undefined }

export type GithubProvider = ReviewProvider & { permissions: Permissions }
/**
 * `run` starts `gh` for commands that need a checkout (`gh repo view`); `call` is `gh api` with a request body on stdin. A
 * `CommandRun` (which takes `stdin`) serves as both; the daemon's `GhRun` takes no stdin, so it needs its `call`.
 */
export type GithubProviderDeps = { run: CommandRun; call?: GhCall | undefined; permissions?: Permissions | undefined } | { run: GhRun; call: GhCall; permissions?: Permissions | undefined }

/** The GitHub `ReviewProvider`. */
export function createGithubProvider(deps: GithubProviderDeps): GithubProvider {
  const run = deps.run
  const call: GhCall = deps.call ?? ((input) => (deps.run as CommandRun)({ argv: input.argv, ...(input.stdin !== undefined ? { stdin: input.stdin } : {}) }))
  const permissions = deps.permissions ?? createPermissions({ gh: call })
  async function repoOf(directory: string) {
    const done = await run({ argv: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd: directory }).catch(() => ({ code: -1, out: "", err: "" }))
    const repo = done.out.trim()
    if (done.code !== 0 || !validRepo(repo)) throw new Error(`[PR_REVIEW]: gh could not name the GitHub repository of ${directory}${done.err ? ` (${firstLine(done.err)})` : ""}`)
    return repo
  }

  const listOpen: ReviewProvider["listOpen"] = async ({ repo, etag }) => {
    if (!validRepo(repo)) return { ok: false, auth: false, reason: `invalid repository ${JSON.stringify(repo.slice(0, 120))}` }
    const conditional = etag && ETAG.test(etag) ? ["-H", `If-None-Match: ${etag}`] : []
    const first = await call({ argv: ["api", LIST(repo), "--include", ...conditional] }).catch((error: unknown) => ({ code: -1, out: "", err: error instanceof Error ? error.message : String(error) }))
    const split = splitInclude(first.out)
    if (conditional.length && (split.status === 304 || /HTTP 304/.test(first.err ?? ""))) return { ok: true, prs: [], etag: etag!, notModified: true }
    if (first.code !== 0) {
      const text = `${first.err ?? ""}\n${first.out}`
      return { ok: false, auth: AUTH.test(text) || MISSING.test(text), reason: firstLine(first.err ?? "") ?? firstLine(first.out) ?? `gh exited with ${first.code}` }
    }
    const page1 = pulls(json(split.body))
    if (!page1) return { ok: false, auth: false, reason: "gh returned something that is not a pull request list" }
    const all = [...page1]
    for (let page = 2, last = page1; last.length >= PAGE_SIZE && page <= MAX_PAGES; page++) {
      const done = await call({ argv: ["api", `${LIST(repo)}&page=${page}`] }).catch(() => ({ code: -1, out: "" }))
      const next = done.code === 0 ? pulls(json(done.out)) : undefined
      // A later page that fails makes the whole list unreadable: a partial list would read as closed pull requests.
      if (!next) return { ok: false, auth: false, reason: `gh could not read page ${page} of the open pull requests` }
      all.push(...next)
      last = next
    }
    const tag = split.headers.get("etag")
    return { ok: true, prs: all.map((pull) => factsOf(pull)), ...(tag && ETAG.test(tag) ? { etag: tag } : {}) }
  }

  const view: ReviewProvider["view"] = async ({ repo, number }) => {
    if (!validRepo(repo) || !Number.isSafeInteger(number) || number <= 0) throw new Error("[PR_REVIEW]: invalid pull request")
    const done = await call({ argv: ["api", `repos/${repo}/pulls/${number}`] }).catch(() => ({ code: -1, out: "", err: "" }))
    const parsed = done.code === 0 ? GithubPull.safeParse(json(done.out)) : undefined
    if (!parsed?.success) throw new Error(`[PR_REVIEW]: gh could not read ${repo}#${number}${done.err ? ` (${firstLine(done.err)})` : ""}`)
    const files = await listAll(call, `repos/${repo}/pulls/${number}/files`)
    const names = files?.flatMap((file) => { const name = (file as { filename?: unknown }).filename; return typeof name === "string" ? [name] : [] })
    return factsOf(parsed.data, names)
  }

  const publish: ReviewProvider["publish"] = async ({ repo, number, head, body, comments, marker }) => {
    if (!validRepo(repo) || !Number.isSafeInteger(number) || number <= 0) return { ok: false, reason: "[PR_REVIEW]: invalid pull request", retryable: false }
    if (!marker.trim()) return { ok: false, reason: "[PR_REVIEW]: a review needs a marker to be published idempotently", retryable: false }
    const outcome = await postReviewOnce({
      gh: call, repo, number, head, items: comments, marker, key: marker, precheck: true,
      render: (inline, moved) => ({
        body: moved.length ? `${body}\n\n<details><summary>Not on a line GitHub shows in this diff (${moved.length})</summary>\n\n${moved.map((comment) => `**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`).join("\n\n")}\n\n</details>` : body,
        comments: inline.map((comment) => ({ path: comment.path, side: "RIGHT", body: comment.body, ...(comment.endLine && comment.endLine > comment.line ? { start_line: comment.line, start_side: "RIGHT", line: comment.endLine } : { line: comment.line }) })),
      }),
    })
    switch (outcome.outcome) {
      case "posted": return { ok: true, remote: outcome.reviewId === undefined ? "" : String(outcome.reviewId), comments: outcome.inline.length, movedToBody: outcome.moved.length }
      case "duplicate": return { ok: true, remote: outcome.reviewId === undefined ? "" : String(outcome.reviewId), comments: 0, movedToBody: 0 }
      case "refused": return { ok: false, reason: outcome.reason, retryable: outcome.retryable }
      case "uncertain": return { ok: false, reason: outcome.reason, retryable: true }
      case "stale": return { ok: false, reason: outcome.reason, retryable: false }
    }
  }

  const findMarker: ReviewProvider["findMarker"] = async ({ repo, number, marker }) => {
    const found = await findReviewMarker({ gh: call, repo, number, marker })
    // Unreadable is not "absent": a caller that took it as absent would post twice.
    if (!found.readable) throw new Error(`[PR_REVIEW]: gh could not read the reviews of ${repo}#${number}`)
    return found.found ? { found: true, ...(found.reviewId === undefined ? {} : { remote: String(found.reviewId) }) } : { found: false }
  }

  return {
    kind: "github",
    capabilities: GITHUB_CAPABILITIES,
    repoOf, listOpen, view, publish, findMarker,
    headRef: (number) => `refs/pull/${number}/head`,
    permission: async ({ repo, login }) => providerPermission(await permissions.permissionOf(repo, login, { fresh: true })),
    permissions,
  }
}
