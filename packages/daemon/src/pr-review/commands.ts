import { createHash } from "node:crypto"
import type { PrFinding } from "@mendcode/protocol"
import type { ReviewSessionFactory } from "./engine"
import type { ReviewProvider } from "./contracts"
import { findingFromComment, type GhCall } from "./publish"
import { answersMarker } from "./publishers"
import { FINDING_MARKER, type ReviewState } from "./state"

/**
 * Commands a maintainer writes in a pull request (docs/pr-review.md): `@mendcode review | pause | resume | explain | fix | learn`.
 * Only someone with write access is answered with anything but a refusal. Every reply carries a hidden marker, so MendCode never
 * takes its own reply for a command, and a hosted runner reads `pause` back from GitHub. Follow-ups explain a failing check of a
 * reviewed head once per failing set.
 */

export const PR_COMMANDS = ["review", "pause", "resume", "explain", "fix", "learn"] as const
export type PrCommandKind = (typeof PR_COMMANDS)[number]
/** `target`: the login a comment addresses (`@mendcode review @alice`); only that login's reviewer answers it. */
export type PrCommand = { kind: PrCommandKind; arg?: string; target?: string }

export const REPLY_MARKER = "<!-- mendcode:reply -->"
export const PAUSE_MARKER = /<!-- mendcode:paused=([01]) -->/
export const FOLLOWUP_MARKER = /<!-- mendcode:followup=([0-9a-f]{16}) -->/
const ARG_LIMIT = 2_000
const LOG_LIMIT = 3_000
const MAX_FAILURES = 3
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"])
export const MAINTAINERS_ONLY = "Only maintainers (write access to this repository) can run @mendcode commands."

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The command in a comment: a configured mention at the start of a line, then a command word, then its argument (the rest of the
 * comment). Quoted lines (`> ...`) and code blocks are ignored, so quoting an earlier command runs nothing.
 */
export function parsePrCommand(body: string, mentions: readonly string[] = ["@mendcode"]): PrCommand | undefined {
  if (body.includes("<!-- mendcode:")) return undefined
  const lines = body.split(/\r?\n/)
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced || /^\s*>/.test(line)) continue
    for (const mention of mentions) {
      const match = new RegExp(`^\\s*${escape(mention)}\\s+([a-z]+)\\b[ \\t]*(.*)$`, "i").exec(line)
      const kind = match?.[1]?.toLowerCase()
      if (!match || !(PR_COMMANDS as readonly string[]).includes(kind!)) continue
      const rest = [match[2] ?? "", ...lines.slice(index + 1)].join("\n").trim()
      // A GitHub login, or a GitLab/Gitea username (which may also hold `_` and `.`, never as its last character).
      const target = /^@([A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?)(?=\s|$)/.exec(rest)?.[1]
      const arg = (target ? rest.slice(target.length + 1).trim() : rest).slice(0, ARG_LIMIT)
      return { kind: kind as PrCommandKind, ...(arg ? { arg } : {}), ...(target ? { target } : {}) }
    }
  }
  return undefined
}

/**
 * Whether `actor` may run MendCode on the repository: write, maintain or admin. Reading another user's permission needs push access;
 * a reviewer the repository lists as a publisher without it falls back to the comment's author association (owner, member or
 * collaborator).
 */
export async function hasWriteAccess({ gh, repo, actor, association, provider }: { gh: GhCall; repo: string; actor: string; association?: string | undefined; provider?: ReviewProvider | undefined }) {
  // GitLab and Gitea: the provider's permission read (GitLab Developer or above, Gitea write or admin); no association fallback.
  if (provider) return /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/.test(actor) && ["admin", "write"].includes(await provider.permission({ repo, login: actor }).catch(() => "unknown"))
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor)) return false
  const done = await gh({ argv: ["api", `repos/${repo}/collaborators/${actor}/permission`, "--jq", ".permission"] })
  if (done.code === 0) return WRITE_PERMISSIONS.has(done.out.trim())
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "")
}

