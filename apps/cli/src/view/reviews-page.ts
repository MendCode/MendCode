import type { PrJobSummary, PrReviewConfigView, PrReviewDashboard, PrReviewerSummary } from "@mendcode/protocol"
import { isCompact, isWide } from "../ui/breakpoints"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { fit, panelGrid, spread, type GridPanel } from "./deck"
import { thousands } from "./format"
import { tabsRow, type PageTab } from "./page"
import { pickerFrame } from "./picker-frame"
import { relativeTime, timeAgo } from "./session-list"
import { shortenMiddle, textWidth, truncateEnd, wrap } from "./wrap"
import { SEARCH_HINT } from "./page-search"
import { reviewStep, type ReviewActivityJob } from "./review-activity"
import { formatElapsed } from "./time"
import { SPINNER_FRAMES } from "./tool-card"

/**
 * `/reviews` (and `/pr dashboard`): the PR review platform's page (docs/pr-review.md). Jobs grouped by state with stacks under their
 * root, the watches and reviewers, a job's detail and the job actions. Data is the `pr.review` action `status` (a
 * `PrReviewDashboard`); this module only lays it out and never computes a metric of its own. Pure. Keys: `reviews-keys.ts`.
 */

export type JobState = PrJobSummary["state"]
export type ReviewGroupId = "running" | "fixing" | "waiting" | "checkpointed" | "paused" | "pending" | "failed" | "done" | "ended"
/** `ready`, `needs-work` and `closed` filter on the pull request's GitHub state (`prVerdict`), not the review's. */
export type PrFilter = "ready" | "needs-work" | "closed"
export type StateFilter = "all" | ReviewGroupId | PrFilter

/** The order the page lists jobs in: work in motion first, then held, queued, failed and finished work. */
export const REVIEW_GROUPS: ReadonlyArray<{ id: ReviewGroupId; label: string; states: readonly JobState[]; tone: ColorName }> = [
  { id: "running", label: "Running", states: ["running"], tone: "primary" },
  { id: "fixing", label: "Fixing · validating", states: ["fixing", "validating"], tone: "primary" },
  { id: "waiting", label: "Waiting · offline", states: ["waiting"], tone: "warning" },
  { id: "checkpointed", label: "Checkpointed", states: ["checkpointed"], tone: "warning" },
  { id: "paused", label: "Paused", states: ["paused"], tone: "muted" },
  { id: "pending", label: "Pending", states: ["pending"], tone: "text" },
  { id: "failed", label: "Failed", states: ["failed"], tone: "error" },
  { id: "done", label: "Done", states: ["done"], tone: "success" },
  { id: "ended", label: "Stale · cancelled", states: ["stale", "cancelled"], tone: "muted" },
]
export const PR_FILTERS: ReadonlyArray<{ id: PrFilter; label: string }> = [{ id: "ready", label: "ready" }, { id: "needs-work", label: "needs work" }, { id: "closed", label: "closed" }]
export const STATE_FILTERS: readonly StateFilter[] = ["all", ...REVIEW_GROUPS.map((group) => group.id), ...PR_FILTERS.map((filter) => filter.id)]
const filterLabel = (filter: StateFilter) => PR_FILTERS.find((entry) => entry.id === filter)?.label ?? REVIEW_GROUPS.find((entry) => entry.id === filter)?.label.toLowerCase() ?? filter

/**
 * What the pull request's GitHub state says, for its cell and the `ready` · `needs work` · `closed` filters: `ready` is open, not a
 * draft, mergeable, checks passing (or none) and no blocking finding; `ci-failed`, `conflict` and `blocking` need work. Undefined
 * while the state is unknown (not read yet, or not GitHub).
 */
export type PrVerdict = "merged" | "closed" | "draft" | "ready" | "ci-failed" | "ci-running" | "conflict" | "blocking" | "open"
export function prVerdict(job: PrJobSummary): PrVerdict | undefined {
  const pr = job.pullRequest
  if (!pr) return undefined
  if (pr.state !== "open") return pr.state
  if (pr.draft) return "draft"
  if (pr.checks === "failing") return "ci-failed"
  if (pr.mergeable === "conflicting") return "conflict"
  if ((job.findings.blocking ?? 0) > 0) return "blocking"
  if (pr.checks === "pending") return "ci-running"
  return pr.mergeable === "mergeable" ? "ready" : "open"
}

const PR_CELLS: Record<PrVerdict, { text: string; fg: ColorName }> = {
  merged: { text: "merged", fg: "muted" },
  closed: { text: "closed", fg: "muted" },
  draft: { text: "draft", fg: "muted" },
  ready: { text: "open · ready", fg: "success" },
  "ci-failed": { text: "open · CI ✗", fg: "error" },
  "ci-running": { text: "open · CI …", fg: "muted" },
  conflict: { text: "open · conflict", fg: "warning" },
  blocking: { text: "open · findings", fg: "warning" },
  open: { text: "open", fg: "muted" },
}

/** The row's pull request cell and the detail's `pull request` line; undefined while the state is unknown. */
export function prCell(job: PrJobSummary): { text: string; fg: ColorName } | undefined {
  const verdict = prVerdict(job)
  return verdict ? PR_CELLS[verdict] : undefined
}

function matchesPrFilter(job: PrJobSummary, filter: PrFilter) {
  const verdict = prVerdict(job)
  if (filter === "ready") return verdict === "ready"
  if (filter === "closed") return verdict === "merged" || verdict === "closed"
  return verdict === "ci-failed" || verdict === "conflict" || verdict === "blocking"
}
const isPrFilter = (filter: StateFilter): filter is PrFilter => PR_FILTERS.some((entry) => entry.id === filter)

/** Where the page's data stands: `unavailable` is a daemon whose `status` answer has no dashboard; `remote` a client that may not ask. */
export type ReviewsData = { status: "loading" | "ready" | "error" | "unavailable" | "remote"; dashboard?: PrReviewDashboard; error?: string; fetchedAt?: number }

