import type { LoopGate, SessionId, WorkflowContract, WorkflowFailureClass, WorkflowId, WorkflowPlan, WorkflowRetryPolicy, WorkflowRun, WorkflowRunState, WorkflowTask, WorkflowVerification } from "@mendcode/protocol"
import { barrierSatisfied, compositionBytes, expandedTasks, outputValue, phaseReady, taskSpec, taskTerminal } from "./composition"

/**
 * The single run reducer (§3.3): every workflow state change is one pure function here, and the run state is derived
 * in one place (`deriveWorkflowState`). The service only feeds events in and acts on what comes out.
 */

/** Automatic starts of a task before an interruption counts as a failure. */
export const MAX_AUTO_ATTEMPTS = 3
export const DEFAULT_MAX_CONCURRENT = 2
const MAX_RESULT = 1_500
const MAX_REASON = 500
const MAX_FEEDBACK = 4_000
const MAX_VERIFICATIONS = 6

/** States only a user action or the contract sets; tasks finishing never change them. */
const STICKY: ReadonlySet<WorkflowRunState> = new Set(["paused", "stopped", "blocked", "completed", "queued"])
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function createRun(input: { workflowId: WorkflowId; plan: WorkflowPlan; planHash: string; directory: string; permission: WorkflowRun["permission"]; rootSessionId: SessionId; originSessionId?: SessionId; at: number }): WorkflowRun {
  const tasks: WorkflowTask[] = input.plan.tasks.map((spec) => ({ id: spec.id, title: spec.title, kind: spec.kind, ...(spec.kind === "agent" ? { mode: spec.mode } : {}), ...(input.plan.phases?.find((phase) => phase.tasks.includes(spec.id)) ? { phaseId: input.plan.phases.find((phase) => phase.tasks.includes(spec.id))!.id } : {}), needs: [...spec.needs], state: "pending", attempt: 0 }))
  return {
    workflowId: input.workflowId,
    name: input.plan.name,
    directory: input.directory,
    objective: input.plan.objective,
    plan: input.plan,
    planHash: input.planHash,
    permission: input.permission,
    state: "running",
    rootSessionId: input.rootSessionId,
    ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
    tasks,
    verifications: [],
    repairs: 0,
    startedAt: input.at,
    updatedAt: input.at,
    ...(input.plan.script ? { script: { host: "idle" as const, calls: 0, logCount: 0, logs: [], starts: 0 } } : {}),
  }
}

/** The run state of a script run: the script's host decides whether more tasks can still come. */
function deriveScriptState(run: WorkflowRun): WorkflowRunState {
  if (run.script?.host === "failed") return "failed"
  const tasks = run.tasks
  if (tasks.some((task) => task.state === "needs_input")) return "needs_input"
  if (run.script?.host !== "done") return "running"
  if (tasks.some((task) => task.state === "running" || task.state === "pending")) return "running"
  return contractOf(run) ? "verifying" : "completed"
}

/** The run state from its tasks, unless a user action or the contract fixed it. */
export function deriveWorkflowState(run: WorkflowRun): WorkflowRunState {
  if (STICKY.has(run.state)) return run.state
  if (run.script) return deriveScriptState(run)
  const tasks = run.tasks.filter((task) => !task.mapRetired)
  const states = new Set(tasks.map((task) => task.state))
  if (states.has("needs_input")) return "needs_input"
  if (states.has("running") || run.tasks.some((task) => task.state === "pending" && needsDone(run, task) && phaseReady(run, task))) return "running"
  if (run.plan.phases && run.tasks.every(taskTerminal)) return run.plan.phases.every((phase) => barrierSatisfied(run, phase)) ? contractOf(run) ? "verifying" : "completed" : "failed"
  if (run.state === "verifying" && tasks.every((task) => task.state === "done")) return "verifying"
  if (states.has("failed") || states.has("skipped") || states.has("stopped")) return "failed"
  if (tasks.every((task) => task.state === "done")) return contractOf(run) ? "verifying" : "completed"
  return "running"
}

