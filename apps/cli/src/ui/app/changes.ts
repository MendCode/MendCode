import type { SidebarChange } from "../../view/sidebar"
import { changesPageHits, changesReviewSent, firstChangedLine } from "../lazy-pages"
import { writeReviewComments } from "../../view/review-comments"
import type { ChangedFile, ChangesReport, ReviewSnapshot, GlobalEvent } from "@mendcode/protocol"
import { parseDiffRows } from "@mendcode/protocol/wire"
import { reviewMessage } from "../../view/review-message"
import type { ChangesPageState } from "../../view/changes-state"
import type { AppContext } from "./context"
import { featureOn } from "@mendcode/protocol/wire"

export function createChanges(ctx: AppContext, deps: { openRef(ref: { raw: string; line?: number }, opened: () => void): void }) {
  const { input, state, requestFrame, fail, say } = ctx
  let reviewOrder = false

  /** `f` on the page, a click on a file: the file in the viewer at its first changed line. The page stays until the viewer shows it, then the chat with the viewer takes its place. */
  function viewChangedFile(action: { path: string; line?: number }) {
    if (state.changesSource) return say("past changes are a snapshot: open the file from the working-tree changes", "info")
    deps.openRef({ raw: action.path, ...(action.line !== undefined ? { line: action.line } : {}) }, () => { state.page = "chat"; requestFrame() })
  }

  /** A left click at a screen position on the Changes page: a file of the list or the heading of its diff opens that file. True when it was one of them. */
  function changesClick(at: { row: number; col: number }): boolean {
    const report = state.changesReport
    if (!report) return false
    // Inside the Git page the Changes page is drawn one row lower, under the tabs row.
    const top = state.pageBodyTop ?? 0
    const hit = changesPageHits({ report, state: state.changesState, width: input.screen.size.width, height: state.pageBodyHeight ?? input.screen.size.height }).find((entry) => entry.row + top === at.row && at.col >= entry.from && at.col < entry.to)
    if (!hit) return false
    const previous = state.changesState
    if (hit.file !== previous.selected) {
      state.changesState = { ...previous, selected: hit.file, scroll: 0, cursor: 0, anchor: null, notice: "" }
      void saveReview(previous)
      void ensureSelectedDiff()
    }
    const file = report.files[hit.file]!
    if (file.status === "deleted") state.changesState = { ...state.changesState, notice: "deleted: no file to open" }
    else {
      const line = firstChangedLine(file)
      viewChangedFile({ path: file.path, ...(line !== undefined ? { line } : {}) })
    }
    requestFrame()
    return true
  }

  async function orderReview(apply: boolean) {
    if (!featureOn(state.settingsNow, "review_order")) return say("review order requires balanced tier", "warning")
    if (!state.changesReport || state.changesState.mode !== "browse") return
    const { orderChanges, refreshChangesState, REVIEW_ORDER_REASON } = await import("../../view/changes-order")
    if (!apply) {
      state.changesState = { ...state.changesState, notice: `order: ${REVIEW_ORDER_REASON} · O applies` }
    } else {
      const next = orderChanges(state.changesReport)
      state.changesState = { ...refreshChangesState(state.changesState, state.changesReport, next), notice: `order applied: ${REVIEW_ORDER_REASON}` }
      state.changesReport = next
      reviewOrder = true
    }
    requestFrame()
  }

  async function ensureSelectedDiff() {
    if (state.changesSource) return
    const file = state.changesReport?.files[state.changesState.selected]
    if (!file || !file.truncated || file.binary || state.fetchedDiffs.has(file.path)) return
    state.fetchedDiffs.add(file.path)
    const reply = await input.send({ type: "changes.file", directory: input.directory ?? "", path: file.path })
    const full = reply.ok ? (reply.result as Partial<ChangedFile>) : undefined
    if (!state.changesReport || !full?.path) return
    state.changesReport = { ...state.changesReport, files: state.changesReport.files.map((f) => (f.path === full.path ? (full as ChangedFile) : f)) }
    requestFrame()
  }

  const revisions = new Map<string, number>()

  function mirrorReview() {
    if (!input.dataDir) return
    const saved = writeReviewComments(input.dataDir, state.sessionId, state.changesState.comments)
    if (!saved.ok) fail(saved.error)
  }

  function takeReview(review: ReviewSnapshot, sessionId = state.sessionId) {
    if (sessionId !== state.sessionId || !state.changesState || review.revision < (revisions.get(sessionId) ?? 0)) return
    revisions.set(sessionId, review.revision)
    const local = state.changesState
    const files = state.changesReport?.files ?? []
    const selected = files.findIndex((file) => file.path === review.selection.filePath)
    const row = review.selection.row ?? 0
    const move = selected >= 0 && (selected !== local.selected || row !== local.cursor)
    // A remote navigation must not discard an in-progress comment or jump draft.
    state.changesState = { ...local, comments: review.comments, ...(move && local.mode !== "compose" && local.mode !== "jump" ? { selected, cursor: row, scroll: Math.max(0, row - 2), anchor: null, focus: "diff" as const } : {}) }
    mirrorReview()
    requestFrame()
  }

  async function saveReview(previous?: ChangesPageState) {
    if (state.changesSource) return
    mirrorReview()
    if (!state.changesReport) return
    const sessionId = state.sessionId
    const local = state.changesState
    const before = previous?.comments ?? []
    const upsert = local.comments.filter((comment) => !before.some((old) => old.id === comment.id && old.body === comment.body)).map((comment) => ({ ...comment, author: comment.author ?? "user" as const }))
    const remove = before.filter((old) => !local.comments.some((comment) => comment.id === old.id)).map((comment) => comment.id)
    const file = state.changesReport.files[local.selected]
    const rows = parseDiffRows((file?.diff ?? "").replace(/\n$/, "").split("\n"))
    const block = rows[local.cursor]?.hunk
    const reply = await input.send({ type: "review.update", sessionId, change: { action: "sync", ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}), selection: file ? { filePath: file.path, row: local.cursor, ...(block !== undefined && block >= 0 ? { blockIndex: block } : {}) } : {} } })
    if (sessionId !== state.sessionId) return
    if (!reply.ok) return fail(reply.error.message)
    const review = reply.result?.review as ReviewSnapshot | undefined
    if (review) takeReview(review, sessionId)
  }

  async function sendReview(action: { text: string; count: number }) {
    if (state.changesSource) return
    const sessionId = state.sessionId
    const fresh = await input.send({ type: "review.query", sessionId, query: { action: "current" } })
    if (sessionId !== state.sessionId) return
    if (fresh.ok && fresh.result?.review) takeReview(fresh.result.review as ReviewSnapshot, sessionId)
    const comments = [...state.changesState.comments]
    const text = fresh.ok && fresh.result?.review ? reviewMessage({ comments, ...(state.changesReport?.branch ? { branch: state.changesReport.branch } : {}) }) : action.text
    if (!text) return
    const reply = await input.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (!reply.ok) return fail(reply.error.message)
    if (sessionId !== state.sessionId) return
    const previous = state.changesState
    const sent = new Set(comments.map((comment) => comment.id))
    state.changesState = { ...changesReviewSent(previous), comments: previous.comments.filter((comment) => !sent.has(comment.id)) }
    await saveReview(previous)
    state.page = "chat"
    say(`review sent · ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`, "success")
  }

  function noteReview(event: Extract<GlobalEvent, { type: "review.changed" }>) {
    if (event.sessionId !== state.sessionId) return
    takeReview(event.review)
    if (event.reload && state.page === "changes") void loadChanges(false)
    else if (state.page === "changes") void ensureSelectedDiff()
  }

  async function loadChanges(reload = true) {
    const sessionId = state.sessionId
    const source = state.changesSource
    state.fetchedDiffs.clear()
    const reply = await input.send(source ? { type: "session.changes", ...source } : { type: "changes.query", directory: input.directory ?? "" })
    if (sessionId !== state.sessionId || source !== state.changesSource) return
    if (reply.ok) {
      const { orderChanges, refreshChangesState } = await import("../../view/changes-order")
      if (sessionId !== state.sessionId || source !== state.changesSource) return
      const next = reviewOrder ? orderChanges(reply.result as ChangesReport) : reply.result as ChangesReport
      state.changesState = refreshChangesState(state.changesState, state.changesReport, next)
      state.changesReport = next
      state.changesError = ""
      if (source) return requestFrame()
      const shared = await input.send({ type: "review.query", sessionId, query: { action: "current" } })
      if (sessionId !== state.sessionId || source !== state.changesSource) return
      if (shared.ok && shared.result?.review) {
        takeReview(shared.result.review as ReviewSnapshot, sessionId)
        if (reload) {
          const refreshed = await input.send({ type: "review.update", sessionId, change: { action: "reload" } })
          if (refreshed.ok && refreshed.result?.review) takeReview(refreshed.result.review as ReviewSnapshot, sessionId)
        }
      }
      void ensureSelectedDiff()
    } else {
      state.changesReport = undefined
      state.changesError = reply.error.code === "not_git" ? "not a git repository" : reply.error.message
    }
    requestFrame()
  }

  async function selectChangesSource(args: string): Promise<boolean> {
    reviewOrder = false
    const choice = args.trim()
    if (!choice) { state.changesSource = undefined; return true }
    if (choice === "session") { state.changesSource = { sessionId: state.sessionId }; return true }
    // `replay [n]` is `message <n>` (the last message by default) opened in replay stepping.
    const match = /^(?:message|replay) ([1-9]\d*)$/.exec(choice) ?? (choice === "replay" ? ["", "0"] : null)
    if (!match) { fail("usage: /changes [session | message <n> | replay [n]]"); return false }
    const sessionId = state.sessionId
    const reply = await input.send({ type: "session.timeline", sessionId })
    if (state.sessionId !== sessionId) return false
    if (!reply.ok) { fail(reply.error.message); return false }
    const entries = reply.result?.entries as import("@mendcode/protocol").TimelineEntry[] | undefined
    const entry = Number(match[1]) === 0 ? entries?.at(-1) : entries?.[Number(match[1]) - 1]
    if (!entry) { fail("Message number is outside the timeline"); return false }
    state.changesSource = { sessionId: state.sessionId, atItemId: entry.itemId }
    return true
  }

  /** `+A -R` for the top bar: asked at start and after each turn, never on a timer. */
  async function loadDiffTotals() {
    if (!input.directory || state.mode === "minimal") return
    const reply = await input.send({ type: "changes.query", directory: input.directory })
    if (reply.ok && Array.isArray((reply.result as Partial<ChangesReport> | undefined)?.files)) {
      const { files } = reply.result as ChangesReport
      state.diffTotals = files.reduce((sum, file) => ({ added: sum.added + file.additions, removed: sum.removed + file.deletions }), { added: 0, removed: 0 })
      // The sidebar lists them; the diffs themselves stay with /changes.
      state.changedFiles = files.map(({ path, status, additions, deletions }): SidebarChange => ({ path, status, additions, deletions }))
      requestFrame()
    }
  }

  return { ensureSelectedDiff, saveReview, sendReview, loadChanges, loadDiffTotals, noteReview, selectChangesSource, orderReview, viewChangedFile, changesClick }
}
