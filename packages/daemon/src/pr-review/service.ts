import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { createIndexer } from "@mendcode/codegraph"
import { ghProcess, parseRef, type GhRun } from "../pr-watch"
import { gitRun, type GitRun } from "./context"
import { readReviewConfig, type ReviewConfig } from "./config"
import type { ReviewSessionFactory } from "./engine"
import { publishReview, type GhCall } from "./publish"
import { explainFinding, failureFollowUp, runPrCommand } from "./commands"
import { runFix } from "./fix"
import { answeredBy, mayPublish, reviewedBy, type PublishCheck } from "./publishers"
import { readPullRequestInfo } from "./pull-request"
import { createRepoWatch, type RepoWatchJob } from "./repo-watch"
import { runChecks } from "./verify"
import { reviewNotice, runPrReview, type ReviewRun } from "./run"
import { readReviewState, writeReviewState } from "./state"

/**
 * The daemon's PR reviewer (docs/pr-review.md): the repo watch, `/pr review`, and the throwaway worktree each review reads. A review
 * runs as a job of the daemon's job scheduler (`schedule`), at most two at once. The head is fetched into `FETCH_HEAD` only and
 * checked out detached in `<dataDir>/pr-review/worktrees/`, so the user's checkout and branches are never touched; the worktree
 * is removed when the review ends. Before the first post to a repository the session is asked once (`/pr publish on|off`); until
 * then findings stay in the session as a notice.
 */

/** `gh` with a request body on stdin, for `gh api --input -`. No shell; the user's own login. */
export const ghCall: GhCall = async ({ argv, stdin }) => {
  try {
    const child = Bun.spawn(["gh", ...argv], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" } })
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, out: out.trim(), err: err.trim() }
    } finally { clearTimeout(timer) }
  } catch (error) { return { code: 127, out: "", err: error instanceof Error ? error.message : String(error) } }
}

export type PrReviewServiceOptions = {
  dir: string
  run?: GhRun
  call?: GhCall
  git?: GitRun
  intervalMs?: number
  now?: () => number
  enabled(): boolean
  /** Whether the code graph may index (`codegraph` on); without it reviews use the diff alone. */
  graphOn(): boolean
  sessionDirectory(sessionId: string): string | undefined
  sessionExists(sessionId: string): boolean
  notify(sessionId: string, text: string): void
  /** Review children for `owner` in `directory`. */
  sessions(owner: string, directory: string): ReviewSessionFactory
  /** The `@mendcode fix` session for `owner`: the default agent under the user's own permission mode. */
  editor(owner: string, directory: string): ReviewSessionFactory
  /** Runs `job` on the daemon's job scheduler and resolves when it ends. */
  schedule(run: () => Promise<void>): Promise<void>
}

/** How often the failing checks of one reviewed PR are read. */
export const FOLLOW_UP_MS = 5 * 60_000

export const PR_REVIEW_DISABLED = "The PR reviewer is off: it reaches the network through gh and spends model calls, so turn it on with /experimental pr_review on (balanced tier or above)"

const View = (text: string) => { try { return JSON.parse(text) as { number?: number; headRefOid?: string; baseRefOid?: string; baseRefName?: string; url?: string; title?: string; body?: string } } catch { return {} } }