/** The inlined contract (resolved at start), if the plan has one. */
export function contractOf(run: WorkflowRun): WorkflowContract | undefined {
  return typeof run.plan.contract === "object" ? run.plan.contract : undefined
}

const needsDone = (run: WorkflowRun, task: WorkflowTask) => task.needs.every((id) => run.tasks.find((other) => other.id === id)?.state === "done")

/** Recomputes the run state after a change; `completed`/terminal states record when the run ended. */
export function settle(run: WorkflowRun, at: number): WorkflowRun {
  const withSkips = cascadeSkips(run)
  const state = deriveWorkflowState(withSkips)
  const ended = state === "completed" || state === "failed" || state === "stopped"
  const { endedAt: _endedAt, ...rest } = withSkips
  return { ...rest, state, updatedAt: at, ...(ended ? { endedAt: withSkips.endedAt ?? at } : {}) }
}

/** Pending tasks whose need failed, was skipped or stopped become skipped (transitively). */
function cascadeSkips(run: WorkflowRun): WorkflowRun {
  let tasks = run.tasks
  for (let changed = true; changed; ) {
    changed = false
    tasks = tasks.map((task) => {
      if (task.state !== "pending") return task
      const dead = task.needs.find((id) => ["failed", "skipped", "stopped"].includes(tasks.find((other) => other.id === id)?.state ?? ""))
      const phaseIndex = run.plan.phases?.findIndex((phase) => phase.tasks.includes(task.mapParentId ?? task.id)) ?? -1
      const blocked = run.plan.phases?.slice(0, Math.max(0, phaseIndex)).find((phase) => {
        const current = { ...run, tasks }
        if (barrierSatisfied(current, phase)) return false
        const members = tasks.filter((entry) => phase.tasks.includes(entry.id))
        if (phase.barrier.kind === "quorum") return members.filter((entry) => entry.state === "done" || !taskTerminal(entry)).length < phase.barrier.quorum
        if (phase.barrier.kind === "best-effort") return false
        return members.every(taskTerminal) || members.some((entry) => ["failed", "skipped", "stopped"].includes(entry.state))
      })
      if (!dead && !blocked) return task
      changed = true
      return { ...task, state: "skipped", reason: dead ? `needs ${dead}, which did not finish` : `phase ${blocked!.id} barrier was not met` }
    })
  }
  return { ...run, tasks }
}

function withTask(run: WorkflowRun, taskId: string, change: (task: WorkflowTask) => WorkflowTask): WorkflowRun {
  if (!run.tasks.some((task) => task.id === taskId)) throw new RangeError(`[WORKFLOWS]: unknown task ${taskId}`)
  return { ...run, tasks: run.tasks.map((task) => (task.id === taskId ? change(task) : task)) }
}

/**
 * Tasks that may start now, in plan order: pending with every need done, while the run is running, under the
 * concurrency cap, and at most one `work` task editing the directory (`directoryBusy`: another live workflow's).
 */
export function readyTasks(run: WorkflowRun, directoryBusy = false, now?: number): string[] {
  if (run.state !== "running" && run.state !== "needs_input") return []
  const cap = run.plan.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  // Map parents and human tasks hold no session or process, so they never use a slot.
  const slotless = (task: WorkflowTask) => task.kind === "map" || task.kind === "human"
  const active = run.tasks.filter((task) => !slotless(task) && (task.state === "running" || task.state === "needs_input"))
  let slots = cap - active.length
  // A task in its own worktree does not edit the directory, so it neither takes nor waits for the single-writer slot.
  let workBusy = directoryBusy || active.some((task) => task.mode === "work" && !task.isolated)
  const ready: string[] = []
  for (const task of run.tasks) {
    if (slots <= 0 && !slotless(task)) continue
    if (task.state !== "pending" || !needsDone(run, task) || !phaseReady(run, task)) continue
    if (now !== undefined && task.retryAt !== undefined && task.retryAt > now) continue
    if (task.mode === "work" && !task.isolated) {
      if (workBusy) continue
      workBusy = true
    }
    ready.push(task.id)
    if (!slotless(task)) slots--
  }
  return ready
}

