import type { PlanReviewRecord, PlanReviewReply } from "@mendcode/protocol"
import { createEditor } from "../../view/editor"
import type { PlanDraft, PlanStage } from "../../view/plan-review-page"
import { preload, renderPlanReviewPage } from "../lazy-pages"
import type { AppContext } from "./context"

export function createPlanReview(ctx: AppContext) {
  const { input, state, requestFrame, report } = ctx
  let draft: PlanDraft | undefined
  let saved: PlanReviewRecord[] = []
  let selected = 0
  let session = state.sessionId
  let busy = false

  function current() {
    if (session !== state.sessionId) { draft = undefined; saved = []; selected = 0; busy = false; session = state.sessionId }
    const request = state.transcript.pendingRequests[0]
    const plan = request ? state.turnState.extras(request.requestId).planReview : undefined
    if (request && plan) return { record: { ...plan, requestId: request.requestId, sessionId: state.sessionId, turnId: state.turnState.extras(request.requestId).turnId!, createdAt: 0 } as PlanReviewRecord, pending: true }
    const record = state.page === "plan-review" ? saved[selected] : undefined
    return record ? { record, pending: false } : undefined
  }

  function sync() {
    const view = current()
    if (!view) return undefined
    if (draft?.id !== view.record.requestId) {
      draft = { id: view.record.requestId, stage: "preview", markdown: view.record.markdown, comments: view.record.reply?.comments ?? "", destination: view.record.destination, scroll: 0, editor: createEditor({ wordWrap: true }), note: "" }
      busy = false
    }
    return { ...view, draft: draft! }
  }

  async function openPlanReview() {
    await preload("plan-review")
    const sessionId = state.sessionId
    const reply = await input.send({ type: "plan.review.list", sessionId })
    if (sessionId !== state.sessionId) return
    if (!reply.ok) { report(reply); return requestFrame() }
    saved = reply.result?.reviews as PlanReviewRecord[] ?? []
    if (!saved.length && !current()) { state.notice = "No reviewed plans"; return requestFrame() }
    selected = 0
    draft = undefined
    state.page = "plan-review"
    requestFrame()
  }

  function stage(next: PlanStage) {
    const view = sync()
    if (!view) return
    if (view.draft.stage === "edit") view.draft.markdown = view.draft.editor.text
    if (view.draft.stage === "comments") view.draft.comments = view.draft.editor.text
    view.draft.stage = next
    view.draft.scroll = 0
    view.draft.editor.replaceAll(next === "edit" ? view.draft.markdown : next === "comments" ? view.draft.comments : "")
    view.draft.editor.resetHistory()
    view.draft.note = ""
  }

  async function send(action: PlanReviewReply["action"]) {
    const view = sync()
    if (!view?.pending || busy) return
    const { record, draft } = view
    const markdown = draft.stage === "edit" ? draft.editor.text : draft.markdown
    const comments = draft.stage === "comments" ? draft.editor.text : draft.comments
    if (!markdown.trim()) { draft.note = "Plan is empty"; return requestFrame() }
    if (markdown.length > 30_000 || comments.length > 4000 || draft.stage === "reject" && draft.editor.text.length > 2000) { draft.note = "Review exceeds the text limit"; return requestFrame() }
    busy = true
    const reply = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: record.requestId, decision: { kind: "plan_review", action, ...(action === "apply" || action === "accept" || action === "edit" ? { markdown, ...(comments.trim() ? { comments: comments.trim() } : {}), destination: draft.destination } : {}), ...(action === "reject" && draft.editor.text.trim() ? { reason: draft.editor.text.trim() } : {}) } })
    busy = false
    if (record.sessionId !== state.sessionId) return
    if (!reply.ok) draft.note = reply.error.message
    else if (state.page === "plan-review") state.page = "chat"
    requestFrame()
  }

  async function planReviewKey(key: string): Promise<boolean> {
    const view = sync()
    if (!view) return false
    const { draft: active, record, pending } = view
    if (key === "\x1b" || key === "\x03") {
      if (active.stage !== "preview") stage("preview")
      else if (pending) await send("close")
      else { state.page = "chat"; saved = []; active.note = "" }
    } else if (active.stage !== "preview") {
      if (key === "\x0f") await send(active.stage === "reject" ? "reject" : record.phase === "plan" ? "accept" : "apply")
      else if (key === "\x13") await send("edit")
      else if (active.stage === "reject" && key === "\r") await send("reject")
      else active.editor.key(key === "\r" ? "\n" : key)
    } else if (key === "\x1b[A" || key === "k" || key === "\x1b[B" || key === "j" || key === "\x1b[5~" || key === "\x1b[6~") {
      active.scroll = Math.max(0, active.scroll + (key === "k" || key.endsWith("A") || key === "\x1b[5~" ? -1 : 1) * (key.endsWith("~") ? Math.max(1, input.screen.size.height - 10) : 1))
    } else if (!pending && (key === "\x1b[C" || key === "\x1b[D")) {
      selected = (selected + (key.endsWith("C") ? 1 : saved.length - 1)) % saved.length
      draft = undefined
    } else if (pending) {
      if (key === "\r") await send(record.phase === "plan" ? "accept" : "apply")
      else if (key === "a") await send("accept")
      else if (key === "e") stage("edit")
      else if (key === "c") stage("comments")
      else if (key === "r") stage("reject")
      else if (key === "t") {
        const reply = await input.send({ type: "agents.list", sessionId: state.sessionId })
        if (!reply.ok) active.note = reply.error.message
        else {
          const names = (reply.result as unknown as import("@mendcode/protocol").AgentsReport).agents.filter((agent) => agent.trusted && !agent.disable && agent.mode !== "subagent" && !agent.hidden && agent.name !== "plan").map((agent) => agent.name)
          if (names.length) active.destination = names[(names.indexOf(active.destination) + 1) % names.length]!
        }
      }
    }
    requestFrame()
    return true
  }

  function planReviewPaste(text: string) {
    const view = sync()
    if (!view) return false
    if (view.draft.stage !== "preview") view.draft.editor.insert(text.replace(/\r\n?/g, "\n"))
    requestFrame()
    return true
  }

  function planReviewFrame(width: number, height: number) {
    const view = sync()
    return view ? renderPlanReviewPage({ ...view, width, height, index: view.pending ? 0 : selected, count: view.pending ? 1 : saved.length }) : undefined
  }
  return { openPlanReview, planReviewKey, planReviewPaste, planReviewFrame }
}