export function createPrReviewService(options: PrReviewServiceOptions) {
  const run = options.run ?? ghProcess
  const call = options.call ?? ghCall
  const git = options.git ?? gitRun
  const root = path.join(options.dir, "pr-review")
  const held = new Map<string, Array<() => Promise<void>>>()

  /** `owner/repo` of a directory's GitHub origin, through gh. */
  async function repoOf(directory: string) {
    const done = await run({ argv: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd: directory })
    if (done.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(done.out)) throw new Error(`[PR_REVIEW]: gh could not name the GitHub repository of ${directory}`)
    return done.out
  }

  async function reviewOne({ sessionId, directory, number, publish, manual }: { sessionId: string; directory: string; number: number; publish: boolean; manual: boolean }): Promise<ReviewRun & { repo: string }> {
    const repo = await repoOf(directory)
    const viewed = await run({ argv: ["pr", "view", String(number), "--json", "number,headRefOid,baseRefOid,baseRefName,url,title,body"], cwd: directory })
    const pr = View(viewed.out)
    if (viewed.code !== 0 || !pr.headRefOid || !pr.baseRefOid || !/^[0-9a-f]{40}$/.test(pr.headRefOid) || !/^[0-9a-f]{40}$/.test(pr.baseRefOid)) throw new Error(`[PR_REVIEW]: gh could not read pull request #${number}`)
    const base = pr.baseRefName && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(pr.baseRefName) && !pr.baseRefName.includes("..") ? pr.baseRefName : undefined
    // FETCH_HEAD only: no branch or remote-tracking ref of the user's checkout changes.
    const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${number}/head`, ...(base ? [`refs/heads/${base}`] : [])], directory)
    if (fetched.code !== 0) throw new Error(`[PR_REVIEW]: git fetch of pull request #${number} failed`)
    mkdirSync(path.join(root, "worktrees"), { recursive: true, mode: 0o700 })
    const worktree = mkdtempSync(path.join(root, "worktrees", `pr${number}-`))
    rmSync(worktree, { recursive: true, force: true })
    const added = await git(["worktree", "add", "--detach", "--quiet", worktree, pr.headRefOid], directory)
    if (added.code !== 0) throw new Error(`[PR_REVIEW]: could not check out ${pr.headRefOid.slice(0, 12)} in a worktree`)
    const graphCache = `${worktree}.graph`
    try {
      const state = readReviewState(options.dir, repo, number)
      const reviewed = await runPrReview({
        // A watched repository that has not enabled publishing is still reviewed, into this session only: the user started the watch.
        repo, number, directory: worktree, base: pr.baseRefOid, head: pr.headRefOid, state, git, publish, force: true, full: manual,
        publisher: { login: await watch.loginOf(directory), check: (config) => publisherOf(directory, repo, config.publishers) }, read: call,
        sessionFactory: options.sessions(sessionId, worktree),
        pullRequest: await readPullRequestInfo({ gh: call, repo, title: typeof pr.title === "string" ? pr.title : "", body: typeof pr.body === "string" ? pr.body : "" }),
        ...(publish ? { gh: call } : {}),
        ...(options.graphOn() ? { graph: () => createIndexer({ cacheDir: graphCache, now: Date.now }).graph({ cwd: worktree, signal: AbortSignal.timeout(120_000) }) } : {}),
      })
      if (reviewed.status === "published") writeReviewState(options.dir, repo, number, reviewed.state)
      return { ...reviewed, repo }
    } finally {
      await git(["worktree", "remove", "--force", worktree], directory)
      rmSync(worktree, { recursive: true, force: true })
      rmSync(graphCache, { recursive: true, force: true })
      await git(["worktree", "prune"], directory)
    }
  }

  /** One job: review, ask once before the first post, notify the session. Never throws. */
  async function job({ sessionId, directory, number, trigger }: Pick<RepoWatchJob, "sessionId" | "directory" | "number" | "trigger">) {
    const manual = trigger === "manual"
    try {
      const allowed = watch.consentOf(directory) === "allowed"
      const first = await reviewOne({ sessionId, directory, number, publish: allowed, manual })
      if (first.status === "skipped" && !manual) return
      options.notify(sessionId, reviewNotice({ repo: first.repo, number, run: first }))
      // A review that could post but has no consent yet: ask once, hold it, post it when the answer is yes.
      if (!allowed && first.status === "reviewed" && first.config?.enabled && !first.notPublisher) {
        const consent = watch.publishConsent(directory)
        if (consent === "denied") return
        const list = held.get(directory) ?? []
        const result = first.outcome!.result
        // The held review is posted as it was found: no second model call.
        list.push(async () => {
          const report = await publishReview({ repo: first.repo, number, result, previous: readReviewState(options.dir, first.repo, number), process: call, ...(first.info ? { info: first.info } : {}) })
          if (report.posted) writeReviewState(options.dir, first.repo, number, report.state)
          options.notify(sessionId, report.posted ? `Posted the held review of ${first.repo}#${number} (${report.comments} inline comment${report.comments === 1 ? "" : "s"}).` : `The held review of ${first.repo}#${number} was not posted: ${report.reason ?? "unknown reason"}.`)
        })
        held.set(directory, list)
        if (consent === "ask") options.notify(sessionId, `MendCode has never posted a review to ${first.repo}. Type /pr publish on to post this review and later ones to GitHub, or /pr publish off to keep reviews in this session. You are asked once.`)
      }
    } catch (error) {
      options.notify(sessionId, `PR review of #${number} failed: ${(error instanceof Error ? error.message : String(error)).replace(/^\[PR_REVIEW\]:\s*/, "")}`)
    }
  }

  const repos = new Map<string, string>()
  const repoCached = async (directory: string) => { const known = repos.get(directory); if (known) return known; const repo = await repoOf(directory); repos.set(directory, repo); return repo }
  const waiting = new Set<number>()

  /** `@mendcode fix`: the PR's branch, where it lives, and the base config's checks and `fixes`. */
  async function fixTarget(directory: string, number: number) {
    const viewed = await run({ argv: ["pr", "view", String(number), "--json", "headRefName,headRefOid,baseRefOid,isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner"], cwd: directory })
    let pr: { headRefName?: string; headRefOid?: string; baseRefOid?: string; isCrossRepository?: boolean; maintainerCanModify?: boolean; headRepository?: { name?: string }; headRepositoryOwner?: { login?: string } } = {}
    try { pr = JSON.parse(viewed.out) } catch { /* checked below */ }
    if (viewed.code !== 0 || !pr.headRefName || !/^[0-9a-f]{40}$/.test(pr.headRefOid ?? "") || !/^[0-9a-f]{40}$/.test(pr.baseRefOid ?? "") || (await git(["check-ref-format", "--branch", pr.headRefName], directory)).code !== 0) throw new Error(`[PR_REVIEW]: gh could not read pull request #${number}`)
    const fork = pr.isCrossRepository === true
    const owner = pr.headRepositoryOwner?.login ?? "", name = pr.headRepository?.name ?? ""
    if (fork && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || fork && !/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("[PR_REVIEW]: invalid fork repository")
    const { config } = await readReviewConfig({ directory, base: pr.baseRefOid!, head: pr.baseRefOid!, git })
    return { branch: pr.headRefName, head: pr.headRefOid!, pushUrl: fork ? `https://github.com/${owner}/${name}.git` : "origin", pushable: !fork || pr.maintainerCanModify === true, config }
  }

  const publishers = new Map<string, { at: number; check: PublishCheck }>()
  /** Whether this daemon's login may post to `repo` (`publishers` in the repo config), asked at most every ten minutes per repository. */
  async function publisherOf(directory: string, repo: string, rule: ReviewConfig["publishers"]): Promise<PublishCheck> {
    const key = `${directory}\n${JSON.stringify(rule)}`
    const at = (options.now ?? Date.now)()
    const known = publishers.get(key)
    if (known && at - known.at < 600_000) return known.check
    const check = await mayPublish({ gh: call, repo, login: await watch.loginOf(directory), rule })
    publishers.set(key, { at, check })
    return check
  }
  const baseConfig = async (directory: string) => (await readReviewConfig({ directory, base: "HEAD", head: "HEAD", git })).config

  /**
   * One `@mendcode` comment of a watched repository: answered on GitHub with the user's own gh, once they allowed posting there, when
   * the repository lets this reviewer post (`publishers`) and no other publisher answered it yet.
   */
  async function commandJob(entry: Extract<RepoWatchJob, { kind: "command" }>) {
    const { sessionId, directory, number, command, comment } = entry
    try {
      const repo = await repoCached(directory)
      if (watch.consentOf(directory) !== "allowed") {
        if (!waiting.has(comment.id)) { waiting.add(comment.id); options.notify(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number} was not answered: MendCode posts to ${repo} only after /pr publish on.`) }
        return
      }
      const config = await baseConfig(directory)
      const allowed = await publisherOf(directory, repo, config.publishers)
      if (!allowed.ok) { options.notify(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number} was not answered: ${allowed.reason}.`); return }
      const other = await answeredBy({ gh: call, repo, number, commentId: comment.id, rule: config.publishers, self: await watch.loginOf(directory) })
      if (other) { options.notify(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number}: @${other} answered it already.`); return }
      const state = readReviewState(options.dir, repo, number)
      let target: Awaited<ReturnType<typeof fixTarget>> | undefined
      const fixInfo = async () => (target ??= await fixTarget(directory, number))
      const outcome = await runPrCommand(command, {
        gh: call, repo, number, comment, state,
        review: async () => { const done = await reviewOne({ sessionId, directory, number, publish: true, manual: true }); options.notify(sessionId, reviewNotice({ repo, number, run: done })); return { status: done.status, reason: done.reason, posted: done.report?.posted ?? false } },
        explain: (question) => explainFinding({ sessionFactory: options.sessions(sessionId, directory), ...question }),
        fixesAllowed: async () => (await fixInfo()).config.fixes,
        pushable: async () => (await fixInfo()).pushable,
        fix: async ({ instructions, finding }) => {
          const info = await fixInfo()
          if ((await git(["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${number}/head`], directory)).code !== 0) return { ok: false, reason: `git fetch of pull request #${number} failed` }
          options.notify(sessionId, `@mendcode fix on ${repo}#${number}: a fix session is editing a copy of the branch; its approvals come to you like any session's.`)
          return runFix({ directory, root, number, head: info.head, branch: info.branch, pushUrl: info.pushUrl, instructions, finding, checks: info.config.checks, runChecks: (dir, commands) => runChecks({ directory: dir, commands }), sessions: (worktree) => options.editor(sessionId, worktree), git })
        },
      })
      if (outcome.state !== state) writeReviewState(options.dir, repo, number, outcome.state)
      options.notify(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number}: ${outcome.kind === "denied" ? "refused (no write access)" : outcome.posted ? "answered on GitHub" : "the reply could not be posted"}.`)
    } catch (error) {
      options.notify(sessionId, `@mendcode ${command.kind} on #${number} failed: ${(error instanceof Error ? error.message : String(error)).replace(/^\[PR_REVIEW\]:\s*/, "")}`)
    }
  }

  const followed = new Map<string, number>()
  /** Explains the failing checks of a head MendCode reviewed and posted on, at most every `FOLLOW_UP_MS` per PR. */
  async function followUp(directory: string, sessionId: string, prs: ReadonlyArray<{ number: number; headRefOid: string }>) {
    if (watch.consentOf(directory) !== "allowed") return
    const repo = await repoCached(directory)
    if (!(await publisherOf(directory, repo, (await baseConfig(directory)).publishers)).ok) return
    const at = (options.now ?? Date.now)()
    for (const pr of prs) {
      const state = readReviewState(options.dir, repo, pr.number)
      if (state.lastHead !== pr.headRefOid || !Object.keys(state.published).length) continue
      const key = `${repo}#${pr.number}`
      if (at - (followed.get(key) ?? -Infinity) < FOLLOW_UP_MS) continue
      followed.set(key, at)
      const done = await failureFollowUp({ gh: call, repo, number: pr.number, head: pr.headRefOid, state })
      if (done.state !== state) writeReviewState(options.dir, repo, pr.number, done.state)
      if (done.posted) options.notify(sessionId, `Checks failed on ${repo}#${pr.number} after the review; MendCode posted their cause on the pull request.`)
    }
  }

  const watch = createRepoWatch({
    dir: options.dir, run, ...(options.now ? { now: options.now } : {}), ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    enabled: options.enabled, sessionExists: options.sessionExists, notify: options.notify,
    triggers: async (directory) => (await readReviewConfig({ directory, base: "HEAD", head: "HEAD", git })).config.triggers,
    limits: async (directory) => { const { config } = await readReviewConfig({ directory, base: "HEAD", head: "HEAD", git }); return { cooldown: config.cooldown, reviewers: config.reviewers } },
    start: (entry) => options.schedule(() => entry.kind === "command" ? commandJob(entry) : job(entry)),
    followUp,
  })

  async function control({ sessionId, action, directory: given, pr, role }: { sessionId: string; action: "watch-repo" | "unwatch-repo" | "review" | "list" | "publish-on" | "publish-off"; directory?: string | undefined; pr?: string | undefined; role?: "all" | "requested" | undefined }): Promise<{ ok: true; text: string; watches: ReturnType<typeof watch.rows> } | { ok: false; message: string }> {
    if (!options.enabled()) return { ok: false, message: PR_REVIEW_DISABLED }
    const directory = given ?? options.sessionDirectory(sessionId)
    if (!directory || !path.isAbsolute(directory)) return { ok: false, message: "unknown session directory" }
    const done = (text: string) => ({ ok: true as const, text, watches: watch.rows() })
    if (action === "list") return done(watch.describe())
    if (action === "unwatch-repo") { const result = watch.unwatchRepo(directory); return result.ok ? done(result.text) : result }
    if (action === "watch-repo") { const result = await watch.watchRepo(sessionId, directory, role); return result.ok ? done(result.text) : result }
    if (action === "publish-on" || action === "publish-off") {
      watch.setPublish(directory, sessionId, action === "publish-on" ? "allowed" : "denied")
      const waiting = held.get(directory) ?? []
      held.delete(directory)
      if (action === "publish-on") for (const post of waiting) void options.schedule(post)
      return done(action === "publish-on" ? `Reviews of this repository are posted to GitHub from now on${waiting.length ? `; posting ${waiting.length} held review${waiting.length === 1 ? "" : "s"}` : ""}.` : "Reviews of this repository stay in this session.")
    }
    const ref = parseRef(pr)
    if (!ref.ok) return ref
    let number = ref.number
    if (number === undefined) {
      const current = await run({ argv: ["pr", "view", ...(ref.arg ? [ref.arg] : []), "--json", "number", "--jq", ".number"], cwd: directory })
      number = current.code === 0 && /^\d{1,7}$/.test(current.out) ? Number(current.out) : undefined
      if (number === undefined) return { ok: false, message: "no pull request found for the current branch; name one: /pr review 12" }
    }
    watch.review({ directory, sessionId, number, head: "" })
    return done(`Reviewing #${number}. The findings arrive in this session when the review ends (two passes, no edits).`)
  }

  return { control, command: commandJob, tick: watch.tick, pending: watch.pending, stop: watch.stop }
}
export type PrReviewService = ReturnType<typeof createPrReviewService>
