import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ghProcess, UNREADABLE_LIMIT_MS, WATCH_INTERVAL_MS, type GhRun } from "../pr-watch"
import { parsePrCommand, type CommandComment, type PrCommand } from "./commands"

/**
 * The repo watch (docs/pr-review.md): the daemon lists a repository's open pull requests through the user's own `gh` about once a
 * minute and queues a review only for a PR it has not seen or a head that moved, so an idle repository costs no model call. At most
 * two reviews run at once per daemon; the rest wait in order. PRs already open when the watch starts are the baseline (`/pr review
 * N` reviews one of them). Drafts wait until they are ready unless the repo config's `triggers.drafts` says otherwise. A missing or
 * logged-out `gh` pauses the watch with one notice; a repository unreadable for 15 minutes ends it, as `pr_watch` does.
 *
 * Two limits keep a busy repository from spending without end (`cooldown` in the repo config): a PR is reviewed again only after
 * `pr_minutes`, and then once, at its newest head; and a repository starts at most `repo_per_hour` automatic reviews. A watch has a
 * role: `all` reviews every PR (one reviewer for the repository), `requested` only a PR that requests a review from, or is assigned
 * to, this daemon's own `gh` login (each developer's own reviewer). Being requested is a trigger of its own.
 */

export type RepoWatchJob =
  | { kind: "review"; directory: string; sessionId: string; number: number; head: string; trigger: "opened" | "synchronize" | "ready_for_review" | "requested" | "manual" }
  /** A maintainer's `@mendcode ...` comment on an open PR of the watched repository. */
  | { kind: "command"; directory: string; sessionId: string; number: number; head: string; trigger: "comment"; command: PrCommand; comment: CommandComment }
export type RepoTriggers = { opened: boolean; synchronize: boolean; ready_for_review: boolean; drafts: boolean }
export type RepoRole = "all" | "requested"
/** The repo config's limits and role (`cooldown`, `reviewers`); without them nothing is limited and every PR counts. */
export type RepoLimits = { cooldown: { pr_minutes: number; repo_per_hour: number }; reviewers: RepoRole }
const NO_LIMITS: RepoLimits = { cooldown: { pr_minutes: 0, repo_per_hour: Number.MAX_SAFE_INTEGER }, reviewers: "all" }
const HOUR_MS = 3_600_000

const AutoTrigger = z.enum(["opened", "synchronize", "ready_for_review", "requested"])
const Seen = z.object({
  head: z.string(), draft: z.boolean(),
  /** This daemon's login is a requested reviewer or an assignee of the PR. */
  requested: z.boolean().optional(),
  /** When its last automatic review started, for `cooldown.pr_minutes`. */
  reviewedAt: z.number().optional(),
  /** A trigger that came during the cooldown or over the hourly limit: the newest head is reviewed once both allow it. */
  waiting: AutoTrigger.optional(),
})
const Watch = z.object({
  directory: z.string(), sessionId: z.string(), createdAt: z.number(),
  seen: z.record(z.string(), Seen).default({}),
  /** Set once the user answered the question before the first post to this repository. */
  publish: z.enum(["allowed", "denied"]).optional(),
  /** The question was asked; it is asked once. */
  asked: z.boolean().optional(),
  paused: z.string().optional(),
  unreadableSince: z.number().optional(),
  ended: z.object({ at: z.number(), reason: z.string() }).optional(),
  /** Comments updated after this ISO time are read for `@mendcode` commands. */
  commentsSince: z.string().max(40).optional(),
  /** Comment ids already queued, so a comment edited later runs once. */
  answered: z.array(z.number().int()).max(200).optional(),
  /** `/pr watch-repo all|requested`; unset, the repo config's `reviewers` decides. */
  role: z.enum(["all", "requested"]).optional(),
  /** This daemon's `gh` login, read when the watch starts; `requested` matches it. */
  login: z.string().max(39).optional(),
  /** Start times of the automatic reviews of the last hour, for `cooldown.repo_per_hour`. */
  starts: z.array(z.number()).max(500).optional(),
  /** When the hourly limit was last reported, so it is said once an hour. */
  limited: z.number().optional(),
})
export type RepoWatchRecord = z.infer<typeof Watch>
const File = z.object({ version: z.literal(1), watches: z.array(z.unknown()) })
const Who = z.object({ login: z.string().max(100).optional() }).passthrough()
const Listed = z.array(z.object({ number: z.number().int().positive(), headRefOid: z.string().regex(/^[0-9a-f]{7,64}$/), isDraft: z.boolean().optional(), updatedAt: z.string().optional(), reviewRequests: z.array(Who).optional(), assignees: z.array(Who).optional() }))