export type ReviewsConfirm = { kind: "cancel" | "forget" | "take-over" | "release"; jobId: string; number: number }
export type ReviewsConfigState = { jobId: string; number: number; scope: PrJobSummary["scope"]; status: "loading" | "ready" | "error"; view?: PrReviewConfigView; error?: string }

export type ReviewsPageState = {
  /** 0 jobs, 1 watches and reviewers. */
  tab: 0 | 1
  /**
   * The job the user picked (↑↓, enter or a job action), by id, so a refresh that reorders the list keeps the selection on it.
   * Unset, the selection follows the latest review (`followedJob`); esc in the list unsets it again.
   */
  selectedId?: string
  selected: number
  /** The selected job's detail fills the page (Enter); the list shows otherwise. */
  detail: boolean
  scroll: number
  filter: { text: string; state: StateFilter; repo?: string }
  /** `/` was pressed: printable keys go to the text filter. */
  typing?: boolean
  confirm?: ReviewsConfirm
  /** `R` asked for the reason a retry is sent with. */
  reason?: { jobId: string; number: number; text: string }
  config?: ReviewsConfigState
  /** `?` opened the list of every key under the tabs; `?` or esc closes it. */
  keys?: boolean
}

export const MAX_FILTER_TEXT = 100
export const MAX_REASON_TEXT = 600

export function createReviewsPageState(): ReviewsPageState {
  return { tab: 0, selected: 0, detail: false, scroll: 0, filter: { text: "", state: "all" } }
}

// ── Model: filter, groups, stacks ─────────────────────────────────────────────────────────────────────────────────────────

const groupOf = (state: JobState) => REVIEW_GROUPS.find((group) => group.states.includes(state))!

function haystack(job: PrJobSummary) {
  return [`#${job.number}`, String(job.number), job.title ?? "", job.repo, job.reviewer, job.phase ?? "", job.state, job.assignment ?? "", job.owner ?? "", job.stop?.kind ?? ""].join("\n").toLowerCase()
}

/** Jobs that pass the filter: every word of the text, the state group and the repository. */
export function filterJobs(jobs: readonly PrJobSummary[], filter: ReviewsPageState["filter"]): PrJobSummary[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean)
  const state = filter.state
  return jobs.filter((job) => (state === "all" || (isPrFilter(state) ? matchesPrFilter(job, state) : groupOf(job.state).id === state))
    && (!filter.repo || job.repo === filter.repo)
    && (!words.length || words.every((word) => haystack(job).includes(word))))
}

export type ReviewRow =
  | { kind: "group"; id: ReviewGroupId; label: string; tone: ColorName; count: number }
  | { kind: "job"; job: PrJobSummary; depth: number; stackedOn?: number }

const newest = (a: PrJobSummary, b: PrJobSummary) => b.updatedAt - a.updatedAt || a.number - b.number

/**
 * A group's jobs with each stacked PR under its parent (same repository, parent number in the group), depth first. A job whose
 * parent is in another group or not listed starts its own tree and says what it is stacked on. A cycle never loops: a job already
 * placed is not placed again, and jobs only reachable through a cycle are listed as roots.
 */
