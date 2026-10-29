import { createLoopsPageState, parseLoopCommand } from "../lazy-pages"
import type { LoopsPageAction } from "../../view/loops-page"
import type { LoopTemplateInfo } from "@mendcode/protocol"
import type { Loop, LoopId } from "@mendcode/protocol"
import type { LoopControlAction } from "../../view/loops-page"
import type { AppContext } from "./context"

/** A loop in one of these states counts in the row under the prompt (v1's `↻ N loops`). */
const LIVE_LOOP_STATES = new Set(["active", "running", "needs_input", "verifying"])

export function createLoops(ctx: AppContext) {
  const { input, state, requestFrame, fail, say, report } = ctx

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
    const parsed = parseLoopCommand(args)
    if (!parsed.ok) {
      state.notice = parsed.error
      return
    }
    const { spec } = parsed
    const reply = await input.send({
      type: "loop.create",
      name: spec.name,
      directory: input.directory ?? "",
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
    say(parsed.summary, "success")
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

  return { loadLoops, saveLoop, fireLoop, controlLoop, createLoop, loadLiveLoops, noteLoop }
}
