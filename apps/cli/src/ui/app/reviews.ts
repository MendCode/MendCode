import type { PrReviewConfigView, PrReviewDashboard, SessionId } from "@mendcode/protocol"
import type { ReviewsData, ReviewsPageState } from "../../view/reviews-page"
import type { ReviewsPageAction } from "../../view/reviews-keys"
import type { Line } from "../theme"
import { createReviewsPageState, preload, renderReviewsPage, reviewsCommand, reviewsPageKey } from "../lazy-pages"
import type { AppContext } from "./context"

/** How often the open page asks the daemon for `status` again; nothing is asked while the page is closed. */
const POLL_MS = 5_000
/** A dashboard holds at most this many jobs (the protocol's bound); a longer answer is cut, never grown. */
const MAX_JOBS = 500

const clean = (message: string) => message.replace(/^\[[A-Z_-]+\]:\s*/, "")

/** The `status` answer's `dashboard`, when it has the page's shape; undefined for a daemon that does not send one. */
function dashboardOf(result: Record<string, unknown> | undefined): PrReviewDashboard | undefined {
  const value = result?.dashboard as Partial<PrReviewDashboard> | undefined
  if (!value || typeof value !== "object" || !Array.isArray(value.jobs) || !Array.isArray(value.watches) || !Array.isArray(value.reviewers) || typeof value.metrics !== "object" || value.metrics === null) return undefined
  const dashboard = value as PrReviewDashboard
  return dashboard.jobs.length > MAX_JOBS ? { ...dashboard, jobs: dashboard.jobs.slice(0, MAX_JOBS) } : dashboard
}

/**
 * `/reviews` and `/pr dashboard` (docs/pr-review.md): the review platform's page. Reads `pr.review` `status` when opened and every
 * 5 s while it stays open (the last good dashboard stays on screen while a refresh runs or fails, so nothing flickers), and sends
 * the job actions the page's keys ask for.
 */
export function createReviews(ctx: AppContext, deps: { switchSession(sessionId: SessionId): Promise<void> }) {
  const { input, state, requestFrame, fail, say, now } = ctx
  let view: ReviewsPageState | undefined
  let data: ReviewsData = { status: "loading" }
  let timer: ReturnType<typeof setInterval> | undefined
  /** The visit whose `status` request is in flight: a refresh never stacks a second request, a new visit does not wait for an old one. */
  let loadingVisit = -1
  let visit = 0

  function stopPolling() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  async function load() {
    if (loadingVisit === visit) return
    if (input.remote) { data = { status: "remote" }; return requestFrame() }
    if (!state.sessionId) { data = { ...data, status: "error", error: "no session yet: send a message first" }; return requestFrame() }
    const ticket = visit
    loadingVisit = ticket
    try {
      const reply = await input.send({ type: "pr.review", sessionId: state.sessionId, action: "status" })
      if (ticket !== visit) return
      if (!reply.ok) data = { ...data, status: "error", error: clean(reply.error.message) }
      else {
        const dashboard = dashboardOf(reply.result)
        data = dashboard ? { status: "ready", dashboard, fetchedAt: now() } : { status: "unavailable" }
      }
    } catch (error) {
      if (ticket === visit) data = { ...data, status: "error", error: clean(error instanceof Error ? error.message : String(error)) }
    } finally {
      if (loadingVisit === ticket) loadingVisit = -1
      if (ticket === visit && state.page === "reviews") requestFrame()
    }
  }

  async function open() {
    await preload("reviews")
    visit++
    stopPolling()
    view = createReviewsPageState()
    data = { status: input.remote ? "remote" : "loading" }
    state.page = "reviews"
    requestFrame()
    if (input.remote) return
    await load()
    timer = setInterval(() => {
      if (state.page !== "reviews") return stopPolling()
      void load()
    }, POLL_MS)
    timer.unref?.()
  }

  /**
   * `/reviews open <job id>` (the link a started review's notice carries, as `/loop open <loop id>` is a loop's): the job's reviewer
   * session when it has one, else the page with a line saying where the job is. A job id is matched whole, by its start or by its end;
   * a session id opens that session.
   */
  async function openJob(target: string) {
    if (target.startsWith("ses_")) return deps.switchSession(target as SessionId)
    if (input.remote) return fail("reviews: opening a job works only from a local session")
    if (!state.sessionId) return fail("no session yet: send a message first")
    const reply = await input.send({ type: "pr.review", sessionId: state.sessionId, action: "status" })
    if (!reply.ok) return fail(`reviews: ${clean(reply.error.message)}`)
    const dashboard = dashboardOf(reply.result)
    const job = dashboard?.jobs.find((entry) => entry.id === target) ?? dashboard?.jobs.find((entry) => target.length >= 6 && (entry.id.startsWith(target) || entry.id.endsWith(target)))
    if (!job) return fail(`no review job ${target}`)
    if (!job.sessionId) {
      say(`job ${job.id} is ${job.state}${job.phase ? ` · ${job.phase}` : ""}; its reviewer session starts when the review does`, "info", { title: "PR review" })
      return open()
    }
    close()
    return deps.switchSession(job.sessionId as SessionId)
  }

  function close() {
    visit++
    stopPolling()
    state.page = "chat"
  }

  async function config(action: Extract<ReviewsPageAction, { type: "config" }>) {
    const command = reviewsCommand(action, state.sessionId)!
    const reply = await input.send(command)
    if (view?.config?.jobId !== action.jobId) return
    const result = reply.ok ? reply.result?.config as PrReviewConfigView | undefined : undefined
    view = { ...view, config: result ? { ...view.config, status: "ready", view: result } : { ...view.config, status: "error", error: reply.ok ? "the daemon sent no configuration" : clean(reply.error.message) } }
  }

  async function run(action: ReviewsPageAction) {
    if (action.type === "close") return close()
    if (action.type === "refresh") return load()
    if (action.type === "url") {
      const reply = await input.send({ type: "url.open", url: action.url })
      if (!reply.ok) fail(`not opened: ${clean(reply.error.message)}`)
      return
    }
    if (action.type === "session") {
      close()
      return deps.switchSession(action.sessionId as SessionId)
    }
    if (action.type === "config") return config(action)
    if (action.type !== "job") return
    if (input.remote) return fail("reviews: job actions work only from a local session")
    const reply = await input.send(reviewsCommand(action, state.sessionId)!)
    if (!reply.ok) return fail(`reviews: ${clean(reply.error.message)}`)
    say(String(reply.result?.text ?? `${action.action} sent`), "success", { title: "PR review" })
    await load()
  }

  async function key(key: string) {
    if (!view) return
    const result = reviewsPageKey(view, key, data.dashboard)
    const changed = result.state !== view
    view = result.state
    if (changed || result.action.type !== "none") requestFrame()
    if (result.action.type !== "none") await run(result.action)
    requestFrame()
  }

  function render(width: number, height: number): Line[] {
    if (!view) return []
    return renderReviewsPage({ data, state: view, width, height, now: now(), offline: state.connection !== "connected", glyphs: ctx.glyphs })
  }

  return { open, openJob, key, render, close }
}