export function stackOrder(jobs: readonly PrJobSummary[]): Array<{ job: PrJobSummary; depth: number; stackedOn?: number }> {
  const key = (repo: string, number: number) => `${repo}#${number}`
  const byPr = new Map<string, PrJobSummary>()
  for (const job of jobs) if (!byPr.has(key(job.repo, job.number))) byPr.set(key(job.repo, job.number), job)
  const children = new Map<PrJobSummary, PrJobSummary[]>()
  const roots: PrJobSummary[] = []
  for (const job of [...jobs].sort(newest)) {
    const parent = job.stack?.parent === undefined ? undefined : byPr.get(key(job.repo, job.stack.parent))
    if (parent && parent !== job) children.set(parent, [...(children.get(parent) ?? []), job])
    else roots.push(job)
  }
  const out: Array<{ job: PrJobSummary; depth: number; stackedOn?: number }> = []
  const placed = new Set<PrJobSummary>()
  const visit = (job: PrJobSummary, depth: number) => {
    if (placed.has(job)) return
    placed.add(job)
    out.push({ job, depth, ...(depth === 0 && job.stack?.parent !== undefined ? { stackedOn: job.stack.parent } : {}) })
    for (const child of (children.get(job) ?? []).sort((a, b) => a.number - b.number)) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  for (const job of jobs) visit(job, 0)
  return out
}

const IN_FLIGHT: ReadonlySet<JobState> = new Set(["running", "fixing", "validating"])
/** The key one pull request's jobs share; an audit is its own. */
const prKey = (job: PrJobSummary) => (job.coverage === "audit" ? `audit:${job.id}` : `${job.repo}#${job.number}`)

/**
 * One job per pull request, the one the list shows: the job at work if there is one, else the newest. The others (earlier heads,
 * earlier attempts) are its history, newest first, shown in its detail. So a failure a later review of the PR superseded is history,
 * not a failure of the PR, and a PR reviewed at twelve heads is one row.
 */
export function latestPerPr(jobs: readonly PrJobSummary[]): { latest: PrJobSummary[]; history: Map<string, PrJobSummary[]> } {
  const byPr = new Map<string, PrJobSummary[]>()
  for (const job of jobs) byPr.set(prKey(job), [...(byPr.get(prKey(job)) ?? []), job])
  const latest: PrJobSummary[] = []
  const history = new Map<string, PrJobSummary[]>()
  for (const members of byPr.values()) {
    const ordered = [...members].sort((a, b) => Number(IN_FLIGHT.has(b.state)) - Number(IN_FLIGHT.has(a.state)) || b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
    const [shown, ...earlier] = ordered
    latest.push(shown!)
    if (earlier.length) history.set(shown!.id, earlier.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt))
  }
  return { latest, history }
}

/** The list as rows: a header per non-empty group (in `REVIEW_GROUPS` order), then its jobs in stack order. */
export function groupedRows(jobs: readonly PrJobSummary[]): ReviewRow[] {
  const rows: ReviewRow[] = []
  for (const group of REVIEW_GROUPS) {
    const members = jobs.filter((job) => group.states.includes(job.state))
    if (!members.length) continue
    rows.push({ kind: "group", id: group.id, label: group.label, tone: group.tone, count: members.length })
    for (const entry of stackOrder(members)) rows.push({ kind: "job", ...entry })
  }
  return rows
}

/** The jobs in the order the list shows them (one per pull request), after the filter: the selection moves through these. */
export function listedJobs(dashboard: PrReviewDashboard | undefined, filter: ReviewsPageState["filter"]): PrJobSummary[] {
  if (!dashboard) return []
  return groupedRows(filterJobs(latestPerPr(dashboard.jobs).latest, filter)).flatMap((row) => (row.kind === "job" ? [row.job] : []))
}

/**
 * The job an unpinned selection follows: the running review that started last (its live start, else when it was queued), else
 * the job updated last. A tie keeps the one listed first.
 */
export function followedJob(jobs: readonly PrJobSummary[], activity: readonly ReviewActivityJob[] = []): PrJobSummary | undefined {
  const started = new Map(activity.map((job) => [job.jobId, job.startedAt]))
  const latest = (list: readonly PrJobSummary[], at: (job: PrJobSummary) => number) => list.reduce((best, job) => (at(job) > at(best) ? job : best))
  const running = jobs.filter((job) => job.state === "running" || started.has(job.id))
  if (running.length) return latest(running, (job) => started.get(job.id) ?? job.createdAt)
  return jobs.length ? latest(jobs, (job) => job.updatedAt) : undefined
}

export function selectedJob(state: ReviewsPageState, jobs: readonly PrJobSummary[], activity?: readonly ReviewActivityJob[]): PrJobSummary | undefined {
  if (!jobs.length) return undefined
  if (state.selectedId === undefined) return followedJob(jobs, activity)
  return jobs.find((job) => job.id === state.selectedId) ?? jobs[Math.max(0, Math.min(state.selected, jobs.length - 1))]
}

/** Repositories the repo filter cycles through: the watches' and the jobs', sorted, each once. */
export function reviewRepos(dashboard: PrReviewDashboard | undefined): string[] {
  if (!dashboard) return []
  return [...new Set([...dashboard.watches.flatMap((watch) => (watch.repo ? [watch.repo] : [])), ...dashboard.jobs.map((job) => job.repo)])].sort()
}

// ── What a job allows (the ledger's transitions, docs/pr-review.md) ──────────────────────────────────────────────────────

const PAUSABLE: ReadonlySet<JobState> = new Set(["pending", "waiting", "running", "fixing", "validating", "checkpointed"])
const RESUMABLE: ReadonlySet<JobState> = new Set(["paused", "checkpointed"])
const CANCELLABLE: ReadonlySet<JobState> = new Set(["pending", "waiting", "running", "fixing", "validating", "checkpointed", "paused"])
const RETRYABLE: ReadonlySet<JobState> = new Set(["failed", "cancelled", "stale", "done"])

export const canPause = (job: PrJobSummary) => PAUSABLE.has(job.state)
export const canResume = (job: PrJobSummary) => RESUMABLE.has(job.state)
export const canCancel = (job: PrJobSummary) => CANCELLABLE.has(job.state)
export const canRetry = (job: PrJobSummary) => RETRYABLE.has(job.state)
/** A finished review leaves the list (`d`); the daemon drops its earlier runs of the same pull request too. */
export const canForget = (job: PrJobSummary) => RETRYABLE.has(job.state)
/** A fix session exists and the reviewer holds it. */
export const canTakeOver = (job: PrJobSummary) => job.fixSessionId !== undefined && job.control !== "user"
export const canRelease = (job: PrJobSummary) => job.fixSessionId !== undefined && job.control === "user"

// ── Formatting ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const short = (sha: string) => sha.slice(0, 7) || "—"

/** A running job as the daemon's live activity has it: its phase and how long the run has gone (`pr.review.activity`). */
export type LiveRun = { phase: string; step: string; elapsedMs: number; steps: ReviewActivityJob["steps"] }
export function liveRuns(activity: readonly ReviewActivityJob[] | undefined, now: number): Map<string, LiveRun> {
  return new Map((activity ?? []).map((job) => [job.jobId, { phase: job.phase, step: reviewStep(job), elapsedMs: Math.max(0, now - job.startedAt), steps: job.steps }]))
}

/** The status column a running row gets while any listed review runs: room for the spinner, phase, step and time. */
const LIVE_STATUS_WIDTH = 34

/**
 * A running review's live line, as the activity status says it: spinner, phase · running step · time. In `width` cells the step
 * is cut first, then dropped; the phase and the time stay.
 */
export function liveLine(live: LiveRun, spinner: string, width = Number.POSITIVE_INFINITY): string {
  const head = `${spinner} ${live.phase}`
  const tail = ` · ${formatElapsed(live.elapsedMs)}`
  const full = `${spinner} ${live.step}${tail}`
  if (textWidth(full) <= width) return full
  const detail = live.step.slice(live.phase.length).replace(/^ · /, "")
  const room = width - textWidth(head) - textWidth(tail) - 3
  return detail && room >= 4 ? `${head} · ${truncateEnd(detail, room)}${tail}` : `${head}${tail}`
}

/** What a finished review left: its findings, never a phase it went through. */
const outcomeWord = (job: PrJobSummary) => {
  const found = job.findings.confirmed + job.findings.plausible
  return found ? `${found} finding${found === 1 ? "" : "s"}` : "no findings"
}

/**
 * What the row's status column says: the phase while it works (and its time, live), what it found once done, where it stopped or
 * failed, else the state.
 */
export function statusWord(job: PrJobSummary, live?: LiveRun): string {
  if (job.state === "running" && live) return `${live.phase} · ${formatElapsed(live.elapsedMs)}`
  if ((job.state === "running" || job.state === "fixing" || job.state === "validating") && job.phase) return job.state === "running" ? job.phase : `${job.state} · ${job.phase}`
  if (job.state === "done") return `done · ${outcomeWord(job)}`
  if ((job.state === "checkpointed" || job.state === "failed" || job.state === "paused") && job.stop) return `${job.state} · ${job.stop.kind.replace("_", " ")}`
  if (job.state === "failed" && job.phase) return `failed · ${job.phase}`
  return job.state
}

/** The detail's state line: a finished job says how it ended, a running one its phase, time and attempt, a failed one where. */
function stateText(job: PrJobSummary, live: LiveRun | undefined): string {
  if (job.state === "done") return `done · ${outcomeWord(job)}`
  if (job.state === "stale" || job.state === "cancelled") return job.state
  if (job.state === "failed") return `failed${job.phase ? ` in ${job.phase}` : ""} · ${job.attempts} attempt${job.attempts === 1 ? "" : "s"}`
  const phase = live?.phase ?? job.phase
  return `${job.state}${phase ? ` · ${phase}` : ""}${live ? ` · ${formatElapsed(live.elapsedMs)}` : ""} · attempt ${job.attempts + 1}`
}

function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

function prose(text: string, width: number, fg: ColorName, indent = ""): Line[] {
  return wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - indent.length)).map((part): Line => [{ text: indent }, { text: part, fg }])
}