/** The earliest time a pending task leaves its retry backoff, if any waits (the service arms one timer for it). */
export function nextRetryAt(run: WorkflowRun): number | undefined {
  const times = run.tasks.filter((task) => task.state === "pending" && task.retryAt !== undefined).map((task) => task.retryAt!)
  return times.length ? Math.min(...times) : undefined
}

/** A task starts (automatically, on retry or for a repair); its rework note is consumed by this start. */
export function startTask(run: WorkflowRun, taskId: string, input: { at: number; sessionId?: SessionId }): WorkflowRun {
  if (!readyTasks(run).includes(taskId)) throw new RangeError(`[WORKFLOWS]: task ${taskId} is not ready`)
  const started = withTask(run, taskId, (task) => {
    const { feedback: _feedback, reason: _reason, result: _result, output: _output, endedAt: _endedAt, latest: _latest, retryAt: _retryAt, ...rest } = task
    return { ...rest, state: "running", attempt: Math.min(6, task.attempt + 1), startedAt: input.at, ...(input.sessionId ?? task.sessionId ? { sessionId: input.sessionId ?? task.sessionId } : {}) }
  })
  return settle(started, input.at)
}

/** A human task starts by waiting: it is `needs_input` at once and stays so until `answerHuman` (or a manual retry asks again). */
export function startHuman(run: WorkflowRun, taskId: string, prompt: string, at: number): WorkflowRun {
  return setLatest(setWaiting(startTask(run, taskId, { at }), taskId, true, at), taskId, prompt.replace(/\s+/g, " "))
}

/** The user's answer to a waiting human task: approve completes it (the note is its text output), reject fails it. */
export function answerHuman(run: WorkflowRun, taskId: string, decision: "approve" | "reject", note: string | undefined, at: number): WorkflowRun {
  const task = run.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new RangeError(`[WORKFLOWS]: unknown task ${taskId}`)
  if (task.kind !== "human") throw new RangeError(`[WORKFLOWS]: task ${taskId} is not a human task`)
  if (task.state !== "needs_input") throw new RangeError(`[WORKFLOWS]: task ${taskId} is ${task.state}, not waiting for you`)
  const text = note?.trim()
  if (decision === "reject") return finishTask(run, taskId, { outcome: "failed", reason: text ? `rejected: ${text}` : "rejected by the user", failure: "terminal", at })
  return finishTask(run, taskId, { outcome: "done", result: text || "approved", ...(text ? { output: { kind: "text" as const, value: text } } : {}), at })
}

/** The task's session opened or resolved a request: the only source of `needs_input` (W-I1). */
export function setWaiting(run: WorkflowRun, taskId: string, waiting: boolean, at: number): WorkflowRun {
  const task = run.tasks.find((candidate) => candidate.id === taskId)
  if (!task || (task.state !== "running" && task.state !== "needs_input")) return run
  const next = waiting ? "needs_input" : "running"
  if (task.state === next) return run
  return settle(withTask(run, taskId, (current) => ({ ...current, state: next })), at)
}

/** Title of the tool the task is running, for display. */
export function setLatest(run: WorkflowRun, taskId: string, latest: string | undefined): WorkflowRun {
  return withTask(run, taskId, (task) => {
    const { latest: _latest, ...rest } = task
    return latest ? { ...rest, latest: clip(latest, 120) } : rest
  })
}

export type TaskEnd =
  | { outcome: "done"; result: string; output?: WorkflowTask["output"] }
  | { outcome: "failed"; reason: string; failure?: WorkflowFailureClass }
  /** Transient failure or daemon restart: back to pending while automatic attempts remain. */
  | { outcome: "interrupted"; reason: string }
  /** The user cancelled the task's turn: the task stops and the run pauses (nothing resumes by itself). */
  | { outcome: "cancelled" }

/** The task's retry policy: agent and check tasks, and a map's children through its template. */
export function retryPolicy(run: WorkflowRun, taskId: string): WorkflowRetryPolicy | undefined {
  const spec = taskSpec(run, taskId)
  return spec && (spec.kind === "agent" || spec.kind === "check") ? spec.retry : undefined
}

