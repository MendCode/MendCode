import { pageSearchKey } from "./page-search"
import type { PrJobSummary, PrReviewDashboard } from "@mendcode/protocol"
import type { ReviewActivityJob } from "./review-activity"
import { canCancel, canPause, canRelease, canResume, canRetry, canTakeOver, listedJobs, MAX_FILTER_TEXT, MAX_REASON_TEXT, reviewRepos, selectedJob, STATE_FILTERS, type ReviewsPageState } from "./reviews-page"

/**
 * Keys of the reviews page (`reviews-page.ts`). Pure: a key gives the next page state and at most one action; the app sends the
 * action's `pr.review` command (`reviewsCommand`) and never decides what a key means. Destructive actions ask first (`x` cancel,
 * `t` take over or release); a retry needs a typed reason.
 */

export type ReviewsJobAction = "job-pause" | "job-resume" | "job-cancel" | "job-retry" | "take-over" | "release"

export type ReviewsPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "refresh" }
  /** Open the pull request in the browser (`url.open`). */
  | { type: "url"; url: string }
  /** Switch to the review session or the fix session. */
  | { type: "session"; sessionId: string }
  | { type: "job"; action: ReviewsJobAction; jobId: string; reason?: string }
  /** `config-show` of the job's scope, for the repository the job is on. */
  | { type: "config"; jobId: string; number: number; scope: PrJobSummary["scope"]; directory?: string }

/** The `pr.review` command an action sends; undefined for the actions the terminal handles itself. */
export function reviewsCommand<Id extends string>(action: ReviewsPageAction, sessionId: Id) {
  if (action.type === "job") return { type: "pr.review" as const, sessionId, action: action.action, jobId: action.jobId, ...(action.reason ? { reason: action.reason } : {}) }
  if (action.type === "config") return { type: "pr.review" as const, sessionId, action: "config-show" as const, scope: action.scope, jobId: action.jobId, ...(action.directory ? { directory: action.directory } : {}) }
  return undefined
}

const NONE: ReviewsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const BACKSPACE = new Set(["\x7f", "\b"])
const ESC = "\x1b"
const ENTER = new Set(["\r", "\n"])
/** Typed text: no control characters (a paste of several characters is one key). */
const printable = (key: string) => key.length > 0 && !/[\x00-\x1f\x7f]/.test(key)

type Result = { state: ReviewsPageState; action: ReviewsPageAction }
const keep = (state: ReviewsPageState): Result => ({ state, action: NONE })

function typedText(text: string, key: string, max: number): string | undefined {
  if (BACKSPACE.has(key)) return text.slice(0, -1)
  if (key === "\x15") return ""
  if (printable(key)) return (text + key).slice(0, max)
  return undefined
}

function directoryOf(dashboard: PrReviewDashboard | undefined, job: PrJobSummary) {
  return dashboard?.watches.find((watch) => watch.repo === job.repo)?.directory
}

function cycle<T>(list: readonly T[], current: T, step: number): T {
  const index = list.indexOf(current)
  return list[(index + step + list.length) % list.length]!
}

/**
 * One raw key. Returns the same state object when nothing changed, so the app can skip a frame. `activity` (the daemon's live
 * runs) is what an unpinned selection follows; moving, enter or a job action pins it, esc in the list unpins it.
 */
