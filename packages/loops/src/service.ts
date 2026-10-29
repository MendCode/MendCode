import { createHash } from "node:crypto"
import { addUsage, carriedUsage, loopBudgetGate, type UsageEvent } from "./budget"
import { evaluateRubric, rubricGate } from "./rubric"
import { approvalGate, protectedGate, reviewLoop, reviewSettingsChanged, reviewSettingsGate, type LoopReviewInput } from "./review"
import type { Clock, TimerHandle } from "@mendcode/kernel"
import type { createIdFactory, Loop, LoopAudit, LoopBudget, LoopCostBudget, LoopRubric, LoopApprovalPolicy, LoopGate, LoopId, LoopRun, LoopRunTrigger, LoopTickResult, LoopTrigger, LoopWorktree, QueueId, SessionEvent, SessionId, TurnId } from "@mendcode/protocol"
import { startedQueueIds } from "@mendcode/protocol"
import { auditPrompt, parseVerdict, rejectionFeedback } from "./audit"
import type { CheckRunner } from "./checks"
import { createVerifier } from "./verifier"
import { nextWake } from "./schedule"
import { beginRun, finishRun, finishVerification, runPrompt } from "./runs"
import { getLoopTemplate, templateCriteria, templateObjective } from "./templates"

type IdFactory = ReturnType<typeof createIdFactory>

export interface LoopStorePort {
  all(): Loop[]
  save(loop: Loop): void
  remove(loopId: LoopId): void
}

/**
 * Git worktrees for loops with workspace "worktree". `create` cuts a branch (from `from` when given, else the current
 * HEAD) in a new worktree; `release` ends the lease: it commits what the run left uncommitted, deletes the worktree and
 * its branch when the run changed nothing, and otherwise deletes only the directory and keeps the branch.
 */
export type WorktreePort = {
  create(input: { directory: string; key: string; label: string; from?: string }): Promise<{ ok: true; path: string; branch: string; base: string } | { ok: false; message: string }>
  release(input: { directory: string; path: string; branch: string; base?: string }): Promise<{ state: "removed" | "retained"; detail?: string }>
}

export type CreateLoopInput = {
  name: string
  directory: string
  /** Required without a template; with one, extra detail added to the template's objective. */
  objective?: string
  criteria?: string
  trigger?: LoopTrigger
  budget?: LoopBudget
  runNow?: boolean
  checks?: string[]
  /** Goal loops default to "independent"; other budgets never audit. */
  audit?: "independent" | "none"
  /** A `LOOP_TEMPLATES` id: fills whatever the input leaves out. */
  template?: string
  reportOnly?: boolean
  workspace?: "in-place" | "worktree"
  draft?: boolean
  costBudget?: LoopCostBudget
  rubric?: LoopRubric
  approvalPolicy?: LoopApprovalPolicy
}

export type UpdateLoopInput = { [K in keyof Omit<CreateLoopInput, "directory">]?: CreateLoopInput[K] | undefined }

/** A patch inherits the saved fields; an explicitly chosen template supplies its own defaults. */
export function loopUpdateInput(loop: Loop, patch: UpdateLoopInput): CreateLoopInput {
  const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Omit<CreateLoopInput, "directory">>
  return {
    name: loop.name,
    directory: loop.directory,
    ...(patch.template ? {} : { objective: loop.objective, trigger: loop.trigger, budget: loop.budget, ...(loop.criteria !== undefined ? { criteria: loop.criteria } : {}), ...(loop.reportOnly !== undefined ? { reportOnly: loop.reportOnly } : {}) }),
    ...(loop.checks ? { checks: loop.checks } : {}),
    ...(loop.audit ? { audit: loop.audit } : {}),
    ...(loop.workspace ? { workspace: loop.workspace } : {}),
    ...(loop.costBudget ? { costBudget: loop.costBudget } : {}),
    ...(loop.rubric ? { rubric: loop.rubric } : {}),
    ...(loop.approvalPolicy ? { approvalPolicy: loop.approvalPolicy } : {}),
    ...fields,
  }
}

/** What a create input becomes once its template (if any) has filled in what it left out; call after `createProblems` found nothing. */
export function resolveCreateInput(input: CreateLoopInput) {
  const template = getLoopTemplate(input.template)
  return {
    template,
    objective: template ? templateObjective(template, input.objective) : input.objective!,
    trigger: input.trigger ?? template!.trigger,
    budget: input.budget ?? template!.budget,
    criteria: input.criteria ?? (template && !input.budget ? templateCriteria(template) : undefined),
    reportOnly: input.reportOnly ?? template?.reportOnly,
  }
}

/** Why a create input cannot make a loop (unknown template, missing pieces, contradictory options), or undefined when it can. */
export function createProblems(input: CreateLoopInput): string | undefined {
  const template = input.template ? getLoopTemplate(input.template) : undefined
  if (input.template && !template) return `unknown loop template "${input.template}"`
  if (!template && !(input.objective && input.trigger && input.budget)) return "a loop needs an objective, a trigger and a budget (or a template that supplies them)"
  if ((input.reportOnly ?? template?.reportOnly) && input.workspace === "worktree") return "a report-only loop never edits, so it needs no worktree"
  if ((input.rubric?.criteria.length || input.rubric?.mandatoryBlockers?.length) && (input.budget ?? template?.budget)?.mode !== "goal") return "a rubric needs a goal loop"
  return undefined
}