export function finishTask(run: WorkflowRun, taskId: string, end: TaskEnd & { at: number }): WorkflowRun {
  const task = run.tasks.find((candidate) => candidate.id === taskId)
  if (!task || (task.state !== "running" && task.state !== "needs_input")) return run
  const base = (() => {
    const { latest: _latest, ...rest } = task
    return rest
  })()
  let next: WorkflowTask
  if (end.outcome === "done") next = { ...base, state: "done", endedAt: end.at, result: clip(end.result, MAX_RESULT), ...(end.output ? { output: end.output } : {}) }
  else if (end.outcome === "failed") {
    const retry = retryPolicy(run, taskId)
    const failure = end.failure ?? "terminal"
    if (retry && failure !== "budget" && task.attempt < retry.maxAttempts && retry.retryOn.includes(failure))
      next = { ...base, state: "pending", reason: clip(`retrying after ${failure} failure: ${end.reason}`, MAX_REASON), ...(retry.backoffMs > 0 ? { retryAt: end.at + retry.backoffMs } : {}) }
    else next = { ...base, state: "failed", endedAt: end.at, reason: clip(end.reason, MAX_REASON) }
  } else if (end.outcome === "interrupted")
    next = task.attempt < MAX_AUTO_ATTEMPTS ? { ...base, state: "pending", reason: clip(end.reason, MAX_REASON) } : { ...base, state: "failed", endedAt: end.at, reason: clip(`interrupted: ${end.reason}`, MAX_REASON) }
  else next = { ...base, state: "stopped", endedAt: end.at, reason: "cancelled by the user" }
  if (compositionBytes(run.tasks.map((entry) => entry.id === taskId ? next : entry)) > 24 * 1024) next = { ...base, state: "failed", endedAt: end.at, reason: "workflow output storage exceeds 24 KiB" }
  const updated = withTask(run, taskId, () => next)
  return settle(end.outcome === "cancelled" && !STICKY.has(run.state) ? { ...updated, state: "paused", reason: `task ${taskId} was cancelled` } : updated, end.at)
}

/** Every task that needs `ids`, directly or through other tasks. */
export function dependents(run: WorkflowRun, ids: readonly string[]): Set<string> {
  const out = new Set(ids)
  for (let grew = true; grew; ) {
    grew = false
    for (const task of run.tasks)
      if (!out.has(task.id) && (task.needs.some((id) => out.has(id)) || task.mapParentId && out.has(task.mapParentId))) {
        out.add(task.id)
        grew = true
      }
  }
  return out
}

/** Puts tasks and their dependents back to pending; attempts, sessions and past verifications stay. */
function reopen(run: WorkflowRun, ids: readonly string[], feedback?: string): WorkflowRun {
  const affected = dependents(run, ids)
  const earliest = run.plan.phases?.findIndex((phase) => phase.tasks.some((id) => affected.has(id))) ?? -1
  for (const phase of run.plan.phases?.slice(earliest >= 0 ? earliest + 1 : Infinity) ?? []) for (const task of run.tasks) if (phase.tasks.includes(task.mapParentId ?? task.id)) affected.add(task.id)
  return {
    ...run,
    tasks: run.tasks.map((task) => {
      if (!affected.has(task.id)) return task
      const { reason: _reason, result: _result, output: _output, expanded: _expanded, endedAt: _endedAt, latest: _latest, feedback: _feedback, retryAt: _retryAt, ...rest } = task
      return { ...rest, state: "pending", ...(feedback && ids.includes(task.id) ? { feedback: clip(feedback, MAX_FEEDBACK) } : {}) }
    }),
  }
}

/** Manual retry of a failed, skipped, stopped or input-waiting task and its dependents. Refused while verifying or when finished. */
export function retryTask(run: WorkflowRun, taskId: string, at: number, reason?: string): WorkflowRun {
  const task = run.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new RangeError(`[WORKFLOWS]: unknown task ${taskId}`)
  if (!["failed", "skipped", "stopped", "needs_input"].includes(task.state)) throw new RangeError(`[WORKFLOWS]: task ${taskId} is ${task.state}, not retryable`)
  if (run.state === "verifying" || run.state === "completed" || run.state === "stopped") throw new RangeError(`[WORKFLOWS]: cannot retry while the run is ${run.state}`)
  const { reason: _reason, endedAt: _endedAt, ...rest } = reopen(run, [task.mapParentId ?? taskId], reason)
  return settle({ ...rest, state: "running" }, at)
}

