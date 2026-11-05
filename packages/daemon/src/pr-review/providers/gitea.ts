import { z } from "zod"
import type { ForgeComment, PrFacts, ReviewProvider } from "../contracts"
import { parseUnifiedDiff, type GitRun } from "../context"
import { PROVIDER_CAPABILITIES, remoteRepoOf } from "./index"

/**
 * Gitea and Forgejo (Codeberg) pull requests over the REST API `/api/v1` (docs/pr-review.md, providers). Not through `tea`: its
 * documented commands list and create PRs but offer no raw API call for review comments, and it is rarely installed (absent on
 * this machine when the adapter was written), so the adapter speaks HTTP itself. The token is only read, at each call, from the
 * environment variable the config names (`GITEA_TOKEN` by default) and sent as `Authorization: token …`; MendCode never stores
 * it. Without one, public repositories can be listed and read; nothing is posted.
 *
 * Shapes follow the swagger of Gitea 1.27 (https://github.com/go-gitea/gitea/blob/release/v1.27/templates/swagger/v1_json.tmpl)
 * and Forgejo (https://codeberg.org/swagger.v1.json); pagination is `page`/`limit` with `Link` and `X-Total-Count` headers
 * (https://docs.gitea.com/development/api-usage). Contract-tested on fixtures; also run live by scripts/live-forges.ts (env-gated,
 * outside the normal suite) against a local Gitea 28.2.0, which is where the placement check before posting comes from. Forgejo
 * has not been run live.
 */

export type GiteaDeps = {
  /** The instance's web origin (`https://codeberg.org`, `https://git.example.com:3000`); `/api/v1` is appended. */
  baseUrl: string
  fetch?: typeof fetch | undefined
  /** Reads the token from the environment variable the config names; undefined means anonymous. */
  token?: (() => string | undefined) | undefined
  git?: GitRun | undefined
}

/** A token reader over one environment variable; the name comes from config, the value is never copied anywhere. */
export const tokenFromEnv = (name: string, env: Readonly<Record<string, string | undefined>> = process.env) => (): string | undefined => {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** The page size asked for; an instance may cap it lower (`MAX_RESPONSE_ITEMS`, default 50), the `Link` header says what is next. */
const LIMIT = 50
const MAX_PAGES = 200
const TIMEOUT_MS = 30_000

const Login = z.object({ login: z.string() }).passthrough()
const Branch = z.object({ ref: z.string(), sha: z.string(), repo_id: z.number().int().nullable().optional(), repo: z.object({ full_name: z.string() }).passthrough().nullable().optional() }).passthrough()
/** One pull request as `GET /repos/{owner}/{repo}/pulls[/{index}]` returns it (`PullRequest` in the swagger). */
export const GiteaPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string().optional(),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  labels: z.array(z.object({ name: z.string() }).passthrough()).nullable().optional(),
  user: Login,
  head: Branch,
  base: Branch,
  allow_maintainer_edit: z.boolean().optional(),
  requested_reviewers: z.array(Login).nullable().optional(),
  assignees: z.array(Login).nullable().optional(),
  html_url: z.string().optional(),
  updated_at: z.string().optional(),
  state: z.string().optional(),
}).passthrough()
const Review = z.object({ id: z.number().int(), body: z.string().nullable().optional(), user: Login.nullable().optional(), commit_id: z.string().nullable().optional(), state: z.string().nullable().optional() }).passthrough()
const Comment = z.object({ id: z.number().int(), body: z.string().nullable().optional(), user: Login.nullable().optional(), created_at: z.string().optional(), updated_at: z.string().optional() }).passthrough()
/** A review comment (`PullReviewComment`): `position` is the new-side line, `original_position` the old one for a deleted line. */
const ReviewComment = Comment.extend({ path: z.string().nullable().optional(), position: z.number().int().nullable().optional(), original_position: z.number().int().nullable().optional() }).passthrough()

