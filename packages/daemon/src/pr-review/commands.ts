import { createHash } from "node:crypto"
import type { PrFinding } from "@mendcode/protocol"
import type { ReviewSessionFactory } from "./engine"
import { findingFromComment, type GhCall } from "./publish"
import { FINDING_MARKER, type ReviewState } from "./state"

/**
 * Commands a maintainer writes in a pull request (docs/pr-review.md): `@mendcode review | pause | resume | explain | fix | learn`.
 * Only someone with write access is answered with anything but a refusal. Every reply carries a hidden marker, so MendCode never
 * takes its own reply for a command, and a hosted runner reads `pause` back from GitHub. Follow-ups explain a failing check of a
 * reviewed head once per failing set.
 */

export const PR_COMMANDS = ["review", "pause", "resume", "explain", "fix", "learn"] as const
export type PrCommandKind = (typeof PR_COMMANDS)[number]
export type PrCommand = { kind: PrCommandKind; arg?: string }

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
      const arg = [match[2] ?? "", ...lines.slice(index + 1)].join("\n").trim().slice(0, ARG_LIMIT)
      return { kind: kind as PrCommandKind, ...(arg ? { arg } : {}) }
    }
  }
  return undefined
}

/** Whether `actor` may run MendCode on the repository: write, maintain or admin. */
export async function hasWriteAccess({ gh, repo, actor }: { gh: GhCall; repo: string; actor: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor)) return false
  const done = await gh({ argv: ["api", `repos/${repo}/collaborators/${actor}/permission`, "--jq", ".permission"] })
  return done.code === 0 && WRITE_PERMISSIONS.has(done.out.trim())
}

/** Where a comment was written: the conversation (issue comment) or a review thread (its `inReplyTo` is the thread's first comment). */
export type CommandComment = { id: number; surface: "issue" | "review"; actor: string; body: string; inReplyTo?: number | undefined; diffHunk?: string | undefined; path?: string | undefined; line?: number | undefined }
export type FixResult = { ok: true; commit: string } | { ok: false; reason: string }
export type ReviewSummary = { status: string; reason?: string | undefined; posted: boolean }

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
  /** Edits the PR branch in a separate session and pushes one commit; undefined where it cannot run. */
  fix?: ((input: { instructions: string; finding?: PrFinding | undefined }) => Promise<FixResult>) | undefined
  /** Why `fix` cannot run here, when `fix` is undefined. */
  fixUnavailable?: string
  /** The base config's `fixes`. */
  fixesAllowed(): Promise<boolean>
  /** Whether a fix may push: the head branch lives in this repository, or its fork allows maintainer edits. */
  pushable(): Promise<boolean>
}
export type CommandOutcome = { kind: PrCommandKind | "denied"; reply?: string; posted: boolean; state: ReviewState }

/** Posts `text` where the comment was written, with the reply marker (and `extra` markers). */
export async function replyTo({ gh, repo, number, comment, text, extra = "" }: { gh: GhCall; repo: string; number: number; comment: CommandComment; text: string; extra?: string }) {
  const body = `${text.trim().slice(0, 60_000)}\n\n${REPLY_MARKER}${extra}`
  const endpoint = comment.surface === "review" ? `repos/${repo}/pulls/${number}/comments/${comment.inReplyTo ?? comment.id}/replies` : `repos/${repo}/issues/${number}/comments`
  const done = await gh({ argv: ["api", endpoint, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) })
  return done.code === 0
}

/** The finding a reply thread is about: from the saved state, or read back from MendCode's own comment. */
async function threadFinding({ gh, repo, comment, state }: Pick<CommandDeps, "gh" | "repo" | "comment" | "state">): Promise<PrFinding | undefined> {
  if (comment.surface !== "review" || !comment.inReplyTo) return undefined
  const saved = Object.entries(state.published).find(([, entry]) => entry.commentId === comment.inReplyTo)
  if (saved?.[1].finding) return saved[1].finding
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
  const { gh, repo, number, comment } = deps
  const reply = async (text: string, extra = "") => ({ reply: text, posted: await replyTo({ gh, repo, number, comment, text, extra }) })
  if (!await hasWriteAccess({ gh, repo, actor: comment.actor })) return { kind: "denied", ...await reply(MAINTAINERS_ONLY), state: deps.state }
  switch (command.kind) {
    case "review": {
      const done = await deps.review()
      if (done.posted) return { kind: "review", posted: true, state: deps.state }
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
      const done = await deps.fix({ instructions, finding }).catch((error: unknown): FixResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
      return { kind: "fix", ...await reply(done.ok ? `Pushed ${done.commit.slice(0, 12)} to this branch.` : `Nothing was pushed: ${done.reason.replace(/^\[PR_REVIEW\]:\s*/, "").slice(0, 3_000)}`), state: deps.state }
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