/** Reopen the whole phase atomically, retaining attempts and invalidating later outputs. */
export function retryPhase(run: WorkflowRun, phaseId: string, at: number, reason?: string): WorkflowRun {
  const phase = run.plan.phases?.find((entry) => entry.id === phaseId)
  if (!phase) throw new RangeError(`[WORKFLOWS]: unknown phase ${phaseId}`)
  if (["verifying", "completed", "stopped"].includes(run.state)) throw new RangeError(`[WORKFLOWS]: cannot retry while the run is ${run.state}`)
  const tasks = run.tasks.filter((task) => phase.tasks.includes(task.mapParentId ?? task.id))
  if (!tasks.some((task) => ["failed", "skipped", "stopped", "needs_input"].includes(task.state))) throw new RangeError(`[WORKFLOWS]: phase ${phaseId} is not retryable`)
  const { reason: _reason, endedAt: _endedAt, ...rest } = reopen(run, phase.tasks, reason)
  return settle({ ...rest, state: "running" }, at)
}

export type Control = "pause" | "resume" | "stop"

/**
 * pause = drain (no new tasks; running ones finish) · resume = continue, or re-verify a blocked run · stop = the run
 * ends and its running tasks are stopped (the service cancels their turns by id).
 */
export function controlRun(run: WorkflowRun, action: Control, at: number): WorkflowRun {
  if (run.state === "completed" || run.state === "stopped") return run
  if (action === "pause") return { ...run, state: "paused", reason: "paused by the user", updatedAt: at }
  if (action === "stop") {
    const tasks = run.tasks.map((task): WorkflowTask => (task.state === "running" || task.state === "needs_input" || task.state === "pending" ? { ...task, state: "stopped", endedAt: at, reason: "workflow stopped" } : task))
    return { ...run, tasks, state: "stopped", reason: "stopped by the user", updatedAt: at, endedAt: at }
  }
  const { reason: _reason, ...rest } = run
  if (run.queuedBehind) return { ...rest, state: "queued", updatedAt: at }
  // A task the user cancelled comes back as pending on resume, so the run can finish.
  const tasks = rest.tasks.map((task): WorkflowTask => (task.state === "stopped" ? { ...withoutEnd(task), state: "pending" } : task))
  if (run.state === "blocked") return settle({ ...rest, tasks, state: "verifying" }, at)
  return settle({ ...rest, tasks, state: "running" }, at)
}

export function advanceMaps(run: WorkflowRun, at: number): WorkflowRun {
  if (run.state !== "running" && run.state !== "needs_input" && run.state !== "paused") return run
  let current = run
  for (const task of run.tasks.filter((task) => task.kind === "map")) {
    const parent = current.tasks.find((entry) => entry.id === task.id)!
    if (current.state !== "paused" && parent.state === "pending" && needsDone(current, parent) && phaseReady(current, parent)) {
      current = startTask(current, parent.id, { at })
      try {
        const children = expandedTasks(current, parent)
        const replacements = new Map(children.map((child) => [child.id, child]))
        current = { ...current, tasks: [...current.tasks.map((entry): WorkflowTask => {
          if (entry.id === parent.id) return { ...entry, expanded: true }
          if (replacements.has(entry.id)) return replacements.get(entry.id)!
          if (entry.mapParentId !== parent.id) return entry
          const { output: _output, result: _result, mapItem: _mapItem, ...rest } = entry
          return { ...rest, mapRetired: true, state: "skipped", reason: "map item removed", endedAt: at }
        }), ...children.filter((child) => !current.tasks.some((entry) => entry.id === child.id))], updatedAt: at }
      } catch (error) {
        current = finishTask(current, parent.id, { outcome: "failed", reason: error instanceof Error ? error.message : String(error), at })
        continue
      }
    }
    const expanded = current.tasks.find((entry) => entry.id === parent.id)!
    if (expanded.state !== "running" || !expanded.expanded) continue
    const children = current.tasks.filter((entry) => entry.mapParentId === parent.id && !entry.mapRetired)
    if (!children.every(taskTerminal)) continue
    const failed = children.find((entry) => entry.state !== "done")
    if (failed) current = finishTask(current, parent.id, { outcome: "failed", reason: `map child ${failed.id}: ${failed.reason ?? failed.state}`, at })
    else {
      const value = JSON.stringify(children.map((entry) => entry.output ? outputValue(entry.output) : entry.result ?? ""))
      current = finishTask(current, parent.id, value.length > 8_000 ? { outcome: "failed", reason: "map output exceeds 8000 characters", at } : { outcome: "done", result: `${children.length} items completed`, output: { kind: "json", value }, at })
    }
  }
  return current
}