/** Gitea's user object has no bot flag: the login decides (Actions' own user, `…[bot]`, `…-bot`, Renovate, Dependabot). */
export const giteaIsBot = (login: string) => /\[bot\]$|-bot$|^(gitea|forgejo)-actions$|^(renovate|dependabot)(-|_|\[|$)/i.test(login)

/** Facts of one pull request; `draft` falls back to the `WIP:`/`[WIP]` title prefix older instances use instead of the flag. */
export function giteaFacts(pr: z.infer<typeof GiteaPullRequest>): PrFacts {
  return {
    number: pr.number,
    ...(pr.title !== undefined ? { title: pr.title } : {}),
    ...(typeof pr.body === "string" && pr.body ? { body: pr.body.slice(0, 100_000) } : {}),
    head: pr.head.sha,
    base: pr.base.sha,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    draft: pr.draft ?? /^\s*(WIP:|\[WIP\])/i.test(pr.title ?? ""),
    labels: (pr.labels ?? []).map((label) => label.name),
    author: pr.user.login,
    authorIsBot: giteaIsBot(pr.user.login),
    fork: pr.head.repo_id != null && pr.base.repo_id != null && pr.head.repo_id !== pr.base.repo_id,
    ...(pr.allow_maintainer_edit !== undefined ? { maintainerCanModify: pr.allow_maintainer_edit } : {}),
    requested: (pr.requested_reviewers ?? []).map((user) => user.login),
    assignees: (pr.assignees ?? []).map((user) => user.login),
    ...(pr.html_url ? { url: pr.html_url } : {}),
    ...(pr.updated_at ? { updatedAt: pr.updated_at } : {}),
    ...(pr.state ? { open: pr.state === "open" } : {}),
  }
}

/** `GET /repos/{owner}/{repo}/collaborators/{user}/permission` answers none, read, write, admin or owner. */
export const giteaPermission = (permission: string): "admin" | "write" | "read" | "none" | "unknown" =>
  permission === "owner" || permission === "admin" ? "admin" : permission === "write" ? "write" : permission === "read" ? "read" : permission === "none" ? "none" : "unknown"

type Answer = { status: number; text: string; headers: Headers }

/** The URL of the next page from a `Link` header, if it names one. */
const nextLink = (link: string | null) => link?.split(",").map((part) => /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)?.[1]).find(Boolean)

