import type { PrJobSummary, PrReviewConfigView, PrReviewDashboard, PrReviewerSummary } from "@mendcode/protocol"
import { isCompact, isWide } from "../ui/breakpoints"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { fit, panelGrid, spread, type GridPanel } from "./deck"
import { compact, thousands } from "./format"
import { tabsRow, type PageTab } from "./page"
import { pickerFrame } from "./picker-frame"
import { relativeTime, timeAgo } from "./session-list"
import { shortenMiddle, textWidth, truncateEnd, wrap } from "./wrap"

/**
 * `/reviews` (and `/pr dashboard`): the PR review platform's page (docs/pr-review.md). Jobs grouped by state with stacks under their
 * root, the watches and reviewers, a job's detail and the job actions. Data is the `pr.review` action `status` (a
 * `PrReviewDashboard`); this module only lays it out and never computes a metric of its own. Pure. Keys: `reviews-keys.ts`.
 */

export type JobState = PrJobSummary["state"]
export type ReviewGroupId = "running" | "fixing" | "waiting" | "checkpointed" | "paused" | "pending" | "failed" | "done" | "ended"
export type StateFilter = "all" | ReviewGroupId

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
export const STATE_FILTERS: readonly StateFilter[] = ["all", ...REVIEW_GROUPS.map((group) => group.id)]

/** Where the page's data stands: `unavailable` is a daemon whose `status` answer has no dashboard; `remote` a client that may not ask. */
export type ReviewsData = { status: "loading" | "ready" | "error" | "unavailable" | "remote"; dashboard?: PrReviewDashboard; error?: string; fetchedAt?: number }

export type ReviewsConfirm = { kind: "cancel" | "take-over" | "release"; jobId: string; number: number }
export type ReviewsConfigState = { jobId: string; number: number; scope: PrJobSummary["scope"]; status: "loading" | "ready" | "error"; view?: PrReviewConfigView; error?: string }

