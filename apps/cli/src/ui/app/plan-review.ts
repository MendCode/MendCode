import { PLAN_APPLY_DEFAULT, PLAN_APPLY_PERMISSIONS } from "@mendcode/protocol/wire"
import type { PlanReviewRecord, PlanReviewReply } from "@mendcode/protocol"
import { createEditor } from "../../view/editor"
import { markdownStyleFor } from "../../view/markdown-style"
import { MOUSE_SGR } from "./constants"
import { wheelStep } from "./page-wheel"
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
      draft = { id: view.record.requestId, stage: "preview", markdown: view.record.markdown, comments: view.record.reply?.comments ?? "", destination: view.record.destination, permission: view.record.reply?.permission ?? (input.remote ? "ask" : PLAN_APPLY_DEFAULT), scroll: 0, reviewScroll: 0, editor: createEditor({ wordWrap: true }), note: "" }
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
    const decision = { kind: "plan_review" as const, action, ...(action === "apply" || action === "accept" || action === "edit" ? { markdown, ...(comments.trim() ? { comments: comments.trim() } : {}), destination: draft.destination, ...(action === "apply" ? { permission: draft.permission } : {}) } : {}), ...(action === "reject" && draft.editor.text.trim() ? { reason: draft.editor.text.trim() } : {}) }
    const resolve = (sent: typeof decision) => input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: record.requestId, decision: sent })
    let reply = await resolve(decision)
    // A daemon from before the `permission` field cannot parse the reply (the client turns that into "it may be an older build"): once more without it, so the plan is still applied, with that daemon's own access.
    let skewed = false
    if (!reply.ok && "permission" in decision && reply.error.code === "invalid_command" && reply.error.message.includes("older build")) {
      const { permission: _unsupported, ...legacy } = decision
      reply = await resolve(legacy)
      skewed = reply.ok
    }
    busy = false
    if (record.sessionId !== state.sessionId) return
    if (!reply.ok) draft.note = reply.error.message
    else {
      if (state.page === "plan-review") state.page = "chat"
      if (skewed) state.notice = "plan applied · the access you chose waits for /daemon restart"
    }
    requestFrame()
  }

  /** A wheel report scrolls the plan, or the Review panel when the pointer is over it and it is taller than its room; any other mouse report does nothing here. */
  function planReviewWheel(key: string, active: PlanDraft) {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(key)
    const button = Number(match![1]) & ~(4 | 8 | 16)
    const step = wheelStep({ page: "plan-review" })
    if (!step || (button !== 64 && button !== 65) || active.stage !== "preview") return
    const notch = step.repeat === "notch" ? state.tuiProfile.wheelLines : 1
    const col = Number(match![2]) - 1
    const row = Number(match![3]) - 1
    const box = active.reviewBox
    const over = box?.overflow && col >= box.left && col <= box.right && row >= box.top && row <= box.bottom
    const delta = (button === 64 ? -1 : 1) * notch
    if (over) active.reviewScroll = Math.max(0, active.reviewScroll + delta)
    else active.scroll = Math.max(0, active.scroll + delta)
  }

  async function planReviewKey(key: string): Promise<boolean> {
    const view = sync()
    if (!view) return false
    const { draft: active, record, pending } = view
    if (MOUSE_SGR.test(key)) { planReviewWheel(key, active); requestFrame(); return true }
    if (key === "\x1b" || key === "\x03") {
      if (active.stage !== "preview") stage("preview")
      else if (pending) await send("close")
      else { state.page = "chat"; saved = []; active.note = ""; draft = undefined }
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
      else if (key === "m") active.permission = PLAN_APPLY_PERMISSIONS[(PLAN_APPLY_PERMISSIONS.indexOf(active.permission) + 1) % PLAN_APPLY_PERMISSIONS.length]!
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
    // Nothing to review: the drawn plan goes with its draft.
    if (!view) { draft = undefined; return undefined }
    return renderPlanReviewPage({ ...view, width, height, index: view.pending ? 0 : selected, count: view.pending ? 1 : saved.length, renderer: state.transcript.concealed ? state.tuiProfile.messageRenderer : "plain", markdown: markdownStyleFor({ profile: state.tuiProfile, mode: state.mode }) })
  }
  return { openPlanReview, planReviewKey, planReviewPaste, planReviewFrame }
}