export const MAX_CONCURRENT_REVIEWS = 2
const MAX_REPOS = 10
const MAX_QUEUE = 50

export type RepoWatchOptions = {
  dir: string
  run?: GhRun
  now?: () => number
  intervalMs?: number
  /** `experimental.pr_review` and the tier permit. Checked on every tick and command: off, no `gh` runs. */
  enabled(): boolean
  /** The repo config's triggers for a watched directory (its base branch's `.mendcode/review.yaml`). */
  triggers(directory: string): Promise<RepoTriggers>
  /** The repo config's cooldown and role for a watched directory. */
  limits?(directory: string): Promise<RepoLimits>
  /** Runs one review to its end (T2 to T4); the watch only counts it against the concurrency cap. */
  start(job: RepoWatchJob): Promise<void>
  notify(sessionId: string, text: string): void
  sessionExists(sessionId: string): boolean
  /** After each successful listing: explain the failing checks of reviewed heads (docs/pr-review.md, follow-ups). */
  followUp?(directory: string, sessionId: string, prs: ReadonlyArray<{ number: number; headRefOid: string }>): Promise<void>
}

type Listed = z.infer<typeof Listed>
/** A comment as `gh api --jq` prints it, one object per line. */
const PolledComment = z.object({ id: z.number().int(), body: z.string().max(100_000).nullable(), user: z.string().max(100).nullable(), association: z.string().max(40).nullable().optional(), html_url: z.string().max(500).optional(), pull_request_url: z.string().max(500).optional(), in_reply_to_id: z.number().int().nullable().optional(), diff_hunk: z.string().max(50_000).nullable().optional() })
const ISSUE_COMMENTS = ".[] | {id, body, user: .user.login, association: .author_association, html_url}"
const REVIEW_COMMENTS = ".[] | {id, body, user: .user.login, association: .author_association, pull_request_url, in_reply_to_id, diff_hunk}"

