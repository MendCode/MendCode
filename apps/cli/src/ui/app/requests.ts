import type { createSecrets } from "./secrets"
import { approvalReviewRows, parseApprovalReview, approvalWindow, renderApprovalDiff, splitApprovalDetail } from "../lazy-pages"
import { maskSecretMarkers } from "../../view/secret-markers"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import { approvalChoicesOf, editedPlanReason, MAX_PLAN_REPLY, PLAN_TITLE, ruleOffer, type ApprovalChoice, type PanelRequest } from "../../view/request-panel"
import { explainApproval } from "../../view/approval-explain"
import { wrapSpans } from "../../view/markdown"
import type { ApprovalModel, QuestionModel } from "@mendcode/extension-api/views"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import { questionFieldWidth, singleQuestion, type QuestionDraft, type QuestionField } from "../../view/question-batch"
import { textWidth } from "../../view/wrap"
import type { QuestionInfo } from "@mendcode/protocol"

export function createRequests(ctx: AppContext, actions: {
  secretTail: ReturnType<typeof createSecrets>["secretTail"]
}) {
  const { input, state, editor, report, requestFrame, say, fail, glyphs: g } = ctx
  const { secretTail } = actions

  /** The plan the agent presented (the text of its plan_submit card), for editing. */
  function planText(itemId: string | undefined) {
    return itemId ? (state.transcript.blocks().find((block) => block.itemId === itemId)?.text ?? "") : ""
  }

  /**
   * Plan review: `edit` puts the plan text in the prompt, `comment` leaves it empty for feedback. A tool approval's `note`
   * is the same box for a rejection: the text goes back to the agent as the reason. Enter then sends it (see submitPlanDraft).
   */
  function startPlanDraft(request: { requestId: string; itemId?: string }, kind: "edit" | "comment" | "note") {
    editor.clear()
    if (kind === "edit") {
      const pending = state.transcript.pendingRequests.find((entry) => entry.requestId === request.requestId)
      const plan = pending?.title === "Save to memory?" ? pending.detail.split("\n").slice(0, -1).join("\n") : planText(request.itemId).trim()
      if (!plan) {
        state.notice = "the plan text is not available to edit"
        return
      }
      editor.insert(plan)
    }
    state.planDraft = { requestId: request.requestId, kind }
    if (state.transcript.pendingRequests.find((entry) => entry.requestId === request.requestId)?.title === "Save to memory?") {
      state.notice = "edit memory text · enter saves · esc cancels"
      return
    }
    state.notice = kind === "edit" ? "edit the plan, then enter sends it back (esc cancels)" : kind === "note" ? "type a note for the agent, then enter rejects with it (esc cancels)" : "type your feedback, then enter sends it (esc cancels)"
  }

  /** Enter in the prompt while a plan review is being edited or commented: a deny whose reason is the feedback or the edited plan. */
  async function submitPlanDraft(text: string) {
    const draft = state.planDraft!
    const request = state.transcript.pendingRequests.find((candidate) => candidate.requestId === draft.requestId)
    if (!request) {
      state.planDraft = undefined
      editor.clear()
      state.notice = ""
      return requestFrame()
    }
    if (!text) {
      state.notice = draft.kind === "edit" ? "the plan is empty · esc cancels" : "type your feedback first · esc cancels"
      return requestFrame()
    }
    const memory = request.title === "Save to memory?" && draft.kind === "edit"
    const reason = memory ? text.length <= MAX_PLAN_REPLY ? text : undefined : draft.kind === "edit" ? editedPlanReason(text) : text.slice(0, MAX_PLAN_REPLY)
    if (reason === undefined) {
      state.notice = `the edited plan is too long to send back (${MAX_PLAN_REPLY} characters at most)`
      return requestFrame()
    }
    state.planDraft = undefined
    editor.clear()
    state.notice = ""
    requestFrame()
    const reply = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: request.requestId, decision: memory ? { kind: "approve", scope: "once", memoryText: text } : { kind: "deny", reason } })
    report(reply)
    requestFrame()
  }

  async function resolveRequest(choice: ApprovalChoice["choice"]) {
    const request = state.transcript.pendingRequests[0]
    if (!request || request.kind !== "approval") return
    if (request.title === "Save to memory?" && choice === "session") {
      report(await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once", memoryAlways: true } }))
      return
    }
    if (choice === "edit" || choice === "comment" || choice === "note") return startPlanDraft(request, choice)
    if (choice === "project" || choice === "user") {
      // Approves this call once and saves the allow rule the daemon derives from the request; the rule applies from the next call.
      const reply = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once", remember: { level: choice } } })
      if (!reply.ok) fail(reply.error.message.replace(/^\[[A-Z]+\]: /, ""))
      else {
        const saved = (reply.result as { remembered?: { level: "project" | "user"; label: string } } | undefined)?.remembered
        if (saved) say(`always allow ${saved.label} ${saved.level === "project" ? "in this project" : "in all projects"}`, "success")
      }
      return
    }
    await input.send({
      type: "request.resolve",
      sessionId: state.sessionId,
      requestId: request.requestId,
      decision: choice === "deny" ? { kind: "deny" } : { kind: "approve", scope: choice },
    })
  }

  /** A click on an approval option selects and confirms it. */
  async function pickApproval(index: number) {
    const request = state.transcript.pendingRequests[0]
    if (!request || request.kind !== "approval") return
    state.approvalChoice = index
    const option = approvalChoicesOf(pendingPanelRequest())[index]
    if (option) await resolveRequest(option.choice)
    requestFrame()
  }

  /** `?` on a pending approval: shows or hides what the request is, why it asks and what each choice does. */
  function toggleApprovalExplain(): boolean {
    const request = state.transcript.pendingRequests[0]
    if (!request || request.kind !== "approval" || request.title === PLAN_TITLE) return false
    state.approvalExplainFor = state.approvalExplainFor === request.requestId ? undefined : request.requestId
    requestFrame()
    return true
  }

  // ─── Questions (docs/layout.md, "Questions") ───────────────────────────────────────────────────────────────────────
  // Every question is a batch here: a single one (title, detail, options) is a batch of one. The card takes the prompt's
  // place; the editor is the buffer of its "Type your own answer" field, so the prompt itself holds nothing meanwhile.

  let batch: QuestionDraft | undefined
  /** What was typed in the prompt when a question arrived: it waits here while the card holds the editor, and comes back after. */
  let parked: string | undefined

  /** The questions a request asks, with secrets masked: a batch's own, or its single question (title as header, detail as the text). */
  function questionsOf(request: PanelRequest): QuestionInfo[] {
    if (request.questions?.length) return request.questions.map((question) => ({ ...question, question: maskSecretMarkers(question.question, secretTail), ...(question.context ? { context: maskSecretMarkers(question.context, secretTail) } : {}) }))
    return [{ header: request.title, question: request.detail.trim() || request.title, options: [...(request.options ?? [])], ...(request.multiple ? { multiple: true } : {}) }]
  }

  /** A question with no options and room for an answer of one's own opens with the field ready. */
  const freeText = (question: QuestionInfo | undefined) => !!question && question.options.length === 0 && question.custom !== false

  function questionDraft(request: PanelRequest) {
    if (batch?.requestId === request.requestId) return batch
    if (!editor.isEmpty()) parked = editor.text
    editor.clear()
    batch = { requestId: request.requestId, tab: 0, choice: 0, answers: [], custom: [], editing: freeText(questionsOf(request)[0]), scroll: 0 }
    return batch
  }

  /** Back from the field to the list: what was typed and not saved is dropped. */
  function leaveField(draft: QuestionDraft) {
    draft.editing = false
    editor.clear()
  }

  function selectQuestionTab(index: number) {
    const request = pendingPanelRequest()
    if (!request || request.kind !== "question") return
    const questions = questionsOf(request)
    const draft = questionDraft(request)
    const count = questions.length + (singleQuestion(questions) ? 0 : 1)
    draft.tab = (index + count) % count
    draft.choice = 0
    draft.scroll = 0
    leaveField(draft)
    if (freeText(questions[draft.tab])) {
      draft.editing = true
      editor.replaceAll(draft.custom[draft.tab] ?? "")
    }
    requestFrame()
  }

  /** Sends every answer. A single question goes back as the text it always was (the labels joined with ", "); a batch adds the lists. */
  async function sendAnswers(request: PanelRequest) {
    const draft = questionDraft(request)
    const answers = questionsOf(request).map((_, index) => [...(draft.answers[index] ?? [])])
    leaveField(draft)
    const text = answers.map((answer) => answer.join(", ")).join("\n")
    const reply = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: request.requestId as import("@mendcode/protocol").RequestId, decision: request.questions?.length ? { kind: "answer", text, answers } : { kind: "answer", text } })
    report(reply)
    requestFrame()
  }

  /** The field's text becomes the open question's answer of one's own (an empty one clears it), and the list is back. */
  function saveCustom(draft: QuestionDraft, question: QuestionInfo, text: string) {
    const previous = draft.custom[draft.tab]
    draft.custom[draft.tab] = text
    const selected = (draft.answers[draft.tab] ?? []).filter((answer) => answer !== previous)
    draft.answers[draft.tab] = question.multiple ? [...selected.filter((answer) => answer !== text), ...(text ? [text] : [])] : text ? [text] : []
    leaveField(draft)
    editor.resetHistory()
  }

  /** Enter in the field: the text becomes the open question's own answer (an empty one clears it). A single choice moves on at once. */
  async function answerQuestion(text: string) {
    const request = pendingPanelRequest()
    if (!request || request.kind !== "question") return
    const questions = questionsOf(request)
    const draft = questionDraft(request)
    const question = questions[draft.tab]
    if (!question || question.custom === false) return
    saveCustom(draft, question, text)
    if (text && !question.multiple) {
      if (singleQuestion(questions)) return sendAnswers(request)
      return selectQuestionTab(draft.tab + 1)
    }
    return requestFrame()
  }

  const isUp = (key: string) => key === "\x1b[A" || key === "\x1bOA"
  const isDown = (key: string) => key === "\x1b[B" || key === "\x1bOB"
  const isText = (key: string) => !/^[\x00-\x1f\x7f]/.test(key)

  /**
   * The card owns the keyboard while a question waits. In the list: ↑↓ move, digits pick, space ticks a multiple choice, Enter
   * confirms (or opens the field on its row), Tab and ←→ switch the tabs of a batch, Esc and ctrl+c dismiss, and any other text
   * starts the answer of one's own. In the field the editor types; Enter saves, Esc goes back to the list. Other keys
   * (scrolling, the palette) go on to the app.
   */
  async function questionKey(key: string): Promise<boolean> {
    const request = pendingPanelRequest()
    if (!request || request.kind !== "question") return false
    const questions = questionsOf(request)
    const draft = questionDraft(request)
    const question = questions[draft.tab]
    const custom = question ? question.options.length : -1
    if (draft.editing) {
      if (key === "\x1b") { leaveField(draft); requestFrame(); return true }
      if (key === "\r") { await answerQuestion(editor.text.trim()); return true }
      if ((key === "\t" || key === "\x1b[Z") && question && !singleQuestion(questions)) {
        // Tab keeps what was typed as this question's answer and goes to the next (or previous) tab.
        saveCustom(draft, question, editor.text.trim())
        selectQuestionTab(draft.tab + (key === "\t" ? 1 : -1))
        return true
      }
      if (key === "\x03") {
        if (editor.isEmpty()) leaveField(draft)
        else editor.clear()
        requestFrame()
        return true
      }
      if (isUp(key) || isDown(key)) {
        if (editor.canMoveRows(isDown(key) ? 1 : -1)) return false
        // An empty field steps back into the list; a typed answer keeps the caret (never the prompt's history).
        if (editor.isEmpty() && question && question.options.length) {
          leaveField(draft)
          draft.choice = isDown(key) ? 0 : Math.max(0, custom - 1)
        }
        requestFrame()
        return true
      }
      return false
    }
    if (key === "\x03" || key === "\x1b") {
      leaveField(draft)
      report(await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: request.requestId as import("@mendcode/protocol").RequestId, decision: { kind: "deny" } }))
      return true
    }
    const backwards = key === "\x1b[Z" || key === "\x1b[D" || key === "\x1bOD"
    if (key === "\t" || backwards || key === "\x1b[C" || key === "\x1bOC") {
      if (!singleQuestion(questions)) selectQuestionTab(draft.tab + (backwards ? -1 : 1))
      return true
    }
    if (isUp(key) || isDown(key)) {
      if (!question) draft.scroll = Math.max(0, draft.scroll + (isDown(key) ? 1 : -1))
      else {
        const count = question.options.length + (question.custom === false ? 0 : 1)
        draft.choice = count ? (draft.choice + (isDown(key) ? 1 : count - 1)) % count : 0
      }
      requestFrame()
      return true
    }
    if (!question) {
      if (key === "\r") await sendAnswers(request)
      return key === "\r" || isText(key)
    }
    const count = question.options.length + (question.custom === false ? 0 : 1)
    if (/^[1-9]$/.test(key) && Number(key) <= count) { await pickQuestion(Number(key) - 1); return true }
    if (key === "\r" && question.multiple && singleQuestion(questions) && draft.choice < custom) {
      // One multiple choice: Enter sends what is ticked, or the highlighted option when nothing is.
      if (!draft.answers[0]?.length) draft.answers[0] = [question.options[draft.choice]!.label]
      await sendAnswers(request)
      return true
    }
    if (key === "\r" || key === " " && question.multiple) { await pickQuestion(draft.choice); return true }
    if (key === " " || key === "\x7f" || key === "\b") return true
    if (question.custom !== false && isText(key)) {
      // Text typed in the list starts the answer of one's own; the editor takes this first key.
      draft.choice = custom
      draft.editing = true
      editor.replaceAll("")
      return false
    }
    // Closed choices do not take stray text.
    return isText(key)
  }

  function questionPaste(text: string): boolean {
    const request = pendingPanelRequest()
    if (!request || request.kind !== "question") return false
    const draft = questionDraft(request)
    const question = questionsOf(request)[draft.tab]
    if (question && question.custom !== false) {
      if (!draft.editing) editor.replaceAll(draft.custom[draft.tab] ?? "")
      draft.editing = true
      draft.choice = question.options.length
      editor.insert(text.replace(/\r\n?/g, "\n"))
      requestFrame()
    }
    return true
  }

  /** A digit or a click: a single choice answers at once (or moves to the next tab), a multiple choice ticks; the last row opens the field. */
  function pickQuestion(index: number) {
    const request = pendingPanelRequest()
    if (!request || request.kind !== "question") return
    const questions = questionsOf(request)
    const draft = questionDraft(request)
    if (index < 0) return selectQuestionTab(-index - 1)
    const question = questions[draft.tab]
    if (!question) return sendAnswers(request)
    if (index === question.options.length && question.custom !== false) {
      const custom = draft.custom[draft.tab] ?? ""
      draft.choice = index
      if (question.multiple && custom && draft.answers[draft.tab]?.includes(custom)) draft.answers[draft.tab] = draft.answers[draft.tab]!.filter((answer) => answer !== custom)
      else {
        draft.editing = true
        editor.replaceAll(custom)
      }
      return requestFrame()
    }
    const option = question.options[index]
    if (!option) return
    draft.choice = index
    if (question.multiple) {
      const selected = draft.answers[draft.tab] ?? []
      // Ticked answers keep the options' order (the answer of one's own last), whatever order they were ticked in.
      const order = (answer: string) => { const at = question.options.findIndex((entry) => entry.label === answer); return at < 0 ? question.options.length : at }
      draft.answers[draft.tab] = (selected.includes(option.label) ? selected.filter((answer) => answer !== option.label) : [...selected, option.label]).sort((a, b) => order(a) - order(b))
      return requestFrame()
    }
    draft.answers[draft.tab] = [option.label]
    if (singleQuestion(questions)) return sendAnswers(request)
    return selectQuestionTab(draft.tab + 1)
  }

  /** The field's rows as the editor wraps them at the card's width, and the caret among them. */
  function questionField(width: number, question: QuestionInfo): QuestionField {
    editor.setVisualWidth(questionFieldWidth(width, question))
    const visual = editor.visualLines()
    const row = Math.max(0, visual.findLastIndex((line) => line.start <= editor.cursorOffset))
    const line = visual[row]!
    const before = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.text)].slice(0, editor.cursorOffset - line.start).map((cell) => cell.segment).join("")
    return { lines: visual.map((entry) => entry.text), row, col: textWidth(before) }
  }

  /** Scrolls the pending approval's diff by a page; false when there is no overflowing preview to scroll. */
  function scrollApproval(direction: -1 | 1): boolean {
    const request = state.transcript.pendingRequests[0]
    const split = request?.kind === "approval" ? splitApprovalDetail(parseApprovalReview(request.detail).detail) : undefined
    if (!split) return false
    const { rows, maxScroll, overflow } = approvalWindow({ total: split.preview.length, screenHeight: input.screen.size.height })
    if (!overflow) return false
    state.approvalScroll = Math.max(0, Math.min(maxScroll, state.approvalScroll + direction * rows))
    return true
  }

  /** The pending request as the panels draw it: the transcript's title and detail plus the wire extras. */
  function pendingPanelRequest(): (PanelRequest & { kind: "approval" | "question" }) | undefined {
    const request = state.transcript.pendingRequests[0]
    if (!request) return undefined
    const extras = state.turnState.extras(request.requestId)
    return { ...request, title: maskSecretMarkers(request.title, secretTail), detail: maskSecretMarkers(request.detail, secretTail), ...extras }
  }

  /** A custom view's hit regions as the panel hits the click handling reads: `tab` regions carry the tab as a negative index. */
  const panelHits = (hits: ReadonlyArray<{ row: number; from: number; to: number; action: string; arg?: string | number }>) =>
    hits.flatMap((hit) => (typeof hit.arg === "number" ? [{ row: hit.row, index: hit.action === "tab" ? -hit.arg - 1 : hit.arg, from: hit.from, to: hit.to }] : []))

  /** The approval or question box above the prompt, drawn by the `approval` / `question` view slots; rows are relative to its first row. */
  function requestPanel(width: number): { rows: Line[]; hits: Array<{ row: number; index: number; from?: number; to?: number }>; kind: "approval" | "question"; cursor?: { row: number; col: number } } | undefined {
    const request = pendingPanelRequest()
    // The question is gone (answered here or elsewhere): what the prompt held before it comes back.
    if (parked !== undefined && request?.kind !== "question") {
      if (editor.isEmpty()) editor.insert(parked)
      parked = undefined
    }
    if (!request) return undefined
    if (request.kind === "question") {
      const questions = questionsOf(request)
      const draft = questionDraft(request)
      const open = questions[draft.tab]
      const field = draft.editing && open ? questionField(width, open) : undefined
      // The card stands where the prompt was, so it may take what the prompt and its frame leave free.
      const height = Math.max(10, input.screen.size.height - 6)
      const options = request.options ?? []
      // The protocol's optional fields may be present as undefined; the view model leaves them out (same data).
      const shown = questions as unknown as NonNullable<QuestionModel["questions"]>
      const model: QuestionModel = request.questions?.length
        ? { requestId: request.requestId, variant: "batch", title: request.title, detail: request.detail, multiple: false, options: [], choice: 0, picked: [], typing: draft.editing, questions: shown, draft }
        : { requestId: request.requestId, variant: "single", title: request.title, detail: request.detail, multiple: request.multiple === true, options, choice: draft.choice, picked: options.flatMap((option, index) => (draft.answers[0]?.includes(option.label) ? [index] : [])), typing: draft.editing, questions: shown, draft }
      const drawn = ctx.views.draw("question", model, { width, height, ...(field ? { extra: { field } } : {}) })
      const caret = drawn.hits.find((hit) => hit.action === "cursor")
      return { rows: drawn.lines, hits: panelHits(drawn.hits), kind: "question", ...(caret ? { cursor: { row: caret.row, col: caret.from } } : {}) }
    }
    const rich = state.mode !== "minimal" || request.title === "Save to memory?"
    const room = rich ? width - PROMPT_MARGIN * 2 - 1 : width
    if (state.approvalScrollFor !== request.requestId) [state.approvalScroll, state.approvalScrollFor] = [0, request.requestId]
    // Smart mode appends why it asks and the reviewer's verdict to the detail; they get their own rows so a long diff never scrolls them away.
    const review = request.kind === "approval" ? parseApprovalReview(request.detail) : { detail: request.detail }
    const diff = renderApprovalDiff({ detail: review.detail, width: room, screenHeight: input.screen.size.height, scroll: state.approvalScroll })
    const detail: Line[] = []
    if (diff) {
      state.approvalScroll = diff.scroll
      detail.push(...wrapSpans([{ text: diff.head, fg: "body" }], room, [{ text: "  " }]).slice(0, 2), ...diff.rows)
    } else detail.push(...wrapSpans([{ text: review.detail, fg: "body" }], room, [{ text: "  " }]).slice(0, 2))
    detail.push(...approvalReviewRows(review, room))
    if (rich && state.approvalChoiceFor !== request.requestId) [state.approvalChoice, state.approvalChoiceFor] = [0, request.requestId]
    const editing = state.planDraft?.requestId === request.requestId ? state.planDraft.kind : undefined
    const hint =
      editing === "edit"
        ? "editing the plan · enter sends it back · esc cancels"
        : editing === "comment"
          ? "type feedback · enter sends it · plan mode stays · esc cancels"
          : state.planDraft?.requestId === request.requestId && state.planDraft.kind === "note"
            ? "type a note · enter rejects with it · esc cancels"
            : `↑↓ select · enter confirm${request.title === PLAN_TITLE ? "" : " · ? explain"}${width >= 84 ? (request.title === PLAN_TITLE ? " · or type feedback" : " · or type what to do instead") : ""}`
    const explain = rich && state.approvalExplainFor === request.requestId && request.title !== PLAN_TITLE
      ? explainApproval({ tool: request.tool, permission: request.permission, mode: state.transcript.permissionMode, why: review.why, context: request.permissionContext, offer: ruleOffer(request), engineFlagged: request.engineFlagged }).flatMap((text) => wrapSpans([{ text, fg: "muted" }], room, [{ text: "  " }]))
      : undefined
    const model: ApprovalModel = {
      requestId: request.requestId,
      variant: rich ? "panel" : "inline",
      title: request.title,
      ...(request.tool ? { tool: request.tool } : {}),
      ...(request.permission ? { permission: request.permission } : {}),
      subject: request.title === "Save to memory?" ? request.detail : review.detail,
      detail,
      ...(explain ? { explain } : {}),
      options: approvalChoicesOf(request),
      choice: state.approvalChoice,
      hint,
      plan: request.title === PLAN_TITLE,
    }
    const drawn = ctx.views.draw("approval", model, { width, height: Math.max(8, input.screen.size.height - 4) })
    return { rows: drawn.lines, hits: panelHits(drawn.hits), kind: "approval" }
  }
  return { answerQuestion, questionKey, questionPaste, submitPlanDraft, toggleApprovalExplain, resolveRequest, pickApproval, pickQuestion, scrollApproval, pendingPanelRequest, requestPanel }
}