/** `label   value` with the label in a fixed muted column; the value wraps under itself. */
function field(label: string, value: string, width: number, fg: ColorName = "body"): Line[] {
  const pad = 11
  const lines = wrap(value, Math.max(1, width - pad))
  return lines.map((part, index): Line => [{ text: index === 0 ? label.padEnd(pad) : " ".repeat(pad), fg: "muted" }, { text: part, fg }])
}

type Column = { text: string; fg: ColorName; width: number }

/** The pull request cell's width: `open · conflict` and a gap. */
const PR_CELL_WIDTH = 16

function jobRow(input: { entry: { job: PrJobSummary; depth: number; stackedOn?: number }; selected: boolean; width: number; now: number; glyphs: Glyphs; showRepo: boolean; showPr: boolean; live?: LiveRun | undefined; earlier: number; spinner: string; statusWidth: number }): Line {
  const { entry, selected, width, now, glyphs, showRepo, showPr, live, earlier, spinner, statusWidth } = input
  const { job } = entry
  const status = job.state === "running" && live ? liveLine(live, spinner, statusWidth - 1) : statusWord(job, live)
  const pr = prCell(job)
  const columns: Column[] = [
    { text: status, fg: job.state === "failed" ? "error" : job.state === "waiting" || job.state === "checkpointed" ? "warning" : live ? "primary" : "muted", width: statusWidth },
    ...(showPr ? [{ text: pr?.text ?? "", fg: pr?.fg ?? ("muted" as ColorName), width: PR_CELL_WIDTH }] : []),
    { text: relativeTime(now, job.updatedAt), fg: "muted", width: 5 },
    { text: `${job.reviewer}${job.control === "user" ? " · you" : ""}`, fg: job.scope === "personal" ? "secondary" : "muted", width: 16 },
    ...(showRepo ? [{ text: job.repo, fg: "muted" as ColorName, width: 20 }] : []),
  ]
  let shown = columns.length
  const nameRoom = () => width - 2 - columns.slice(0, shown).reduce((sum, column) => sum + column.width, 0)
  while (shown > 1 && nameRoom() < 18) shown--
  const room = Math.max(4, nameRoom())
  const tree = entry.depth > 0 ? `${"  ".repeat(entry.depth - 1)}└─ ` : ""
  const runs = earlier ? ` · ${earlier + 1} runs` : ""
  const name = truncateEnd(`${tree}${jobLabel(job)} ${job.title ?? ""}`.trimEnd() + (entry.stackedOn !== undefined ? ` (on #${entry.stackedOn})` : ""), room - 1 - textWidth(runs))
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: name, fg: selected ? "primary" : "text", bold: selected },
    ...(runs ? [{ text: runs, fg: "muted" as ColorName }] : []),
    { text: " ".repeat(Math.max(1, room - textWidth(name) - textWidth(runs))) },
  ]
  for (const column of columns.slice(0, shown)) {
    const text = truncateEnd(column.text, column.width - 1)
    line.push({ text, fg: column.fg }, { text: " ".repeat(column.width - textWidth(text)) })
  }
  return clampLine(line, width)
}

const yes = (value: boolean) => (value ? "yes" : "no")
/** A pull request by its number; an audit of the repository has no pull request (its ledger number is a placeholder). */
export const jobLabel = (job: Pick<PrJobSummary, "number" | "coverage">) => (job.coverage === "audit" ? "audit" : `#${job.number}`)

/** The stop reason in its own unit: used, limit (or that no internal limit is set), whether it resumes, when a quota resets. */
export function stopRows(stop: NonNullable<PrJobSummary["stop"]>, width: number, now: number): Line[] {
  const rows: Line[] = [...field("stopped", `${stop.kind.replace("_", " ")} · ${stop.detail}`, width, stop.kind === "error" || stop.kind === "permission" ? "error" : "warning")]
  if (stop.unit) {
    const used = stop.used === undefined ? "unknown" : thousands(stop.used)
    const limit = stop.limit === undefined ? "no internal limit" : thousands(stop.limit)
    rows.push(...field("", `${stop.unit}: used ${used} · limit ${limit}`, width))
  }
  const reset = stop.resetsAt === undefined ? "" : stop.resetsAt > now ? ` · resets in ${relativeTime(stop.resetsAt, now)}` : " · reset passed"
  rows.push(...field("", `resumable ${yes(stop.resumable)}${reset}`, width, stop.resumable ? "body" : "warning"))
  if (stop.remaining) rows.push(...field("remaining", stop.remaining, width))
  return rows
}

/** Tokens as the provider reported them; `cached` is part of `input`, and calls without a report are unknown, not zero. */
export function tokenText(tokens: PrJobSummary["tokens"]): string {
  const parts = [`in ${thousands(tokens.input)}`, `out ${thousands(tokens.output)}`, tokens.cached === undefined ? "cached not reported" : `cached ${thousands(tokens.cached)}`]
  if (tokens.unreported) parts.push(`${tokens.unreported} call${tokens.unreported === 1 ? "" : "s"} unreported`)
  return parts.join(" · ")
}

