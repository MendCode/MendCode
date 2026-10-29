import { createIdFactory, type SessionEvent, type SessionId, type TurnId, type WorkflowId, type WorkflowRun } from "@mendcode/protocol"
import { createWorkflowService, validatePlan } from "../src"

export const flushB78 = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve))
}

export function b78Clock() {
  let now = 1_800_000_000_000
  const timers = new Set<{ at: number; run(): void }>()
  return {
    now: () => now,
    setTimer(ms: number, run: () => void) {
      const entry = { at: now + ms, run }
      timers.add(entry)
      return { cancel: () => void timers.delete(entry) }
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const entry = [...timers].filter((entry) => entry.at <= target).sort((first, second) => first.at - second.at)[0]
        if (!entry) break
        timers.delete(entry)
        now = entry.at
        entry.run()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

export function b78Service(options: { saved?: Map<WorkflowId, WorkflowRun>; clock?: ReturnType<typeof b78Clock> } = {}) {
  const saved = options.saved ?? new Map<WorkflowId, WorkflowRun>()
  const clock = options.clock ?? b78Clock()
  const ids = createIdFactory({ now: clock.now })
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: ReturnType<typeof ids<"queue">> }> = []
  const cancelled: Array<{ sessionId: SessionId; turnId: TurnId }> = []
  const sessions: Array<{ sessionId: SessionId; readOnly?: boolean; directory: string }> = []
  const service = createWorkflowService({
    clock, ids,
    store: { all: () => [...saved.values()], save: (run) => void saved.set(run.workflowId, run), remove: (id) => void saved.delete(id) },
    createSession(input) { const sessionId = ids("session"); sessions.push({ ...input, sessionId }); return sessionId },
    async submit(input) { const queueId = ids("queue"); submitted.push({ ...input, queueId }); return { queueId } },
    cancelTurn: (input) => void cancelled.push(input),
    async runCheck() { return { exitCode: 0, output: "ok" } },
    fingerprint: async () => "same",
  })
  let sequence = 0
  const turns = new Map<SessionId, TurnId>()
  const event = (sessionId: SessionId, patch: Record<string, unknown>) => service.observe({ sessionId, seq: ++sequence, at: clock.now(), ...patch } as SessionEvent)
  const state = (run: WorkflowRun) => service.get(run.workflowId)!
  const sessionOf = (run: WorkflowRun, id: string) => state(run).tasks.find((task) => task.id === id)!.sessionId!
  const begin = (sessionId: SessionId) => {
    const sent = submitted.filter((entry) => entry.sessionId === sessionId).at(-1)!
    const turnId = ids("turn")
    turns.set(sessionId, turnId)
    event(sessionId, { type: "turn.started", queueId: sent.queueId, turnId })
    return turnId
  }
  const finish = async (run: WorkflowRun, id: string, answer = "done", failed = false) => {
    await flushB78()
    const sessionId = sessionOf(run, id)
    const turnId = turns.get(sessionId) ?? begin(sessionId)
    const itemId = ids("item")
    event(sessionId, { type: "item.started", turnId, itemId, kind: "agent_message" })
    event(sessionId, { type: "item.completed", itemId, status: "ok", text: answer })
    event(sessionId, failed ? { type: "turn.failed", turnId, error: { code: "fake", message: "failed" } } : { type: "turn.completed", turnId })
    turns.delete(sessionId)
    await flushB78()
    return state(run)
  }
  const create = (input: unknown, directory = "/fake/project") => {
    const parsed = validatePlan(input)
    if (!parsed.ok) throw new Error(parsed.problems.join("; "))
    return service.create({ plan: parsed.plan, planHash: "0".repeat(64), directory, permission: "ask" })
  }
  return { clock, ids, saved, service, sessions, submitted, cancelled, event, state, sessionOf, begin, finish, create }
}

export const b78Agent = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "agent", id, title: id, prompt: `Inspect ${id}`, mode: "read", ...extra })
export const b78Plan = (extra: Record<string, unknown> = {}) => ({ name: "b78", objective: "Review bounded inputs", tasks: [b78Agent("first"), b78Agent("second"), b78Agent("last")], ...extra })
export const b78MapPlan = (extra: Record<string, unknown> = {}) => b78Plan({
  tasks: [b78Agent("source", { output: { kind: "json" } }), { kind: "map", id: "review", title: "Review files", needs: ["source"], map: { source: { taskId: "source" }, maxItems: 3, taskTemplate: { title: "Review", prompt: "Inspect the map item", mode: "read", output: { kind: "artifact", artifactKind: "review", schema: { type: "object", required: ["file"], properties: { file: { type: "string" } }, additionalProperties: false } } } } }, b78Agent("report", { needs: ["review"], inputs: [{ taskId: "review" }] })],
  phases: [{ id: "discover", title: "Discover", tasks: ["source"] }, { id: "inspect", title: "Inspect", tasks: ["review"] }, { id: "reporting", title: "Report", tasks: ["report"] }],
  ...extra,
})
export const outputB78 = (value: unknown) => `\`\`\`WORKFLOW_OUTPUT\n${JSON.stringify(value)}\n\`\`\`\n\`\`\`TASK_RESULT\nstatus: done\nsummary: ready\n\`\`\``