export type ReviewsPageState = {
  /** 0 jobs, 1 watches and reviewers. */
  tab: 0 | 1
  /** The selected job by id, so a refresh that reorders the list keeps the selection on the same job. */
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
  return jobs.filter((job) => (filter.state === "all" || groupOf(job.state).id === filter.state)
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

/** The jobs in the order the list shows them, after the filter: the selection moves through these. */
export function listedJobs(dashboard: PrReviewDashboard | undefined, filter: ReviewsPageState["filter"]): PrJobSummary[] {
  if (!dashboard) return []
  return groupedRows(filterJobs(dashboard.jobs, filter)).flatMap((row) => (row.kind === "job" ? [row.job] : []))
}

export function selectedJob(state: ReviewsPageState, jobs: readonly PrJobSummary[]): PrJobSummary | undefined {
  if (!jobs.length) return undefined
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
/** A fix session exists and the reviewer holds it. */
export const canTakeOver = (job: PrJobSummary) => job.fixSessionId !== undefined && job.control !== "user"
export const canRelease = (job: PrJobSummary) => job.fixSessionId !== undefined && job.control === "user"

// ── Formatting ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const short = (sha: string) => sha.slice(0, 7) || "—"

/** What the row's status column says: the phase while it works, the stop kind once it stopped, else the state. */
export function statusWord(job: PrJobSummary): string {
  if ((job.state === "running" || job.state === "fixing" || job.state === "validating") && job.phase) return job.state === "running" ? job.phase : `${job.state} · ${job.phase}`
  if ((job.state === "checkpointed" || job.state === "failed" || job.state === "paused") && job.stop) return `${job.state} · ${job.stop.kind.replace("_", " ")}`
  return job.state
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

function jobRow(input: { entry: { job: PrJobSummary; depth: number; stackedOn?: number }; selected: boolean; width: number; now: number; glyphs: Glyphs; showRepo: boolean }): Line {
  const { entry, selected, width, now, glyphs, showRepo } = input
  const { job } = entry
  const columns: Column[] = [
    { text: statusWord(job), fg: job.state === "failed" ? "error" : job.state === "waiting" || job.state === "checkpointed" ? "warning" : "muted", width: 22 },
    { text: relativeTime(now, job.updatedAt), fg: "muted", width: 5 },
    { text: `${job.reviewer}${job.control === "user" ? " · you" : ""}`, fg: job.scope === "personal" ? "secondary" : "muted", width: 16 },
    ...(showRepo ? [{ text: job.repo, fg: "muted" as ColorName, width: 20 }] : []),
  ]
  let shown = columns.length
  const nameRoom = () => width - 2 - columns.slice(0, shown).reduce((sum, column) => sum + column.width, 0)
  while (shown > 1 && nameRoom() < 18) shown--
  const room = Math.max(4, nameRoom())
  const tree = entry.depth > 0 ? `${"  ".repeat(entry.depth - 1)}└─ ` : ""
  const name = truncateEnd(`${tree}${jobLabel(job)} ${job.title ?? ""}`.trimEnd() + (entry.stackedOn !== undefined ? ` (on #${entry.stackedOn})` : ""), room - 1)
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: name, fg: selected ? "primary" : "text", bold: selected },
    { text: " ".repeat(Math.max(1, room - textWidth(name))) },
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
export function jobDetailRows(job: PrJobSummary, width: number, now: number): Line[] {
  const rows: Line[] = []
  rows.push(...wrap(`${jobLabel(job)} ${job.title ?? ""}`.trim(), width).map((text): Line => [{ text, fg: "text", bold: true }]))
  if (job.url) rows.push([{ text: shortenMiddle(job.url, width), fg: "muted" }])
  rows.push([])
  rows.push(...field("repository", `${job.repo} · ${job.provider}`, width))
  rows.push(...field("state", `${job.state}${job.phase ? ` · phase ${job.phase}` : ""} · attempt ${job.attempts}`, width, groupOf(job.state).tone))
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
  if (job.stop) rows.push([], ...stopRows(job.stop, width, now))
  if (job.error) rows.push([], ...field("error", job.error, width, "error"))
  rows.push([])
  rows.push(...field("created", `${timeAgo(now, job.createdAt)} · updated ${timeAgo(now, job.updatedAt)}`, width, "muted"))
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

/** The metrics in one plain line for the tab row, shortened to fit `width`; empty without data. */
export function metricsSummary(dashboard: PrReviewDashboard | undefined, width: number): string {
  if (!dashboard) return ""
  const m = dashboard.metrics
  const tokens = `${compact(m.tokens24h.input)} in · ${compact(m.tokens24h.output)} out`
  const options = [
    `${m.running}/${m.concurrency} running · ${m.queued} queued · ${m.waiting} waiting · 24h ${m.done24h} done · ${m.failed24h} failed · ${tokens}`,
    `${m.running}/${m.concurrency} running · ${m.queued} queued · ${m.waiting} waiting · 24h ${m.done24h} done · ${m.failed24h} failed`,
    `${m.running}/${m.concurrency} running · ${m.queued} queued · ${m.waiting} waiting`,
    `${m.running}/${m.concurrency} running`,
  ]
  return options.find((text) => textWidth(text) <= width) ?? ""
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PAGE_TABS: PageTab[] = [{ key: "1", label: "Jobs" }, { key: "2", label: "Watches & reviewers", short: "Watches" }]

/** The keys shown in the header, the most useful first (the header keeps those that fit), for what the selected job allows. */
export function reviewsHints(state: ReviewsPageState, job: PrJobSummary | undefined): string {
  if (state.typing) return "type to filter · enter keep · esc clear"
  if (state.reason) return "type the reason · enter retry · esc cancel"
  if (state.config) return "↑↓ scroll · esc back"
  if (state.tab === 1) return "↑↓ scroll · 1 jobs · r refresh · esc back"
  const actions = job ? [
    ...(job.url ? ["o open PR"] : []),
    ...(job.sessionId ? ["s session"] : []),
    ...(job.fixSessionId ? ["S fix session"] : []),
    ...(canResume(job) ? ["u resume"] : []),
    ...(canPause(job) ? ["p pause"] : []),
    ...(canRetry(job) ? ["R retry"] : []),
    ...(canCancel(job) ? ["x cancel"] : []),
    ...(canTakeOver(job) ? ["t take over"] : canRelease(job) ? ["t release"] : []),
    "c config",
  ] : []
  const parts = state.detail
    ? [...actions, "↑↓ scroll", "r refresh", "esc back"]
    : [...(job ? ["enter detail"] : []), "/ filter", ...actions, "f state", "m repo", "↑↓ select", "2 watches", "r refresh", "esc back"]
  return parts.join(" · ")
}

/** The question or input that replaces the top row of the active panel: a confirm, the retry reason or the filter being typed. */
function promptRows(state: ReviewsPageState, width: number): Line[] {
  if (state.confirm) {
    const { kind, number } = state.confirm
    const key = kind === "cancel" ? "x" : "t"
    const verb = kind === "cancel" ? "cancel the job of" : kind === "take-over" ? "take over the fix session of" : "give the fix session back to the reviewer on"
    const texts = [`${verb} #${number}? ${key} or y confirms · any key keeps it`, `${kind} #${number}? ${key}/y confirm`]
    return [clampLine([{ text: texts.find((text) => textWidth(text) <= width) ?? texts[1]!, fg: "warning", bold: true }], width), []]
  }
  if (state.reason) return [clampLine([{ text: `retry #${state.reason.number} because `, fg: "warning", bold: true }, { text: state.reason.text, fg: "text" }, { text: "▏", fg: "primary" }], width), []]
  const { text, state: group, repo } = state.filter
  if (!state.typing && !text && group === "all" && !repo) return []
  const parts: Span[] = [{ text: "/ ", fg: "primary", bold: true }, { text: text || (state.typing ? "" : "any"), fg: text ? "text" : "muted" }]
  if (state.typing) parts.push({ text: "▏", fg: "primary" })
  if (group !== "all") parts.push({ text: ` · ${REVIEW_GROUPS.find((entry) => entry.id === group)!.label.toLowerCase()}`, fg: "muted" })
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

function listRows(input: { dashboard: PrReviewDashboard; state: ReviewsPageState; job: PrJobSummary | undefined; width: number; room: number; now: number; glyphs: Glyphs }): Line[] {
  const { dashboard, state, job, width, room, now, glyphs } = input
  const prompt = state.detail ? [] : promptRows(state, width)
  const rows = groupedRows(filterJobs(dashboard.jobs, state.filter))
  if (!rows.length) return [...prompt, ...noJobsRows(dashboard, width)]
  const showRepo = new Set(dashboard.jobs.map((entry) => entry.repo)).size > 1
  const drawn = rows.map((row): Line => row.kind === "group"
    ? clampLine([{ text: row.label, fg: row.tone, bold: true }, { text: `  ${row.count}`, fg: "muted" }], width)
    : jobRow({ entry: row, selected: row.job === job, width, now, glyphs, showRepo }))
  const at = rows.findIndex((row) => row.kind === "job" && row.job === job)
  const visible = Math.max(1, room - prompt.length)
  // Keep the selected row and its group header in view; the window never starts past the last full page.
  let start = Math.max(0, at - visible + 1)
  const header = rows.slice(0, at + 1).findLastIndex((row) => row.kind === "group")
  if (header >= 0 && at - header < visible && start > header) start = header
  start = Math.min(start, Math.max(0, drawn.length - visible))
  return [...prompt, ...drawn.slice(start, start + visible)]
}

export function renderReviewsPage(input: { data: ReviewsData; state: ReviewsPageState; width: number; height: number; now: number; offline?: boolean; glyphs?: Glyphs }): Line[] {
  const { data, state, width, height, now } = input
  if (height <= 0) return []
  const offline = input.offline ?? false
  const glyphs = input.glyphs ?? defaultGlyphs()
  const dashboard = data.dashboard
  const jobs = listedJobs(dashboard, state.filter)
  const job = selectedJob(state, jobs)
  const room = Math.max(0, height - 2)
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
    body = single({ title: `${jobLabel(job)} · ${job.state}`, scroll: state.scroll, body: (w) => [...promptRows(state, w), ...jobDetailRows(job, w, now)] })
  } else {
    const listTitle = `Jobs · ${jobs.length}${dashboard.jobs.length !== jobs.length ? ` of ${dashboard.jobs.length}` : ""}`
    if (isWide(width) && job) {
      body = panelGrid({ width, compact: false, padding: true, maxColumns: 2, heights: [room], rows: [[
        { title: listTitle, weight: 3, active: true, body: (w) => listRows({ dashboard, state, job, width: w, room: panelRoom(width, room), now, glyphs }) },
        { title: jobLabel(job), weight: 2, body: (w) => jobDetailRows(job, w, now) },
      ]] })
    } else if (!isCompact(width) && job && room >= 16) {
      const top = Math.max(6, Math.floor(room * 0.5))
      body = panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [top, Math.max(0, room - top - 1)], rows: [
        [{ title: listTitle, active: true, body: (w) => listRows({ dashboard, state, job, width: w, room: panelRoom(width, top), now, glyphs }) }],
        [{ title: `#${job.number} · enter for all of it`, body: (w) => jobDetailRows(job, w, now) }],
      ] })
    } else body = single({ title: listTitle, body: (w) => listRows({ dashboard, state, job, width: w, room: panelRoom(width, room), now, glyphs }) })
  }
  const frame = pickerFrame(title, hints, width, height, body)
  if (height > 1) {
    const tabs = tabsRow(PAGE_TABS, state.tab, Math.max(1, Math.floor(width / 2)))
    const summary = metricsSummary(dashboard, Math.max(0, width - textWidth(tabs.map((span) => span.text).join("")) - 2))
    frame[1] = fit(spread(tabs, summary ? [{ text: summary, fg: "muted" }] : [], width), width)
  }
  return frame
}
