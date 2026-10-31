import { estimateTokens, type PrStopReason } from "@mendcode/protocol"
import { budgetPolicy, stopText } from "./budget"
import { ignoredBy, readReviewConfig, type ReviewConfig } from "./config"
import { CONTEXT_SHARE, gitRun, parseUnifiedDiff, type GitRun, type ReviewContext } from "./context"
import type { JobCheckpoint, PhasePlan, RunPlatformInput } from "./contracts"
import type { ReviewCheckpoint, ReviewOutcome, ReviewSessionFactory } from "./engine"
import { spokenLanguage, withReviewLanguage } from "./language"
import { phaseFacts, planPhases } from "./phases"
import { attemptReview, engineConfigFor } from "./run"

/**
 * An explicit audit of a repository at a commit (docs/pr-review.md, coverage `audit`; R01): the whole tree reviewed as if every
 * file were added on top of git's empty tree, through the same review and verify passes as a pull request. It is only ever
 * started by a person (the `pr.review` command's `audit` action; no slash command sends it yet), never by a watch. Its findings are for the session that asked:
 * there is no pull request to post them on, and this module has no way to publish (no `gh`, no provider).
 *
 * A repository is usually far larger than one call may carry, so the context is bounded by the budget's `contextTokens` (half of
 * it, like a pull request's diff): files are taken in path order while they fit, the rest are named in the notes (the review
 * child may still open them with its read-only tools). Binary files, symlinks and submodules are left out. No check commands run.
 */

/** git's empty tree: the base an audit is reviewed against. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** A file larger than this is never put in the prompt whole, whatever the budget. */
const MAX_FILE_BYTES = 256 * 1024
/** At most this many files are read for one audit context. */
const MAX_FILES = 2_000

export type AuditContext = ReviewContext & { cut: Array<{ path: string; reason: "budget" | "size" | "binary" }> }

/** One tree entry of `git ls-tree -r -l -z`: `<mode> <type> <object> <size>\t<path>`. */
const TREE_ENTRY = /^(\d{6}) (\w+) [0-9a-f]+\s+(-|\d+)\t([\s\S]+)$/

/** A file's whole text as an added file in a unified diff, so every line is a new-side line a finding may name. */
function addedFile(path: string, text: string): string {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ""].join("\n")
}

/**
 * The audit's context: the files at `head` within `contextTokens * CONTEXT_SHARE`, chosen by size before any is read, in path
 * order (a large file is skipped so smaller ones after it still fit). What was left out, and why, is in `cut` and in the notes.
 */