/** Where a comment was written: the conversation (issue comment) or a review thread (its `inReplyTo` is the thread's first comment). */
/** `association`: GitHub's author association of the commenter, the fallback when the reviewer may not read permissions. */
/** `discussion`: the GitLab discussion the comment belongs to, where its reply goes. */
export type CommandComment = { id: number; surface: "issue" | "review"; actor: string; body: string; association?: string | undefined; inReplyTo?: number | undefined; diffHunk?: string | undefined; path?: string | undefined; line?: number | undefined; discussion?: string | undefined }
/**
 * What a fix did. `ok` is a commit made after the checks passed: `pushed` to the PR's branch, or not (`fix.push` off) and `kept` on
 * a local ref. Not `ok` pushed nothing; `kept` names the local ref holding a commit that was made but not pushed (a push refused or
 * blocked by the revalidation), and `stale` says the branch or base moved meanwhile. `sessionId`: the fix session, kept for the user.
 * `notPushed`: why a committed fix was kept instead of pushed (`fix.push` off, a fork that does not let maintainers push, …).
 */
export type FixResult =
  | { ok: true; commit: string; pushed: boolean; kept?: string | undefined; sessionId?: string | undefined; notPushed?: string | undefined }
  | { ok: false; reason: string; commit?: string | undefined; kept?: string | undefined; stale?: boolean | undefined; sessionId?: string | undefined }
/** `text`, when set, is the whole reply (a review of a new head that found nothing new names that head and the earlier findings). */
export type ReviewSummary = { status: string; reason?: string | undefined; posted: boolean; text?: string | undefined }

/**
 * The reply to `@mendcode review` when the review of a new head found nothing new, so no review was posted: the head it reviewed,
 * how many earlier findings it resolved, and which are still open. `state` is the state after that review.
 */
export function nothingNewReply({ head, resolved, state }: { head: string; resolved: number; state: ReviewState }): string {
  const open = Object.values(state.published).flatMap((entry) => entry.finding && !entry.resolved ? [entry.finding] : [])
  const lines = [`Reviewed ${head.slice(0, 12)}: no new findings, so no new review was posted.`]
  if (resolved) lines.push(`${resolved} earlier finding${resolved === 1 ? " is" : "s are"} fixed on this head; ${resolved === 1 ? "its thread was" : "their threads were"} resolved or answered.`)
  if (open.length) {
    lines.push(`Still open from earlier reviews (${open.length}):`)
    for (const finding of open.slice(0, 10)) lines.push(`- \`${finding.path}:${finding.line}\` ${finding.summary.replace(/\s+/g, " ").slice(0, 160)}`)
    if (open.length > 10) lines.push(`- and ${open.length - 10} more`)
  } else if (Object.keys(state.published).length) lines.push("Every earlier finding is resolved.")
  return lines.join("\n")
}

export type CommandDeps = {
  gh: GhCall
  repo: string
  number: number
  comment: CommandComment
  state: ReviewState
  /** Runs the full review of the current head (`review`); it posts itself. */
  review(): Promise<ReviewSummary>
  /** Answers a question about a finding in a read-only child. */
  explain(input: { finding: PrFinding; question: string; diffHunk?: string | undefined }): Promise<string>
  /**
   * Edits the PR branch in a separate session and commits once; undefined where it cannot run. `push` is the decision from
   * `pushAllowed` and `guards` are the checks to repeat right before the push: the caller hands both to `runFix` (`push`,
   * `stillOpen`, `mayPush`), which keeps the commit on a local ref whenever it does not push.
   */
  fix?: ((input: { instructions: string; finding?: PrFinding | undefined; push: boolean; guards: FixGuards }) => Promise<FixResult>) | undefined
  /** Why `fix` cannot run here, when `fix` is undefined. */
  fixUnavailable?: string
  /** The base config's `fixes`. */
  fixesAllowed(): Promise<boolean>
  /** Whether a fix may push: the head branch lives in this repository, or its fork allows maintainer edits. */
  pushable(): Promise<boolean>
  /**
   * The repository's `fix.push` (and `fix.personal` for a personal reviewer): off, the fix is committed and kept locally, never
   * pushed. Unset: the fix pushes, as `fixes: true` alone always did.
   */
  pushAllowed?: (() => Promise<boolean>) | undefined
  /**
   * Why `review` or `fix` does not run on this pull request (the repository's filters, a personal profile's narrowing), checked
   * after the commenter's write access; undefined when it runs. A refused command gets one reply naming the filter, and no job or
   * model turn starts. A comment never overrides a filter.
   */
  refusal?: (() => Promise<string | undefined>) | undefined
  /**
   * The caller already checked the commenter (write access, or the daemon's own login) and the filters, in the daemon's order:
   * permission, then filters, then the reviewed head. They are not checked again here.
   */
  checked?: boolean | undefined
  /**
   * Sends one reply (the body already carries the reply and answer markers) and says whether it is on the pull request. The daemon
   * passes one that goes through the effects ledger, so a comment is answered once across retries and restarts; absent, the reply
   * is posted directly.
   */
  send?: ((input: { endpoint: string; body: string }) => Promise<boolean>) | undefined
  /**
   * GitLab and Gitea: the adapter answers what `gh` answers on GitHub (the commenter's write access, the replied-to comment, the
   * PR's state, a reply without `send`). Absent, everything goes through `gh` as before.
   */
  provider?: ReviewProvider | undefined
}

