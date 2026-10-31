import { parseDiffRows } from "@mendcode/protocol/wire"
import { z } from "zod"
import type { CommandRun, ForgeComment, PrFacts, ReviewProvider } from "../contracts"
import type { GitRun } from "../context"
import { PROVIDER_CAPABILITIES, remoteRepoOf } from "./index"

/**
 * GitLab merge requests through the user's own `glab api` (docs/pr-review.md, providers): MendCode handles no GitLab token; `glab`
 * is logged in or the call fails with an auth reason, as `gh` does for GitHub. Shapes follow the documented API
 * (https://docs.gitlab.com/api/merge_requests/, https://docs.gitlab.com/api/discussions/, https://docs.gitlab.com/api/notes/,
 * https://docs.gitlab.com/api/project_members/) and are contract-tested on fixtures; scripts/live-forges.ts (env-gated, outside the
 * normal suite) runs every method live against a local GitLab CE 19.5.3 through glab 1.126.0. gitlab.com itself was not used.
 *
 * A merge request has no review object: the summary is one note and each inline comment its own diff discussion (resolvable).
 * Every body MendCode posts carries the review's hidden marker, so a retry after a crash or timeout finds the notes already there
 * and posts only what is missing; the summary note goes last, so a found summary means the whole review is on the merge request.
 */

export type GitlabDeps = {
  /** `glab` with an argument array (no shell); `stdin` is the JSON body for `--input -`. */
  run: CommandRun
  /** `glab api --hostname` for a self-hosted instance; unset, glab uses gitlab.com or the checkout's authenticated host. */
  hostname?: string | undefined
  /**
   * The instance's web origin (`https://gitlab.example.com:8443`, `http://127.0.0.1:8929`). When given, every call names the full
   * API URL instead of `--hostname`: glab 1.126 refuses a `--hostname` with a port ("invalid hostname") although `glab auth login`
   * accepts one, and a call without a checkout (publish, findMarker, permission) would otherwise go to gitlab.com. glab still
   * picks the stored login of that host:port; MendCode never sees the token.
   */
  baseUrl?: string | undefined
  git?: GitRun | undefined
}

/** GitLab's REST pages hold at most 100 items (https://docs.gitlab.com/api/rest/, pagination). */
const PER_PAGE = 100
/** A list longer than this many pages is refused rather than read partially (10,000 merge requests or notes). */
const MAX_PAGES = 100

const User = z.object({ username: z.string(), bot: z.boolean().optional() }).passthrough()
const DiffRefs = z.object({ base_sha: z.string().nullable().optional(), start_sha: z.string().nullable().optional(), head_sha: z.string().nullable().optional() }).passthrough()
/** One merge request as `GET /projects/:id/merge_requests[/:iid]` returns it; the list carries no `diff_refs`, the single MR does. */
export const GitlabMergeRequest = z.object({
  iid: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().nullish(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).default([]),
  author: User,
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullable(),
  diff_refs: DiffRefs.nullable().optional(),
  source_project_id: z.number().int(),
  target_project_id: z.number().int(),
  allow_collaboration: z.boolean().nullable().optional(),
  reviewers: z.array(User).default([]),
  assignees: z.array(User).default([]),
  web_url: z.string().optional(),
  updated_at: z.string().optional(),
  state: z.string().optional(),
}).passthrough()
const Note = z.object({ id: z.number().int(), body: z.string(), type: z.string().nullable().optional(), system: z.boolean().optional(), author: z.object({ username: z.string() }).passthrough().nullable().optional(), created_at: z.string().optional(), updated_at: z.string().optional(), resolved: z.boolean().optional(), position: z.object({ new_path: z.string().nullable().optional(), new_line: z.number().int().nullable().optional() }).passthrough().nullable().optional() }).passthrough()
const Discussion = z.object({ id: z.string(), individual_note: z.boolean().optional(), notes: z.array(z.unknown()) }).passthrough()

/**
 * A bot author: GitLab's own `author.bot`, or a login that names one (project/group access-token bots are `project_<id>_bot_…`
 * and `group_<id>_bot_…`; Renovate and Dependabot run as ordinary users with those names).
 */
