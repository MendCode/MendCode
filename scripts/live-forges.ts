// Live check of the GitLab and Gitea review adapters (docs/pr-review.md, providers) against real, self-hosted instances.
//   MENDCODE_LIVE_FORGES=write bun scripts/live-forges.ts [--forge gitea|gitlab|all] [--daemon] [--out evidence.json]
// `--daemon` runs the daemon-level flow instead (watch, review post, dedupe, mentions, fix push; see "Daemon level" below).
// Without MENDCODE_LIVE_FORGES=write it prints why it skipped and exits 0: it is never part of the normal suite, and it WRITES to the
// repository it is pointed at (notes, reviews, one comment, pushed commits), so point it only at a throwaway instance.
//
// Gitea / Forgejo:
//   MENDCODE_LIVE_GITEA_URL       web origin, e.g. http://127.0.0.1:3917
//   MENDCODE_LIVE_GITEA_REPO      owner/repo with an open same-repository PR and an open PR from a fork that allows maintainer edits
//   GITEA_TOKEN                   the reviewer's token (a repository admin), read by the adapter as the daemon would
//   MENDCODE_LIVE_GITEA_ACTOR_TOKEN   a second user's token, who writes the "@mendcode" mention the harness then reads
//   MENDCODE_LIVE_GITEA_READER    a login with read access only (expected permission "read")
//   MENDCODE_LIVE_GITEA_ADMIN     a login that administers the repository (default: the owner segment of the repo)
// GitLab (through the user's `glab`, as the adapter runs it; give glab a throwaway GLAB_CONFIG_DIR):
//   MENDCODE_LIVE_GITLAB_HOST     host[:port] of the instance, e.g. 127.0.0.1:8929 (the adapter gets it as `baseUrl`)
//   MENDCODE_LIVE_GITLAB_PROTOCOL http or https (default https), for git URLs
//   MENDCODE_LIVE_GITLAB_REPO     group/project with an open same-project MR and an open MR from a fork with allow_collaboration
//   GITLAB_TOKEN                  the reviewer's token (a Maintainer), read by glab itself
//   MENDCODE_LIVE_GITLAB_ACTOR_TOKEN  a second user's token, who writes the "@mendcode" mention
//   MENDCODE_LIVE_GITLAB_READER   a login with Reporter access (expected permission "read")
//   MENDCODE_LIVE_GITLAB_ADMIN    a login with Maintainer or Owner access (default: the first segment of the project path)
// Every step records the request it made and what came back; token values are replaced by "[token]" in everything recorded.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandRun, PrFacts, ReviewProvider } from "../packages/daemon/src/pr-review/contracts"
import { parseUnifiedDiff } from "../packages/daemon/src/pr-review/context"
import { createGiteaProvider, tokenFromEnv } from "../packages/daemon/src/pr-review/providers/gitea"
import { createGitlabProvider } from "../packages/daemon/src/pr-review/providers/gitlab"

type Step = { forge: string; step: string; ok: boolean; request: string; response: unknown }
const steps: Step[] = []
const secrets = () => [process.env.GITEA_TOKEN, process.env.MENDCODE_LIVE_GITEA_ACTOR_TOKEN, process.env.MENDCODE_LIVE_GITEA_READER_TOKEN, process.env.GITLAB_TOKEN, process.env.MENDCODE_LIVE_GITLAB_ACTOR_TOKEN, process.env.MENDCODE_LIVE_GITLAB_READER_TOKEN].filter((value): value is string => !!value && value.length >= 8)
const redact = (value: unknown): unknown => { let text = JSON.stringify(value) ?? "null"; for (const secret of secrets()) text = text.split(secret).join("[token]"); return JSON.parse(text) }
function record(forge: string, step: string, ok: boolean, request: string, response: unknown) {
  const entry = redact({ forge, step, ok, request, response }) as Step
  steps.push(entry)
  console.log(`${ok ? "PASS" : "FAIL"} ${forge} ${step}: ${request}\n     ${JSON.stringify(entry.response).slice(0, 400)}`)
}
const SHA = /^[0-9a-f]{40}$/