export function createRepoWatch(options: RepoWatchOptions) {
  const run = options.run ?? ghProcess
  const now = options.now ?? Date.now
  const interval = options.intervalMs ?? WATCH_INTERVAL_MS
  const file = path.join(options.dir, "pr-review", "watches.json")
  let watches = load()
  const queue: RepoWatchJob[] = []
  let running = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false
  let stopped = false

  function load(): RepoWatchRecord[] {
    try {
      const parsed = File.safeParse(JSON.parse(readFileSync(file, "utf8")))
      return parsed.success ? parsed.data.watches.flatMap((item) => { const watch = Watch.safeParse(item); return watch.success ? [watch.data] : [] }) : []
    } catch { return [] }
  }
  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, watches }), { mode: 0o600, flag: "wx" })
      renameSync(temp, file)
    } catch { /* an unsaved watch still works until the daemon stops */ }
  }
  const active = (watch: RepoWatchRecord) => !watch.ended && !watch.paused
  function arm() {
    const needed = !stopped && watches.some(active)
    if (needed && !timer) { timer = setInterval(() => void tick(), interval); timer.unref?.() }
    if (!needed && timer) { clearInterval(timer); timer = undefined }
  }

  /** Starts queued jobs while fewer than `MAX_CONCURRENT_REVIEWS` run. */
  function pump() {
    while (!stopped && running < MAX_CONCURRENT_REVIEWS && queue.length) {
      const job = queue.shift()!
      running++
      void options.start(job).catch(() => undefined).finally(() => { running--; pump() })
    }
  }
  function enqueue(job: RepoWatchJob) {
    const same = (item: RepoWatchJob) => item.kind === "command" || job.kind === "command" ? item.kind === job.kind && item.kind === "command" && job.kind === "command" && item.comment.id === job.comment.id : item.directory === job.directory && item.number === job.number && item.head === job.head
    if (queue.some(same)) return
    if (queue.length >= MAX_QUEUE) queue.shift()
    queue.push(job)
    pump()
  }

  /**
   * The `@mendcode` commands written on the repository's open PRs since the last poll: two `gh api` calls, issue comments and
   * review comments, filtered by `since`. MendCode's own replies carry a marker and are never read as commands. Failures are
   * quiet: the next poll reads from the same time again.
   */
  /**
   * Which `@mendcode` comments this reviewer takes: one addressed to its login (`@mendcode review @alice`), or one addressed to no
   * one when it reviews every PR (`all`) or the PR requests it. Many developers can run their own reviewer on one repository and a
   * comment is answered by the reviewer it is meant for.
   */
  const takes = ({ command, role, me, requested }: { command: PrCommand; role: RepoRole; me: string | undefined; requested: boolean }) =>
    command.target ? !!me && command.target.toLowerCase() === me : role === "all" || requested

  async function pollComments(watch: RepoWatchRecord, prs: Listed, role: RepoRole) {
    const me = watch.login?.toLowerCase()
    const requestedOf = (number: number) => { const pr = prs.find((entry) => entry.number === number); return !!me && !!pr && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me) }
    const started = new Date(now()).toISOString()
    const since = watch.commentsSince ?? new Date(watch.createdAt).toISOString()
    const heads = new Map(prs.map((pr) => [pr.number, pr.headRefOid]))
    const answered = new Set(watch.answered ?? [])
    let complete = true
    for (const [endpoint, jq] of [["issues/comments", ISSUE_COMMENTS], ["pulls/comments", REVIEW_COMMENTS]] as const) {
      const done = await run({ argv: ["api", `repos/{owner}/{repo}/${endpoint}?since=${since}&per_page=100`, "--jq", jq], cwd: watch.directory })
      if (done.code !== 0) { complete = false; continue }
      for (const line of done.out.split("\n")) {
        let item: z.infer<typeof PolledComment>
        try { const parsed = PolledComment.safeParse(JSON.parse(line)); if (!parsed.success) continue; item = parsed.data } catch { continue }
        if (answered.has(item.id) || !item.body || !item.user) continue
        const command = parsePrCommand(item.body)
        const number = Number((endpoint === "issues/comments" ? /\/pull\/(\d+)(?:#|$)/.exec(item.html_url ?? "") : /\/pulls\/(\d+)$/.exec(item.pull_request_url ?? ""))?.[1])
        const head = heads.get(number)
        if (!command || !head) continue
        answered.add(item.id)
        if (!takes({ command, role, me, requested: requestedOf(number) })) continue
        const comment: CommandComment = { id: item.id, surface: endpoint === "pulls/comments" ? "review" : "issue", actor: item.user, body: item.body, ...(item.association ? { association: item.association } : {}), ...(item.in_reply_to_id ? { inReplyTo: item.in_reply_to_id } : {}), ...(item.diff_hunk ? { diffHunk: item.diff_hunk } : {}) }
        enqueue({ kind: "command", directory: watch.directory, sessionId: watch.sessionId, number, head, trigger: "comment", command, comment })
      }
    }
    watch.answered = [...answered].slice(-200)
    if (complete) watch.commentsSince = started
  }

  async function list(directory: string): Promise<{ ok: true; prs: Listed } | { ok: false; auth: boolean; reason: string }> {
    const result = await run({ argv: ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefOid,isDraft,updatedAt,reviewRequests,assignees"], cwd: directory })
    if (result.code === 127) return { ok: false, auth: true, reason: "gh is not installed or not on PATH" }
    if (result.code !== 0) {
      const line = result.err.split("\n").find((entry) => entry.trim())?.slice(0, 160) ?? `gh exited with ${result.code}`
      return { ok: false, auth: /auth|log ?in|token|credentials|HTTP 401/i.test(result.err), reason: line }
    }
    try {
      const parsed = Listed.safeParse(JSON.parse(result.out))
      return parsed.success ? { ok: true, prs: parsed.data } : { ok: false, auth: false, reason: "gh returned something that is not a pull request list" }
    } catch { return { ok: false, auth: false, reason: "gh returned something that is not JSON" } }
  }

  async function poll(watch: RepoWatchRecord) {
    const found = await list(watch.directory)
    if (!found.ok) {
      if (found.auth) {
        watch.paused = found.reason
        options.notify(watch.sessionId, `The PR review watch of ${watch.directory} is paused: ${found.reason}. Fix gh (gh auth login) and run /pr watch-repo again.`)
        return
      }
      watch.unreadableSince ??= now()
      if (now() - watch.unreadableSince >= UNREADABLE_LIMIT_MS) {
        watch.ended = { at: now(), reason: "unreadable" }
        options.notify(watch.sessionId, `The PR review watch of ${watch.directory} ended: gh could not list its pull requests for ${Math.round(UNREADABLE_LIMIT_MS / 60_000)} minutes (${found.reason}).`)
      }
      return
    }
    delete watch.unreadableSince
    const triggers = await options.triggers(watch.directory).catch((): RepoTriggers => ({ opened: true, synchronize: true, ready_for_review: true, drafts: false }))
    const limits = (await options.limits?.(watch.directory).catch(() => undefined)) ?? NO_LIMITS
    const role = watch.role ?? limits.reviewers
    const me = watch.login?.toLowerCase()
    const open = new Set<string>()
    watch.starts = (watch.starts ?? []).filter((at) => now() - at < HOUR_MS)
    for (const pr of found.prs) {
      const key = String(pr.number)
      open.add(key)
      const before = watch.seen[key]
      const draft = pr.isDraft === true
      const requested = !!me && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me)
      const seen: RepoWatchRecord["seen"][string] = { head: pr.headRefOid, draft, requested, ...(before?.reviewedAt ? { reviewedAt: before.reviewedAt } : {}), ...(before?.waiting ? { waiting: before.waiting } : {}) }
      watch.seen[key] = seen
      if (draft && !triggers.drafts) continue
      let trigger: z.infer<typeof AutoTrigger> | undefined = !before ? "opened" : before.draft && !draft ? "ready_for_review" : before.head !== pr.headRefOid ? "synchronize" : undefined
      if (trigger && !triggers[trigger as keyof RepoTriggers]) trigger = undefined
      if (role === "requested") {
        // Someone else's PR is not this reviewer's: nothing waits for it, and a request for this login is what starts one.
        if (!requested) { delete seen.waiting; continue }
        if (before && !before.requested) trigger = "requested"
      }
      const due = trigger ?? seen.waiting
      if (!due) continue
      const cooling = seen.reviewedAt !== undefined && now() - seen.reviewedAt < limits.cooldown.pr_minutes * 60_000
      const full = watch.starts.length >= limits.cooldown.repo_per_hour
      if (cooling || full) {
        seen.waiting = due
        if (full && !cooling && (watch.limited === undefined || now() - watch.limited >= HOUR_MS)) {
          watch.limited = now()
          options.notify(watch.sessionId, `The PR review watch of ${watch.directory} reached ${limits.cooldown.repo_per_hour} automatic reviews this hour (cooldown.repo_per_hour in .mendcode/review.yaml); the waiting PRs are reviewed at their newest head as the hour frees up. /pr review N still runs one now.`)
        }
        continue
      }
      delete seen.waiting
      seen.reviewedAt = now()
      watch.starts.push(now())
      enqueue({ kind: "review", directory: watch.directory, sessionId: watch.sessionId, number: pr.number, head: pr.headRefOid, trigger: due })
    }
    for (const key of Object.keys(watch.seen)) if (!open.has(key)) delete watch.seen[key]
    await pollComments(watch, found.prs, role)
    await options.followUp?.(watch.directory, watch.sessionId, found.prs).catch(() => undefined)
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      if (options.enabled()) for (const watch of [...watches]) {
        if (stopped) break
        if (!options.sessionExists(watch.sessionId)) { watches = watches.filter((item) => item !== watch); continue }
        if (active(watch)) await poll(watch)
      }
    } finally {
      ticking = false
      save()
      arm()
    }
  }

  const roleText = (watch: RepoWatchRecord) => watch.role === "requested" ? `only PRs that request ${watch.login ? `@${watch.login}` : "you"}` : watch.role === "all" ? "every PR" : "role from the repo config"
  const waitingOf = (watch: RepoWatchRecord) => Object.values(watch.seen).filter((seen) => seen.waiting).length
  const describe = () => watches.length ? watches.map((watch) => `${watch.directory} · ${watch.ended ? `ended (${watch.ended.reason})` : watch.paused ? `paused (${watch.paused})` : "watching"} · ${roleText(watch)} · ${Object.keys(watch.seen).length} open PR${Object.keys(watch.seen).length === 1 ? "" : "s"}${waitingOf(watch) ? ` · ${waitingOf(watch)} waiting for the cooldown` : ""} · publish ${watch.publish ?? "not asked yet"}`).join("\n") : "no repository is watched"
  const rows = () => watches.map((watch) => ({ directory: watch.directory, state: watch.ended ? `ended (${watch.ended.reason})` : watch.paused ? "paused" : "watching", open: Object.keys(watch.seen).length, publish: watch.publish ?? "not asked" }))
  const find = (directory: string) => watches.find((watch) => watch.directory === directory && !watch.ended)

  /** This daemon's `gh` login, which `requested` matches; undefined when gh cannot say. */
  async function ownLogin(directory: string) {
    const done = await run({ argv: ["api", "user", "--jq", ".login"], cwd: directory }).catch(() => ({ code: 1, out: "", err: "" }))
    const login = done.code === 0 ? done.out.trim() : ""
    return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined
  }

  async function watchRepo(sessionId: string, directory: string, role?: RepoRole): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const existing = find(directory)
    if (existing && !existing.paused && (role === undefined || role === existing.role)) return { ok: true, text: `Already watching ${directory} (${roleText(existing)}).` }
    if (existing && !existing.paused && role) {
      if (role === "requested" && !existing.login) existing.login = await ownLogin(directory)
      if (role === "requested" && !existing.login) return { ok: false, message: "could not read your gh login (gh api user), which requested reviews are matched against" }
      existing.role = role
      save()
      return { ok: true, text: `Watching ${directory}: ${roleText(existing)} from now on.` }
    }
    if (!existing && watches.filter((watch) => !watch.ended).length >= MAX_REPOS) return { ok: false, message: `at most ${MAX_REPOS} repositories are watched at once` }
    const found = await list(directory)
    if (!found.ok) return { ok: false, message: `could not list pull requests: ${found.reason}` }
    // What is open now is the baseline: only a new PR or a new head after this moment starts a review.
    const login = existing?.login ?? await ownLogin(directory)
    if (role === "requested" && !login) return { ok: false, message: "could not read your gh login (gh api user), which requested reviews are matched against" }
    const me = login?.toLowerCase()
    const seen = Object.fromEntries(found.prs.map((pr) => [String(pr.number), { head: pr.headRefOid, draft: pr.isDraft === true, requested: !!me && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me) }]))
    const record: RepoWatchRecord = { ...(existing ?? {}), directory, sessionId, createdAt: existing?.createdAt ?? now(), seen, ...(role ? { role } : {}), ...(login ? { login } : {}) }
    delete record.paused
    delete record.unreadableSince
    watches = [...watches.filter((watch) => watch !== existing), record]
    save()
    arm()
    const minutes = Math.max(1, Math.round(interval / 60_000))
    const limits = (await options.limits?.(directory).catch(() => undefined)) ?? NO_LIMITS
    const effective = role ?? limits.reviewers
    const who = effective === "requested" ? `Only PRs that request a review from @${login} or are assigned to them are reviewed. ` : ""
    const cooldown = limits.cooldown.pr_minutes || limits.cooldown.repo_per_hour < NO_LIMITS.cooldown.repo_per_hour ? `A PR is reviewed again after ${limits.cooldown.pr_minutes} minutes at its newest head, and at most ${limits.cooldown.repo_per_hour} reviews start per hour (cooldown in .mendcode/review.yaml). ` : ""
    return { ok: true, text: `Watching ${directory}: ${found.prs.length} open PR${found.prs.length === 1 ? "" : "s"} are the baseline. Every ${minutes} minute${minutes === 1 ? "" : "s"} gh lists them; a new PR or a new push starts a review (no model call while nothing changes). ${who}${cooldown}Before the first post to this repository you are asked once.` }
  }

  function unwatchRepo(directory: string): { ok: true; text: string } | { ok: false; message: string } {
    const watch = find(directory)
    if (!watch) return { ok: false, message: `${directory} is not watched` }
    watch.ended = { at: now(), reason: "stopped" }
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index]!.directory === directory) queue.splice(index, 1)
    save()
    arm()
    return { ok: true, text: `Stopped watching ${directory}.` }
  }

  /**
   * Whether a review of `directory` may post: `allowed` once the user said so, `denied` when they declined, `ask` the first time
   * (the caller asks in the session and the question is not asked again), `wait` while the question is open.
   */
  function publishConsent(directory: string): "allowed" | "denied" | "ask" | "wait" {
    const watch = watches.find((item) => item.directory === directory)
    if (!watch) return "ask"
    if (watch.publish) return watch.publish
    if (watch.asked) return "wait"
    watch.asked = true
    save()
    return "ask"
  }
  /** The answer so far, without asking. */
  const consentOf = (directory: string) => watches.find((item) => item.directory === directory)?.publish
  function setPublish(directory: string, sessionId: string, answer: "allowed" | "denied") {
    let watch = watches.find((item) => item.directory === directory)
    if (!watch) { watch = { directory, sessionId, createdAt: now(), seen: {}, ended: { at: now(), reason: "not watched" } }; watches.push(watch) }
    watch.publish = answer
    save()
  }

  arm()
  return {
    tick, watchRepo, unwatchRepo, describe, rows, publishConsent, consentOf, setPublish,
    /** The `gh` login this daemon posts as in a watched directory: read once, then kept with the watch. */
    async loginOf(directory: string) {
      const watch = find(directory)
      if (watch?.login) return watch.login
      const login = await ownLogin(directory)
      if (watch && login) { watch.login = login; save() }
      return login
    },
    /** A review asked for by hand (`/pr review`): queued behind the cap like any other. */
    review(job: Omit<RepoWatchJob, "kind" | "trigger">) { enqueue({ ...job, kind: "review", trigger: "manual" }) },
    pending: () => ({ running, queued: queue.length }),
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; queue.splice(0); save() },
  }
}
export type RepoWatchService = ReturnType<typeof createRepoWatch>