/** What a fix checks again right before it pushes: the PR is still open, and the commenter and the reviewer may still write to the branch. */
export type FixGuards = { stillOpen(): Promise<boolean>; mayPush(): Promise<true | string> }

/**
 * Fresh reads for `runFix`'s revalidation: the PR's state from GitHub, the commenter's write access again (a maintainer removed
 * meanwhile no longer gets a push), and whether the branch still accepts the reviewer's push. A failed read counts as "no": the fix
 * is then kept on its local ref instead of pushed.
 */
export function fixGuards({ gh, repo, number, actor, association, pushable, provider }: { gh: GhCall; repo: string; number: number; actor: string; association?: string | undefined; pushable(): Promise<boolean>; provider?: ReviewProvider | undefined }): FixGuards {
  return {
    async stillOpen() {
      if (provider) return (await provider.view({ directory: "", repo, number }).catch(() => undefined))?.open === true
      const done = await gh({ argv: ["api", `repos/${repo}/pulls/${number}`, "--jq", ".state"] })
      return done.code === 0 && done.out.trim() === "open"
    },
    async mayPush() {
      if (!await hasWriteAccess({ gh, repo, actor, association, ...(provider ? { provider } : {}) })) return `${actor} no longer has write access to ${repo}`
      if (!await pushable()) return "the branch no longer accepts pushes from maintainers"
      return true
    },
  }
}

/** The reply to `@mendcode fix`: what was pushed, or why nothing was, and where a commit that was not pushed is kept. */
export function fixReply(done: FixResult) {
  const where = (kept: string, commit?: string) => `The fix is kept in the reviewer's checkout as \`${kept}\`${commit ? ` (commit ${commit.slice(0, 12)})` : ""}, so it is not lost.`
  if (done.ok && done.pushed) return `Pushed ${done.commit.slice(0, 12)} to this branch.`
  if (done.ok) return `Committed ${done.commit.slice(0, 12)} but did not push it: \`fix.push\` is off for this repository.${done.kept ? ` ${where(done.kept)}` : ""}`
  const reason = done.reason.replace(/^\[PR_REVIEW\]:\s*/, "").slice(0, 3_000)
  const stale = done.stale ? " Ask again with `@mendcode fix` to redo it on the new head." : ""
  return `Nothing was pushed: ${reason}${done.kept ? `\n\n${where(done.kept, done.commit)}${stale}` : stale}`
}
/** `filtered`: a `review` or `fix` the repository's filters keep off this pull request (one reply names the filter). */
export type CommandOutcome = { kind: PrCommandKind | "denied" | "filtered"; reply?: string; posted: boolean; state: ReviewState }