export function reviewsPageKey(state: ReviewsPageState, key: string, dashboard: PrReviewDashboard | undefined, activity?: readonly ReviewActivityJob[]): Result {
  const jobs = listedJobs(dashboard, state.filter)
  const job = selectedJob(state, jobs, activity)

  if (state.reason) {
    if (key === ESC) { const { reason: _dropped, ...rest } = state; void _dropped; return keep(rest) }
    if (ENTER.has(key)) {
      const reason = state.reason.text.trim()
      if (!reason) return keep(state)
      const { reason: sent, ...rest } = state
      return { state: rest, action: { type: "job", action: "job-retry", jobId: sent.jobId, reason } }
    }
    const text = typedText(state.reason.text, key, MAX_REASON_TEXT)
    return text === undefined ? keep(state) : keep({ ...state, reason: { ...state.reason, text } })
  }

  // The `/` filter edits through the shared page search; arrows still move in the filtered list while the box is open.
  const searched = pageSearchKey({ open: state.typing === true, query: state.filter.text }, key)
  if (searched && (state.typing || (key === "/" && state.tab === 0 && !state.detail && !state.confirm && !state.config))) {
    const { search } = searched
    return keep({ ...state, typing: search.open, selected: 0, filter: { ...state.filter, text: search.query.slice(0, MAX_FILTER_TEXT) } })
  }
  if (state.typing && !UP.has(key) && !DOWN.has(key) && key !== PAGE_UP && key !== PAGE_DOWN) return keep(state)

  if (state.confirm) {
    const { confirm, ...rest } = state
    const confirmed = key === "y" || (confirm.kind === "cancel" ? key === "x" : key === "t")
    const target = dashboard?.jobs.find((entry) => entry.id === confirm.jobId)
    if (!confirmed || !target) return keep(rest)
    const action: ReviewsJobAction = confirm.kind === "cancel" ? "job-cancel" : confirm.kind
    return { state: rest, action: { type: "job", action, jobId: confirm.jobId } }
  }

  if (state.config) {
    if (key === ESC || key === "q") { const { config: _closed, ...rest } = state; void _closed; return keep({ ...rest, scroll: 0 }) }
    if (UP.has(key) || DOWN.has(key)) return keep({ ...state, scroll: Math.max(0, state.scroll + (UP.has(key) ? -1 : 1)) })
    if (key === PAGE_UP || key === PAGE_DOWN) return keep({ ...state, scroll: Math.max(0, state.scroll + (key === PAGE_UP ? -10 : 10)) })
    return keep(state)
  }

  const filtered = state.filter.text !== "" || state.filter.state !== "all" || state.filter.repo !== undefined
  if (key === "q") return { state, action: { type: "close" } }
  if (key === ESC) {
    if (state.detail) return keep({ ...state, detail: false, scroll: 0 })
    if (state.tab === 0 && state.selectedId !== undefined) { const { selectedId: _unpinned, ...rest } = state; void _unpinned; return keep({ ...rest, selected: 0, scroll: 0 }) }
    if (state.tab === 0 && filtered) return keep({ ...state, selected: 0, filter: { text: "", state: "all" } })
    return { state, action: { type: "close" } }
  }
  if (key === "r") return { state, action: { type: "refresh" } }
  if (key === "1" || key === "2") {
    const tab = key === "1" ? 0 : 1
    return tab === state.tab ? keep(state) : keep({ ...state, tab, detail: false, scroll: 0 })
  }
  if (key === "\t" || key === "\x1b[Z") return keep({ ...state, tab: state.tab === 0 ? 1 : 0, detail: false, scroll: 0 })

  if (state.tab === 1) {
    if (UP.has(key) || DOWN.has(key)) return keep({ ...state, scroll: Math.max(0, state.scroll + (UP.has(key) ? -1 : 1)) })
    if (key === PAGE_UP || key === PAGE_DOWN) return keep({ ...state, scroll: Math.max(0, state.scroll + (key === PAGE_UP ? -10 : 10)) })
    return keep(state)
  }

  if (state.detail) {
    if (UP.has(key) || DOWN.has(key)) return keep({ ...state, scroll: Math.max(0, state.scroll + (UP.has(key) ? -1 : 1)) })
    if (key === PAGE_UP || key === PAGE_DOWN) return keep({ ...state, scroll: Math.max(0, state.scroll + (key === PAGE_UP ? -10 : 10)) })
  } else {
    const move = (index: number) => {
      const next = jobs[Math.max(0, Math.min(index, jobs.length - 1))]
      if (!next || next === job) return keep(state)
      return keep({ ...state, selectedId: next.id, selected: jobs.indexOf(next), scroll: 0 })
    }
    const at = job ? jobs.indexOf(job) : 0
    if (UP.has(key)) return move(at - 1)
    if (DOWN.has(key)) return move(at + 1)
    if (key === PAGE_UP) return move(at - 10)
    if (key === PAGE_DOWN) return move(at + 10)
    if (key === "g" || key === "\x1b[H") return move(0)
    if (key === "G" || key === "\x1b[F") return move(jobs.length - 1)
    if (key === "f" || key === "F") return keep({ ...state, selected: 0, filter: { ...state.filter, state: cycle(STATE_FILTERS, state.filter.state, key === "f" ? 1 : -1) } })
    if (key === "m") {
      const repos: Array<string | undefined> = [undefined, ...reviewRepos(dashboard)]
      const repo = cycle(repos, state.filter.repo, 1)
      const { repo: _old, ...filter } = state.filter
      void _old
      return keep({ ...state, selected: 0, filter: repo ? { ...filter, repo } : filter })
    }
    if (ENTER.has(key) && job) return keep({ ...state, selectedId: job.id, detail: true, scroll: 0 })
  }

  if (!job) return keep(state)
  const pinned = { ...state, selectedId: job.id }
  if (key === "o") return job.url ? { state, action: { type: "url", url: job.url } } : keep(state)
  if (key === "s") return job.sessionId ? { state, action: { type: "session", sessionId: job.sessionId } } : keep(state)
  if (key === "S") return job.fixSessionId ? { state, action: { type: "session", sessionId: job.fixSessionId } } : keep(state)
  if (key === "p") return canPause(job) ? { state, action: { type: "job", action: "job-pause", jobId: job.id } } : keep(state)
  if (key === "u") return canResume(job) ? { state, action: { type: "job", action: "job-resume", jobId: job.id } } : keep(state)
  if (key === "x") return canCancel(job) ? keep({ ...pinned, confirm: { kind: "cancel", jobId: job.id, number: job.number } }) : keep(state)
  if (key === "R") return canRetry(job) ? keep({ ...pinned, reason: { jobId: job.id, number: job.number, text: "" } }) : keep(state)
  if (key === "t") {
    if (canTakeOver(job)) return keep({ ...pinned, confirm: { kind: "take-over", jobId: job.id, number: job.number } })
    if (canRelease(job)) return keep({ ...pinned, confirm: { kind: "release", jobId: job.id, number: job.number } })
    return keep(state)
  }
  if (key === "c") {
    const directory = directoryOf(dashboard, job)
    return {
      state: { ...pinned, scroll: 0, config: { jobId: job.id, number: job.number, scope: job.scope, status: "loading" } },
      action: { type: "config", jobId: job.id, number: job.number, scope: job.scope, ...(directory ? { directory } : {}) },
    }
  }
  return keep(state)
}