export async function auditContext({ directory, head, git = gitRun, contextTokens, ignore = () => false }: { directory: string; head: string; git?: GitRun; contextTokens: number; ignore?: (path: string) => boolean }): Promise<AuditContext> {
  const listed = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", head], directory)
  if (listed.code !== 0) throw new Error(`[PR_REVIEW]: git ls-tree ${head.slice(0, 12)} failed in ${directory}`)
  const limit = Math.max(1_000, Math.floor(contextTokens * CONTEXT_SHARE))
  const cut: AuditContext["cut"] = []
  const chosen: string[] = []
  let used = 0
  const entries = listed.out.split("\0").flatMap((record) => { const match = TREE_ENTRY.exec(record); return match ? [{ mode: match[1]!, type: match[2]!, size: Number(match[3]), path: match[4]! }] : [] })
  for (const entry of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (entry.type !== "blob" || entry.mode === "120000" || ignore(entry.path)) continue
    if (!Number.isFinite(entry.size) || entry.size > MAX_FILE_BYTES) { cut.push({ path: entry.path, reason: "size" }); continue }
    // The added-file form adds a `+` per line and a header: a little over the file's own size.
    const estimate = estimateTokens(entry.size + Math.ceil(entry.size / 30) + entry.path.length * 2 + 80)
    if (used + estimate > limit || chosen.length >= MAX_FILES) { cut.push({ path: entry.path, reason: "budget" }); continue }
    chosen.push(entry.path)
    used += estimate
  }
  const parts: string[] = []
  for (const path of chosen) {
    const shown = await git(["show", `${head}:${path}`], directory)
    if (shown.code !== 0) continue
    if (shown.out.includes("\0")) { cut.push({ path, reason: "binary" }); continue }
    if (!shown.out.length) continue
    parts.push(addedFile(path, shown.out))
  }
  const diff = parts.join("")
  const files = parseUnifiedDiff(diff)
  const notes = [`An audit of the whole repository at ${head.slice(0, 12)}, not a pull request: every file is shown as added on git's empty tree. Report defects in the code as it is; nothing is posted anywhere.`]
  const byBudget = cut.filter((entry) => entry.reason === "budget").map((entry) => entry.path)
  const bySize = cut.filter((entry) => entry.reason === "size").map((entry) => entry.path)
  const list = (paths: readonly string[]) => `${paths.slice(0, 8).join(", ")}${paths.length > 8 ? `, … (${paths.length - 8} more)` : ""}`
  if (byBudget.length) notes.push(`The context budget (${limit.toLocaleString("en-US")} tokens for the code) left out ${byBudget.length} file${byBudget.length === 1 ? "" : "s"}: ${list(byBudget)}. Open them with your tools where the shown code depends on them.`)
  if (bySize.length) notes.push(`${bySize.length} file${bySize.length === 1 ? " is" : "s are"} larger than ${MAX_FILE_BYTES / 1024} KB and not shown: ${list(bySize)}.`)
  return { directory, base: EMPTY_TREE, head, diff, files, changedSymbols: [], truncated: cut.length > 0, notes, tokens: estimateTokens(diff.length), cut }
}

export type AuditRun = {
  status: "reviewed" | "failed"
  coverage: "audit"
  /** Always `EMPTY_TREE`. */
  base: string
  head: string
  reason?: string | undefined
  config?: ReviewConfig | undefined
  outcome?: ReviewOutcome | undefined
  /** Set when the audit stopped before it was complete (budget, quota, rate limit, failed verifier): resume from `checkpoint`. */
  stop?: PrStopReason | undefined
  checkpoint?: JobCheckpoint | undefined
  plan?: PhasePlan | undefined
  /** Files in the prompt, and the ones left out with why. */
  files: number
  cut: AuditContext["cut"]
  /** The session notice: findings, what was cut, and the stop when there is one. */
  text: string
}

/**
 * Audits the repository in `directory` at `head` (default `HEAD`). `config` defaults to `.mendcode/review.yaml` at that commit.
 * `checkpoint` (from an earlier stopped audit of the same head) resumes verification without a second review pass. Never throws:
 * a failure is `status: "failed"` with its reason.
 */