/** Posts `text` where the comment was written, with the reply marker (and `extra` markers); through `send` when given. */
export async function replyTo({ gh, repo, number, comment, text, extra = "", send, provider }: { gh: GhCall; repo: string; number: number; comment: CommandComment; text: string; extra?: string; send?: CommandDeps["send"]; provider?: ReviewProvider | undefined }) {
  const body = `${text.trim().slice(0, 60_000)}\n\n${REPLY_MARKER}${answersMarker(comment.id)}${extra}`
  const endpoint = comment.surface === "review" ? `repos/${repo}/pulls/${number}/comments/${comment.inReplyTo ?? comment.id}/replies` : `repos/${repo}/issues/${number}/comments`
  if (send) return send({ endpoint, body })
  if (provider) return (await provider.reply?.({ repo, number, to: comment, body }).catch(() => undefined))?.ok === true
  const done = await gh({ argv: ["api", endpoint, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) })
  return done.code === 0
}

/** The reply to a `review` or `fix` that a filter refused: the filter by name, and how to change it. */
export const filteredReply = (kind: "review" | "fix", reason: string) =>
  `MendCode does not ${kind === "fix" ? "fix" : "review"} this pull request: ${reason}. A comment does not override the repository's filters (\`filters\` and \`triggers.drafts\` in \`.mendcode/review.yaml\` on the base branch, narrowed by the reviewer's personal profile); change the filter there, or remove the label, to have it ${kind === "fix" ? "fixed" : "reviewed"}.`

/** The finding a reply thread is about: from the saved state, or read back from MendCode's own comment. */
async function threadFinding({ gh, repo, number, comment, state, provider }: Pick<CommandDeps, "gh" | "repo" | "number" | "comment" | "state" | "provider">): Promise<PrFinding | undefined> {
  if (comment.surface !== "review" || !comment.inReplyTo) return undefined
  const saved = Object.entries(state.published).find(([, entry]) => entry.commentId === comment.inReplyTo)
  if (saved?.[1].finding) return saved[1].finding
  if (provider) {
    // The thread's first comment is MendCode's own: its finding marker names the finding, and the saved state holds it.
    const read = await provider.comments?.({ repo, number }).catch(() => undefined)
    const parent = read?.ok ? read.comments.find((item) => item.id === comment.inReplyTo) : undefined
    const id = FINDING_MARKER.exec(parent?.body ?? "")?.[1]
    if (!parent || !id) return undefined
    return state.published[id]?.finding ?? findingFromComment({ id, body: parent.body, path: parent.path, line: parent.line ?? null })
  }
  const done = await gh({ argv: ["api", `repos/${repo}/pulls/comments/${comment.inReplyTo}`] })
  if (done.code !== 0) return undefined
  try {
    const parent = JSON.parse(done.out) as { body?: string; path?: string; line?: number | null }
    const id = FINDING_MARKER.exec(parent.body ?? "")?.[1]
    return id ? findingFromComment({ id, body: parent.body ?? "", path: parent.path, line: parent.line }) : undefined
  } catch { return undefined }
}

/** `@mendcode explain`: a read-only child reads the code and answers about one finding; it may say the finding is wrong. */
export async function explainFinding({ sessionFactory, finding, question, diffHunk }: { sessionFactory: ReviewSessionFactory; finding: PrFinding; question: string; diffHunk?: string | undefined }) {
  const prompt = [
    "A maintainer replied to one of MendCode's review comments on this pull request and asks a question. Read the code to check before you answer. Answer in at most three short paragraphs of Markdown, cite file:line, and if the finding is wrong, say so plainly.",
    `The finding: ${finding.path}:${finding.line} (${finding.severity} ${finding.category}) ${finding.summary}\n${finding.detail}`,
    diffHunk ? `The diff around it:\n\`\`\`diff\n${diffHunk.slice(-4_000)}\n\`\`\`` : "",
    `The question:\n${question.slice(0, ARG_LIMIT)}`,
  ].filter(Boolean).join("\n\n")
  const session = await sessionFactory({ purpose: "review" })
  try { return (await session.send(prompt)).text.trim() || "I have no answer." } finally { await session.close() }
}

