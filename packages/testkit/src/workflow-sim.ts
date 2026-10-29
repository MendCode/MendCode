import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, MAX_WORKFLOW_RUN_BYTES, WorkflowPlan, type QueueId, type SessionEvent, type SessionId, type TurnId, type WorkflowId, type WorkflowRun } from "@mendcode/protocol"
import { createWorkflowService, type WorkflowService } from "@mendcode/workflows"
import type { Violation } from "./invariants"

const DEFAULT_MAX_CONCURRENT = 2
const FINISHED = new Set(["completed", "failed", "stopped"])

/**
 * Invariants of one stored run that hold at every instant (§4, W-I2, W-I3, W-I6, W-I8). Pure. `peers` are the other
 * runs, for the one-work-task-per-directory rule across runs.
 */
export function checkWorkflowRun(run: WorkflowRun, peers: readonly WorkflowRun[] = []): Violation[] {
  const out: Violation[] = []
  const state = new Map(run.tasks.map((task) => [task.id, task.state]))
  const active = run.tasks.filter((task) => task.state === "running" || task.state === "needs_input")
  const cap = run.plan.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  if (active.length > cap) out.push({ invariant: "W-I2", message: `${run.name}: ${active.length} tasks running, cap ${cap}` })
  const work = [...active, ...peers.filter((peer) => peer.workflowId !== run.workflowId && peer.directory === run.directory).flatMap((peer) => peer.tasks.filter((task) => task.state === "running" || task.state === "needs_input"))].filter((task) => task.mode === "work")
  if (work.length > 1) out.push({ invariant: "W-I2", message: `${run.name}: ${work.length} work tasks running in ${run.directory}` })
  for (const task of active) for (const need of task.needs) if (state.get(need) !== "done") out.push({ invariant: "W-I3", message: `${run.name}: ${task.id} runs before ${need} is done` })
  if (run.state === "completed") {
    if (run.tasks.some((task) => task.state !== "done") && !run.override) out.push({ invariant: "W-I3", message: `${run.name}: completed with unfinished tasks and no accept` })
    const contract = typeof run.plan.contract === "object" ? run.plan.contract : undefined
    if (contract && !run.override && !run.verifications.at(-1)?.accepted) out.push({ invariant: "W-I3", message: `${run.name}: completed without an accepted verification` })
  }
  const contract = typeof run.plan.contract === "object" ? run.plan.contract : undefined
  if (contract && run.repairs > contract.maxRepairs) out.push({ invariant: "W-I6", message: `${run.name}: ${run.repairs} repairs, max ${contract.maxRepairs}` })
  const bytes = Buffer.byteLength(JSON.stringify(run))
  if (bytes > MAX_WORKFLOW_RUN_BYTES) out.push({ invariant: "W-I8", message: `${run.name}: ${bytes} bytes` })
  return out
}

/** Deterministic PRNG (mulberry32) so a seed replays exactly. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Turn = { sessionId: SessionId; turnId: TurnId; auditor: boolean; requestOpen?: string }

/**
 * Drives the real workflow service through random turn outcomes, approvals, user cancels, pauses, stops, retries,
 * audits (honest, failing, hung) and daemon restarts, checking W-I1..W-I8 after every step.
 * `broken` injects a service bug (a task started before its needs are done) that the checks must catch.
 */