/**
 * `started` remembers turn starts by queue id: the actor may start the turn synchronously while the
 * submit is still resolving, before this service knows the queue id it is waiting for.
 */
type Live = {
  loopId: LoopId
  run: number
  queueId?: QueueId
  turnId?: TurnId
  lastAnswer: string
  answerItems: Set<string>
  started: Map<string, TurnId>
  reportOnly?: boolean
  usageRecorded?: boolean
}

/**
 * Owns every loop's lifecycle. Runs are ordinary messages in the loop's root session, so the session
 * actor keeps its guarantees (queue, cancel, approvals) and the loop only observes events. One timer at
 * most, armed for the earliest wakeup (P12); state is saved on every change, so a restart resumes.
 */
export function createLoopService(options: {
  store: LoopStorePort
  clock: Clock
  ids: IdFactory
  /** `readOnly` sessions start in plan mode (the auditor's). */
  createSession(input: { directory: string; title: string; readOnly?: boolean }): SessionId
  submit(input: { sessionId: SessionId; text: string }): Promise<{ queueId: QueueId } | { error: string }>
  /** Runs one check program; without it, loops with checks can never pass them. */
  runCheck?: CheckRunner
  /** A digest of the workspace (e.g. git status + diff), or undefined when it cannot tell; an audit must not change it. */
  fingerprint?(directory: string): Promise<string | undefined>
  /** Cancels a hung auditor's turn when the audit times out. */
  cancelTurn?(input: { sessionId: SessionId; turnId: TurnId }): unknown
  auditTimeoutMs?: number
  /** Without it a loop with workspace "worktree" cannot run (its runs fail rather than touch the user's checkout). */
  worktree?: WorktreePort
  onChange?(loop: Loop): void
}) {
  const { store, clock, ids } = options
  const loops = new Map<LoopId, Loop>(store.all().map((loop) => [loop.loopId, loop]))
  const bySession = new Map<SessionId, Live>()
  const usageSeq = new Map<SessionId, number>()
  let timer: TimerHandle | undefined
  const observers = new Set<(loop: Loop) => void>()
  const tickWaiters = new Set<() => void>()
  const verifier = createVerifier({
    createSession: options.createSession,
    submit: options.submit,
    clock,
    ...(options.runCheck ? { runCheck: options.runCheck } : {}),
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
    ...(options.cancelTurn ? { cancelTurn: options.cancelTurn } : {}),
    ...(options.auditTimeoutMs ? { auditTimeoutMs: options.auditTimeoutMs } : {}),
  })

  function put(loop: Loop, journalEvent = true) {
    const before = loops.get(loop.loopId)
    const last = loop.history.at(-1)
    const previous = before?.history.at(-1)
    const type: NonNullable<Loop["journal"]>[number]["type"] = !before ? "created" : loop.runs !== before.runs ? "run" : last?.endedAt !== previous?.endedAt ? "checkpoint" : JSON.stringify(last?.gates) !== JSON.stringify(previous?.gates) || JSON.stringify(last?.audit) !== JSON.stringify(previous?.audit) ? "verification" : loop.state !== before.state ? "state" : "updated"
    const title = type === "created" ? `${loop.draft ? "Draft" : "Loop"} created: ${loop.name}` : type === "run" ? `Run ${loop.runs} started` : type === "checkpoint" ? last?.checkpoint?.summary || `Run ${loop.runs} ${last?.outcome ?? "ended"}` : loop.reason || `${loop.name}: ${loop.state}`
    const journal = before?.journal ?? loop.journal ?? []
    loop = { ...loop, journal: journalEvent ? [...journal, { seq: (journal.at(-1)?.seq ?? 0) + 1, at: clock.now(), type, title: title.slice(0, 500), ...(loop.runs ? { run: loop.runs } : {}) }].slice(-200) : journal }
    loops.set(loop.loopId, loop)
    store.save(loop)
    options.onChange?.(loop)
    for (const observer of [...observers]) observer(loop)
    return loop
  }

  function arm() {
    timer?.cancel()
    timer = undefined
    let earliest: number | undefined
    for (const loop of loops.values()) if (loop.state === "active" && loop.nextWakeAt !== undefined) earliest = earliest === undefined ? loop.nextWakeAt : Math.min(earliest, loop.nextWakeAt)
    if (earliest !== undefined) timer = clock.setTimer(Math.max(0, earliest - clock.now()), wakeDue)
  }

  function wakeDue() {
    timer = undefined
    const now = clock.now()
    for (const loop of [...loops.values()]) if (loop.state === "active" && loop.nextWakeAt !== undefined && loop.nextWakeAt <= now) void startRun(loop, "schedule")
    arm()
  }

  /** Replaces one run's entry in the loop's history (the run is identified by its number). */
  function patchRun(loopId: LoopId, run: number, patch: Partial<LoopRun>) {
    const loop = loops.get(loopId)
    if (!loop || !loop.history.some((entry) => entry.run === run)) return
    put({ ...loop, history: loop.history.map((entry) => (entry.run === run ? { ...entry, ...patch } : entry)) })
  }

  /**
   * One wakeup. The loop is marked running before anything is awaited, so a second wakeup cannot start a second run.
   * Workspace "worktree": the run gets a fresh session in its own git worktree (goal and fixed loops continue from the
   * branch the previous run kept, so iterating toward a goal does not start over); if the worktree cannot be made the run
   * fails instead of falling back to the user's checkout.
   */
  async function startRun(loop: Loop, how: LoopRunTrigger, reportOnly = false) {
    const cap = loopBudgetGate(loop)
    if (cap?.status === "fail") {
      const { nextWakeAt: _wake, ...rest } = loop
      put({ ...rest, state: "blocked", reason: cap.detail, updatedAt: clock.now() })
      arm()
      return
    }
    const fired = loop.pendingFire
    const trigger: LoopRunTrigger = fired ? "external" : how
    const { reviewInvalidatedAt: _review, ...ready } = loop
    const running = beginRun(ready, clock.now(), { trigger })
    put(running)
    let sessionId = loop.sessionId
    let worktree: LoopWorktree | undefined
    if (reportOnly) {
      sessionId = options.createSession({ directory: loop.directory, title: `loop · ${loop.name} · report ${running.runs}`, readOnly: true })
      patchRun(loop.loopId, running.runs, { sessionId })
    } else if (loop.workspace === "worktree") {
      const previous = loop.history.at(-1)?.worktree
      const chained = loop.budget.mode !== "monitor" && previous?.state === "retained" ? previous.branch : undefined
      const made = options.worktree
        ? await options.worktree.create({ directory: loop.directory, key: `${loop.loopId}-r${running.runs}`, label: loop.name, ...(chained ? { from: chained } : {}) }).catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
        : { ok: false as const, message: "worktrees are not available in this daemon" }
      const current = loops.get(loop.loopId)
      if (!current || current.runs !== running.runs || current.state !== "running" || current.updatedAt !== running.updatedAt) {
        if (current?.runs === running.runs) put(finishRun(current, { outcome: "interrupted", finalText: "", at: clock.now() }))
        if (made.ok && options.worktree) {
          const released = await options.worktree.release({ directory: loop.directory, path: made.path, branch: made.branch, base: made.base }).catch(() => ({ state: "retained" as const, detail: "Unused worktree cleanup failed; inspect the retained lease" }))
          patchRun(loop.loopId, running.runs, { worktree: { path: made.path, branch: made.branch, base: made.base, state: released.state, ...(released.detail ? { detail: released.detail.slice(0, 500) } : {}) } })
        }
        arm()
        return
      }
      if (!made.ok) {
        const failed = finishRun(loops.get(loop.loopId) ?? running, { outcome: "failed", finalText: "", at: clock.now() })
        put({ ...failed, reason: `worktree unavailable: ${made.message}`.slice(0, 500) })
        arm()
        return
      }
      worktree = { path: made.path, branch: made.branch, base: made.base, state: "active" }
      sessionId = options.createSession({ directory: made.path, title: `loop · ${loop.name} · run ${running.runs}`, ...(loop.reportOnly ? { readOnly: true } : {}) })
      patchRun(loop.loopId, running.runs, { sessionId, worktree })
    }
    const live: Live = { loopId: loop.loopId, run: running.runs, lastAnswer: "", answerItems: new Set(), started: new Map(), ...(reportOnly ? { reportOnly: true } : {}) }
    bySession.set(sessionId, live)
    const text = runPrompt(reportOnly ? { ...running, reportOnly: true, checks: [], budget: { mode: "monitor" } } : running, running.runs, { ...(fired ? { fired: { note: fired.note } } : {}), ...(worktree ? { worktreeBranch: worktree.branch } : {}) })
    const sent = await options.submit({ sessionId, text })
    if ("error" in sent) {
      bySession.delete(sessionId)
      put(finishRun(loops.get(loop.loopId) ?? running, { outcome: "failed", finalText: "", at: clock.now() }))
      void releaseLease(loop.loopId)
      arm()
      return
    }
    live.queueId = sent.queueId
    const turnId = live.started.get(sent.queueId)
    if (turnId) live.turnId = turnId
  }

  /** In-flight lease releases, so one lease is never released twice. */
  const releasing = new Set<string>()

  /** Ends the loop's active worktree lease (if any) and records how it ended on the run. */
  async function releaseLease(loopId: LoopId) {
    const loop = loops.get(loopId)
    const entry = loop?.history.findLast((candidate) => candidate.worktree?.state === "active")
    const lease = entry?.worktree
    if (!loop || !entry || !lease || releasing.has(lease.path)) return
    releasing.add(lease.path)
    const result = await (options.worktree
      ? options.worktree.release({ directory: loop.directory, path: lease.path, branch: lease.branch, ...(lease.base ? { base: lease.base } : {}) }).catch((error: unknown) => ({ state: "retained" as const, detail: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` }))
      : Promise.resolve({ state: "retained" as const, detail: "no worktree support to clean up" }))
    releasing.delete(lease.path)
    patchRun(loopId, entry.run, { worktree: { ...lease, state: result.state, ...(result.detail ? { detail: result.detail.slice(0, 500) } : {}) } })
  }

  /** Where a verification runs: the claiming run's worktree while it is still leased (that is where the work is), else the loop's directory. */
  function workDirectory(loop: Loop) {
    const lease = loop.history.at(-1)?.worktree
    return lease?.state === "active" ? lease.path : loop.directory
  }

  /** Ends a run (or an audit) once its turn reaches a terminal event. */
  function endRun(live: Live, outcome: "completed" | "failed" | "cancelled" | "interrupted") {
    if (live.turnId && !live.usageRecorded) recordUnreported(live.loopId, live.run)
    const loop = loops.get(live.loopId)
    if (!loop) return
    for (const [sessionId, entry] of bySession) if (entry === live) { bySession.delete(sessionId); usageSeq.delete(sessionId) }
    // A one-off report cannot claim an editing objective complete or launch host validation commands.
    const end = { outcome, finalText: live.reportOnly ? live.lastAnswer.replace(/(status\s*:\s*)complete\b/gi, "$1continue") : live.lastAnswer, at: clock.now() }
    let next = finishRun(loop, end)
    const run = next.history.at(-1)
    if (run?.checkpoint) {
      const checkpointHash = createHash("sha256").update(JSON.stringify([run.run, run.startedAt, run.checkpoint])).digest("hex")
      next = { ...next, history: [...next.history.slice(0, -1), { ...run, checkpointHash }] }
    }
    const gates = [loopBudgetGate(next), approvalGate(next), reviewSettingsGate(next)].filter((gate): gate is LoopGate => !!gate)
    if (gates.length && run) next = { ...next, history: [...next.history.slice(0, -1), { ...next.history.at(-1)!, gates }] }
    const blocking = gates.find((gate) => gate.status === "fail")
    if (blocking && loop.state !== "stopped" && loop.state !== "paused") {
      const { nextWakeAt: _wake, ...rest } = next
      next = { ...rest, state: "blocked", reason: blocking.detail }
    }
    if (next.state !== "verifying" && loop.history.some((entry) => entry.worktree?.state === "active")) {
      // The lease ends before the loop can start another run (which may continue from the branch this one keeps).
      void releaseLease(live.loopId).then(() => {
        const fresh = loops.get(live.loopId)
        if (!fresh) return
        put({ ...next, ...(fresh.state === "stopped" || fresh.state === "paused" ? { state: fresh.state, reason: fresh.reason } : {}), history: fresh.history.map((entry) => entry.run === next.runs ? { ...next.history.at(-1)!, ...(entry.worktree ? { worktree: entry.worktree } : {}) } : entry) })
        arm()
      })
      return
    }
    put(next)
    arm()
    if (next.state === "verifying") void verify(next)
  }

  /** In-flight verifications, so pause, stop and accept can abort their checks. */
  const verifications = new Map<LoopId, AbortController>()

  function settle(loopId: LoopId, result: Omit<Parameters<typeof finishVerification>[1], "at">) {
    verifications.delete(loopId)
    const loop = loops.get(loopId)
    if (!loop || loop.state !== "verifying") return
    const claim = loop.history.at(-1)?.checkpoint
    const gates = [...result.gates, ...[loopBudgetGate(loop), approvalGate(loop), reviewSettingsGate(loop)].filter((gate): gate is LoopGate => !!gate)]
    if (result.audit) gates.push({ id: "independent-audit", status: result.audit.verdict === "pass" && !result.audit.workspaceChanged ? "pass" : "fail", ...(result.audit.workspaceChanged || result.audit.findings.startsWith("the auditor inspected nothing") ? { failureClass: "integrity" } : {}), detail: result.audit.findings.slice(0, 2_000) })
    const rubricResult = claim ? evaluateRubric(loop, claim, gates, result.audit) : undefined
    const rubric = rubricGate(rubricResult)
    if (rubric) gates.push(rubric)
    const accepted = result.accepted && gates.every((gate) => gate.status === "pass")
    let next = finishVerification(loop, { ...result, gates, accepted, ...(accepted ? {} : { feedback: rejectionFeedback({ gates, audit: result.audit }) }), at: clock.now() })
    if (rubricResult) next = { ...next, history: [...next.history.slice(0, -1), { ...next.history.at(-1)!, rubricResult }] }
    const critical = gates.find((gate) => gate.status === "fail" && protectedGate(gate))
    if (critical) {
      const { nextWakeAt: _wake, ...rest } = next
      next = { ...rest, state: "blocked", reason: critical.detail ?? `gate ${critical.id} blocked completion` }
    }
    put(next)
    arm()
  }

  function block(loopId: LoopId, reason: string) {
    verifications.delete(loopId)
    const loop = loops.get(loopId)
    if (loop?.state !== "verifying") return
    put({ ...loop, state: "blocked", reason, updatedAt: clock.now() })
  }

  /** Host checks first (cheap, deterministic); then, if the loop wants one, the independent read-only audit. */
  async function verify(loop: Loop) {
    const controller = new AbortController()
    verifications.get(loop.loopId)?.abort()
    verifications.set(loop.loopId, controller)
    const claim = loop.history.at(-1)?.checkpoint ?? { status: "complete" as const, summary: "" }
    let auditUsage = false
    let auditSubmitted = false
    let auditSession: SessionId | undefined
    const outcome = await verifier.run({
      directory: workDirectory(loop),
      title: `loop · ${loop.name} · audit ${loop.runs}`,
      checks: loop.checks ?? [],
      ...(loop.rubric ? { keepOutput: true } : {}),
      onUsage: (event) => { auditUsage = true; auditSession = event.sessionId; recordUsage(loop.loopId, event, loop.runs) },
      onAuditSubmitted: () => { auditSubmitted = true },
      signal: controller.signal,
      stillWanted: () => loops.get(loop.loopId)?.state === "verifying",
      ...(loop.audit === "independent" ? { audit: { prompt: (gates: LoopGate[]) => auditPrompt(loop, loop.runs, claim, gates) } } : {}),
    })
    if (auditSubmitted && !auditUsage) recordUnreported(loop.loopId, loop.runs)
    if (auditSession) usageSeq.delete(auditSession)
    // The claiming run's worktree ends with its verification (before the loop can run again), unless the daemon is stopping.
    if (outcome.kind !== "interrupted") await releaseLease(loop.loopId)
    switch (outcome.kind) {
      case "aborted":
      case "interrupted": // the daemon is stopping; start() re-verifies after the restart
        return
      case "checks-failed":
        return settle(loop.loopId, { gates: outcome.gates, accepted: false, feedback: rejectionFeedback({ gates: outcome.gates }) })
      case "checked":
        return settle(loop.loopId, { gates: outcome.gates, accepted: true })
      case "unavailable":
        patchRun(loop.loopId, loop.runs, { gates: [...outcome.gates, { id: "independent-audit", status: "fail", failureClass: "integrity", detail: outcome.reason.slice(0, 2_000) }, ...[loopBudgetGate(loops.get(loop.loopId) ?? loop)].filter((gate): gate is LoopGate => !!gate)] })
        return block(loop.loopId, outcome.reason)
      case "audited": {
        const verdict = parseVerdict(outcome.audit.answer)
        const { workspaceChanged } = outcome.audit
        // An auditor that looked at nothing cannot have checked anything: its pass is void (v1's inspection gate).
        const blind = outcome.audit.inspections === 0
        const result: LoopAudit = {
          verdict: blind ? "fail" : (verdict?.verdict ?? "fail"),
          findings: blind ? "the auditor inspected nothing (no successful read or search), so its verdict cannot be trusted" : verdict?.findings || (verdict ? "" : "the auditor gave no AUDIT_VERDICT block"),
          sessionId: outcome.audit.sessionId,
          ...(workspaceChanged ? { workspaceChanged: true } : {}),
        }
        const accepted = result.verdict === "pass" && !workspaceChanged
        return settle(loop.loopId, { gates: outcome.gates, audit: result, accepted, ...(accepted ? {} : { feedback: rejectionFeedback({ gates: outcome.gates, audit: result }) }) })
      }
    }
  }

  function recordUnreported(loopId: LoopId, runNumber: number) {
    const loop = loops.get(loopId)
    if (!loop) return
    const unknown = (usage: Loop["usage"]) => ({ tokens: usage?.tokens ?? 0, costMicros: usage?.costMicros ?? 0, unknownCostCalls: (usage?.unknownCostCalls ?? 0) + 1, unreportedTurns: (usage?.unreportedTurns ?? 0) + 1 })
    put({ ...loop, usage: unknown(carriedUsage(loop)), history: loop.history.map((run) => run.run === runNumber ? { ...run, usage: unknown(run.usage) } : run), updatedAt: clock.now() }, false)
  }

  function recordUsage(loopId: LoopId, event: UsageEvent, runNumber: number) {
    if (event.seq <= (usageSeq.get(event.sessionId) ?? 0)) return
    usageSeq.set(event.sessionId, event.seq)
    const loop = loops.get(loopId)
    if (!loop) return
    const next = { ...loop, usage: addUsage(carriedUsage(loop), event), history: loop.history.map((run) => run.run === runNumber ? { ...run, usage: addUsage(run.usage, event) } : run), updatedAt: clock.now() }
    put(next, false)
    if (loopBudgetGate(next)?.status === "fail") options.cancelTurn?.({ sessionId: event.sessionId, turnId: event.turnId })
  }

  const TERMINAL = { "turn.completed": "completed", "turn.failed": "failed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted" } as const

  /** Every session event passes through here (cheap map lookups for non-loop sessions). */
  function observe(event: SessionEvent) {
    if (verifier.observe(event)) return
    const live = bySession.get(event.sessionId)
    if (!live) return
    if (event.type === "turn.started") {
      if (live.queueId === undefined) for (const queueId of startedQueueIds(event)) live.started.set(queueId, event.turnId)
      else if (startedQueueIds(event).includes(live.queueId)) live.turnId = event.turnId
    }
    if (!live.turnId) return
    if (event.type === "usage.recorded" && event.turnId === live.turnId) { live.usageRecorded = true; recordUsage(live.loopId, event, live.run) }
    // The checkpoint is read from the run's last agent message (never from tool output).
    if (event.type === "item.started" && event.turnId === live.turnId && event.kind === "agent_message") live.answerItems.add(event.itemId)
    if (event.type === "item.completed" && event.text && live.answerItems.has(event.itemId)) live.lastAnswer = event.text
    if (event.type === "server.request" && event.turnId === live.turnId) {
      const loop = loops.get(live.loopId)
      if (loop?.state === "running") put({ ...loop, state: "needs_input", reason: event.title, updatedAt: clock.now() })
    }
    if (event.type === "server.request.resolved") {
      const loop = loops.get(live.loopId)
      if (loop?.state === "needs_input") {
        const { reason: _reason, ...rest } = loop
        put({ ...rest, state: "running", updatedAt: clock.now() })
      }
    }
    if (event.type in TERMINAL && "turnId" in event && event.turnId === live.turnId) endRun(live, TERMINAL[event.type as keyof typeof TERMINAL])
  }

  function change(loopId: LoopId, apply: (loop: Loop) => Loop | undefined) {
    const loop = loops.get(loopId)
    if (!loop) return undefined
    const next = apply(loop)
    if (next && next !== loop) {
      const saved = put(next)
      arm()
      return saved
    }
    return next ?? loop
  }

  return {
    /** Throws on what `createProblems` reports; callers that take user input check it first. */
    create(input: CreateLoopInput): Loop {
      const problem = createProblems(input)
      if (problem) throw new Error(`[LOOP]: ${problem}`)
      const { template, objective, trigger, budget, criteria, reportOnly } = resolveCreateInput(input)
      const now = clock.now()
      const sessionId = options.createSession({ directory: input.directory, title: `loop · ${input.name}`, ...(reportOnly ? { readOnly: true } : {}) })
      const wake = input.draft ? undefined : input.runNow ? now : nextWake(trigger, now)
      const loop: Loop = {
        loopId: ids("loop"),
        name: input.name,
        directory: input.directory,
        objective,
        ...(criteria ? { criteria } : {}),
        ...(input.checks?.length ? { checks: input.checks } : {}),
        ...(budget.mode === "goal" ? { audit: input.audit ?? "independent" } : {}),
        trigger,
        budget,
        ...(input.costBudget ? { costBudget: input.costBudget } : {}),
        ...(input.rubric ? { rubric: input.rubric } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(template ? { template: template.id } : {}),
        ...(reportOnly ? { reportOnly: true } : {}),
        ...(input.workspace === "worktree" ? { workspace: "worktree" as const } : {}),
        state: input.draft ? "paused" : "active",
        ...(input.draft ? { draft: true, reason: "Draft; activate to schedule runs" } : {}),
        sessionId,
        runs: 0,
        ...(wake !== undefined ? { nextWakeAt: wake } : {}),
        history: [],
        createdAt: now,
        updatedAt: now,
      }
      const saved = put(loop)
      arm()
      return saved
    },
    list(directory?: string) {
      return [...loops.values()].filter((loop) => !directory || loop.directory === directory).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    /** Edits never restart a disabled loop or interrupt a run; the host validates the merged input first. */
    update(loopId: LoopId, patch: UpdateLoopInput): Loop | undefined {
      return change(loopId, (loop) => {
        const input = loopUpdateInput(loop, patch)
        const problem = createProblems(input)
        if (problem) throw new Error(`[LOOP]: ${problem}`)
        const { template, objective, trigger, budget, criteria, reportOnly } = resolveCreateInput(input)
        const now = clock.now()
        const { nextWakeAt: _wake, adaptiveMs: _pace, pendingFire: _fire, criteria: _criteria, checks: _checks, audit: _audit, reportOnly: _reportOnly, workspace: _workspace, ...rest } = loop
        const pace = JSON.stringify(trigger) !== JSON.stringify(loop.trigger) ? undefined : loop.adaptiveMs
        const audit = budget.mode === "goal" ? input.audit ?? (patch.budget || patch.template ? "independent" : undefined) : undefined
        const sameTrigger = JSON.stringify(trigger) === JSON.stringify(loop.trigger)
        const wake = loop.state === "active" ? input.runNow ? now : sameTrigger && loop.nextWakeAt !== undefined ? loop.nextWakeAt : nextWake(trigger, now, { adaptiveMs: pace }) : undefined
        const next: Loop = {
          ...rest,
          name: input.name,
          objective,
          ...(criteria !== undefined ? { criteria } : {}),
          trigger,
          budget,
          ...(input.costBudget !== undefined ? { costBudget: input.costBudget } : {}),
          ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
          ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
          ...(input.checks !== undefined ? { checks: input.checks } : {}),
          ...(audit !== undefined ? { audit } : {}),
          ...(template ? { template: template.id } : {}),
          ...(reportOnly !== undefined ? { reportOnly } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(pace !== undefined && trigger.kind === "adaptive" ? { adaptiveMs: pace } : {}),
          ...(loop.pendingFire && trigger.kind === "external" ? { pendingFire: loop.pendingFire } : {}),
          ...(wake !== undefined ? { nextWakeAt: wake } : {}),
          updatedAt: Math.max(now, loop.updatedAt + 1),
        }
        return loop.history.length && loop.state !== "completed" && loop.state !== "stopped" && reviewSettingsChanged(loop, next) ? { ...next, reviewInvalidatedAt: now } : next
      })
    },
    get: (loopId: LoopId) => loops.get(loopId),
    /** Pausing never interrupts a run in progress; it only stops future wakeups (and a pending verification). */
    pause: (loopId: LoopId) =>
      change(loopId, (loop) => {
        if (loop.state !== "active" && loop.state !== "blocked" && loop.state !== "verifying") return loop
        verifications.get(loopId)?.abort()
        const { nextWakeAt: _drop, ...rest } = loop
        return { ...rest, state: "paused", updatedAt: clock.now() }
      }),
    /** The user declares the goal met: recorded with their reason. Not while a run is in progress. */
    accept: (loopId: LoopId, reason: string) =>
      change(loopId, (loop) => {
        if (loop.state === "running" || loop.state === "needs_input" || loop.state === "completed" || loop.reviewInvalidatedAt !== undefined || loop.costBudget?.maxTokens || loop.costBudget?.maxCost || loop.rubric?.criteria.length || loop.rubric?.mandatoryBlockers?.length || loop.approvalPolicy?.requireApprovalFor.length || loop.history.at(-1)?.gates?.some((gate) => gate.status === "fail" && protectedGate(gate))) return loop
        verifications.get(loopId)?.abort()
        const { nextWakeAt: _drop, feedback: _feedback, ...rest } = loop
        return { ...rest, state: "completed", reason: `accepted by the user: ${reason}`, override: { reason, at: clock.now() }, updatedAt: clock.now() }
      }),
    review(loopId: LoopId, input: LoopReviewInput) {
      const loop = loops.get(loopId)
      if (!loop) return { ok: false as const, message: "unknown loop" }
      const cap = loopBudgetGate(loop)
      if (cap?.status === "fail") return { ok: false as const, message: cap.detail ?? "budget reached" }
      const result = reviewLoop(loop, input, clock.now())
      if (result.ok) {
        put(result.loop)
        if (input.action === "approve" && result.loop.history.at(-1)?.checkpoint?.status === "complete" && approvalGate(result.loop)?.status === "pass") {
          const next = { ...result.loop, state: "verifying" as const }
          put(next)
          void verify(next)
        }
        arm()
      }
      return result
    },
    resume: (loopId: LoopId) =>
      change(loopId, (loop) => {
        if (loop.state !== "paused" && loop.state !== "blocked" || loopBudgetGate(loop)?.status === "fail") return loop
        const next = nextWake(loop.trigger, clock.now(), loop)
        const { reason: _reason, draft: _draft, ...rest } = loop
        return { ...rest, state: "active", ...(next !== undefined ? { nextWakeAt: next } : {}), updatedAt: clock.now() }
      }),
    activate: (loopId: LoopId, reason?: string) =>
      change(loopId, (loop) => {
        if (!loop.draft) return loop
        const next = loop.trigger.kind === "interval" || loop.trigger.kind === "adaptive" ? clock.now() : nextWake(loop.trigger, clock.now(), loop)
        const { reason: _reason, draft: _draft, ...rest } = loop
        return { ...rest, state: "active", ...(next !== undefined ? { nextWakeAt: next } : {}), ...(reason ? { reason: `Activated: ${reason}` } : {}), updatedAt: clock.now() }
      }),
    /**
     * Fires an external loop (`loop.fire`). An idle loop runs now; one that is running or verifying remembers the fire
     * (several count once) and runs again as soon as it is free. Paused, blocked, stopped and finished loops refuse it.
     */
    fire(loopId: LoopId, note?: string): { ok: true; loop: Loop; queued: boolean } | { ok: false; reason: "unknown" | "not_external" | "inactive"; message: string } {
      const loop = loops.get(loopId)
      if (!loop) return { ok: false, reason: "unknown", message: "unknown loop" }
      if (loop.trigger.kind !== "external") return { ok: false, reason: "not_external", message: `this loop wakes by ${loop.trigger.kind}, not by external fire; use run` }
      const cap = loopBudgetGate(loop)
      if (cap?.status === "fail") return { ok: false, reason: "inactive", message: cap.detail ?? "budget reached" }
      const pendingFire = { at: clock.now(), ...(note ? { note } : {}) }
      if (loop.state === "running" || loop.state === "needs_input" || loop.state === "verifying") {
        const queued = { ...loop, pendingFire, updatedAt: clock.now() }
        put(queued)
        return { ok: true, loop: queued, queued: true }
      }
      if (loop.state !== "active") return { ok: false, reason: "inactive", message: `the loop is ${loop.state}; resume it before firing` }
      const armed = { ...loop, pendingFire, updatedAt: clock.now() }
      put(armed)
      void startRun(armed, "external")
      return { ok: true, loop: loops.get(loopId) ?? armed, queued: false }
    },
    stop: (loopId: LoopId) =>
      change(loopId, (loop) => {
        verifications.get(loopId)?.abort()
        const { nextWakeAt: _drop, ...rest } = loop
        return { ...rest, state: "stopped", reason: "stopped by the user", updatedAt: clock.now() }
      }),
    /** Runs now if the loop can run (not already running, not finished). */
    runNow(loopId: LoopId) {
      const loop = loops.get(loopId)
      if (!loop || loop.draft || loop.state === "running" || loop.state === "needs_input" || loop.state === "verifying" || loop.state === "completed" || loop.state === "stopped" || loopBudgetGate(loop)?.status === "fail") return false
      void startRun(loop, "manual")
      return true
    },
    /** One scheduler pass. Dry runs never write or submit; selected loops must be active. */
    async tick(input: { directory: string; loopId?: LoopId | undefined; limit: number; execute: boolean; reportOnly: boolean }): Promise<LoopTickResult[]> {
      const selected = input.loopId ? [loops.get(input.loopId)].filter((loop): loop is Loop => Boolean(loop && loop.directory === input.directory)) : [...loops.values()].filter((loop) => loop.directory === input.directory && loop.state === "active" && loop.nextWakeAt !== undefined && loop.nextWakeAt <= clock.now()).sort((a, b) => a.nextWakeAt! - b.nextWakeAt!).slice(0, input.limit)
      return Promise.all(selected.map(async (loop) => {
        if (loop.state !== "active" || loop.draft) return { loopId: loop.loopId, state: "skipped", summary: `Loop is ${loop.draft ? "draft" : loop.state}` }
        const cap = loopBudgetGate(loop)
        if (cap?.status === "fail") return { loopId: loop.loopId, state: "skipped", summary: cap.detail ?? "Budget reached" }
        if (!input.execute) return { loopId: loop.loopId, state: "skipped", summary: `Dry-run: would run ${loop.name}. Pass --execute to run.` }
        const run = loop.runs + 1
        return new Promise<LoopTickResult>((resolve) => {
          let deadline: TimerHandle | undefined
          const finish = (current: Loop, summary?: string, state?: string, timedOut = false) => {
            observers.delete(observe)
            tickWaiters.delete(interrupt)
            deadline?.cancel()
            const last = current.history.at(-1)
            resolve({ loopId: loop.loopId, state: state ?? (last?.outcome === "failed" ? "failed" : current.state), run, summary: summary ?? current.reason ?? last?.checkpoint?.summary ?? last?.outcome ?? current.state, ...(timedOut ? { timedOut: true } : {}) })
          }
          const observe = (current: Loop) => {
            if (current.loopId === loop.loopId && current.runs >= run && current.state !== "running" && current.state !== "verifying") finish(current)
          }
          const interrupt = () => finish(loops.get(loop.loopId) ?? loop, "Daemon stopped during the tick", "interrupted")
          observers.add(observe)
          tickWaiters.add(interrupt)
          deadline = clock.setTimer(15 * 60_000, () => finish(loops.get(loop.loopId) ?? loop, "Tick wait timed out; the run remains inspectable", undefined, true))
          void startRun(loop, input.loopId ? "manual" : "schedule", input.reportOnly).catch((error: unknown) => {
            const current = loops.get(loop.loopId) ?? loop
            put({ ...finishRun(current, { outcome: "failed", finalText: "", at: clock.now() }), reason: String(error).slice(0, 500) })
            finish(loops.get(loop.loopId) ?? loop)
            arm()
          })
        })
      }))
    },
    remove(loopId: LoopId) {
      const loop = loops.get(loopId)
      if (!loop || loop.state === "running" || loop.state === "needs_input") return false
      loops.delete(loopId)
      store.remove(loopId)
      arm()
      return true
    },
    observe,
    /**
     * After a restart: a run that was in progress was interrupted with the daemon (its turn is marked
     * interrupted by crash recovery), so it is closed as interrupted; overdue loops run once, no catch-up.
     */
    start() {
      for (const loop of [...loops.values()]) if (loop.state === "running" || loop.state === "needs_input") put(finishRun({ ...loop, state: "running" }, { outcome: "interrupted", finalText: "", at: clock.now() }))
      // A verification cut off by the restart is done again from the start (checks, then a fresh audit).
      for (const loop of [...loops.values()]) if (loop.state === "verifying") void verify(loop)
      // A worktree lease the daemon died holding ends now (what the run left is committed to its branch, never lost).
      for (const loop of [...loops.values()]) if (loop.state !== "verifying" && loop.history.some((entry) => entry.worktree?.state === "active")) void releaseLease(loop.loopId)
      arm()
    },
    dispose() {
      timer?.cancel()
      timer = undefined
      for (const controller of verifications.values()) controller.abort()
      for (const interrupt of [...tickWaiters]) interrupt()
    },
  }
}
export type LoopService = ReturnType<typeof createLoopService>
