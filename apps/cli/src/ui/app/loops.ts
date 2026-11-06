import { createLoopsPageState, parseLoopCommand } from "../lazy-pages"
import type { LoopsPageAction } from "../../view/loops-page"
import type { LoopTemplateInfo } from "@mendcode/protocol"
import type { Loop, LoopId, PermissionMode, RequestId, SessionId } from "@mendcode/protocol"
import type { LoopControlAction } from "../../view/loops-page"
import type { LoopParse } from "../../view/loop-command"
import type { AppContext } from "./context"

/** A loop in one of these states counts in the row under the prompt (v1's `↻ N loops`). */
const LIVE_LOOP_STATES = new Set(["active", "running", "needs_input", "verifying"])

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, smart: 2, edits: 3, full: 4 }
const MODE_WORDS = new Set<string>(["ask", "smart", "edits", "full"])
/** The mode as the confirmation line says it (short: the line shares its row with the keys). */
const MODE_NAME: Record<PermissionMode, string> = { ask: "ask", smart: "smart", edits: "edits", full: "full access", plan: "plan" }
/** How long a phrase waits for its confirmation before the line goes away (the draft itself stays until something else is typed). */
const DRAFT_MS = 120_000

/** A `/loop` written as a phrase, shown as one line until the user starts it (enter), edits it (`e`) or lowers its mode (a mode word). */
export type LoopDraft = { parsed: Extract<LoopParse, { ok: true }>; permission: PermissionMode }