function withoutEnd(task: WorkflowTask): WorkflowTask {
  const { reason: _reason, endedAt: _endedAt, ...rest } = task
  return rest
}

/** The contract could not be settled (audit unavailable or timed out, no repair owner): resumable. */
export function blockRun(run: WorkflowRun, reason: string, at: number): WorkflowRun {
  return { ...run, state: "blocked", reason: clip(reason, MAX_REASON), updatedAt: at }
}

/** The user accepts the result as is, with a reason that stays on the run. */
export function acceptRun(run: WorkflowRun, reason: string, at: number): WorkflowRun {
  if (run.state === "completed" || run.state === "stopped") return run
  const { reason: _reason, ...rest } = run
  return { ...rest, state: "completed", override: { reason: clip(reason, MAX_REASON), at }, updatedAt: at, endedAt: at }
}

/** Whether the contract needs an auditor at all: always when independent; with auto, when a required criterion has no covering check. */
export function auditNeeded(contract: WorkflowContract): boolean {
  if (contract.audit === "independent") return true
  if (contract.audit === "none") return false
  return contract.criteria.some((criterion) => criterion.required && !contract.checks.some((check) => check.covers?.includes(criterion.id)))
}

export type AuditOutcome = NonNullable<WorkflowVerification["audit"]>

/**
 * One verification round from the host checks and the (optional) audit: checks decide the criteria they cover; the
 * auditor decides the rest, and only with at least one inspection and an unchanged workspace. Accepted when every
 * check passed and no required criterion is fail or unsure.
 */
export function judgeVerification(input: { contract: WorkflowContract; round: number; at: number; gates: LoopGate[]; audit?: AuditOutcome }): WorkflowVerification {
  const { contract, gates, audit } = input
  const gateOf = new Map(contract.checks.map((check, index) => [check.id, gates[index]]))
  const auditValid = audit !== undefined && audit.inspections > 0 && !audit.workspaceChanged
  const criteria = contract.criteria.map((criterion): WorkflowVerification["criteria"][number] => {
    const covering = contract.checks.filter((check) => check.covers?.includes(criterion.id))
    if (covering.length) return { id: criterion.id, status: covering.every((check) => gateOf.get(check.id)?.status === "pass") ? "pass" : "fail", by: "check" }
    if (!audit) return { id: criterion.id, status: "unverified", by: "none" }
    if (!auditValid) return { id: criterion.id, status: "unsure", by: "audit" }
    const said = audit.criteria.filter((entry) => entry.id === criterion.id)
    const status = said.length === 1 && said[0]!.evidence.trim() ? said[0]!.status : "unsure"
    return { id: criterion.id, status, by: "audit" }
  })
  const required = new Set(contract.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id))
  const checksPassed = gates.every((gate) => gate.status === "pass")
  const accepted = checksPassed && criteria.every((entry) => !required.has(entry.id) || entry.status === "pass" || (entry.status === "unverified" && contract.audit === "none"))
  return { round: input.round, at: input.at, gates, ...(audit ? { audit } : {}), criteria, accepted }
}

/**
 * Applies a verification round: accepted completes the run; rejected sends the owners of what failed (and their
 * dependents) back with the rejection as feedback, or blocks when repairs ran out or no owner is declared.
 */
