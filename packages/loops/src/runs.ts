import type { Loop, LoopAudit, LoopCheckpoint, LoopGate, LoopRun, LoopRunTrigger, LoopState } from "@mendcode/protocol"
import { lastMarkedBlock } from "./marked-block"
import { nextWake, paceAfter } from "./schedule"

const HISTORY = 20

/** What the host knows about this wakeup beyond the loop itself. */
export type RunContext = {
  /** An external fire started this run; `note` is what the caller said happened. */
  fired?: { note?: string | undefined }
  /** The run works in this private git worktree, not the user's checkout. */
  worktreeBranch?: string
}

/**
 * The message a run sends to its session. It restates the contract every time, because
 * the session may have been compacted between wakeups.
 */
export function runPrompt(loop: Loop, run: number, context: RunContext = {}) {
  const budget =
    loop.budget.mode === "goal"
      ? `Goal loop: finish as soon as the goal is verified${loop.budget.maxRuns ? ` (safety cap ${loop.budget.maxRuns} runs)` : ""}.`
      : loop.budget.mode === "fixed"
        ? `Fixed loop: run ${run} of ${loop.budget.maxRuns}.`
        : "Monitor loop: do the objective for this wakeup; the schedule continues until the user stops it."
  return [
    `[loop "${loop.name}" · run ${run}]`,
    budget,
    "",
    `Objective:\n${loop.objective}`,
    ...(context.fired ? ["", `This run was fired from outside${context.fired.note ? `: ${context.fired.note}` : "."}`] : []),
    ...(loop.reportOnly ? ["", "Report-only loop: you can read and search but cannot edit files or run commands. Report what you found and what you would change; do not try to change anything, and do not use plan_submit."] : []),
    ...(context.worktreeBranch ? ["", `You are in a private git worktree of the project (branch ${context.worktreeBranch}), not the user's checkout. Edit freely here; if you change files, commit them on this branch so the work can be reviewed and merged. Never touch the user's checkout.`] : []),
    ...(loop.costBudget ? ["", `Usage caps: ${JSON.stringify(loop.costBudget)}. Used: ${JSON.stringify(loop.usage ?? { tokens: 0, costMicros: 0, unknownCostCalls: 0 })}.`] : []),
    ...(loop.rubric ? ["", `Runtime rubric: ${JSON.stringify(loop.rubric)}. Scores are computed by the host from evidence, not by you.`] : []),
    ...(loop.approvalPolicy?.requireApprovalFor.length ? ["", `Actions requiring user approval: ${loop.approvalPolicy.requireApprovalFor.join(", ")}. Request permission before acting; reporting an action is not approval.`] : []),
    ...(loop.criteria ? ["", `Done when:\n${loop.criteria}`] : []),
    ...(loop.checks?.length ? ["", `The host runs these checks when you report complete; all must pass:\n${loop.checks.map((check) => `- ${check}`).join("\n")}`] : []),
    ...(loop.feedback ? ["", `Your last completion claim was rejected. Fix this before claiming complete again:\n${loop.feedback}`] : []),
    "",
    "Work on it now. End your final message with this block, filled in:",
    "```LOOP_CHECKPOINT",
    "status: complete | continue | blocked",
    "summary: <what you did and found in this run>",
    "next: <what the next run should do>",
    ...(loop.rubric || loop.approvalPolicy ? ['evidence: ["file:line or observed check output", "other concrete evidence"]'] : []),
    ...(loop.trigger?.kind === "adaptive" ? ["activity: idle | acted (idle = you found nothing to do; acted = you changed, fixed or reported something new)"] : []),
    "```",
    "Use complete only when the objective (or its done-when criteria) is verified; blocked when you cannot proceed without the user.",
  ].join("\n")
}

/** Reads the last LOOP_CHECKPOINT block of a message; tolerant of spacing and missing `next`. */
export function parseCheckpoint(text: string): LoopCheckpoint | undefined {
  const body = lastMarkedBlock(text, "LOOP_CHECKPOINT")
  if (!body) return undefined
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im").exec(body)?.[1]?.trim()
  const status = field("status")?.toLowerCase()
  if (status !== "complete" && status !== "continue" && status !== "blocked") return undefined
  const next = field("next")
  const rawEvidence = field("evidence")
  let evidence: string[] | undefined
  if (rawEvidence) {
    try {
      const value: unknown = JSON.parse(rawEvidence)
      if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) evidence = value.slice(0, 10).map((item: string) => item.slice(0, 1_000))
    } catch {}
  }
  const activity = /^(idle|acted)\b/.exec(field("activity")?.toLowerCase() ?? "")?.[1] as "idle" | "acted" | undefined
  return { status, summary: (field("summary") ?? "").slice(0, 2_000), ...(evidence ? { evidence } : {}), ...(next ? { next: next.slice(0, 1_000) } : {}), ...(activity ? { activity } : {}) }
}

export type RunEnd = { outcome: NonNullable<LoopRun["outcome"]>; finalText: string; at: number }