export function createLoops(ctx: AppContext, actions: { switchSession(sessionId: SessionId): Promise<unknown> | unknown }) {
  const { input, state, requestFrame, fail, say, report, editor, permissionLabels } = ctx

  async function loadLoops() {
    const reply = await input.send({ type: "loop.list", ...(state.loopsState.scope === "project" ? { directory: input.directory ?? "" } : {}) })
    if (reply.ok) {
      state.loops = (reply.result?.loops ?? []) as Loop[]
      state.loopsLoaded = true
      state.loopsError = ""
      state.loopsState = { ...state.loopsState, selected: Math.max(0, Math.min(state.loopsState.selected, state.loops.length - 1)) }
      if (!state.loopsState.templates) void loadLoopTemplates()
    } else state.loopsError = reply.error.message
    requestFrame()
  }

  /** The built-in templates for the loops form; without an answer the form uses the ones in docs/loops.md. */
  async function loadLoopTemplates() {
    const reply = await input.send({ type: "loop.templates" })
    if (!reply.ok) return
    state.loopsState = { ...state.loopsState, templates: (reply.result?.templates ?? []) as LoopTemplateInfo[] }
    requestFrame()
  }

  /** Save in place when editing; a refusal restores the form with what was typed. */
  async function saveLoop(action: Extract<LoopsPageAction, { type: "save" }>) {
    const reply = await input.send(action.replaces
      ? { type: "loop.update", loopId: action.replaces.loopId as LoopId, ...action.fields }
      : { type: "loop.create", directory: input.directory ?? "", ...action.fields })
    if (!reply.ok) {
      state.loopsState = { ...state.loopsState, form: action.form }
      return fail(reply.error.message)
    }
    say(`loop ${action.replaces ? "saved" : "created"} · ${action.summary}`, "success")
    state.loopsLoaded = false
    await loadLoops()
  }

  async function fireLoop(loopId: string) {
    const reply = await input.send({ type: "loop.fire", loopId: loopId as LoopId })
    report(reply)
    if (reply.ok) say("loop fired", "success")
    requestFrame()
  }

  /** Answers the tool permission a loop's session waits on, from /loops (`a` once, `o` for the loop's session, `x` refuse). */
  async function resolveLoopRequest(action: Extract<LoopsPageAction, { type: "resolve" }>) {
    const reply = await input.send({ type: "request.resolve", sessionId: action.sessionId as SessionId, requestId: action.requestId as RequestId, decision: action.decision === "deny" ? { kind: "deny" } : { kind: "approve", scope: action.decision } })
    report(reply)
    if (reply.ok) say(action.decision === "deny" ? "refused" : action.decision === "once" ? "allowed once" : "allowed for the loop's session", "success")
    requestFrame()
  }

  /** Lowers the permission mode of a loop's runs (the daemon refuses to go above its creator's). */
  async function setLoopMode(loopId: string, permission: PermissionMode) {
    const reply = await input.send({ type: "loop.update", loopId: loopId as LoopId, permission })
    report(reply)
    if (reply.ok) say(`loop runs now with ${permissionLabels[permission]}`, "success")
    requestFrame()
  }

  async function controlLoop(loopId: string, action: LoopControlAction) {
    const reply = await input.send({ type: "loop.control", loopId: loopId as LoopId, action })
    report(reply)
    if (reply.ok && action === "delete") state.loops = state.loops.filter((loop) => loop.loopId !== loopId)
    requestFrame()
  }

  async function createLoop(args: string) {
    const review = /^(accept|waive|approve)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim())
    if (review) {
      const loop = state.loops.find((entry) => entry.loopId === review[2])
      const run = loop?.history.at(-1)
      const action = review[1] as "accept" | "waive" | "approve"
      let reason = review[3]?.trim() ?? ""
      let target: string | undefined
      if (action !== "accept") {
        const match = /^("(?:[^"\\]|\\.)*"|\S+)\s+([\s\S]+)$/.exec(reason)
        if (!match) return fail(`usage: /loop ${action} <id> <target> <reason>`)
        try { target = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1] }
        catch { return fail("review target has invalid quoting") }
        reason = match[2]!.trim()
      }
      if (!reason) return fail("review needs a reason")
      const reply = run?.checkpointHash
        ? await input.send({ type: "loop.review", loopId: review[2] as LoopId, action, run: run.run, checkpointHash: run.checkpointHash, reviewer: "user", reason: reason.slice(0, 500), ...(action === "waive" && target ? { gateId: target } : {}), ...(action === "approve" && target ? { approvalAction: target as "push" | "merge" | "deploy" | "publish" | "delete" } : {}) })
        : action === "accept" ? await input.send({ type: "loop.control", loopId: review[2] as LoopId, action: "accept", reason: reason.slice(0, 500) }) : { ok: false as const, error: { message: "reload /loops to review the current checkpoint" } }
      if (reply.ok) say(`loop ${action === "accept" ? "accepted" : action === "approve" ? "approval recorded" : "gate waived"}`, "success")
      else fail(reply.error.message)
      return
    }
    const opening = /^open\s+(\S+)$/i.exec(args.trim())
    if (opening) return openLoopSession(opening[1]!)
    let parsed = parseLoopCommand(args)
    // A schedule the local parser does not know: the small role turns the phrase into a trigger and an objective.
    if (!parsed.ok && parsed.interpret) {
      state.notice = "reading the schedule…"
      requestFrame()
      const asked = await input.send({ type: "loop.interpret", text: parsed.interpret, ...(input.directory ? { directory: input.directory } : {}) })
      if (!asked.ok) {
        state.notice = asked.error.message.replace(/^\[[A-Z]+\]: /, "")
        return requestFrame()
      }
      const read = asked.result as { trigger: string; objective: string }
      const strict = `${read.trigger} ${read.objective}`
      const again = parseLoopCommand(strict)
      parsed = again.ok ? { ...again, natural: true, strict } : again
    }
    if (!parsed.ok) {
      state.notice = parsed.error
      return
    }
    const permission = state.transcript.permissionMode
    if (parsed.natural) {
      state.loopDraft = { parsed, permission }
      showDraft(state.loopDraft)
      return requestFrame()
    }
    await startLoop(parsed, permission)
  }

  /** The one line a phrase waits behind: when, with what permission, doing what; the keys stay visible (the hint) when the line is cut. */
  function showDraft({ parsed, permission }: LoopDraft) {
    const objective = parsed.spec.objective.replace(/\s+/g, " ")
    say(`loop: ${parsed.when} · ${MODE_NAME[permission]} · ${objective.length > 60 ? `${objective.slice(0, 59)}…` : objective}`, "info", { hint: "enter start · e edit", oneLine: true, ms: DRAFT_MS })
  }

  /** Enter starts the pending phrase, `e` puts it back in the prompt in the strict form, a mode word lowers its permission; anything else drops it. */
  async function confirmLoopDraft(text: string): Promise<boolean> {
    const draft = state.loopDraft
    if (!draft) return false
    const word = text.trim().toLowerCase()
    if (!word) {
      state.loopDraft = undefined
      await startLoop(draft.parsed, draft.permission)
      return true
    }
    if (word === "e") {
      state.loopDraft = undefined
      editor.replaceAll(`/loop ${draft.parsed.strict ?? draft.parsed.spec.objective}`)
      say("edit it and press enter", "info", { oneLine: true, ms: 3_000 })
      requestFrame()
      return true
    }
    if (MODE_WORDS.has(word) && MODE_RANK[word as PermissionMode] <= MODE_RANK[state.transcript.permissionMode]) {
      state.loopDraft = { ...draft, permission: word as PermissionMode }
      showDraft(state.loopDraft)
      editor.clear()
      requestFrame()
      return true
    }
    // Anything else is a new message: the loop is not started.
    state.loopDraft = undefined
    say("loop not started", "info", { oneLine: true, ms: 2_500 })
    return false
  }

  /** Opens the session of a loop (`/loop open <loop id>`, the link a run's notice carries) or any session id. */
  async function openLoopSession(id: string) {
    if (id.startsWith("ses_")) return void (await actions.switchSession(id as SessionId))
    if (!state.loops.some((loop) => loop.loopId === id)) await loadLiveLoops()
    const loop = state.loops.find((entry) => entry.loopId === id)
    if (!loop) return fail(`no loop ${id} in this project`)
    state.page = "chat"
    await actions.switchSession(loop.sessionId)
  }

  /** Creates the loop; it starts with the permission mode of the session that typed `/loop` (the daemon never gives it more). */
  async function startLoop(parsed: Extract<LoopParse, { ok: true }>, permission: PermissionMode) {
    const { spec } = parsed
    const reply = await input.send({
      type: "loop.create",
      name: spec.name,
      directory: input.directory ?? "",
      ...(state.sessionId ? { creatorSessionId: state.sessionId } : {}),
      permission,
      objective: spec.objective,
      ...(spec.criteria ? { criteria: spec.criteria } : {}),
      trigger: spec.trigger,
      budget: spec.budget,
      ...(spec.costBudget ? { costBudget: spec.costBudget } : {}),
      ...(spec.approvalPolicy ? { approvalPolicy: spec.approvalPolicy } : {}),
      ...(spec.runNow ? { runNow: true } : {}),
      ...(spec.checks ? { checks: spec.checks } : {}),
      ...(spec.audit ? { audit: spec.audit } : {}),
    })
    if (!reply.ok) {
      fail(reply.error.message)
      return
    }
    say(`loop: ${parsed.when} · ${permissionLabels[permission]} · ${parsed.budgetText}`, "success")
    state.page = "loops"
    state.loopsState = createLoopsPageState()
    state.loopsLoaded = false
    requestFrame()
    await loadLoops()
  }

  /** Loops in a live state for this project: asked once at start, then kept by `loop.changed`. */
  async function loadLiveLoops() {
    const reply = await input.send({ type: "loop.list", ...(input.directory ? { directory: input.directory } : {}) })
    for (const loop of ((reply.ok ? reply.result?.loops : undefined) ?? []) as Loop[]) noteLoop(loop, false)
    requestFrame()
  }

  function noteLoop(loop: Loop, deleted: boolean) {
    if (input.directory && loop.directory !== input.directory) return
    state.loops = [...state.loops.filter((existing) => existing.loopId !== loop.loopId), ...(deleted ? [] : [loop])]
    if (!deleted && LIVE_LOOP_STATES.has(loop.state)) state.liveLoops.add(loop.loopId)
    else state.liveLoops.delete(loop.loopId)
  }

  return { loadLoops, saveLoop, fireLoop, resolveLoopRequest, setLoopMode, confirmLoopDraft, controlLoop, createLoop, loadLiveLoops, noteLoop }
}