export function applyVerification(run: WorkflowRun, verification: WorkflowVerification, at: number): WorkflowRun {
  const contract = contractOf(run)
  if (!contract) throw new RangeError("[WORKFLOWS]: the run has no contract")
  const verifications = [...run.verifications, verification].slice(-MAX_VERIFICATIONS)
  if (verification.accepted) {
    const { reason: _reason, ...rest } = run
    return { ...rest, verifications, state: "completed", updatedAt: at, endedAt: at }
  }
  // A script decides its own control flow, so there is no owner task to send back: a rejected contract blocks the run for the user.
  if (run.plan.script) return blockRun({ ...run, verifications }, `contract rejected: ${rejection(verification).split("\n")[0] || "see the verification round"}`, at)
  // Out of repairs: blocked, and blocking is not a repair (a resumed run that fails again blocks again, repairs unchanged).
  if (run.repairs >= contract.maxRepairs) return blockRun({ ...run, verifications }, `contract still failing after ${contract.maxRepairs} repairs`, at)
  const repairs = run.repairs + 1
  const failedCriteria = verification.criteria.filter((entry) => entry.status !== "pass" && entry.status !== "unverified").map((entry) => entry.id)
  const failedChecks = contract.checks.filter((check, index) => verification.gates[index]?.status === "fail")
  const owners = new Set([...contract.criteria.filter((criterion) => failedCriteria.includes(criterion.id)).flatMap((criterion) => criterion.owners ?? []), ...failedChecks.flatMap((check) => check.owners ?? [])])
  if (owners.size === 0) {
    const workers = run.tasks.filter((task) => task.kind === "agent" && task.mode === "work")
    if (workers.length === 1) owners.add(workers[0]!.id)
    else return blockRun({ ...run, verifications, repairs }, `no repair owner declared for: ${[...failedCriteria, ...failedChecks.map((check) => check.id)].join(", ") || "the failed checks"}`, at)
  }
  const reopened = reopen({ ...run, verifications, repairs }, [...owners], rejection(verification))
  const { reason: _reason, ...rest } = reopened
  return settle({ ...rest, state: "running" }, at)
}

/** The rework note for repair owners: failing checks' details and the auditor's findings. */
export function rejection(verification: WorkflowVerification): string {
  const gates = verification.gates.filter((gate) => gate.status === "fail").map((gate) => `check ${gate.id} failed${gate.detail ? `:\n${gate.detail}` : ""}`)
  const criteria = verification.criteria.filter((entry) => entry.status === "fail" || entry.status === "unsure").map((entry) => `criterion ${entry.id}: ${entry.status}`)
  return clip([...gates, ...criteria, ...(verification.audit?.findings ? [`auditor: ${verification.audit.findings}`] : [])].join("\n\n"), MAX_FEEDBACK)
}

/**
 * After a daemon restart: no turn survived, so running and waiting tasks are interrupted (back to pending while
 * attempts remain). A run that was verifying verifies again from scratch.
 */
export function reconcileAfterRestart(run: WorkflowRun, at: number): WorkflowRun {
  let next = run
  // A human task keeps waiting for the user: no turn or process was running for it.
  for (const task of run.tasks) if (task.kind !== "map" && task.kind !== "human" && (task.state === "running" || task.state === "needs_input")) next = finishTask(next, task.id, { outcome: "interrupted", reason: "the daemon restarted", at })
  // A script run's host process died with the daemon: it replays from its journal when the run is pumped again.
  if (next.script && (next.script.host === "running" || next.script.host === "idle")) next = { ...next, script: { ...next.script, host: "idle" } }
  return next
}

const SCRIPT_RESULT_CLIP = 120
const SCRIPT_LOG_TAIL = 10