/**
 * Applies a finished run to the loop: records it, then decides the next state and wakeup from the
 * budget and the checkpoint. A run without a checkpoint counts as "continue" for monitors and fixed
 * loops, but a goal loop never completes without an explicit `complete`.
 */
export function finishRun(loop: Loop, end: RunEnd): Loop {
  const checkpoint = end.outcome === "completed" ? parseCheckpoint(end.finalText) : undefined
  const history = [...loop.history]
  const current = history.at(-1)
  if (current && current.endedAt === undefined) history[history.length - 1] = { ...current, endedAt: end.at, outcome: end.outcome, ...(checkpoint ? { checkpoint } : {}) }
  // The run has seen the feedback of the previous rejection; a new one replaces it if this claim fails too.
  const { feedback: _seen, ...unfed } = loop
  const base = { ...unfed, history: history.slice(-HISTORY), updatedAt: end.at }
  const stop = (state: LoopState, reason: string) => {
    const { nextWakeAt: _drop, pendingFire: _fire, ...rest } = base
    return { ...rest, state, reason }
  }

  if (loop.state === "stopped" || loop.state === "paused") return { ...base, state: loop.state }
  if (end.outcome === "cancelled") return stop("paused", "run cancelled by the user")
  if (checkpoint?.status === "blocked") return stop("blocked", checkpoint.summary || "the run reported it is blocked")
  if (loop.budget.mode === "goal" && checkpoint?.status === "complete")
    return needsVerification(loop) ? stop("verifying", "checking the completion claim") : stop("completed", checkpoint.summary || "goal verified")
  const cap = loop.budget.mode === "monitor" ? undefined : loop.budget.maxRuns
  if (cap !== undefined && loop.runs >= cap)
    return loop.budget.mode === "fixed" ? stop("completed", `${cap} runs done`) : stop("blocked", `safety cap of ${cap} runs reached without a verified goal`)
  // An adaptive loop's pace follows what this run reported; a fire that arrived meanwhile runs as soon as the loop is free.
  const adaptiveMs = loop.trigger.kind === "adaptive" ? paceAfter(loop.trigger, loop.adaptiveMs, checkpoint?.activity) : undefined
  const next = loop.pendingFire ? end.at : nextWake(loop.trigger, end.at, { adaptiveMs })
  return { ...base, ...(adaptiveMs !== undefined ? { adaptiveMs } : {}), state: "active", ...(next !== undefined ? { nextWakeAt: next } : {}), ...(end.outcome === "failed" ? { reason: "last run failed" } : {}) }
}

/** A completion claim is verified when the loop has host checks or an independent audit. */
export function needsVerification(loop: Loop) {
  return (loop.checks?.length ?? 0) > 0 || loop.audit === "independent" || !!loop.rubric
}

/**
 * Applies the verification of a completion claim: records gates and audit on the claiming run, then
 * completes the loop or sends it back to work with `feedback`. Running out of runs after a rejection blocks it.
 */
export function finishVerification(loop: Loop, result: { gates: LoopGate[]; audit?: LoopAudit; accepted: boolean; feedback?: string; at: number }): Loop {
  const history = [...loop.history]
  const claim = history.at(-1)
  if (claim) history[history.length - 1] = { ...claim, ...(result.gates.length ? { gates: result.gates } : {}), ...(result.audit ? { audit: result.audit } : {}) }
  const { nextWakeAt: _drop, reason: _reason, ...rest } = loop
  const base = { ...rest, history, updatedAt: result.at }
  if (loop.state !== "verifying") return { ...base, state: loop.state }
  if (result.accepted) return { ...base, state: "completed", reason: claim?.checkpoint?.summary || "goal verified" }
  const feedback = (result.feedback ?? "").slice(0, 4_000)
  const cap = loop.budget.mode === "goal" ? loop.budget.maxRuns : undefined
  if (cap !== undefined && loop.runs >= cap) return { ...base, state: "blocked", reason: `safety cap of ${cap} runs reached; last claim rejected`, ...(feedback ? { feedback } : {}) }
  const next = loop.pendingFire ? result.at : nextWake(loop.trigger, result.at, loop)
  return { ...base, state: "active", reason: "completion claim rejected", ...(feedback ? { feedback } : {}), ...(next !== undefined ? { nextWakeAt: next } : {}) }
}

/** Starts a run: counts it, clears the wakeup (and a pending fire, which this run answers) and records the start. */
export function beginRun(loop: Loop, at: number, how: { trigger?: LoopRunTrigger; sessionId?: LoopRun["sessionId"]; worktree?: LoopRun["worktree"] } = {}): Loop {
  const run = loop.runs + 1
  const { nextWakeAt: _drop, reason: _reason, pendingFire: _fire, ...rest } = loop
  const entry: LoopRun = { run, startedAt: at, ...(how.trigger ? { trigger: how.trigger } : {}), ...(how.sessionId ? { sessionId: how.sessionId } : {}), ...(how.worktree ? { worktree: how.worktree } : {}) }
  return { ...rest, state: "running", runs: run, history: [...loop.history, entry].slice(-HISTORY), updatedAt: at }
}
