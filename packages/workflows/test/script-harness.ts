import { createIdFactory, type QueueId, type SessionEvent, type SessionId, type TurnId, type WorkflowId, type WorkflowRun } from "@mendcode/protocol"
import { buildScriptPlan, createWorkflowService, validatePlan, type ScriptHostPort, type ScriptJournalPort, type ScriptMergePort } from "../src"
import { createInProcessScriptHost } from "../src/script-inprocess"

export const settle = async (times = 12) => {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve))
}

export function scriptClock(start = 1_800_000_000_000) {
  let now = start
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
        const entry = [...timers].filter((candidate) => candidate.at <= target).sort((a, b) => a.at - b.at)[0]
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

export function memoryJournal(rows = new Map<string, string>()): ScriptJournalPort & { rows: Map<string, string> } {
  const id = (workflowId: string, key: string) => `${workflowId}\u0000${key}`
  return {
    rows,
    get: (workflowId, key) => rows.get(id(workflowId, key)),
    set: (workflowId, key, payload) => void rows.set(id(workflowId, key), payload),
    list: (workflowId, prefix = "") => [...rows].filter(([k]) => k.startsWith(`${workflowId}\u0000${prefix}`)).map(([k, payload]) => ({ key: k.slice(workflowId.length + 1), payload })),
    removeRun: (workflowId) => void [...rows.keys()].filter((k) => k.startsWith(`${workflowId}\u0000`)).forEach((k) => rows.delete(k)),
  }
}

export type Responder = (prompt: string, info: { sessionId: SessionId; turn: number; mode: "read" | "work" | undefined }) => string | "HOLD" | Promise<string | "HOLD">

/**
 * A workflow service with the in-process script host, an in-memory journal and an automatic "model": each submitted prompt is
 * answered by `responder` (or held, for tests that decide when a task ends). Pass the same `saved`/`rows` to a second harness to
 * simulate a daemon restart.
 */
export function scriptHarness(options: { saved?: Map<WorkflowId, WorkflowRun>; rows?: Map<string, string>; clock?: ReturnType<typeof scriptClock>; responder?: Responder; host?: ScriptHostPort; checkExit?: (argv: string[], cwd?: string) => number; /** Route per-run-worktree tasks to `/worktrees/<task>` like the daemon's router. */ worktrees?: boolean; /** No script host and no journal: what a daemon without isolation looks like. */ bare?: boolean; /** The git side of worktree results (a fake in most tests). */ merge?: ScriptMergePort } = {}) {
  const clock = options.clock ?? scriptClock()
  const ids = createIdFactory({ now: clock.now })
  const saved = options.saved ?? new Map<WorkflowId, WorkflowRun>()
  const journal = memoryJournal(options.rows)
  const host = (options.host ?? createInProcessScriptHost()) as ScriptHostPort & { started?: number; killed?: string[] }
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const cancelled: Array<{ sessionId: SessionId; turnId: TurnId }> = []
  const sessions: Array<{ sessionId: SessionId; readOnly?: boolean; title: string }> = []
  const prompts: string[] = []
  const ran: string[][] = []
  const checkDirs: string[] = []
  const turns = new Map<SessionId, TurnId>()
  const turnCount = new Map<SessionId, number>()
  let sequence = 0
  let responder: Responder | undefined = options.responder
  const service = createWorkflowService({
    clock,
    ids,
    store: { all: () => [...saved.values()], save: (run) => void saved.set(run.workflowId, JSON.parse(JSON.stringify(run))), remove: (id) => void saved.delete(id) },
    ...(options.bare ? {} : { scriptHost: host, journal }),
    ...(options.merge ? { merge: options.merge } : {}),
    // Like the daemon's router: a task in a per-run worktree runs in its own directory.
    ...(options.worktrees ? { prepareTask: async (_run: WorkflowRun, spec: { id: string; workspace?: { mode?: string } }, execution: Record<string, unknown>) => (spec.workspace?.mode === "per-run-worktree" ? { ...execution, directory: `/worktrees/${spec.id}` } : execution) } as never : {}),
    createSession(input) {
      const sessionId = ids("session")
      sessions.push({ sessionId, title: input.title, ...(input.readOnly ? { readOnly: true } : {}) })
      return sessionId
    },
    async submit(input) {
      const queueId = ids("queue")
      submitted.push({ ...input, queueId })
      setImmediate(() => void drive(input.sessionId, input.text, queueId))
      return { queueId }
    },
    cancelTurn: (input) => void cancelled.push(input),
    async runCheck({ argv, cwd }) {
      ran.push(argv)
      if (cwd) checkDirs.push(cwd)
      const exitCode = options.checkExit?.(argv, cwd) ?? 0
      return { exitCode, output: exitCode ? "failing" : "ok" }
    },
    fingerprint: async () => "same",
  })
  const event = (sessionId: SessionId, patch: Record<string, unknown>) => service.observe({ sessionId, seq: ++sequence, at: clock.now(), ...patch } as SessionEvent)
  async function drive(sessionId: SessionId, text: string, queueId: QueueId) {
    const run = service.list().find((candidate) => candidate.tasks.some((task) => task.sessionId === sessionId))
    const task = run?.tasks.find((candidate) => candidate.sessionId === sessionId)
    if (!responder) return
    // The task's own prompt, without the engine's framing (repair turns are passed whole).
    const raw = /Your task: [^\n]*\n([\s\S]*?)(?:\n\n(?:Results of the tasks|Selected inputs|Map item|The previous result|Return |Do the task completely))/.exec(text)?.[1] ?? text
    prompts.push(raw)
    const turn = (turnCount.get(sessionId) ?? 0) + 1
    turnCount.set(sessionId, turn)
    const turnId = ids("turn")
    turns.set(sessionId, turnId)
    event(sessionId, { type: "turn.started", queueId, turnId })
    const answer = await responder(raw, { sessionId, turn, mode: task?.mode })
    if (answer === "HOLD") return
    await finishWith(sessionId, queueId, answer)
  }
  async function finishWith(sessionId: SessionId, queueId: QueueId | undefined, answer: string, failed = false) {
    const sent = submitted.filter((entry) => entry.sessionId === sessionId).at(-1)
    let turnId = turns.get(sessionId)
    if (!turnId) {
      turnId = ids("turn")
      turns.set(sessionId, turnId)
      event(sessionId, { type: "turn.started", queueId: queueId ?? sent!.queueId, turnId })
    }
    const itemId = ids("item")
    event(sessionId, { type: "item.started", turnId, itemId, kind: "agent_message" })
    event(sessionId, { type: "item.completed", itemId, status: "ok", text: answer })
    event(sessionId, failed ? { type: "turn.failed", turnId, error: { code: "fake", message: "failed" } } : { type: "turn.completed", turnId })
    turns.delete(sessionId)
    await settle()
  }
  const start = (source: string, args?: Record<string, unknown>, directory = "/fake/project") => {
    const built = buildScriptPlan({ source, args, origin: "inline" })
    if (!built.ok) throw new Error(built.problems.join("; "))
    const checked = validatePlan(built.plan)
    if (!checked.ok) throw new Error(checked.problems.join("; "))
    return service.create({ plan: checked.plan, planHash: "0".repeat(64), directory, permission: "edits" })
  }
  const get = (run: WorkflowRun) => service.get(run.workflowId)!
  const header = (meta: string) => `export const meta = ${meta}\n`
  return {
    clock, ids, saved, rows: journal.rows, journal, service, host, sessions, submitted, cancelled, prompts, ran, checkDirs, event, start, get, header, finishWith,
    turnOf: (sessionId: SessionId) => turns.get(sessionId),
    setResponder: (next: Responder | undefined) => void (responder = next),
    /** Held tasks: the task ids whose session got a prompt that was not answered. */
    sessionOf: (run: WorkflowRun, taskId: string) => get(run).tasks.find((task) => task.id === taskId)?.sessionId,
  }
}

/** An agent's structured answer in the block the task prompt asks for. */
export const output = (value: unknown) => `\`\`\`WORKFLOW_OUTPUT\n${JSON.stringify(value)}\n\`\`\`\n\`\`\`TASK_RESULT\nstatus: done\nsummary: ok\n\`\`\``