/** One learning as a single safe Markdown bullet. */
export function learningBullet(text: string) {
  const line = text.replace(/\s+/g, " ").replace(/`/g, "'").trim().slice(0, 300)
  return line ? `- ${line}` : ""
}

/** Checks the commenter, then runs the command and answers in the same thread. Never throws for a GitHub failure. */
export async function runPrCommand(command: PrCommand, deps: CommandDeps): Promise<CommandOutcome> {
  const { gh, repo, number, comment, provider } = deps
  const via = provider ? { provider } : {}
  const reply = async (text: string, extra = "") => ({ reply: text, posted: await replyTo({ gh, repo, number, comment, text, extra, ...(deps.send ? { send: deps.send } : {}), ...via }) })
  if (!deps.checked && !await hasWriteAccess({ gh, repo, actor: comment.actor, association: comment.association, ...via })) return { kind: "denied", ...await reply(MAINTAINERS_ONLY), state: deps.state }
  if (!deps.checked && (command.kind === "review" || command.kind === "fix") && deps.refusal) {
    const refused = await deps.refusal()
    if (refused) return { kind: "filtered", ...await reply(filteredReply(command.kind, refused)), state: deps.state }
  }
  switch (command.kind) {
    case "review": {
      const done = await deps.review()
      if (done.posted) return { kind: "review", posted: true, state: deps.state }
      if (done.text) return { kind: "review", ...await reply(done.text), state: deps.state }
      return { kind: "review", ...await reply(`Reviewed the current head: ${done.status}${done.reason ? ` (${done.reason})` : ""}.`), state: deps.state }
    }
    case "pause":
    case "resume": {
      const paused = command.kind === "pause"
      const state = { ...deps.state, paused }
      return { kind: command.kind, ...await reply(paused ? "Paused: new pushes to this pull request are not reviewed until `@mendcode resume`. `@mendcode review` still reviews on request." : "Resumed: the next push is reviewed.", `\n<!-- mendcode:paused=${paused ? 1 : 0} -->`), state }
    }
    case "explain": {
      const finding = await threadFinding(deps)
      if (!finding) return { kind: "explain", ...await reply("`@mendcode explain` works as a reply to one of MendCode's review comments."), state: deps.state }
      const answer = await deps.explain({ finding, question: command.arg ?? "Explain this finding: why it is a problem and how to fix it.", diffHunk: comment.diffHunk }).catch((error: unknown) => `I could not answer: ${error instanceof Error ? error.message.replace(/^\[PR_REVIEW\]:\s*/, "") : String(error)}`)
      return { kind: "explain", ...await reply(answer.slice(0, 6_000)), state: deps.state }
    }
    case "fix": {
      if (!deps.fix) return { kind: "fix", ...await reply(deps.fixUnavailable ?? "`@mendcode fix` cannot run here."), state: deps.state }
      if (!await deps.fixesAllowed()) return { kind: "fix", ...await reply("`@mendcode fix` is off for this repository: set `fixes: true` in `.mendcode/review.yaml` on the base branch."), state: deps.state }
      if (!await deps.pushable()) return { kind: "fix", ...await reply("`@mendcode fix` cannot push to this branch: it lives in a fork that does not allow edits from maintainers."), state: deps.state }
      const finding = await threadFinding(deps)
      const instructions = command.arg ?? (finding ? `Fix this finding: ${finding.summary}` : "")
      if (!instructions) return { kind: "fix", ...await reply("Say what to fix (`@mendcode fix the null check in parse`), or reply to one of MendCode's review comments."), state: deps.state }
      const push = deps.pushAllowed ? await deps.pushAllowed() : true
      const guards = fixGuards({ gh, repo, number, actor: comment.actor, association: comment.association, pushable: deps.pushable, ...via })
      const done = await deps.fix({ instructions, finding, push, guards }).catch((error: unknown): FixResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
      return { kind: "fix", ...await reply(fixReply(done)), state: deps.state }
    }
    case "learn": {
      const bullet = learningBullet(command.arg ?? "")
      if (!bullet) return { kind: "learn", ...await reply("Say what to learn: `@mendcode learn a missing await on store.flush is intended`."), state: deps.state }
      // A learning counts once it is on the base branch, so it is proposed as a commit a maintainer makes, never written by a PR.
      return { kind: "learn", ...await reply(`To teach the reviewer, commit this line to \`.mendcode/review-learnings.md\` on the base branch; it counts once merged:\n\n\`\`\`sh\ncat >> .mendcode/review-learnings.md <<'LEARNING'\n${bullet}\nLEARNING\ngit add .mendcode/review-learnings.md && git commit -m "review: add a learning"\n\`\`\``), state: deps.state }
    }
  }
}