/** Everything the ledger says about one job, top to bottom: what it is, where it stands, why, and what it has used. */
export function jobDetailRows(job: PrJobSummary, width: number, now: number, extra: { live?: LiveRun | undefined; earlier?: readonly PrJobSummary[] | undefined; spinner?: string } = {}): Line[] {
  const { live, earlier = [], spinner = SPINNER_FRAMES[0] } = extra
  const rows: Line[] = []
  rows.push(...wrap(`${jobLabel(job)} ${job.title ?? ""}`.trim(), width).map((text): Line => [{ text, fg: "text", bold: true }]))
  if (job.url) rows.push([{ text: shortenMiddle(job.url, width), fg: "muted" }])
  rows.push([])
  rows.push(...field("repository", `${job.repo} · ${job.provider}`, width))
  rows.push(...field("state", stateText(job, live), width, groupOf(job.state).tone))
  // The same live line the running row shows, under the state.
  if (job.state === "running" && live) rows.push(...field("", liveLine(live, spinner), width, "primary"))
  // The pull request's GitHub state, as the row's cell says it, and the checks that fail.
  const pr = prCell(job)
  if (pr) {
    rows.push([{ text: "pull request  ", fg: "muted" }, { text: pr.text, fg: pr.fg }])
    if (job.pullRequest?.failing?.length) rows.push(...field("", `failing ${job.pullRequest.failing.join(", ")}`, width, "error"))
  }
  // The run's steps so far, as its watching session shows them; the last one is still running.
  if (live) for (const [at, step] of live.steps.entries()) rows.push(...field(at === 0 ? "steps" : "", `${step.label}${step.detail ? ` · ${step.detail}` : ""} · ${formatElapsed((step.endedAt ?? now) - step.startedAt)}${step.endedAt === undefined ? " so far" : ""}`, width, step.endedAt === undefined ? "primary" : "body"))
  rows.push(...field("trigger", `${job.trigger.replaceAll("_", " ")} · ${job.coverage} review`, width))
  rows.push(...field("range", `${short(job.base)}..${short(job.head)}`, width))
  rows.push(...field("reviewer", `${job.reviewer} (${job.scope})`, width, job.scope === "personal" ? "secondary" : "body"))
  if (job.assignment) rows.push(...field("assigned", job.assignment, width))
  rows.push(...field("owner", job.owner ?? "this daemon (no device recorded)", width, job.owner ? "body" : "muted"))
  if (job.fixSessionId) rows.push(...field("control", job.control === "user" ? "you (taken over)" : "reviewer", width, job.control === "user" ? "warning" : "body"))
  rows.push(...field("session", job.sessionId ?? "none yet", width, job.sessionId ? "body" : "muted"))
  if (job.fixSessionId) rows.push(...field("fix", job.fixSessionId, width))
  if (job.stack) {
    const parts = [job.stack.parent !== undefined ? `on #${job.stack.parent}` : "root", job.stack.children.length ? `children ${job.stack.children.map((n) => `#${n}`).join(", ")}` : "", `depth ${job.stack.depth}`].filter(Boolean)
    rows.push(...field("stack", parts.join(" · "), width))
  }
  rows.push([])
  const found = job.findings
  rows.push(...field("findings", `${found.confirmed} confirmed · ${found.plausible} plausible · ${found.candidates} candidates · ${found.resolved} resolved`, width))
  rows.push(...field("", "a count of what was found, not a measure of the review", width, "muted"))
  rows.push(...field("tokens", tokenText(job.tokens), width))
  if (job.readTokens) rows.push(...field("", `of which cheap readers: ${tokenText(job.readTokens)}`, width, "muted"))
  if (job.stop) rows.push([], ...stopRows(job.stop, width, now))
  if (job.error) rows.push([], ...field("error", job.error, width, "error"))
  rows.push([])
  rows.push(...field("created", `${timeAgo(now, job.createdAt)} · updated ${timeAgo(now, job.updatedAt)}`, width, "muted"))
  // The PR's earlier runs (other heads, earlier attempts), newest first: what each ended as, and why when it failed.
  if (earlier.length) {
    rows.push([], [{ text: `Earlier runs · ${earlier.length}`, fg: "text", bold: true }])
    for (const run of earlier.slice(0, 20)) {
      const why = run.state === "failed" && run.error ? ` · ${run.error.replace(/^\[[A-Z_]+\]:\s*/, "")}` : ""
      rows.push(...field(short(run.head), `${statusWord(run)} · ${timeAgo(now, run.createdAt)}${why}`, width, run.state === "failed" ? "error" : "muted"))
    }
    if (earlier.length > 20) rows.push(...field("", `and ${earlier.length - 20} more`, width, "muted"))
  }
  return rows.map((line) => clampLine(line, width))
}

/** The effective config of the job's scope, one top-level key per row with where its value came from. */
export function configRows(config: ReviewsConfigState, width: number): Line[] {
  if (config.status === "loading") return [[{ text: "reading the configuration…", fg: "muted" }]]
  if (config.status === "error" || !config.view) return prose(config.error || "the daemon sent no configuration", width, "warning")
  const { view } = config
  const rows: Line[] = [
    ...field("scope", `${view.scope}${view.login ? ` · ${view.login}` : ""}${view.repo ? ` · ${view.repo}` : ""}`, width),
    ...field("file", view.target, width),
    ...field("version", String(view.version), width),
    [],
  ]
  for (const [key, value] of Object.entries(view.effective)) {
    const origin = view.origins[key]
    rows.push(...field(key, `${truncateEnd(JSON.stringify(value) ?? "null", 400)}${origin ? `  (${origin})` : ""}`, width))
  }
  if (view.problems?.length) rows.push([], ...view.problems.flatMap((problem) => prose(problem, width, "warning")))
  return rows.map((line) => clampLine(line, width))
}

function watchRows(dashboard: PrReviewDashboard, width: number): Line[] {
  if (!dashboard.watches.length) return [[{ text: "No watched repository.", fg: "muted" }], ...prose("/pr watch-repo reviews this repository's new pull requests", width, "muted")]
  return dashboard.watches.flatMap((watch): Line[] => [
    clampLine([{ text: watch.repo ?? shortenMiddle(watch.directory, width), fg: "text", bold: true }, { text: `  ${watch.provider}`, fg: "muted" }], width),
    clampLine([{ text: "  " }, { text: watch.state, fg: watch.state === "watching" ? "success" : "warning" }, { text: ` · ${watch.open} open · publish ${watch.publish}${watch.owner ? ` · owner ${watch.owner}` : ""}`, fg: "muted" }], width),
  ])
}

const AVAILABILITY: Record<PrReviewerSummary["availability"], ColorName> = { online: "success", offline: "muted", unknown: "muted" }

function reviewerRows(dashboard: PrReviewDashboard, width: number, now: number, glyphs: Glyphs): Line[] {
  if (!dashboard.reviewers.length) return [[{ text: "No reviewer registered.", fg: "muted" }], ...prose(".mendcode/reviewers.yaml on the base branch lists them", width, "muted")]
  return dashboard.reviewers.flatMap((reviewer): Line[] => {
    const seen = reviewer.availability !== "online" && reviewer.lastSeenAt !== undefined ? ` · seen ${timeAgo(now, reviewer.lastSeenAt)}` : ""
    return [
      clampLine([{ text: `${glyphs.dot} `, fg: AVAILABILITY[reviewer.availability] }, { text: reviewer.id, fg: "text", bold: true }, { text: `  ${reviewer.scope}${reviewer.login ? ` · ${reviewer.login}` : ""}`, fg: "muted" }], width),
      clampLine([{ text: "  " }, { text: reviewer.availability, fg: AVAILABILITY[reviewer.availability] }, { text: `${reviewer.device ? ` · device ${reviewer.device}` : ""}${seen}`, fg: "muted" }], width),
      ...(reviewer.areas.length ? [clampLine([{ text: `  ${reviewer.areas.join(", ")}`, fg: "muted", dim: true }], width)] : []),
    ]
  })
}

function ledgerRows(dashboard: PrReviewDashboard, width: number): Line[] {
  const m = dashboard.metrics
  return [
    ...field("running", `${m.running} of ${m.concurrency} at once`, width),
    ...field("queued", `${m.queued} pending · ${m.waiting} waiting`, width),
    ...field("24 hours", `${m.done24h} done · ${m.failed24h} failed`, width),
    ...field("tokens", tokenText(m.tokens24h), width),
    ...field("", "jobs updated in the last 24 hours, from the job ledger", width, "muted"),
  ].map((line) => clampLine(line, width))
}

/**
 * What needs attention, for the tab row: running (behind the activity spinner), queued, waiting and failed, each only when
 * non-zero, "idle" when all are zero, empty without data. The 24-hour totals and tokens live in the Watches tab's ledger.
 * Counts that do not fit `width` are dropped from the end.
 */
export function metricsSummary(dashboard: PrReviewDashboard | undefined, width: number, spinner: string = SPINNER_FRAMES[0]!): Span[] {
  if (!dashboard) return []
  const m = dashboard.metrics
  const counts: Array<[number, string, ColorName]> = [[m.running, "running", "text"], [m.queued, "queued", "muted"], [m.waiting, "waiting", "muted"], [m.failed24h, "failed", "error"]]
  const shown = counts.filter(([count]) => count > 0)
  if (!shown.length) return textWidth("idle") <= width ? [{ text: "idle", fg: "muted", dim: true }] : []
  for (let take = shown.length; take > 0; take--) {
    const spans = shown.slice(0, take).flatMap(([count, label, fg], index): Span[] => [
      ...(index ? [{ text: " · ", fg: "muted" as ColorName }] : []),
      ...(label === "running" ? [{ text: `${spinner} `, fg: "primary" as ColorName }] : []),
      { text: `${count} ${label}`, fg },
    ])
    if (textWidth(spans.map((span) => span.text).join("")) <= width) return spans
  }
  return []
}

/** Every key of the jobs tab with what it does, for the `?` section. */
const PAGE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓", "select (wraps)"], ["shift ↑↓", "5 at a time"], ["g G", "first, last"], ["enter", "detail"], ["/", "search"], ["f F", "state filter"], ["m", "repo filter"],
  ["o", "open PR"], ["s", "review session"], ["S", "fix session"], ["p", "pause"], ["u", "resume"], ["R", "retry (asks why)"],
  ["x", "cancel"], ["d", "remove a finished review"], ["t", "take over, release"], ["c", "config"], ["1 2 tab", "jobs, watches"], ["r", "refresh"],
  ["esc", "follow latest, back"], ["q", "close"], ["?", "hide keys"],
]