export async function runAudit({ directory, head = "HEAD", sessionFactory, git = gitRun, config, contextWindow, account, memory, checkpoint }: {
  directory: string; head?: string; sessionFactory: ReviewSessionFactory; git?: GitRun; config?: ReviewConfig | undefined
  contextWindow?: number | undefined; account?: RunPlatformInput["account"]; memory?: RunPlatformInput["memory"]; checkpoint?: JobCheckpoint | undefined
}): Promise<AuditRun> {
  const failed = (reason: string, sha = head, extra: Partial<AuditRun> = {}): AuditRun => ({ status: "failed", coverage: "audit", base: EMPTY_TREE, head: sha, reason, files: 0, cut: [], text: `Audit of ${directory} at ${sha.slice(0, 12)}: failed (${reason.replace(/^\[PR_REVIEW\]:\s*/, "")})`, ...extra })
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(head) || head.includes("..")) return failed(`[PR_REVIEW]: invalid ref ${JSON.stringify(head.slice(0, 80))}`)
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${head}^{commit}`], directory)
  const sha = resolved.out.trim()
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return failed(`[PR_REVIEW]: ${head} is not a commit in ${directory}`)
  try {
    const read = config ? { config, learnings: "", notes: [] as string[] } : await readReviewConfig({ directory, base: sha, head: sha, git })
    // No pull request to judge `auto` from: the default language, named, for every prompt and harness setting.
    const effective = withReviewLanguage(read.config, spokenLanguage(read.config.template.language))
    const budget = budgetPolicy(effective, { contextWindow })
    const context = await auditContext({ directory, head: sha, git, contextTokens: budget.contextTokens, ignore: ignoredBy(effective) })
    context.notes.unshift(...read.notes)
    if (!context.files.length) return failed("the commit has no text file to audit within the context budget", sha, { config: effective, cut: context.cut })
    const plan = planPhases({ config: effective.phases, facts: phaseFacts({ context, fixMode: "review" }) })
    const remembered = memory ? await memory({ title: `Audit of ${directory}`, files: context.files.map((file) => file.path) }).catch(() => undefined) : undefined
    const engineConfig = engineConfigFor({ config: effective, context, learnings: read.learnings, budgetTokens: budget.tokensPerPr ?? Number.POSITIVE_INFINITY, plan, memory: remembered })
    const resume = checkpoint?.result && checkpoint.result.head === sha ? checkpoint as ReviewCheckpoint : undefined
    const attempt = await attemptReview({ sessionFactory, account, context, config: engineConfig, plan, cap: effective.cap, checkpoint: resume })
    const base = { status: "reviewed" as const, coverage: "audit" as const, base: EMPTY_TREE, head: sha, config: effective, plan, files: context.files.length, cut: context.cut }
    if (!attempt.ok) return { ...base, reason: "audit incomplete; stopped by the provider's limit", stop: attempt.stop, checkpoint: attempt.checkpoint, text: auditText({ directory, head: sha, cut: context.cut, stop: attempt.stop }) }
    const outcome = attempt.outcome
    const kept: JobCheckpoint = outcome.checkpoint ?? { completedPhases: outcome.completedPhases ?? [], candidates: [], verified: outcome.candidates, result: outcome.result, rounds: [], decisions: plan.decisions, ...(outcome.sections ? { sections: outcome.sections } : {}) }
    const status = !outcome.verified && !attempt.limit ? "failed" as const : "reviewed" as const
    return {
      ...base, status, outcome, checkpoint: kept,
      ...(outcome.stop ? { stop: outcome.stop, reason: status === "failed" ? "verification failed" : `audit incomplete (${outcome.stop.kind})` } : {}),
      text: auditText({ directory, head: sha, cut: context.cut, outcome, ...(outcome.stop ? { stop: outcome.stop } : {}) }),
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), sha)
  }
}

/** The audit's session notice. */
function auditText({ directory, head, cut, outcome, stop }: { directory: string; head: string; cut: AuditContext["cut"]; outcome?: ReviewOutcome | undefined; stop?: PrStopReason | undefined }): string {
  const lines = [`Audit of ${directory} at ${head.slice(0, 12)}${stop ? " (incomplete)" : ""}: kept in this session, never posted.`]
  const result = outcome?.result
  if (result) {
    lines.push(result.summary.trim() || "No findings.")
    for (const finding of result.findings) lines.push(`- ${finding.path}:${finding.line} ${finding.severity} ${finding.category}${finding.verdict === "plausible" ? " (plausible)" : ""}: ${finding.summary}`)
    lines.push(`tokens: ${result.tokens.input.toLocaleString("en-US")} in, ${result.tokens.output.toLocaleString("en-US")} out`)
  }
  if (cut.length) lines.push(`${cut.length} file${cut.length === 1 ? " was" : "s were"} not in the prompt (budget, size or binary).`)
  if (stop) lines.push(stopText(stop, result ? { tokens: result.tokens } : {}))
  return lines.join("\n")
}