/** The pause flag as MendCode's own replies record it: the newest pause or resume marker wins. */
export function pausedFromComments(comments: ReadonlyArray<{ body?: string | null; created_at?: string | null }>) {
  const marks = comments.flatMap((comment) => { const mark = PAUSE_MARKER.exec(comment.body ?? "")?.[1]; return mark ? [{ paused: mark === "1", at: comment.created_at ?? "" }] : [] })
  return marks.sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.paused
}

type CheckRun = { id?: number; name?: string; conclusion?: string | null; details_url?: string | null }
const FAILED = new Set(["failure", "timed_out", "startup_failure"])

/** A short id for a failing set: the head and the names of its failed checks. */
export const failingKey = (head: string, names: readonly string[]) => createHash("sha256").update(`${head}\n${[...names].sort().join("\n")}`).digest("hex").slice(0, 16)

/** The lines of a failed job's log worth reading: the error lines, else the tail; bounded. */
export function failureExcerpt(log: string) {
  const lines = log.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\S+\t\S+\t\S+Z /, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""))
  const errors = lines.filter((line) => /\b(error|failed|fail|exception|assert|panic)\b/i.test(line)).slice(-20)
  return (errors.length ? errors : lines.filter((line) => line.trim()).slice(-20)).join("\n").slice(-LOG_LIMIT)
}

/**
 * After a review, a check that fails on the reviewed head gets one comment with its cause: the failed job's log lines, bounded,
 * through `gh run view --log-failed`. The same failing set is explained once (`state.explainedFailures`); a new failure, or the
 * same one on a new head, is explained again.
 */
export async function failureFollowUp({ gh, repo, number, head, state }: { gh: GhCall; repo: string; number: number; head: string; state: ReviewState }): Promise<{ posted: boolean; state: ReviewState; key?: string }> {
  const listed = await gh({ argv: ["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`, "--jq", ".check_runs[] | {id, name, conclusion, details_url}"] })
  if (listed.code !== 0) return { posted: false, state }
  const failed = listed.out.split("\n").flatMap((line) => { try { const run = JSON.parse(line) as CheckRun; return run.conclusion && FAILED.has(run.conclusion) ? [run] : [] } catch { return [] } })
  if (!failed.length) return { posted: false, state }
  const key = failingKey(head, failed.map((run) => run.name ?? "check"))
  if (state.explainedFailures === key) return { posted: false, state, key }
  const sections: string[] = []
  for (const run of failed.slice(0, MAX_FAILURES)) {
    const job = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(run.details_url ?? "")
    let cause = "No log: this check does not run on GitHub Actions."
    if (job) {
      const log = await gh({ argv: ["run", "view", job[1]!, "--repo", repo, "--job", job[2]!, "--log-failed"] })
      cause = log.code === 0 && log.out.trim() ? failureExcerpt(log.out) : "gh could not read its log."
    }
    sections.push(`**${(run.name ?? "check").replace(/[*`]/g, "")}**${run.details_url ? ` ([details](${run.details_url}))` : ""}\n\n\`\`\`text\n${cause.replace(/```/g, "'''")}\n\`\`\``)
  }
  const more = failed.length > MAX_FAILURES ? `\n\nAnd ${failed.length - MAX_FAILURES} more failing check${failed.length - MAX_FAILURES === 1 ? "" : "s"}.` : ""
  const body = `**MendCode**: ${failed.length} check${failed.length === 1 ? "" : "s"} failed on ${head.slice(0, 12)}, which MendCode reviewed.\n\n${sections.join("\n\n")}${more}\n\n${REPLY_MARKER}\n<!-- mendcode:followup=${key} -->`
  const done = await gh({ argv: ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) })
  return done.code === 0 ? { posted: true, state: { ...state, explainedFailures: key }, key } : { posted: false, state, key }
}