const KEY_GAP = 2
const COLUMN_GAP = 4

/** Rows of the keys in `columns` columns, read down each column; each column as wide as its longest key and meaning. */
function keyColumns(columns: number) {
  const rows = Math.ceil(PAGE_KEYS.length / columns)
  const sets = Array.from({ length: columns }, (_, column) => PAGE_KEYS.slice(column * rows, (column + 1) * rows))
  const widths = sets.map((set) => ({ key: Math.max(0, ...set.map(([key]) => textWidth(key))), meaning: Math.max(0, ...set.map(([, meaning]) => textWidth(meaning))) }))
  const total = widths.reduce((sum, w) => sum + w.key + KEY_GAP + w.meaning, 0) + COLUMN_GAP * (columns - 1)
  return { rows, sets, widths, total }
}

/** The `?` section: the keys in as many columns as fit (at most five), indented like the tabs. */
function keysRows(width: number): Line[] {
  let layout = keyColumns(1)
  for (let columns = 5; columns > 1; columns--) {
    const candidate = keyColumns(columns)
    if (candidate.total + 1 <= width) { layout = candidate; break }
  }
  const { rows, sets, widths } = layout
  return Array.from({ length: rows }, (_, row) => clampLine([{ text: " " }, ...sets.flatMap((set, column): Span[] => {
    const entry = set[row]
    if (!entry) return []
    const [key, meaning] = entry
    const last = column === sets.length - 1 || !sets[column + 1]?.[row]
    const pad = last ? "" : " ".repeat(widths[column]!.meaning - textWidth(meaning) + COLUMN_GAP)
    return [{ text: key + " ".repeat(widths[column]!.key - textWidth(key) + KEY_GAP), fg: "text", bold: true }, { text: meaning + pad, fg: "muted" }]
  })], width))
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PAGE_TABS: PageTab[] = [{ key: "1", label: "Jobs" }, { key: "2", label: "Watches" }]

/**
 * The keys shown in the header: a few, with `?` for the rest (`PAGE_KEYS`), plus at most one that matters right now (esc while a
 * job is pinned or a filter is on). The last one always stays when the header is narrow.
 */
export function reviewsHints(state: ReviewsPageState, job: PrJobSummary | undefined): string {
  if (state.typing) return SEARCH_HINT
  if (state.reason) return "type the reason · enter retry · esc cancel"
  if (state.config) return "↑↓ scroll · esc back"
  if (state.tab === 1) return "↑↓ scroll · 1 jobs · r refresh · esc back"
  const keys = state.keys ? "? hide keys" : "? keys"
  if (state.detail) return ["↑↓ scroll", keys, "esc back"].join(" · ")
  const filtered = state.filter.text !== "" || state.filter.state !== "all" || state.filter.repo !== undefined
  const context = state.keys ? [] : state.selectedId !== undefined ? ["esc follow latest"] : filtered ? ["esc clear filter"] : []
  return [...(job ? ["enter detail"] : []), "/ search", keys, ...context].join(" · ")
}

/** The question or input that replaces the top row of the active panel: a confirm, the retry reason or the filter being typed. */
function promptRows(state: ReviewsPageState, width: number): Line[] {
  if (state.confirm) {
    const { kind, number } = state.confirm
    const key = kind === "cancel" ? "x" : kind === "forget" ? "d" : "t"
    const verb = kind === "cancel" ? "cancel the job of" : kind === "forget" ? "remove from the list" : kind === "take-over" ? "take over the fix session of" : "give the fix session back to the reviewer on"
    const texts = [`${verb} #${number}? ${key} or y confirms · any key keeps it`, `${kind} #${number}? ${key}/y confirm`]
    return [clampLine([{ text: texts.find((text) => textWidth(text) <= width) ?? texts[1]!, fg: "warning", bold: true }], width), []]
  }
  if (state.reason) return [clampLine([{ text: `retry #${state.reason.number} because `, fg: "warning", bold: true }, { text: state.reason.text, fg: "text" }, { text: "▏", fg: "primary" }], width), []]
  const { text, state: group, repo } = state.filter
  if (!state.typing && !text && group === "all" && !repo) return []
  const parts: Span[] = [{ text: "/ ", fg: "primary", bold: true }, { text: text || (state.typing ? "" : "any"), fg: text ? "text" : "muted" }]
  if (state.typing) parts.push({ text: "▏", fg: "primary" })
  if (group !== "all") parts.push({ text: ` · ${filterLabel(group)}`, fg: "muted" })
  if (repo) parts.push({ text: ` · ${repo}`, fg: "muted" })
  return [clampLine(parts, width), []]
}

function emptyRows(data: ReviewsData, offline: boolean, width: number): Line[] | undefined {
  if (data.status === "remote") return prose("The PR reviewer runs gh on the daemon's own machine, so this page works only from a local session.", width, "warning")
  if (data.dashboard) return undefined
  if (offline) return prose("The daemon is offline. The page fills in when the terminal reconnects.", width, "warning")
  if (data.status === "unavailable") return [...prose("Review status is not available from this daemon: its `status` answer carried no dashboard.", width, "warning"), [], ...prose("A daemon built with the review platform answers it. /pr repos still lists the watched repositories.", width, "muted")]
  if (data.status === "error") return [...prose(data.error || "The daemon did not answer.", width, "warning"), [], ...prose("r tries again.", width, "muted")]
  return [[{ text: "reading review status…", fg: "muted" }]]
}

function noJobsRows(dashboard: PrReviewDashboard, width: number): Line[] {
  if (dashboard.jobs.length) return [[{ text: "No job matches the filter.", fg: "muted" }], ...prose("esc clears it", width, "muted")]
  return [
    [{ text: "No review jobs yet.", fg: "muted" }],
    [],
    ...prose(dashboard.watches.length ? "Watched repositories get a job for each new pull request and head." : "/pr watch-repo reviews this repository's new pull requests; /pr review [pr] reviews one now.", width, "muted"),
  ]
}

/** Rows a panel body gets at this width: a flat panel (under 68 cells) loses its title and rule, a boxed one its borders and padding. */
const panelRoom = (width: number, height: number) => Math.max(1, height - (width < 68 ? 2 : 4))

function listRows(input: { dashboard: PrReviewDashboard; state: ReviewsPageState; job: PrJobSummary | undefined; width: number; room: number; now: number; glyphs: Glyphs; per: ReturnType<typeof latestPerPr>; live: Map<string, LiveRun>; spinner: string }): Line[] {
  const { dashboard, state, job, width, room, now, glyphs, per, live, spinner } = input
  const prompt = state.detail ? [] : promptRows(state, width)
  const rows = groupedRows(filterJobs(per.latest, state.filter))
  if (!rows.length) return [...prompt, ...noJobsRows(dashboard, width)]
  const showRepo = new Set(dashboard.jobs.map((entry) => entry.repo)).size > 1
  const showPr = rows.some((row) => row.kind === "job" && row.job.pullRequest !== undefined)
  const statusWidth = rows.some((row) => row.kind === "job" && row.job.state === "running" && live.has(row.job.id)) ? LIVE_STATUS_WIDTH : 22
  const drawn = rows.map((row): Line => row.kind === "group"
    ? clampLine([{ text: row.label, fg: row.tone, bold: true }, { text: `  ${row.count}`, fg: "muted" }], width)
    : jobRow({ entry: row, selected: row.job === job, width, now, glyphs, showRepo, showPr, live: live.get(row.job.id), earlier: per.history.get(row.job.id)?.length ?? 0, spinner, statusWidth }))
  const at = rows.findIndex((row) => row.kind === "job" && row.job === job)
  const visible = Math.max(1, room - prompt.length)
  // Keep the selected row and its group header in view; the window never starts past the last full page.
  let start = Math.max(0, at - visible + 1)
  const header = rows.slice(0, at + 1).findLastIndex((row) => row.kind === "group")
  if (header >= 0 && at - header < visible && start > header) start = header
  start = Math.min(start, Math.max(0, drawn.length - visible))
  return [...prompt, ...drawn.slice(start, start + visible)]
}

/**
 * `spinner` is the activity status's frame (the app's pulse turns it while a review runs and this page is open); `activity` the
 * daemon's live runs, which the unpinned selection follows.
 */
export function renderReviewsPage(input: { data: ReviewsData; state: ReviewsPageState; width: number; height: number; now: number; offline?: boolean; glyphs?: Glyphs; activity?: readonly ReviewActivityJob[]; spinner?: string }): Line[] {
  const { data, state, width, height, now } = input
  if (height <= 0) return []
  const offline = input.offline ?? false
  const glyphs = input.glyphs ?? defaultGlyphs()
  const spinner = input.spinner ?? SPINNER_FRAMES[0]
  const dashboard = data.dashboard
  const jobs = listedJobs(dashboard, state.filter)
  const job = selectedJob(state, jobs, input.activity)
  const pinned = state.selectedId !== undefined && job?.id === state.selectedId ? { note: "pinned" } : {}
  const per = latestPerPr(dashboard?.jobs ?? [])
  const live = liveRuns(input.activity, now)
  const detailOf = (w: number) => jobDetailRows(job!, w, now, { live: live.get(job!.id), earlier: per.history.get(job!.id), spinner })
  const keys = state.keys && state.tab === 0 && !state.config && dashboard && data.status !== "remote" ? keysRows(width) : []
  // The keys section leaves the panels at least four rows, and a blank row parts it from them.
  const keyLines = keys.length ? [...keys.slice(0, Math.max(1, height - 7)), []] : []
  const room = Math.max(0, height - 2 - keyLines.length)
  const hints = reviewsHints(state, job)
  const status = offline ? "daemon offline" : data.status === "error" && dashboard ? "refresh failed" : ""
  const title = `Reviews${state.filter.repo ? ` · ${state.filter.repo}` : ""}${status ? ` · ${status}` : ""}`
  const single = (panel: GridPanel) => panelGrid({ width, compact: isCompact(width), padding: true, heights: [room], maxColumns: 1, rows: [[{ ...panel, active: true }]] })
  let body: Line[]
  if (!dashboard || data.status === "remote") body = single({ title: "Reviews", body: (w) => emptyRows(data, offline, w) ?? [] })
  else if (state.config) body = single({ title: `Config · #${state.config.number} · ${state.config.scope}`, body: (w) => configRows(state.config!, w), scroll: state.scroll })
  else if (state.tab === 1) {
    if (isCompact(width)) body = single({ title: "Watches & reviewers", scroll: state.scroll, body: (w) => [[{ text: "Watches", fg: "text", bold: true }], ...watchRows(dashboard, w), [], [{ text: "Reviewers", fg: "text", bold: true }], ...reviewerRows(dashboard, w, now, glyphs), [], [{ text: "Ledger", fg: "text", bold: true }], ...ledgerRows(dashboard, w)] })
    else {
      const ledger = Math.min(9, Math.max(7, Math.floor(room / 3)))
      body = panelGrid({ width, compact: false, padding: true, maxColumns: 2, heights: [Math.max(0, room - ledger - 1), ledger], rows: [
        [{ title: `Watches · ${dashboard.watches.length}`, body: (w) => watchRows(dashboard, w), scroll: state.scroll, active: true }, { title: `Reviewers · ${dashboard.reviewers.length}`, body: (w) => reviewerRows(dashboard, w, now, glyphs), scroll: state.scroll }],
        [{ title: "Ledger", body: (w) => ledgerRows(dashboard, w) }],
      ] })
    }
  } else if (state.detail && job) {
    body = single({ title: `${jobLabel(job)} · ${job.state}`, ...pinned, scroll: state.scroll, body: (w) => [...promptRows(state, w), ...detailOf(w)] })
  } else {
    const listTitle = `Pull requests · ${jobs.length}${per.latest.length !== jobs.length ? ` of ${per.latest.length}` : ""}`
    if (isWide(width) && job) {
      body = panelGrid({ width, compact: false, padding: true, maxColumns: 2, heights: [room], rows: [[
        { title: listTitle, weight: 3, active: true, body: (w) => listRows({ dashboard, state, job, per, live, spinner, width: w, room: panelRoom(width, room), now, glyphs }) },
        { title: jobLabel(job), ...pinned, weight: 2, body: (w) => detailOf(w) },
      ]] })
    } else if (!isCompact(width) && job && room >= 16) {
      const top = Math.max(6, Math.floor(room * 0.5))
      body = panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [top, Math.max(0, room - top - 1)], rows: [
        [{ title: listTitle, active: true, body: (w) => listRows({ dashboard, state, job, per, live, spinner, width: w, room: panelRoom(width, top), now, glyphs }) }],
        [{ title: `#${job.number} · enter for all of it`, ...pinned, body: (w) => detailOf(w) }],
      ] })
    } else body = single({ title: listTitle, body: (w) => listRows({ dashboard, state, job, per, live, spinner, width: w, room: panelRoom(width, room), now, glyphs }) })
  }
  const frame = pickerFrame(title, hints, width, height, [...keyLines, ...body])
  if (height > 1) {
    const tabs = tabsRow(PAGE_TABS, state.tab, Math.max(1, Math.floor(width / 2)))
    const summary = metricsSummary(dashboard, Math.max(0, width - textWidth(tabs.map((span) => span.text).join("")) - 2), spinner)
    frame[1] = fit(spread(tabs, summary, width), width)
  }
  return frame
}