export async function simulateWorkflows(input: { seed: number; steps?: number; broken?: boolean }) {
  const random = prng(input.seed)
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const clock = createVirtualClock(1_800_000_000_000)
  const idRandom = prng(input.seed + 1)
  const ids = createIdFactory({ now: () => clock.now(), random: (size) => Uint8Array.from({ length: size }, () => Math.floor(idRandom() * 256)) })
  const saved = new Map<WorkflowId, WorkflowRun>()
  const violations: Violation[] = []
  const steps: string[] = []
  const sessions = new Map<SessionId, { auditor: boolean }>()
  const queued: Array<{ sessionId: SessionId; queueId: QueueId }> = []
  const turns: Turn[] = []
  /** Turns the service itself started (by its own submits): the only ones it may cancel (W-I5). */
  const own = new Set<string>()
  let seq = 0

  const store = {
    all: () => [...saved.values()],
    save(run: WorkflowRun) {
      let next = run
      if (input.broken) {
        const early = run.tasks.find((task) => task.state === "pending" && task.needs.some((need) => run.tasks.find((other) => other.id === need)?.state !== "done"))
        if (early) {
          next = { ...run, tasks: run.tasks.map((task) => (task === early ? { ...task, state: "running" as const } : task)) }
        }
      }
      saved.set(run.workflowId, next)
    },
    remove: (workflowId: WorkflowId) => void saved.delete(workflowId),
  }
  const build = () =>
    createWorkflowService({
      store,
      clock,
      ids,
      createSession: ({ readOnly, title }) => {
        const sessionId = ids("session")
        sessions.set(sessionId, { auditor: Boolean(readOnly) && title.includes("audit") })
        return sessionId
      },
      submit: async ({ sessionId }) => {
        const queueId = ids("queue")
        queued.push({ sessionId, queueId })
        return { queueId }
      },
      cancelTurn: ({ sessionId, turnId }) => {
        const key = `${sessionId}:${turnId}`
        if (!own.has(key)) violations.push({ invariant: "W-I5", message: `cancelled a turn it did not start (${key})` })
        const index = turns.findIndex((turn) => turn.turnId === turnId)
        if (index >= 0) {
          turns.splice(index, 1)
          emit(sessionId, { type: "turn.cancelled", turnId, by: "user" })
        }
      },
      runCheck: async () => ({ exitCode: random() < 0.75 ? 0 : 1, output: "x" }),
      fingerprint: async () => "same",
      auditTimeoutMs: 600_000,
    })
  let service: WorkflowService = build()
  const emit = (sessionId: SessionId, patch: Record<string, unknown>) => service.observe({ sessionId, seq: ++seq, at: clock.now(), ...patch } as SessionEvent)
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }

  const plan = (() => {
    const count = 2 + Math.floor(random() * 4)
    const tasks = Array.from({ length: count }, (_, index) => {
      const id = `t${index}`
      const needs = index > 0 && random() < 0.6 ? [`t${Math.floor(random() * index)}`] : []
      return random() < 0.2 ? { kind: "check", id, title: id, command: "true", needs } : { kind: "agent", id, title: id, prompt: `do ${id}`, needs, mode: random() < 0.5 ? "work" : "read" }
    })
    const agents = tasks.filter((task) => task.kind === "agent").map((task) => task.id)
    const contract =
      random() < 0.3
        ? undefined
        : { criteria: [{ id: "c1", text: "one", ...(agents.length ? { owners: [pick(agents)] } : {}) }, { id: "c2", text: "two", ...(agents.length ? { owners: [pick(agents)] } : {}) }], checks: random() < 0.5 ? [{ id: "k", command: "true", covers: ["c1"] }] : [], maxRepairs: Math.floor(random() * 3) }
    return WorkflowPlan.parse({ name: `sim-${input.seed}`, objective: "simulate", tasks, maxConcurrent: 1 + Math.floor(random() * 3), ...(contract ? { contract } : {}) })
  })()

  const check = () => {
    const runs = [...saved.values()]
    for (const run of runs) violations.push(...checkWorkflowRun(run, runs))
    // W-I1: a task waits for input only while its session has an open request.
    for (const run of runs)
      for (const task of run.tasks)
        if (task.state === "needs_input" && !turns.some((turn) => turn.sessionId === task.sessionId && turn.requestOpen)) violations.push({ invariant: "W-I1", message: `${task.id} needs input with no open request` })
  }

  const run = service.create({ plan, planHash: "0".repeat(64), directory: "/sim", permission: "edits" })
  await settle()
  check()
  const total = input.steps ?? 60
  for (let step = 0; step < total && violations.length === 0; step++) {
    const roll = random()
    const current = saved.get(run.workflowId)
    if (!current) break
    if (queued.length && roll < 0.35) {
      const { sessionId, queueId } = queued.splice(Math.floor(random() * queued.length), 1)[0]!
      const turnId = ids("turn")
      own.add(`${sessionId}:${turnId}`)
      turns.push({ sessionId, turnId, auditor: sessions.get(sessionId)?.auditor ?? false })
      emit(sessionId, { type: "turn.started", turnId, queueId })
      steps.push(`start ${sessionId.slice(-6)}`)
    } else if (turns.length && roll < 0.75) {
      const turn = pick(turns)
      const outcome = random()
      const end = (type: string, extra: Record<string, unknown> = {}) => {
        turns.splice(turns.indexOf(turn), 1)
        emit(turn.sessionId, { type, turnId: turn.turnId, ...extra })
      }
      const say = (text: string) => {
        const itemId = ids("item")
        const tool = ids("item")
        emit(turn.sessionId, { type: "item.started", turnId: turn.turnId, itemId: tool, kind: "tool_call", meta: { tool: "read" } })
        emit(turn.sessionId, { type: "item.completed", itemId: tool, status: "ok", text: "ok" })
        emit(turn.sessionId, { type: "item.started", turnId: turn.turnId, itemId, kind: "agent_message" })
        emit(turn.sessionId, { type: "item.completed", itemId, status: "ok", text })
      }
      if (turn.auditor) {
        if (outcome < 0.2) {
          clock.advance(600_000)
          steps.push("audit hangs")
        } else {
          const status = () => (random() < 0.7 ? "pass" : "fail")
          say(["```AUDIT_VERDICT", "verdict: pass", "criteria:", `- c1: ${status()} — a.ts:1`, `- c2: ${status()} — b.ts:2`, "findings: ok", "```"].join("\n"))
          end("turn.completed")
          steps.push("audit answers")
        }
      } else if (turn.requestOpen) {
        const requestId = turn.requestOpen
        delete turn.requestOpen
        emit(turn.sessionId, { type: "server.request.resolved", requestId, resolution: "approved" })
        steps.push("approve")
      } else if (outcome < 0.5) {
        say(random() < 0.1 ? "```TASK_RESULT\nstatus: blocked\nsummary: stuck\n```" : "done")
        end("turn.completed")
        steps.push("task done")
      } else if (outcome < 0.6) {
        end("turn.failed", { error: { code: "x", message: "y" } })
        steps.push("task fails")
      } else if (outcome < 0.7) {
        end("turn.interrupted", { reason: "restart" })
        steps.push("task interrupted")
      } else if (outcome < 0.78) {
        end("turn.cancelled", { by: "user" })
        steps.push("user cancels")
      } else {
        turn.requestOpen = ids("request")
        emit(turn.sessionId, { type: "server.request", requestId: turn.requestOpen, turnId: turn.turnId, kind: "approval", title: "Edit", detail: "", tool: "edit", permission: "write" })
        steps.push("asks approval")
      }
    } else if (roll < 0.8) {
      // Restart: every turn dies with the daemon (crash recovery marks them interrupted without the service seeing it).
      service.dispose()
      turns.length = 0
      queued.length = 0
      service = build()
      service.start()
      steps.push("restart")
    } else if (roll < 0.86) {
      const action = pick(["pause", "resume", "verify"] as const)
      service.control(run.workflowId, action)
      steps.push(action)
    } else if (roll < 0.9) {
      const failed = current.tasks.filter((task) => ["failed", "skipped", "stopped"].includes(task.state))
      if (failed.length) service.control(run.workflowId, "retry", { taskId: pick(failed).id })
      steps.push("retry")
    } else if (roll < 0.92) {
      // A turn the user starts in a task session: never the service's to cancel.
      const task = current.tasks.find((candidate) => candidate.sessionId)
      if (task?.sessionId && !turns.some((turn) => turn.sessionId === task.sessionId)) {
        const turnId = ids("turn")
        turns.push({ sessionId: task.sessionId, turnId, auditor: false })
        emit(task.sessionId, { type: "turn.started", turnId, queueId: ids("queue") })
      }
      steps.push("user turn")
    } else if (roll < 0.94) {
      if (current.state === "blocked") service.control(run.workflowId, "accept", { reason: "fine" })
      steps.push("accept")
    } else if (roll < 0.95) {
      service.control(run.workflowId, "stop")
      steps.push("stop")
    } else {
      // W-I7: reads never change what is stored.
      const before = JSON.stringify([...saved.values()])
      service.list()
      service.get(run.workflowId)
      if (JSON.stringify([...saved.values()]) !== before) violations.push({ invariant: "W-I7", message: "a read changed the store" })
      steps.push("read")
    }
    await settle()
    check()
    if (FINISHED.has(saved.get(run.workflowId)?.state ?? "")) break
  }
  service.dispose()
  return { seed: input.seed, violations, steps, run: saved.get(run.workflowId) }
}