export function createGiteaProvider({ baseUrl, fetch: fetcher = fetch, token = () => undefined, git }: GiteaDeps): ReviewProvider & Required<Pick<ReviewProvider, "self" | "files" | "comments" | "comment" | "reply" | "markers" | "pushTarget">> {
  const origin = baseUrl.replace(/\/+$/, "")
  if (!/^https?:\/\/[^/\s]+/.test(origin)) throw new TypeError(`[PR_REVIEW]: ${JSON.stringify(baseUrl.slice(0, 120))} is not a Gitea base URL`)
  const repoPath = (repo: string) => {
    const [owner, name, extra] = repo.split("/")
    if (!owner || !name || extra !== undefined) throw new TypeError(`[PR_REVIEW]: ${JSON.stringify(repo.slice(0, 120))} is not owner/repo`)
    return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  }

  async function request(path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<Answer | { status: 0; error: string }> {
    const secret = token()
    const url = `${origin}/api/v1/${path}`
    try {
      const response = await fetcher(url, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { accept: init.accept ?? "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(secret ? { authorization: `token ${secret}` } : {}) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return { status: response.status, text: await response.text(), headers: response.headers }
    } catch (error) { return { status: 0, error: error instanceof Error ? error.message : String(error) } }
  }
  const reason = (answer: Answer | { status: 0; error: string }) => "error" in answer ? answer.error.slice(0, 200) : `HTTP ${answer.status}${(() => { try { const message = (JSON.parse(answer.text) as { message?: unknown }).message; return typeof message === "string" ? `: ${message.slice(0, 160)}` : "" } catch { return "" } })()}`
  const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

  /**
   * Every page of a list. The next page number comes from `Link: rel="next"` (only its `page` is read: the server's ROOT_URL may
   * differ from `baseUrl`, and the token is never sent to a URL the server chose); without a `Link`, from `X-Total-Count`;
   * without either, a short page is the last.
   */
  async function pages(path: string): Promise<{ ok: true; items: unknown[] } | { ok: false; status: number; reason: string }> {
    const items: unknown[] = []
    const at = (page: number) => `${path}${path.includes("?") ? "&" : "?"}limit=${LIMIT}&page=${page}`
    let page = 1
    for (let count = 0; count < MAX_PAGES; count++) {
      const answer = await request(at(page))
      if ("error" in answer || answer.status !== 200) return { ok: false, status: answer.status, reason: reason(answer) }
      const batch = parse(answer.text)
      if (!Array.isArray(batch)) return { ok: false, status: answer.status, reason: "Gitea returned something that is not a JSON list" }
      items.push(...batch)
      const link = answer.headers.get("link")
      const next = Number(/[?&]page=(\d+)/.exec(nextLink(link) ?? "")?.[1] ?? Number.NaN)
      const total = Number(answer.headers.get("x-total-count") ?? Number.NaN)
      if (Number.isInteger(next) && next > page) { page = next; continue }
      if (link !== null || !batch.length) return { ok: true, items }
      if (Number.isFinite(total) ? items.length >= total : batch.length < LIMIT) return { ok: true, items }
      page++
    }
    return { ok: false, status: 200, reason: `more than ${MAX_PAGES} pages at ${path}` }
  }

  async function view({ repo, number }: { directory?: string; repo: string; number: number }): Promise<PrFacts> {
    const answer = await request(`${repoPath(repo)}/pulls/${number}`)
    const pr = "error" in answer || answer.status !== 200 ? undefined : GiteaPullRequest.safeParse(parse(answer.text))
    if (!pr?.success) throw new Error(`[PR_REVIEW]: Gitea could not read pull request #${number} of ${repo} (${pr ? "not a pull request" : reason(answer)})`)
    return giteaFacts(pr.data)
  }

  async function reviewWithMarker(repo: string, number: number, marker: string) {
    const listed = await pages(`${repoPath(repo)}/pulls/${number}/reviews`)
    if (!listed.ok) return listed
    const review = listed.items.map((item) => Review.safeParse(item)).find((parsed) => parsed.success && parsed.data.body?.includes(marker))
    return { ok: true as const, id: review?.success ? review.data.id : undefined }
  }

  return {
    kind: "gitea",
    capabilities: PROVIDER_CAPABILITIES.gitea,
    repoOf: (directory) => remoteRepoOf({ directory, git, provider: "gitea" }),
    /** Gitea keeps every pull request's head at `refs/pull/N/head` in the base repository. */
    headRef: (number) => `refs/pull/${number}/head`,
    view,

    async listOpen({ repo }) {
      const listed = await pages(`${repoPath(repo)}/pulls?state=open&sort=recentupdate`)
      if (!listed.ok) {
        const auth = listed.status === 401 || listed.status === 403 || (listed.status === 404 && !token())
        return { ok: false, auth, reason: auth && !token() ? `${listed.reason} (no Gitea token in the environment variable the config names)` : listed.reason }
      }
      const prs: PrFacts[] = []
      for (const item of listed.items) {
        const pr = GiteaPullRequest.safeParse(item)
        if (!pr.success) return { ok: false, auth: false, reason: "Gitea returned a pull request this adapter cannot read" }
        prs.push(giteaFacts(pr.data))
      }
      return { ok: true, prs }
    },

    async publish({ repo, number, head, body, comments, marker }) {
      if (!token()) return { ok: false, reason: "no Gitea token in the environment variable the config names; nothing was posted", retryable: false }
      const current = await view({ repo, number }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
      if (current instanceof Error) return { ok: false, reason: current.message.replace(/^\[PR_REVIEW\]: /, ""), retryable: true }
      if (current.head !== head) return { ok: false, reason: `the pull request's head moved to ${current.head.slice(0, 12)} after ${head.slice(0, 12)} was reviewed; nothing was posted`, retryable: false }
      const existing = await reviewWithMarker(repo, number, marker)
      if (!existing.ok) return { ok: false, reason: `Gitea reviews could not be read (${existing.reason})`, retryable: existing.status !== 401 && existing.status !== 403 }
      if (existing.id !== undefined) return { ok: true, remote: `review:${existing.id}`, comments: 0, movedToBody: 0, duplicate: true }

      // Placement is checked against the pull request's own diff before posting: Gitea 28 accepts a comment on a line outside the
      // diff (it stores it with an empty diff hunk, shown on no diff line), so the 422 below is not the only refusal to plan for.
      const fits = (files: ReturnType<typeof parseUnifiedDiff>) => (comment: (typeof comments)[number]) => { const right = files.find((file) => file.path === comment.path)?.right; if (!right) return false; for (let line = comment.line; line <= (comment.endLine ?? comment.line); line++) if (!right.has(line)) return false; return true }
      const readDiff = async () => { const diff = await request(`${repoPath(repo)}/pulls/${number}.diff`, { accept: "text/plain" }); return "error" in diff || diff.status !== 200 ? undefined : parseUnifiedDiff(diff.text) }
      const planned = comments.length ? await readDiff() : undefined
      let inline = planned ? comments.filter(fits(planned)) : comments
      let moved: typeof comments = planned ? comments.filter((comment) => !fits(planned)(comment)) : []
      const text = () => {
        const extra = moved.length ? `\n\n---\n**Comments Gitea could not place on the diff**\n\n${moved.map((comment) => `**\`${comment.path}\` line ${comment.line}${comment.endLine && comment.endLine > comment.line ? `–${comment.endLine}` : ""}**\n\n${comment.body}`).join("\n\n")}` : ""
        const full = `${body}${extra}`
        return full.includes(marker) ? full : `${full}\n\n${marker}`
      }
      // One line per comment: the API has `new_position` and no range, so a range anchors on its last line, as GitHub's does.
      const send = () => request(`${repoPath(repo)}/pulls/${number}/reviews`, { body: { body: text(), commit_id: head, event: "COMMENT", comments: inline.map((comment) => ({ path: comment.path, body: comment.body, new_position: comment.endLine && comment.endLine > comment.line ? comment.endLine : comment.line })) } })
      let answer = await send()
      if (!("error" in answer) && answer.status === 422 && inline.length) {
        // The swagger's 422 names no comment: the pull request's own diff says which lines it takes; if it says they all fit (or
        // cannot be read), every comment moves into the body so the review is still posted once.
        const files = planned ?? await readDiff() ?? []
        const refused = inline.filter((comment) => !fits(files)(comment))
        const kept = inline.filter(fits(files))
        if (refused.length) { moved = [...moved, ...refused]; inline = kept } else { moved = [...moved, ...inline]; inline = [] }
        answer = await send()
      }
      if ("error" in answer || answer.status < 200 || answer.status >= 300) {
        const status = "error" in answer ? 0 : answer.status
        return { ok: false, reason: `Gitea refused the review (${reason(answer)}); nothing was posted`, retryable: status === 0 || status === 429 || status >= 500 }
      }
      const id = (parse(answer.text) as { id?: unknown } | undefined)?.id
      return { ok: true, remote: `review:${typeof id === "number" ? id : "unknown"}`, comments: inline.length, movedToBody: moved.length }
    },

    async findMarker({ repo, number, marker }) {
      const found = await reviewWithMarker(repo, number, marker)
      if (!found.ok) throw new Error(`[PR_REVIEW]: Gitea reviews of #${number} could not be read (${found.reason})`)
      return found.id !== undefined ? { found: true, remote: `review:${found.id}` } : { found: false }
    },

    async permission({ repo, login }) {
      const answer = await request(`${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`)
      if ("error" in answer) return "unknown"
      if (answer.status === 404) return "none"
      if (answer.status !== 200) return "unknown"
      const permission = (parse(answer.text) as { permission?: unknown } | undefined)?.permission
      return typeof permission === "string" ? giteaPermission(permission) : "unknown"
    },

    async self() {
      if (!token()) return undefined
      const answer = await request("user")
      const login = "error" in answer || answer.status !== 200 ? undefined : (parse(answer.text) as { login?: unknown } | undefined)?.login
      return typeof login === "string" && login.length > 0 && login.length <= 255 ? login : undefined
    },

    /** The paths of the pull request's own diff (`GET …/pulls/{index}.diff`, the read the placement check uses). */
    async files({ repo, number }) {
      const diff = await request(`${repoPath(repo)}/pulls/${number}.diff`, { accept: "text/plain" })
      return "error" in diff || diff.status !== 200 ? undefined : parseUnifiedDiff(diff.text).map((file) => file.path)
    },

    /**
     * The conversation (`GET …/issues/{index}/comments`, one unpaged list) and every review's comments
     * (`GET …/pulls/{index}/reviews/{id}/comments`). Gitea records no parent of a review comment: one answers the first comment of
     * its review conversation, the earliest on the same path and line.
     */
    async comments({ repo, number }) {
      const issue = await request(`${repoPath(repo)}/issues/${number}/comments`)
      const listed = "error" in issue || issue.status !== 200 ? undefined : parse(issue.text)
      if (!Array.isArray(listed)) return { ok: false, reason: `Gitea comments could not be read (${reason(issue)})` }
      const reviews = await pages(`${repoPath(repo)}/pulls/${number}/reviews`)
      if (!reviews.ok) return { ok: false, reason: `Gitea reviews could not be read (${reviews.reason})` }
      const comments: ForgeComment[] = []
      for (const item of listed) {
        const comment = Comment.safeParse(item)
        if (comment.success && comment.data.user?.login && typeof comment.data.body === "string") comments.push({ id: comment.data.id, author: comment.data.user.login, body: comment.data.body, surface: "issue", ...dates(comment.data) })
      }
      const inline: Array<z.infer<typeof ReviewComment>> = []
      for (const item of reviews.items) {
        const review = Review.safeParse(item)
        if (!review.success) continue
        const answer = await request(`${repoPath(repo)}/pulls/${number}/reviews/${review.data.id}/comments`)
        const items = "error" in answer || answer.status !== 200 ? undefined : parse(answer.text)
        if (!Array.isArray(items)) return { ok: false, reason: `Gitea review ${review.data.id}'s comments could not be read (${reason(answer)})` }
        for (const entry of items) { const comment = ReviewComment.safeParse(entry); if (comment.success) inline.push(comment.data) }
      }
      inline.sort((a, b) => a.id - b.id)
      for (const comment of inline) {
        if (!comment.user?.login || typeof comment.body !== "string") continue
        const line = comment.position || comment.original_position || undefined
        const root = inline.find((other) => other.id < comment.id && other.path === comment.path && (other.position || other.original_position || undefined) === line)
        comments.push({ id: comment.id, author: comment.user.login, body: comment.body, surface: "review", ...dates(comment), ...(root ? { inReplyTo: root.id } : {}), ...(comment.path ? { path: comment.path } : {}), ...(line ? { line } : {}) })
      }
      return { ok: true, comments }
    },

    /** `POST …/issues/{index}/comments`, or `PATCH …/issues/comments/{id}` for `edit`. */
    async comment({ repo, number, body, edit }) {
      if (!token()) return { ok: false, reason: "no Gitea token in the environment variable the config names" }
      const answer = await request(edit === undefined ? `${repoPath(repo)}/issues/${number}/comments` : `${repoPath(repo)}/issues/comments/${edit}`, { method: edit === undefined ? "POST" : "PATCH", body: { body } })
      const id = "error" in answer || answer.status < 200 || answer.status >= 300 ? undefined : (parse(answer.text) as { id?: unknown } | undefined)?.id
      return typeof id === "number" ? { ok: true, id } : { ok: false, reason: reason(answer) }
    },

    /**
     * A reply in the review conversation of `to` (`POST …/pulls/{index}/comments/{id}/replies`, Gitea's; Forgejo has none and
     * answers 404 or 405, and then the reply goes to the conversation), or a conversation comment.
     */
    async reply({ repo, number, to, body }) {
      if (!token()) return { ok: false, reason: "no Gitea token in the environment variable the config names" }
      const conversation = async () => {
        const answer = await request(`${repoPath(repo)}/issues/${number}/comments`, { body: { body } })
        const id = "error" in answer || answer.status !== 201 ? undefined : (parse(answer.text) as { id?: unknown } | undefined)?.id
        return typeof id === "number" ? { ok: true as const, id } : { ok: false as const, reason: reason(answer) }
      }
      if (to.surface !== "review") return conversation()
      const answer = await request(`${repoPath(repo)}/pulls/${number}/comments/${to.inReplyTo ?? to.id}/replies`, { body: { body } })
      if (!("error" in answer) && (answer.status === 404 || answer.status === 405)) return conversation()
      const id = "error" in answer || answer.status < 200 || answer.status >= 300 ? undefined : (parse(answer.text) as { id?: unknown } | undefined)?.id
      return typeof id === "number" ? { ok: true, id } : { ok: false, reason: reason(answer) }
    },

    /** The pull request's reviews with their authors, the commit each reviewed and its state. */
    async markers({ repo, number }) {
      const listed = await pages(`${repoPath(repo)}/pulls/${number}/reviews`)
      if (!listed.ok) return { ok: false, reason: listed.reason }
      return { ok: true, posts: listed.items.flatMap((item) => { const review = Review.safeParse(item); return review.success && review.data.user?.login ? [{ id: review.data.id, author: review.data.user.login, body: review.data.body ?? "", ...(review.data.commit_id ? { commit: review.data.commit_id } : {}), ...(review.data.state ? { state: review.data.state } : {}) }] : [] }) }
    },

    /** `GET …/labels`: the repository's label names. */
    async repoLabels({ repo }) {
      const listed = await pages(`${repoPath(repo)}/labels`)
      return listed.ok ? listed.items.flatMap((item) => typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : []) : undefined
    },

    /** `PATCH …/pulls/{index}` for the title and description; labels are added by id (`POST …/issues/{index}/labels`). */
    async edit({ repo, number, title, body, labels }) {
      if (!token()) return { ok: false, reason: "no Gitea token in the environment variable the config names" }
      if (title !== undefined || body !== undefined) {
        const answer = await request(`${repoPath(repo)}/pulls/${number}`, { method: "PATCH", body: { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) } })
        if ("error" in answer || answer.status < 200 || answer.status >= 300) return { ok: false, reason: reason(answer) }
      }
      if (labels?.length) {
        const known = await pages(`${repoPath(repo)}/labels`)
        if (!known.ok) return { ok: false, reason: known.reason }
        const ids = labels.flatMap((name) => { const found = known.items.find((item) => (item as { name?: unknown }).name === name) as { id?: unknown } | undefined; return typeof found?.id === "number" ? [found.id] : [] })
        if (ids.length) {
          const answer = await request(`${repoPath(repo)}/issues/${number}/labels`, { body: { labels: ids } })
          if ("error" in answer || answer.status < 200 || answer.status >= 300) return { ok: false, reason: reason(answer) }
        }
      }
      return { ok: true }
    },

    /** `POST …/pulls/{index}/reviews` with event APPROVED on the reviewed commit. */
    async approve({ repo, number, head, body }) {
      if (!token()) return { ok: false, reason: "no Gitea token in the environment variable the config names" }
      const answer = await request(`${repoPath(repo)}/pulls/${number}/reviews`, { body: { body, commit_id: head, event: "APPROVED" } })
      return "error" in answer || answer.status < 200 || answer.status >= 300 ? { ok: false, reason: reason(answer) } : { ok: true }
    },

    /** The head branch and its repository; a fork takes a push only with `allow_maintainer_edit`. */
    async pushTarget({ repo, number }) {
      const answer = await request(`${repoPath(repo)}/pulls/${number}`)
      const pr = "error" in answer || answer.status !== 200 ? undefined : GiteaPullRequest.safeParse(parse(answer.text))
      if (!pr?.success) throw new Error(`[PR_REVIEW]: Gitea could not read pull request #${number} of ${repo} (${pr ? "not a pull request" : reason(answer)})`)
      const facts = giteaFacts(pr.data)
      const source = pr.data.head.repo?.full_name
      if (facts.fork && (!source || source.split("/").length !== 2)) throw new Error(`[PR_REVIEW]: Gitea did not name the fork of pull request #${number}`)
      return { branch: facts.headRef, head: facts.head, base: facts.base, baseRef: facts.baseRef, repo: facts.fork ? source! : repo, fork: facts.fork, pushable: !facts.fork || pr.data.allow_maintainer_edit === true }
    },
  }
}
const dates = (item: { created_at?: string | undefined; updated_at?: string | undefined }) => ({ ...(item.created_at ? { createdAt: item.created_at } : {}), ...(item.updated_at ? { updatedAt: item.updated_at } : {}) })