async function git(args: string[], cwd: string, header?: string) {
  const child = Bun.spawn(["git", ...(header ? ["-c", `http.extraHeader=${header}`] : []), "-c", "user.name=mendcode-live", "-c", "user.email=live@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}
const glab: CommandRun = async ({ argv, cwd, stdin }) => {
  const child = Bun.spawn(["glab", ...argv], { ...(cwd ? { cwd } : {}), stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}

/** What differs between the forges outside the ReviewProvider contract: raw calls the daemon's seams would make. */
type Forge = {
  name: "gitea" | "gitlab"
  provider: ReviewProvider & { resolve?: (input: { repo: string; number: number; discussion: string }) => Promise<boolean> }
  repo: string
  version(): Promise<unknown>
  cloneUrl(repo: string): string
  gitHeader: string
  apiDiff(number: number): Promise<string>
  /** The fork's repository path of a PR from a fork. */
  forkRepo(number: number): Promise<string>
  mention(number: number, body: string): Promise<{ ok: boolean; id?: number; response: unknown }>
  comments(number: number): Promise<Array<{ id: number; author: string; body: string; discussion?: string; diff?: boolean }>>
  reply(number: number, to: { id: number; discussion?: string }, body: string): Promise<{ ok: boolean; response: unknown }>
  /** A thread resolution outside the adapter (Gitea), when the adapter has no `resolve`. */
  resolveRaw?(number: number, to: { id: number }): Promise<{ ok: boolean; response: unknown }>
  /** A login expected to administer the repository (default: the repository path's first segment). */
  admin: string
  reader: string
}

function giteaForge(): Forge | string {
  const baseUrl = process.env.MENDCODE_LIVE_GITEA_URL, repo = process.env.MENDCODE_LIVE_GITEA_REPO, token = process.env.GITEA_TOKEN, actor = process.env.MENDCODE_LIVE_GITEA_ACTOR_TOKEN
  if (!baseUrl || !repo || !token || !actor) return "MENDCODE_LIVE_GITEA_URL, MENDCODE_LIVE_GITEA_REPO, GITEA_TOKEN and MENDCODE_LIVE_GITEA_ACTOR_TOKEN are needed"
  const origin = baseUrl.replace(/\/+$/, "")
  const call = async (pathname: string, init: { method?: string; body?: unknown; as?: string } = {}) => {
    const response = await fetch(`${origin}/api/v1/${pathname}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: { authorization: `token ${init.as ?? token}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const text = await response.text()
    try { return { status: response.status, json: JSON.parse(text) as any, text } } catch { return { status: response.status, json: undefined as any, text } }
  }
  return {
    name: "gitea", repo, admin: process.env.MENDCODE_LIVE_GITEA_ADMIN ?? "", reader: process.env.MENDCODE_LIVE_GITEA_READER ?? "",
    provider: createGiteaProvider({ baseUrl: origin, token: tokenFromEnv("GITEA_TOKEN") }),
    version: async () => (await call("version")).json,
    cloneUrl: (path) => `${origin}/${path}.git`,
    gitHeader: `Authorization: token ${token}`,
    apiDiff: async (number) => (await call(`repos/${repo}/pulls/${number}.diff`)).text,
    forkRepo: async (number) => (await call(`repos/${repo}/pulls/${number}`)).json.head.repo.full_name,
    async mention(number, body) { const done = await call(`repos/${repo}/issues/${number}/comments`, { body: { body }, as: actor }); return { ok: done.status === 201, id: done.json?.id, response: { status: done.status, id: done.json?.id, user: done.json?.user?.login } } },
    async comments(number) {
      const issue = await call(`repos/${repo}/issues/${number}/comments`)
      const reviews = await call(`repos/${repo}/pulls/${number}/reviews`)
      const inline: any[] = []
      for (const review of reviews.json ?? []) inline.push(...((await call(`repos/${repo}/pulls/${number}/reviews/${review.id}/comments`)).json ?? []))
      // A review's body is the summary; its id space is the reviews', so it is keyed apart from issue comments.
      return [...(issue.json ?? []).map((c: any) => ({ id: c.id, author: c.user.login, body: c.body })), ...(reviews.json ?? []).map((r: any) => ({ id: -r.id, author: r.user?.login ?? "", body: r.body ?? "" })), ...inline.map((c: any) => ({ id: c.id, author: c.user.login, body: c.body, diff: true }))]
    },
    /** `POST …/pulls/{index}/comments/{id}/replies` (in this instance's swagger; not in Forgejo's). */
    async reply(number, to, body) { const done = await call(`repos/${repo}/pulls/${number}/comments/${to.id}/replies`, { body: { body } }); return { ok: done.status === 201, response: { status: done.status, id: done.json?.id, path: done.json?.path, in_reply_to: to.id } } },
    async resolveRaw(_number, to) { const done = await call(`repos/${repo}/pulls/comments/${to.id}/resolve`, { method: "POST" }); return { ok: done.status === 204, response: { status: done.status, text: done.text.slice(0, 160) } } },
  }
}

function gitlabForge(): Forge | string {
  const host = process.env.MENDCODE_LIVE_GITLAB_HOST, repo = process.env.MENDCODE_LIVE_GITLAB_REPO, token = process.env.GITLAB_TOKEN, actor = process.env.MENDCODE_LIVE_GITLAB_ACTOR_TOKEN
  if (!host || !repo || !token || !actor) return "MENDCODE_LIVE_GITLAB_HOST, MENDCODE_LIVE_GITLAB_REPO, GITLAB_TOKEN and MENDCODE_LIVE_GITLAB_ACTOR_TOKEN are needed"
  const protocol = process.env.MENDCODE_LIVE_GITLAB_PROTOCOL === "http" ? "http" : "https"
  const origin = `${protocol}://${host}`
  const project = `projects/${encodeURIComponent(repo)}`
  // Full API URLs, as the adapter makes them with `baseUrl`: glab refuses `--hostname host:port`.
  const api = async (endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const done = await glab({ argv: ["api", `${origin}/api/v4/${endpoint}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], ...(body === undefined ? {} : { stdin: JSON.stringify(body) }) })
    try { return { code: done.code, json: JSON.parse(done.out) as any, out: done.out, err: done.err } } catch { return { code: done.code, json: undefined as any, out: done.out, err: done.err } }
  }
  /** The actor writes with plain HTTP and its own token: glab holds one login, the reviewer's. */
  const asActor = async (endpoint: string, body: unknown) => {
    const response = await fetch(`${protocol}://${host}/api/v4/${endpoint}`, { method: "POST", headers: { "private-token": actor, "content-type": "application/json" }, body: JSON.stringify(body) })
    return { status: response.status, json: await response.json().catch(() => undefined) as any }
  }
  return {
    name: "gitlab", repo, admin: process.env.MENDCODE_LIVE_GITLAB_ADMIN ?? "", reader: process.env.MENDCODE_LIVE_GITLAB_READER ?? "",
    provider: createGitlabProvider({ run: glab, baseUrl: origin }),
    version: async () => (await api("version")).json,
    cloneUrl: (path) => `${protocol}://${host}/${path}.git`,
    gitHeader: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
    apiDiff: async (number) => { const done = await api(`${project}/merge_requests/${number}/raw_diffs`); return done.code === 0 ? done.out : `glab exited ${done.code}: ${done.err.slice(0, 200)}` },
    forkRepo: async (number) => { const mr = (await api(`${project}/merge_requests/${number}`)).json; return (await api(`projects/${mr.source_project_id}`)).json.path_with_namespace },
    async mention(number, body) { const done = await asActor(`${project}/merge_requests/${number}/notes`, { body }); return { ok: done.status === 201, id: done.json?.id, response: { status: done.status, id: done.json?.id, author: done.json?.author?.username } } },
    async comments(number) {
      const done = await api(`${project}/merge_requests/${number}/discussions?per_page=100`)
      return (done.json ?? []).flatMap((discussion: any) => discussion.notes.filter((note: any) => !note.system).map((note: any) => ({ id: note.id, author: note.author.username, body: note.body, discussion: discussion.id, diff: note.type === "DiffNote" })))
    },
    async reply(number, to, body) { const done = await api(`${project}/merge_requests/${number}/discussions/${to.discussion}/notes`, { body }); return { ok: done.code === 0, response: { code: done.code, id: done.json?.id, discussion: to.discussion, err: done.code ? done.err.slice(0, 200) : undefined } } },
  }
}

async function check(forge: Forge) {
  const f = forge.name, p = forge.provider, repo = forge.repo
  const work = mkdtempSync(path.join(tmpdir(), `mendcode-live-${f}-`))
  try {
    record(f, "server version", true, f === "gitea" ? "GET /api/v1/version" : "glab api version", await forge.version())
    record(f, "capabilities", true, "provider.capabilities", p.capabilities)

    const listed = await p.listOpen({ directory: work, repo })
    if (!listed.ok) { record(f, "listOpen", false, `listOpen ${repo}`, listed); return }
    const shasOk = listed.prs.length >= 2 && listed.prs.every((pr) => SHA.test(pr.head))
    record(f, "listOpen", shasOk, `listOpen ${repo}`, listed.prs.map((pr) => ({ number: pr.number, head: pr.head, base: pr.base, headRef: pr.headRef, baseRef: pr.baseRef, fork: pr.fork, draft: pr.draft, author: pr.author, maintainerCanModify: pr.maintainerCanModify })))
    const same = listed.prs.find((pr) => !pr.fork), fork = listed.prs.find((pr) => pr.fork)
    if (!same || !fork) { record(f, "fixture", false, "one same-repository and one fork PR", { same: !!same, fork: !!fork }); return }

    const viewed = await p.view({ directory: work, repo, number: same.number })
    record(f, "view", viewed.head === same.head && SHA.test(viewed.base), `view #${same.number}`, { head: viewed.head, base: viewed.base, listedBase: same.base })

    // Diff: the daemon fetches the head ref into the checkout and diffs locally; the API diff is compared with it.
    const clone = path.join(work, "clone")
    const cloned = await git(["clone", "-q", forge.cloneUrl(repo), clone], work, forge.gitHeader)
    const fetched = await git(["fetch", "-q", "origin", `+${p.headRef(same.number)}:refs/remotes/review/${same.number}`, `+${p.headRef(fork.number)}:refs/remotes/review/${fork.number}`], clone, forge.gitHeader)
    const head = await git(["rev-parse", `refs/remotes/review/${same.number}`], clone)
    const forkHead = await git(["rev-parse", `refs/remotes/review/${fork.number}`], clone)
    record(f, "fetch head refs", cloned.code === 0 && fetched.code === 0 && head.out.trim() === same.head && forkHead.out.trim() === fork.head, `git fetch origin ${p.headRef(same.number)} ${p.headRef(fork.number)}`, { clone: cloned.code, fetch: fetched.code, err: fetched.err.slice(0, 200), sameHead: head.out.trim(), forkHead: forkHead.out.trim() })
    const named = await p.repoOf(clone).catch((error: unknown) => error instanceof Error ? error.message : String(error))
    record(f, "repoOf", named === repo, "repoOf(a clone of the repository)", { repoOf: named })
    const local = await git(["diff", `${viewed.base}...${viewed.head}`], clone)
    const files = parseUnifiedDiff(local.out)
    const apiDiff = await forge.apiDiff(same.number)
    const apiFiles = parseUnifiedDiff(apiDiff).map((file) => file.path)
    record(f, "fetch diff", local.code === 0 && files.length > 0 && files.every((file) => apiFiles.includes(file.path)), `git diff base...head; API diff of #${same.number}`, { localFiles: files.map((file) => file.path), apiFiles, apiBytes: apiDiff.length })

    // Publish: a changed line, a range (a suggestion where supported), an unchanged context line of the hunk, and a line outside
    // the diff, which must end up in the summary instead of on no line at all.
    const file = files.find((entry) => entry.touched.length && [...entry.right].some((at) => !entry.touched.includes(at)))!
    const line = file.touched[0]!
    const context = [...file.right].find((at) => !file.touched.includes(at))!
    const marker = `<!-- mendcode:live run=${Date.now().toString(36)} forge=${f} -->`
    const comments = [
      { path: file.path, line, body: "Live check: an inline comment on a changed line." },
      { path: file.path, line: Math.max(1, line - 1), endLine: line, body: p.capabilities.suggestions ? "Live check: a range with a suggestion.\n\n```suggestion\n// suggested line one\n// suggested line two\n```" : "Live check: a range comment." },
      { path: file.path, line: context, body: "Live check: an unchanged context line of the hunk." },
      { path: file.path, line: 9999, body: "Live check: a line outside the diff, which the forge must refuse and the summary must carry." },
    ]
    const before = await forge.comments(same.number)
    const stale = await p.publish({ repo, number: same.number, head: "0".repeat(40), body: "Live check: must not be posted.", comments, marker })
    record(f, "publish refuses a moved head", !stale.ok && !stale.retryable, "publish with head 000…", stale)
    const first = await p.publish({ repo, number: same.number, head: same.head, body: `Live check summary from scripts/live-forges.ts.`, comments, marker })
    const afterFirst = await forge.comments(same.number)
    const known = new Set(before.map((comment) => `${comment.diff ? "d" : "c"}${comment.id}`))
    const mine = afterFirst.filter((comment) => !known.has(`${comment.diff ? "d" : "c"}${comment.id}`))
    const summaryCarries = mine.some((comment) => !comment.diff && comment.body.includes(marker) && comment.body.includes("line 9999"))
    record(f, "publish summary + inline", first.ok && first.comments === 3 && first.movedToBody === 1 && summaryCarries && mine.filter((comment) => comment.diff).length === 3, `publish #${same.number} with 4 comments (lines ${line}, ${line - 1}-${line}, context ${context}, 9999)`,{ result: first, posted: mine.map((comment) => ({ id: comment.id, diff: !!comment.diff, discussion: comment.discussion, body: comment.body.slice(0, 160) })) })
    const again = await p.publish({ repo, number: same.number, head: same.head, body: `Live check summary from scripts/live-forges.ts.`, comments, marker })
    const afterAgain = await forge.comments(same.number)
    record(f, "publish is idempotent by marker", again.ok && first.ok && again.remote === first.remote && afterAgain.length === afterFirst.length, "publish the same marker again", { result: again, commentsBefore: afterFirst.length, commentsAfter: afterAgain.length })
    const found = await p.findMarker({ repo, number: same.number, marker })
    const missing = await p.findMarker({ repo, number: same.number, marker: "<!-- mendcode:live run=never -->" })
    record(f, "findMarker", found.found && !missing.found && first.ok && found.remote === first.remote, "findMarker posted / never posted", { found, missing })

    // Mentions: a second user writes "@mendcode review"; the reviewer reads it back with its author.
    const mention = await forge.mention(same.number, "@mendcode review please (live check)")
    const read = (await forge.comments(same.number)).find((comment) => comment.id === mention.id)
    record(f, "read comments/mentions", mention.ok && !!read && /@mendcode\b/.test(read.body), "actor posts @mendcode; reviewer lists comments", { posted: mention.response, readBack: read && { id: read.id, author: read.author, body: read.body } })

    const inline = mine.find((comment) => comment.diff)
    if (inline) {
      const reply = await forge.reply(same.number, inline, `Live check reply. ${marker.replace("live run", "live reply")}`)
      record(f, "reply", reply.ok, f === "gitlab" ? "POST …/discussions/:id/notes" : "POST …/pulls/:n/comments/:id/replies", reply.response)
      if (forge.provider.resolve && inline.discussion) {
        const resolved = await forge.provider.resolve({ repo, number: same.number, discussion: inline.discussion })
        record(f, "resolve thread", resolved, `provider.resolve discussion ${inline.discussion}`, { resolved })
      } else if (forge.resolveRaw) {
        const resolved = await forge.resolveRaw(same.number, inline)
        record(f, "resolve thread (raw API, not in the adapter)", resolved.ok, `POST …/pulls/comments/${inline.id}/resolve`, resolved.response)
      }
    }

    for (const login of [forge.reader, fork.author, `no-such-user-${Date.now().toString(36)}`]) {
      if (!login) continue
      const level = await p.permission({ repo, login })
      // A user who is not a member may still read a public repository: "read" or "none" are both truthful, never more.
      const expected = login === forge.reader ? level === "read" : login === fork.author ? level === "read" || level === "none" : level === "none"
      record(f, `permission ${login === forge.reader ? "reader" : login === fork.author ? "fork author (not a member)" : "unknown user"}`, expected, `permission ${login}`, { login, level })
    }
    const owner = forge.admin || repo.split("/")[0]!
    const ownerLevel = await p.permission({ repo, login: owner })
    record(f, "permission owner", ownerLevel === "admin", `permission ${owner}`, { login: owner, level: ownerLevel })

    // Pushes: a commit to the same-repository branch, then to the fork's branch, which the fork allows for maintainers.
    for (const [pr, target] of [[same, repo], [fork, await forge.forkRepo(fork.number)]] as Array<[PrFacts, string]>) {
      await git(["checkout", "-q", "--detach", `refs/remotes/review/${pr.number}`], clone)
      await git(["commit", "-q", "--allow-empty", "-m", `live check push ${Date.now()}`], clone)
      const sha = (await git(["rev-parse", "HEAD"], clone)).out.trim()
      const pushed = await git(["push", "-q", forge.cloneUrl(target), `HEAD:refs/heads/${pr.headRef}`], clone, forge.gitHeader)
      let moved = ""
      for (let i = 0; i < 20 && moved !== sha; i++) { moved = (await p.view({ directory: work, repo, number: pr.number })).head; if (moved !== sha) await Bun.sleep(1500) }
      record(f, pr.fork ? "push to fork branch" : "push to branch", pushed.code === 0 && moved === sha, `git push ${target} HEAD:${pr.headRef}`, { pushed: pushed.code, err: pushed.err.slice(0, 200), sha, prHead: moved })
    }
  } catch (error) {
    record(f, "harness", false, "unexpected error", error instanceof Error ? error.message : String(error))
  } finally { rmSync(work, { recursive: true, force: true }) }
}

// ── Daemon level (`--daemon`) ─────────────────────────────────────────────────────────────────────────────────────────────
//
// One flow per forge through the real daemon (startDaemon in this process, its socket, the faux engine for sessions) and the real
// adapters: watch-repo → a PR opened by a writer → one review job → one review post → no second post of the same head (another
// poll and a manual /pr review) → a reader's `@mendcode pause` refused in the PR → a writer's `@mendcode fix` pushed to the branch
// and answered. Review and fix children are scripted (`prReview.sessions`): the faux engine echoes every prompt, which never parses
// as findings, so nothing would be posted; no model is called either way. Extra environment, per forge:
//   MENDCODE_LIVE_<FORGE>_DAEMON_REPO   a repository whose main has `.mendcode/review.yaml` with `enabled: true` and `fixes: true`
//   MENDCODE_LIVE_<FORGE>_READER_TOKEN  a reader's token (permission read), whose `@mendcode` must be refused
// The writer is the `ACTOR_TOKEN` user (write access), the reviewer the `GITEA_TOKEN` user / glab's login (admin).

type DaemonForge = {
  name: "gitea" | "gitlab"
  repo: string
  cloneUrl: string
  gitHeader: string
  /** The writer opens PR/MR from a new branch with one file; its number. */
  openPr(branch: string, file: string, content: string): Promise<number>
  /** A conversation comment by the writer or the reader; its id. */
  say(number: number, who: "writer" | "reader", body: string): Promise<number | undefined>
  /** The text of `file` at the tip of `branch`. */
  fileAt(branch: string, file: string): Promise<string | undefined>
  provider: ReviewProvider
}

function giteaDaemon(): DaemonForge | string {
  const baseUrl = process.env.MENDCODE_LIVE_GITEA_URL, repo = process.env.MENDCODE_LIVE_GITEA_DAEMON_REPO, token = process.env.GITEA_TOKEN, writer = process.env.MENDCODE_LIVE_GITEA_ACTOR_TOKEN, reader = process.env.MENDCODE_LIVE_GITEA_READER_TOKEN
  if (!baseUrl || !repo || !token || !writer || !reader) return "MENDCODE_LIVE_GITEA_URL, MENDCODE_LIVE_GITEA_DAEMON_REPO, GITEA_TOKEN, MENDCODE_LIVE_GITEA_ACTOR_TOKEN and MENDCODE_LIVE_GITEA_READER_TOKEN are needed"
  const origin = baseUrl.replace(/\/+$/, "")
  const call = async (pathname: string, as: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${origin}/api/v1/${pathname}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: { authorization: `token ${as}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const text = await response.text()
    try { return { status: response.status, json: JSON.parse(text) as any, text } } catch { return { status: response.status, json: undefined as any, text } }
  }
  return {
    name: "gitea", repo, cloneUrl: `${origin}/${repo}.git`, gitHeader: `Authorization: token ${token}`,
    provider: createGiteaProvider({ baseUrl: origin, token: tokenFromEnv("GITEA_TOKEN") }),
    async openPr(branch, file, content) {
      const made = await call(`repos/${repo}/contents/${file}`, writer, { body: { content: Buffer.from(content).toString("base64"), branch: "main", new_branch: branch, message: `${branch}: ${content.trim()}` } })
      if (made.status !== 201) throw new Error(`creating ${file} on ${branch}: HTTP ${made.status} ${made.text.slice(0, 200)}`)
      const pr = await call(`repos/${repo}/pulls`, writer, { body: { head: branch, base: "main", title: `Live daemon check ${branch}` } })
      if (pr.status !== 201) throw new Error(`opening the PR: HTTP ${pr.status} ${pr.text.slice(0, 200)}`)
      return pr.json.number
    },
    async say(number, who, body) { const done = await call(`repos/${repo}/issues/${number}/comments`, who === "writer" ? writer : reader, { body: { body } }); return done.json?.id },
    async fileAt(branch, file) { const done = await call(`repos/${repo}/raw/${file}?ref=${encodeURIComponent(branch)}`, token); return done.status === 200 ? done.text : undefined },
  }
}

function gitlabDaemon(): DaemonForge | string {
  const host = process.env.MENDCODE_LIVE_GITLAB_HOST, repo = process.env.MENDCODE_LIVE_GITLAB_DAEMON_REPO, token = process.env.GITLAB_TOKEN, writer = process.env.MENDCODE_LIVE_GITLAB_ACTOR_TOKEN, reader = process.env.MENDCODE_LIVE_GITLAB_READER_TOKEN
  if (!host || !repo || !token || !writer || !reader) return "MENDCODE_LIVE_GITLAB_HOST, MENDCODE_LIVE_GITLAB_DAEMON_REPO, GITLAB_TOKEN, MENDCODE_LIVE_GITLAB_ACTOR_TOKEN and MENDCODE_LIVE_GITLAB_READER_TOKEN are needed"
  const protocol = process.env.MENDCODE_LIVE_GITLAB_PROTOCOL === "http" ? "http" : "https"
  const origin = `${protocol}://${host}`
  const project = `projects/${encodeURIComponent(repo)}`
  const call = async (endpoint: string, as: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${origin}/api/v4/${endpoint}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: { "private-token": as, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const text = await response.text()
    try { return { status: response.status, json: JSON.parse(text) as any, text } } catch { return { status: response.status, json: undefined as any, text } }
  }
  return {
    name: "gitlab", repo, cloneUrl: `${origin}/${repo}.git`, gitHeader: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
    provider: createGitlabProvider({ run: glab, baseUrl: origin }),
    async openPr(branch, file, content) {
      const made = await call(`${project}/repository/files/${encodeURIComponent(file)}`, writer, { body: { branch, start_branch: "main", content, commit_message: `${branch}: ${content.trim()}` } })
      if (made.status !== 201) throw new Error(`creating ${file} on ${branch}: HTTP ${made.status} ${made.text.slice(0, 200)}`)
      const mr = await call(`${project}/merge_requests`, writer, { body: { source_branch: branch, target_branch: "main", title: `Live daemon check ${branch}` } })
      if (mr.status !== 201) throw new Error(`opening the MR: HTTP ${mr.status} ${mr.text.slice(0, 200)}`)
      return mr.json.iid
    },
    async say(number, who, body) { const done = await call(`${project}/merge_requests/${number}/notes`, who === "writer" ? writer : reader, { body: { body } }); return done.json?.id },
    async fileAt(branch, file) { const done = await call(`${project}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(branch)}`, token); return done.status === 200 ? done.text : undefined },
  }
}

async function daemonCheck(forge: DaemonForge) {
  const f = `${forge.name} daemon`
  const { startDaemon } = await import("../packages/daemon/src/daemon")
  const { createClient } = await import("../packages/client/src/index")
  const { createFauxEngine } = await import("../packages/engine-faux/src/index")
  const { findingId } = await import("../packages/daemon/src/pr-review/findings")
  const { MAINTAINERS_ONLY } = await import("../packages/daemon/src/pr-review/commands")
  const work = mkdtempSync(path.join(tmpdir(), `mendcode-live-daemon-${forge.name}-`))
  // git's credentials for the daemon's fetch, ls-remote and push: in this process's environment only, never in a file.
  const env = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 }
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: forge.gitHeader })
  const stops: Array<() => unknown> = []
  const branch = `live-${Date.now().toString(36)}`
  const file = `${branch}.ts`
  const wait = async (what: string, check: () => Promise<boolean>, ms = 180_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(1500) } }
  try {
    const clone = path.join(work, "clone")
    const cloned = await git(["clone", "-q", forge.cloneUrl, clone], work)
    const web = new URL(forge.cloneUrl).origin
    await git(["config", "mendcode.forge", forge.name], clone)
    await git(["config", "mendcode.forgeUrl", web], clone)
    record(f, "checkout", cloned.code === 0, `git clone ${forge.cloneUrl}; git config mendcode.forge ${forge.name}; mendcode.forgeUrl ${web}`, { clone: cloned.code, err: cloned.err.slice(0, 200) })
    if (cloned.code !== 0) return

    // Scripted children: a review turn reports one finding on line 1 of the PR's file, a verify turn confirms it, a fix turn edits it.
    const finding = { path: file, line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: [`${file}:1`] }
    const id = findingId({ path: finding.path, line: finding.line, category: finding.category, summary: finding.summary })
    const turns: string[] = []
    const sessions = (_owner: string, directory: string) => async ({ purpose }: { purpose: string }) => ({
      id: `ses_live_${purpose}`,
      async send(prompt: string) {
        const fixing = prompt.startsWith("A maintainer asked for a fix")
        turns.push(fixing ? "fix" : purpose)
        if (fixing) { writeFileSync(path.join(directory, file), "export const one = 1\n"); return { text: "Set one back to 1.", tokens: { input: 1, output: 1 } } }
        return { text: purpose === "verify" ? JSON.stringify({ verdicts: [{ id, verdict: "confirmed", evidence: [`${file}:1 exports 2`] }] }) : JSON.stringify({ summary: "Changes one.", findings: [finding] }), tokens: { input: 1, output: 1 } }
      },
      async close() {},
    })
    const data = path.join(work, "data")
    const daemon = await startDaemon({ dir: data, socketPath: path.join(work, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), prReview: { intervalMs: 5_000, noGraph: true, sessions: sessions as never } })
    stops.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "live-forges" })
    await client.connect()
    stops.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: clone, title: "live" } as never)
    const sessionId = (created.ok ? (created.result as { sessionId: string }).sessionId : "") as never
    await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true } } } as never)
    const pr = async (action: string, extra: Record<string, unknown> = {}) => client.send({ type: "pr.review", sessionId, action, directory: clone, ...extra } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>
    const published = await pr("publish-on")
    const watched = await pr("watch-repo")
    record(f, "watch-repo", watched.ok && /Watching .*\((GitLab|Gitea), /.test(watched.result?.text ?? ""), "pr.review publish-on; watch-repo", { publish: published.ok, text: watched.ok ? watched.result.text : watched.error?.message })
    if (!watched.ok) return

    const number = await forge.openPr(branch, file, "export const one = 2\n")
    const opened = await forge.provider.view({ directory: clone, repo: forge.repo, number })
    const posts = async () => { const read = await forge.provider.markers!({ repo: forge.repo, number }); return read.ok ? read.posts.filter((post) => post.body.includes("<!-- mendcode:reviewer=")) : [] }
    const jobs = async () => ((await pr("status")).result?.dashboard?.jobs ?? []) as Array<{ number: number; state: string; provider: string; head: string; trigger: string }>
    await wait("the review post", async () => (await posts()).length > 0)
    const first = await posts()
    const job = (await jobs()).find((item) => item.number === number)
    record(f, "watch → job → review post", first.length === 1 && first[0]!.body.includes(`<!-- mendcode:review head=${opened.head} -->`) && job?.provider === forge.name && job?.state === "done", `PR #${number} opened by the writer; the daemon polls every 5 s`, { number, head: opened.head, job, posts: first.map((post) => ({ id: post.id, author: post.author, commit: post.commit, body: post.body.slice(0, 200) })), turns: [...turns] })
    const comments = await forge.provider.comments!({ repo: forge.repo, number })
    const inline = comments.ok ? comments.comments.filter((comment) => comment.surface === "review" && comment.body.includes(`<!-- mendcode:f=${id} -->`)) : []
    const claims = comments.ok ? comments.comments.filter((comment) => comment.body.includes("mendcode:claim")) : []
    record(f, "inline comment and claim", inline.length === 1 && claims.length === 1 && /released/.test(claims[0]!.body), "the PR's comments after the review", { inline: inline.map((comment) => ({ id: comment.id, path: comment.path, line: comment.line })), claims: claims.map((comment) => ({ id: comment.id, author: comment.author, body: comment.body.slice(0, 160) })) })

    // The same head: two more polls, then a manual review of it; still one post.
    await Bun.sleep(11_000)
    const manual = await pr("review", { pr: String(number) })
    await wait("the manual review job", async () => (await jobs()).filter((item) => item.number === number && item.state === "done").length >= 2, 120_000)
    const after = await posts()
    record(f, "no second post of the same head", after.length === 1, "two polls and pr.review review on the same head", { manual: manual.ok, posts: after.length, jobs: (await jobs()).filter((item) => item.number === number).map((item) => ({ state: item.state, trigger: item.trigger })) })

    // Mentions: the reader is refused in the PR; the writer's fix is pushed and answered.
    const refusedId = await forge.say(number, "reader", "@mendcode pause")
    const answered = async (commentId: number | undefined) => { const read = await forge.provider.comments!({ repo: forge.repo, number }); return read.ok ? read.comments.find((comment) => comment.body.includes(`<!-- mendcode:answers=${commentId} -->`)) : undefined }
    await wait("the reader's refusal", async () => !!(await answered(refusedId)), 120_000)
    const refusal = await answered(refusedId)
    record(f, "mention by a reader refused", !!refusal?.body.includes(MAINTAINERS_ONLY), "the reader comments @mendcode pause", { comment: refusedId, reply: refusal && { id: refusal.id, author: refusal.author, surface: refusal.surface, body: refusal.body.slice(0, 160) } })
    const fixId = await forge.say(number, "writer", "@mendcode fix set one back to 1")
    await wait("the fix reply", async () => !!(await answered(fixId)), 180_000)
    const fixReply = await answered(fixId)
    const tip = (await forge.provider.view({ directory: clone, repo: forge.repo, number })).head
    const content = await forge.fileAt(branch, file)
    record(f, "mention by a writer: fix pushed and answered", tip !== opened.head && content?.trim() === "export const one = 1" && !!fixReply?.body.includes(`Pushed ${tip.slice(0, 12)}`), "the writer comments @mendcode fix", { comment: fixId, reply: fixReply && { id: fixReply.id, author: fixReply.author, body: fixReply.body.slice(0, 200) }, before: opened.head, after: tip, file: content?.trim(), turns: [...turns] })
    await Bun.sleep(11_000)
    const replies = (await forge.provider.comments!({ repo: forge.repo, number }))
    record(f, "each mention answered once", replies.ok && replies.comments.filter((comment) => comment.body.includes(`<!-- mendcode:answers=${fixId} -->`)).length === 1 && replies.comments.filter((comment) => comment.body.includes(`<!-- mendcode:answers=${refusedId} -->`)).length === 1, "two more polls", { comments: replies.ok ? replies.comments.length : 0 })
  } catch (error) {
    record(f, "harness", false, "unexpected error", error instanceof Error ? error.message : String(error))
  } finally {
    for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => undefined)
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    rmSync(work, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const value = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
if (process.env.MENDCODE_LIVE_FORGES !== "write") {
  console.log("skipped: set MENDCODE_LIVE_FORGES=write to run the live forge check (it writes to the configured repositories)")
  process.exit(0)
}
const which = value("--forge") ?? "all"
const daemonLevel = argv.includes("--daemon")
for (const [name, make, makeDaemon] of [["gitea", giteaForge, giteaDaemon], ["gitlab", gitlabForge, gitlabDaemon]] as const) {
  if (which !== "all" && which !== name) continue
  if (daemonLevel) {
    const forge = makeDaemon()
    if (typeof forge === "string") { console.log(`skipped ${name} daemon: ${forge}`); continue }
    await daemonCheck(forge)
    continue
  }
  const forge = make()
  if (typeof forge === "string") { console.log(`skipped ${name}: ${forge}`); continue }
  await check(forge)
}
const out = value("--out")
if (out) writeFileSync(out, `${JSON.stringify(steps, null, 2)}\n`)
const failed = steps.filter((step) => !step.ok)
console.log(`${steps.length - failed.length}/${steps.length} steps passed${failed.length ? `; failed: ${failed.map((step) => `${step.forge} ${step.step}`).join(", ")}` : ""}`)
process.exit(failed.length ? 1 : 0)