export const gitlabIsBot = (user: { username: string; bot?: boolean | undefined }) =>
  user.bot === true || /^(project|group)_\d+_bot(_|$)|\[bot\]$|-bot$|^(renovate|dependabot)(-|_|\[|$)/i.test(user.username)

/** Facts of one merge request. `base` is the target tip of the MR's diff (`diff_refs.start_sha`); the list has none, so it is "". */
export function gitlabFacts(mr: z.infer<typeof GitlabMergeRequest>): PrFacts {
  return {
    number: mr.iid,
    ...(mr.title !== undefined ? { title: mr.title } : {}),
    ...(typeof mr.description === "string" && mr.description ? { body: mr.description.slice(0, 100_000) } : {}),
    head: mr.diff_refs?.head_sha ?? mr.sha ?? "",
    base: mr.diff_refs?.start_sha ?? "",
    baseRef: mr.target_branch,
    headRef: mr.source_branch,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    labels: mr.labels.map((label) => typeof label === "string" ? label : label.name),
    author: mr.author.username,
    authorIsBot: gitlabIsBot(mr.author),
    fork: mr.source_project_id !== mr.target_project_id,
    ...(typeof mr.allow_collaboration === "boolean" ? { maintainerCanModify: mr.allow_collaboration } : {}),
    requested: mr.reviewers.map((user) => user.username),
    assignees: mr.assignees.map((user) => user.username),
    ...(mr.web_url ? { url: mr.web_url } : {}),
    ...(mr.updated_at ? { updatedAt: mr.updated_at } : {}),
    ...(mr.state ? { open: mr.state === "opened" } : {}),
  }
}

/** Access level → permission (https://docs.gitlab.com/api/project_members/): Maintainer 40 and Owner 50 administer, Developer 30
 * pushes, Reporter 20 and Security Manager 25 read the code; Guest 10 and Planner 15 cannot read a private project's code. */
export const gitlabPermission = (level: number): "admin" | "write" | "read" | "none" => level >= 40 ? "admin" : level >= 30 ? "write" : level >= 20 ? "read" : "none"

const failure = (done: { code: number; out: string; err: string }) => `${done.err}\n${done.out}`
const firstLine = (done: { code: number; out: string; err: string }) => failure(done).split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? `glab exited with ${done.code}`
const isAuth = (done: { code: number; out: string; err: string }) => /\b401\b|unauthori[sz]ed|not logged|auth login|no token|invalid token/i.test(failure(done))
const isNotFound = (done: { code: number; out: string; err: string }) => /\b404\b|not found/i.test(failure(done))
/** GitLab refuses a diff position it cannot map with 400 (`line_code` errors, see issue 296829 referenced from the discussions API). */
const isRefusedPosition = (done: { code: number; out: string; err: string }) => !isAuth(done) && /\b(400|422)\b|line_code|bad request|position/i.test(failure(done)) && !/\b(403|404|429|5\d\d)\b/.test(failure(done))
const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

/** A GitHub-style ```suggestion block over lines `line..endLine` becomes GitLab's ```suggestion:-N+0 anchored on `endLine`. */
export const gitlabSuggestion = (body: string, line: number, endLine?: number) =>
  endLine && endLine > line ? body.replace(/^```suggestion[ \t]*$/gm, `\`\`\`suggestion:-${endLine - line}+0`) : body

const DiffFile = z.object({ old_path: z.string(), new_path: z.string(), diff: z.string(), deleted_file: z.boolean().optional() }).passthrough()

/**
 * Per new path, from `GET …/merge_requests/:iid/diffs` (https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs): the
 * file's old path and every right-side line of its diff, mapped to the old line when it is unchanged context (an added line maps
 * to undefined). A deleted file has no right side.
 */
export function gitlabLineMap(items: readonly unknown[]): Map<string, { oldPath: string; lines: Map<number, number | undefined> }> {
  const map = new Map<string, { oldPath: string; lines: Map<number, number | undefined> }>()
  for (const item of items) {
    const file = DiffFile.safeParse(item)
    if (!file.success || file.data.deleted_file) continue
    const lines = new Map<number, number | undefined>()
    for (const row of parseDiffRows(file.data.diff.replace(/\n$/, "").split("\n"))) {
      if (row.kind === "add" && row.new !== undefined) lines.set(row.new, undefined)
      if (row.kind === "context" && row.new !== undefined) lines.set(row.new, row.old)
    }
    map.set(file.data.new_path, { oldPath: file.data.old_path, lines })
  }
  return map
}

const withMarker = (body: string, marker: string) => body.includes(marker) ? body : `${body}\n\n${marker}`

export function createGitlabProvider({ run, hostname, baseUrl, git }: GitlabDeps): ReviewProvider & Required<Pick<ReviewProvider, "self" | "files" | "comments" | "comment" | "reply" | "markers" | "threads" | "resolve" | "pushTarget">> {
  if (baseUrl !== undefined && !/^https?:\/\/[^/\s]+\/*$/.test(baseUrl)) throw new TypeError(`[PR_REVIEW]: ${JSON.stringify(baseUrl.slice(0, 120))} is not a GitLab base URL`)
  // A host with a port cannot go through `--hostname`; it becomes an https origin, as an http one must be given as `baseUrl`.
  const origin = baseUrl ? baseUrl.replace(/\/+$/, "") : hostname && /:\d+$/.test(hostname) ? `https://${hostname}` : undefined
  const host = !origin && hostname ? ["--hostname", hostname] : []
  const target = (endpoint: string) => origin ? `${origin}/api/v4/${endpoint}` : endpoint
  const project = (repo: string) => `projects/${encodeURIComponent(repo)}`
  const api = (endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST", cwd?: string) =>
    run({ argv: ["api", target(endpoint), "--method", method, ...host, ...(body === undefined ? [] : ["--input", "-"])], ...(body === undefined ? {} : { stdin: JSON.stringify(body) }), ...(cwd ? { cwd } : {}) })

  /** Every page of a list endpoint (`page`/`per_page`; a page shorter than `per_page` is the last). */
  async function pages(endpoint: string, cwd?: string): Promise<{ ok: true; items: unknown[] } | { ok: false; auth: boolean; reason: string }> {
    const items: unknown[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const done = await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`, undefined, "GET", cwd)
      if (done.code === 127) return { ok: false, auth: true, reason: "glab is not installed or not on the daemon's PATH" }
      if (done.code !== 0) return { ok: false, auth: isAuth(done), reason: firstLine(done) }
      const batch = parse(done.out)
      if (!Array.isArray(batch)) return { ok: false, auth: false, reason: "glab returned something that is not a JSON list" }
      items.push(...batch)
      if (batch.length < PER_PAGE) return { ok: true, items }
    }
    return { ok: false, auth: false, reason: `more than ${MAX_PAGES * PER_PAGE} items at ${endpoint}` }
  }

  async function notes(repo: string, number: number) {
    const listed = await pages(`${project(repo)}/merge_requests/${number}/notes?sort=asc&order_by=created_at`)
    if (!listed.ok) return listed
    return { ok: true as const, notes: listed.items.flatMap((item) => { const note = Note.safeParse(item); return note.success ? [note.data] : [] }) }
  }

  async function discussions(repo: string, number: number) {
    const listed = await pages(`${project(repo)}/merge_requests/${number}/discussions`)
    if (!listed.ok) return listed
    return { ok: true as const, items: listed.items.flatMap((item) => { const thread = Discussion.safeParse(item); return thread.success ? [thread.data] : [] }) }
  }

  async function view({ directory, repo, number }: { directory?: string; repo: string; number: number }): Promise<PrFacts> {
    const done = await api(`${project(repo)}/merge_requests/${number}`, undefined, "GET", directory)
    const mr = done.code === 0 ? GitlabMergeRequest.safeParse(parse(done.out)) : undefined
    if (!mr?.success) throw new Error(`[PR_REVIEW]: glab could not read merge request !${number} of ${repo} (${done.code === 0 ? "not a merge request" : firstLine(done)})`)
    return gitlabFacts(mr.data)
  }

  return {
    kind: "gitlab",
    capabilities: PROVIDER_CAPABILITIES.gitlab,
    repoOf: (directory) => remoteRepoOf({ directory, git, provider: "gitlab" }),
    headRef: (number) => `refs/merge-requests/${number}/head`,
    view,

    async listOpen({ directory, repo }) {
      // `with_labels_details=true` is what makes GitLab skip its cached list (lib/api/merge_requests.rb, `render_merge_requests`,
      // up to 8 hours keyed on the MR's `updated_at`): a push does not change `updated_at`, and live on 19.5.3 the cached `sha`
      // stayed on the old head while the single merge request and refs/merge-requests/N/head had the new one.
      const listed = await pages(`${project(repo)}/merge_requests?state=opened&order_by=updated_at&with_labels_details=true`, directory)
      if (!listed.ok) return listed
      const prs: PrFacts[] = []
      for (const item of listed.items) {
        const mr = GitlabMergeRequest.safeParse(item)
        if (!mr.success) return { ok: false, auth: false, reason: "glab returned a merge request this adapter cannot read" }
        prs.push(gitlabFacts(mr.data))
      }
      return { ok: true, prs }
    },

    async publish({ repo, number, head, body, comments, marker }) {
      let current: PrFacts
      let refs: z.infer<typeof DiffRefs> | null | undefined
      {
        const done = await api(`${project(repo)}/merge_requests/${number}`)
        const mr = done.code === 0 ? GitlabMergeRequest.safeParse(parse(done.out)) : undefined
        if (!mr?.success) return { ok: false, reason: `GitLab did not return merge request !${number} (${done.code === 0 ? "unreadable" : firstLine(done)})`, retryable: done.code !== 0 && !isAuth(done) && !isNotFound(done) }
        current = gitlabFacts(mr.data)
        refs = mr.data.diff_refs
      }
      if (current.head !== head) return { ok: false, reason: `the merge request's head moved to ${current.head.slice(0, 12)} after ${head.slice(0, 12)} was reviewed; nothing was posted`, retryable: false }
      const existing = await notes(repo, number)
      if (!existing.ok) return { ok: false, reason: `GitLab notes could not be read (${existing.reason})`, retryable: !existing.auth }
      const summary = existing.notes.find((note) => note.type !== "DiffNote" && note.body.includes(marker))
      const posted = new Set(existing.notes.filter((note) => note.type === "DiffNote" && note.body.includes(marker)).map((note) => note.body.trim()))
      if (summary) return { ok: true, remote: `note:${summary.id}`, comments: posted.size, movedToBody: 0, duplicate: true }
      if (comments.length && !(refs?.base_sha && refs.start_sha && refs.head_sha)) return { ok: false, reason: `merge request !${number} has no diff_refs yet (GitLab is still preparing its diff)`, retryable: true }

      const moved: typeof comments = []
      let inline = 0
      // The merge request's own diff says which lines take a comment and what an unchanged line was called before: GitLab 19.5
      // refuses a context line given by `new_line` alone (400 `line_code can't be blank`) and needs the file's old path on a rename.
      // Unreadable, every comment is tried as it is and a refusal moves it into the summary.
      const map = comments.length ? await (async () => { const listed = await pages(`${project(repo)}/merge_requests/${number}/diffs`); return listed.ok ? gitlabLineMap(listed.items) : undefined })() : undefined
      for (const comment of comments) {
        const text = withMarker(gitlabSuggestion(comment.body, comment.line, comment.endLine), marker)
        if (posted.has(text.trim())) { inline++; continue }
        const anchor = comment.endLine && comment.endLine > comment.line ? comment.endLine : comment.line
        const file = map?.get(comment.path)
        if (map && (!file || !Array.from({ length: anchor - comment.line + 1 }, (_, at) => comment.line + at).every((line) => file.lines.has(line)))) { moved.push(comment); continue }
        const old = file?.lines.get(anchor)
        const position = { position_type: "text", base_sha: refs!.base_sha, start_sha: refs!.start_sha, head_sha: refs!.head_sha, old_path: file?.oldPath ?? comment.path, new_path: comment.path, new_line: anchor, ...(old !== undefined ? { old_line: old } : {}) }
        const done = await api(`${project(repo)}/merge_requests/${number}/discussions`, { body: text, position })
        if (done.code === 0) { inline++; continue }
        if (isRefusedPosition(done)) { moved.push(comment); continue }
        return { ok: false, reason: `GitLab refused an inline comment (${firstLine(done)}); ${inline} of ${comments.length} were posted and the summary was not`, retryable: !isAuth(done) }
      }
      const movedText = moved.length ? `\n\n---\n**Comments GitLab could not place on the diff**\n\n${moved.map((comment) => `**\`${comment.path}\` line ${comment.line}${comment.endLine && comment.endLine > comment.line ? `–${comment.endLine}` : ""}**\n\n${comment.body}`).join("\n\n")}` : ""
      const note = await api(`${project(repo)}/merge_requests/${number}/notes`, { body: withMarker(`${body}${movedText}`, marker) })
      const id = (parse(note.out) as { id?: unknown } | undefined)?.id
      if (note.code !== 0) return { ok: false, reason: `GitLab refused the summary note (${firstLine(note)}); ${inline} inline comment${inline === 1 ? " was" : "s were"} posted`, retryable: !isAuth(note) }
      return { ok: true, remote: `note:${typeof id === "number" ? id : "unknown"}`, comments: inline, movedToBody: moved.length }
    },

    async findMarker({ repo, number, marker }) {
      const found = await notes(repo, number)
      if (!found.ok) throw new Error(`[PR_REVIEW]: GitLab notes of !${number} could not be read (${found.reason})`)
      const note = found.notes.find((item) => item.type !== "DiffNote" && item.body.includes(marker))
      return note ? { found: true, remote: `note:${note.id}` } : { found: false }
    },

    async permission({ repo, login }) {
      const users = await api(`users?username=${encodeURIComponent(login)}`)
      const list = users.code === 0 ? parse(users.out) : undefined
      if (!Array.isArray(list)) return "unknown"
      const id = (list[0] as { id?: unknown } | undefined)?.id
      if (typeof id !== "number") return "none"
      const member = await api(`${project(repo)}/members/all/${id}`)
      if (member.code !== 0) return isNotFound(member) ? "none" : "unknown"
      const level = (parse(member.out) as { access_level?: unknown } | undefined)?.access_level
      return typeof level === "number" ? gitlabPermission(level) : "unknown"
    },

    /** Resolves one diff discussion (`PUT …/discussions/:id?resolved=true`); GitLab lets Developers and the MR author do it. */
    async resolve({ repo, number, discussion }) {
      if (!DISCUSSION_ID.test(discussion)) throw new TypeError(`[PR_REVIEW]: ${JSON.stringify(discussion.slice(0, 80))} is not a GitLab discussion id`)
      const done = await api(`${project(repo)}/merge_requests/${number}/discussions/${discussion}?resolved=true`, undefined, "PUT")
      return done.code === 0
    },

    async self() {
      const done = await api("user")
      const name = done.code === 0 ? (parse(done.out) as { username?: unknown } | undefined)?.username : undefined
      return typeof name === "string" && name.length > 0 && name.length <= 255 ? name : undefined
    },

    /** `GET …/merge_requests/:iid/diffs`: every new path (a deleted file by its old path). */
    async files({ repo, number }) {
      const listed = await pages(`${project(repo)}/merge_requests/${number}/diffs`)
      if (!listed.ok) return undefined
      return listed.items.flatMap((item) => { const file = DiffFile.safeParse(item); return file.success ? [file.data.deleted_file ? file.data.old_path : file.data.new_path] : [] })
    },

    /**
     * `GET …/merge_requests/:iid/discussions`: every note but GitLab's system notes. A diff note is `review` and answers its
     * discussion's first note; a note in a thread started on the conversation keeps its discussion, so a reply goes there too.
     */
    async comments({ repo, number }) {
      const threads = await discussions(repo, number)
      if (!threads.ok) return { ok: false, reason: threads.reason }
      const comments: ForgeComment[] = []
      for (const thread of threads.items) {
        const notes = thread.notes.flatMap((item) => { const note = Note.safeParse(item); return note.success ? [note.data] : [] })
        const first = notes[0]
        for (const note of notes) {
          if (note.system || !note.author?.username) continue
          const diff = note.type === "DiffNote" || first?.type === "DiffNote"
          const position = note.position ?? first?.position
          comments.push({
            id: note.id, author: note.author.username, body: note.body, surface: diff ? "review" : "issue",
            ...(note.created_at ? { createdAt: note.created_at } : {}), ...(note.updated_at ? { updatedAt: note.updated_at } : {}),
            ...(thread.individual_note ? {} : { discussion: thread.id }),
            ...(diff && first && first.id !== note.id ? { inReplyTo: first.id } : {}),
            ...(position?.new_path ? { path: position.new_path } : {}), ...(typeof position?.new_line === "number" ? { line: position.new_line } : {}),
          })
        }
      }
      return { ok: true, comments }
    },

    /** `POST …/notes`, or `PUT …/notes/:id` for `edit`. */
    async comment({ repo, number, body, edit }) {
      const done = await api(`${project(repo)}/merge_requests/${number}/notes${edit === undefined ? "" : `/${edit}`}`, { body }, edit === undefined ? "POST" : "PUT")
      const id = (parse(done.out) as { id?: unknown } | undefined)?.id
      return done.code === 0 && typeof id === "number" ? { ok: true, id } : { ok: false, reason: done.code === 0 ? "GitLab returned no note id" : firstLine(done) }
    },

    /** `POST …/discussions/:id/notes` in the comment's own thread; a lone conversation note is answered with a new note. */
    async reply({ repo, number, to, body }) {
      const thread = to.discussion && DISCUSSION_ID.test(to.discussion) ? to.discussion : undefined
      const done = await api(thread ? `${project(repo)}/merge_requests/${number}/discussions/${thread}/notes` : `${project(repo)}/merge_requests/${number}/notes`, { body })
      const id = (parse(done.out) as { id?: unknown } | undefined)?.id
      return done.code === 0 && typeof id === "number" ? { ok: true, id } : { ok: false, reason: done.code === 0 ? "GitLab returned no note id" : firstLine(done) }
    },

    /** The merge request's conversation notes with their authors: a review summary is one of them (no commit is recorded). */
    async markers({ repo, number }) {
      const listed = await notes(repo, number)
      if (!listed.ok) return { ok: false, reason: listed.reason }
      return { ok: true, posts: listed.notes.flatMap((note) => note.type !== "DiffNote" && !note.system && note.author?.username ? [{ id: note.id, author: note.author.username, body: note.body }] : []) }
    },

    async threads({ repo, number }) {
      const listed = await discussions(repo, number)
      if (!listed.ok) return undefined
      return listed.items.flatMap((thread) => {
        const first = Note.safeParse(thread.notes[0])
        return first.success && first.data.type === "DiffNote" ? [{ id: thread.id, resolved: first.data.resolved === true, body: first.data.body }] : []
      })
    },

    /** The source branch and project of the merge request; a fork takes a push only with `allow_collaboration`. */
    async pushTarget({ repo, number }) {
      const done = await api(`${project(repo)}/merge_requests/${number}`)
      const mr = done.code === 0 ? GitlabMergeRequest.safeParse(parse(done.out)) : undefined
      if (!mr?.success) throw new Error(`[PR_REVIEW]: glab could not read merge request !${number} of ${repo} (${done.code === 0 ? "not a merge request" : firstLine(done)})`)
      const facts = gitlabFacts(mr.data)
      const fork = mr.data.source_project_id !== mr.data.target_project_id
      let source = repo
      if (fork) {
        const read = await api(`projects/${mr.data.source_project_id}`)
        const name = read.code === 0 ? (parse(read.out) as { path_with_namespace?: unknown } | undefined)?.path_with_namespace : undefined
        if (typeof name !== "string" || name.split("/").length < 2) throw new Error(`[PR_REVIEW]: glab could not read the source project of merge request !${number} (${read.code === 0 ? "no path" : firstLine(read)})`)
        source = name
      }
      return { branch: facts.headRef, head: facts.head, base: facts.base, baseRef: facts.baseRef, repo: source, fork, pushable: !fork || mr.data.allow_collaboration === true }
    },
  }
}
const DISCUSSION_ID = /^[0-9a-f]{1,64}$/i