/** A new script task: pending, no dependencies, ready for the scheduler. The spec itself lives in the journal. */
export function addScriptTask(run: WorkflowRun, task: { id: string; title: string; kind: WorkflowTask["kind"]; mode?: "read" | "work"; label?: string; phase?: string; isolated?: boolean; engine?: string; modelId?: string }, at: number): WorkflowRun {
  if (!run.script) throw new RangeError("[WORKFLOWS]: not a script run")
  if (run.tasks.some((existing) => existing.id === task.id)) return run
  const added: WorkflowTask = { id: task.id, title: clip(task.title, 80), kind: task.kind, ...(task.mode ? { mode: task.mode } : {}), needs: [], state: "pending", attempt: 0, ...(task.label ? { label: clip(task.label, 80) } : {}), ...(task.phase ? { phase: clip(task.phase, 80) } : {}), ...(task.isolated ? { isolated: true } : {}), ...(task.engine ? { engine: task.engine } : {}), ...(task.modelId ? { modelId: clip(task.modelId, 100) } : {}) } as WorkflowTask
  return settle({ ...run, tasks: [...run.tasks, added], script: { ...run.script, calls: run.script.calls + (task.kind === "agent" ? 1 : 0) } }, at)
}

/** What a finished script task keeps in the row: the answer and the frozen execution live in the journal, not here. */
export function compactScriptTask(run: WorkflowRun, taskId: string): WorkflowRun {
  if (!run.script) return run
  return { ...run, tasks: run.tasks.map((task) => {
    if (task.id !== taskId || task.state !== "done") return task
    const { execution: _execution, ...rest } = task
    return { ...rest, ...(task.result ? { result: clip(task.result, SCRIPT_RESULT_CLIP) } : {}) }
  }) }
}

export function setScriptPhase(run: WorkflowRun, phase: string, at: number): WorkflowRun {
  return run.script ? { ...run, script: { ...run.script, phase }, updatedAt: at } : run
}

/** A log line from the script's Nth `log()` call; a replay repeats earlier ones, which are dropped by their index. */
export function appendScriptLog(run: WorkflowRun, n: number, message: string, at: number): WorkflowRun {
  if (!run.script || n < run.script.logCount) return run
  return { ...run, updatedAt: at, script: { ...run.script, logCount: n + 1, logs: [...run.script.logs, clip(message, 200)].slice(-SCRIPT_LOG_TAIL) } }
}

/** The host process started: the run is replaying (or running) its script. */
export function scriptHostStarted(run: WorkflowRun, at: number): WorkflowRun {
  return run.script ? { ...run, updatedAt: at, script: { ...run.script, host: "running", starts: run.script.starts + 1 } } : run
}

/** The host process stopped on purpose (pause, stop, a cap): it starts again, replaying, on resume. */
export function scriptHostIdle(run: WorkflowRun, at: number): WorkflowRun {
  return run.script && run.script.host === "running" ? { ...run, updatedAt: at, script: { ...run.script, host: "idle" } } : run
}

/** The script returned: the run finishes once its tasks do (then verifies a contract if it has one). */
export function finishScript(run: WorkflowRun, result: string | undefined, at: number): WorkflowRun {
  if (!run.script) return run
  const { error: _error, ...script } = run.script
  return settle({ ...run, script: { ...script, host: "done", ...(result !== undefined ? { result: clip(result, 4_000) } : {}) } }, at)
}

/** The script threw, was killed for a limit, or its host could not run: the run fails, and `resume` replays it. */
export function failScript(run: WorkflowRun, message: string, at: number): WorkflowRun {
  if (!run.script) return run
  return settle({ ...run, reason: clip(message, MAX_REASON), script: { ...run.script, host: "failed", error: clip(message, MAX_REASON) } }, at)
}

/** Before a resume or a retry of a script run: its host starts again from the journal. */
export function resetScriptHost(run: WorkflowRun): WorkflowRun {
  if (!run.script || run.script.host === "done") return run
  const { error: _error, ...script } = run.script
  return { ...run, script: { ...script, host: "idle" } }
}

/** A cap was reached: the run pauses (resumable), its running tasks go back to pending, nothing new starts. */
export function pauseScriptRun(run: WorkflowRun, reason: string, at: number): WorkflowRun {
  let next = run
  for (const task of run.tasks) if (task.state === "running" || task.state === "needs_input") if (task.kind !== "human") next = finishTask(next, task.id, { outcome: "interrupted", reason: "paused: a cap was reached", at })
  return { ...next, state: "paused", reason: clip(reason, MAX_REASON), updatedAt: at }
}
