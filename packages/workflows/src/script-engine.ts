import { createHash } from "node:crypto"
import { parseCheck } from "@mendcode/loops"
import { WORKFLOW_SCRIPT_MAX_AGENTS, WorkflowAgentTaskSpec, WorkflowCheckTaskSpec, WorkflowHumanTaskSpec, WorkflowEngineId, WorkflowScriptBudget, effectiveScriptBudget, type WorkflowId, type WorkflowRun, type WorkflowTaskSpec } from "@mendcode/protocol"
import { scriptSpecRegistry } from "./composition"
import { captureOutput, schemaProblems } from "./outputs"
import { workflowPlanHash } from "./definitions"
import { addScriptTask, appendScriptLog, failScript, finishScript, pauseScriptRun, resetScriptHost, scriptHostIdle, scriptHostStarted, setScriptPhase } from "./run"
import { parseScript } from "./script-plan"
import { emptyTaskUsage, totalTaskUsage } from "./routing"

/**
 * The script side of the workflow engine. A script run is an ordinary run whose tasks are created while a sandboxed host
 * process executes the script: every `agent()`/`check()`/`ask()` call becomes a normal task (so scheduling, limits,
 * permissions, accounting, cancel and the views keep working) and its result is written to an event-sourced journal. The host is
 * disposable: on pause, stop, a cap, a restart or a resume it is killed and started again, and the script replays against the
 * journal, so completed calls answer instantly and only changed or new ones run.
 */

export type ScriptHostInput = {
  workflowId: WorkflowId
  body: string
  meta: unknown
  args: unknown
  seed: number
  now: number
  directory: string
  onMessage(message: Record<string, unknown>): void
  onExit(info: { reason: string }): void
}
export type ScriptHostHandle = { send(message: Record<string, unknown>): void; kill(reason: string): void }
/** Starts the isolated process (or, in tests, an in-process stand-in). The daemon implements it; this package never spawns. */
export type ScriptHostPort = { start(input: ScriptHostInput): ScriptHostHandle }

export type ScriptJournalPort = {
  get(workflowId: string, key: string): string | undefined
  set(workflowId: string, key: string, payload: string): void
  list(workflowId: string, prefix?: string): Array<{ key: string; payload: string }>
  removeRun(workflowId: string): void
}

/** What a worktree agent left behind, as its `detail` result shows it: the branch its changes were committed to and the size of the change. */
export type WorktreeSummary = { branch: string; commit: string; files: number; insertions: number; deletions: number; changed: string[] }
/** The git side of worktree results, done by the daemon: summarize a worktree, build the reviewed integration branch, merge it into the checkout. */
export type MergeOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string; conflict?: boolean }
export type ScriptMergePort = {
  /**
   * `branch` and `message` name the branch and commit of a caller that is not a workflow (a `task` child in its own worktree);
   * `base` is the commit the worktree started from, so commits the agent made itself count in the size too.
   */
  summarize(input: { workflowId: string; taskId: string; workspace: string; branch?: string; message?: string; base?: string }): Promise<WorktreeSummary | undefined>
  /** Idempotent: merging worktrees whose branches are already in the integration branch is a no-op, so a resumed run continues after conflicts were resolved there. */
  prepare(input: { directory: string; workflowId: string; workspaces: Array<{ workspace: string; branch?: string }>; message: string }): Promise<MergeOutcome>
  apply(input: { directory: string; branch: string }): Promise<MergeOutcome>
}

type Timer = { cancel(): void }
type Context = {
  host?: ScriptHostPort | undefined
  journal?: ScriptJournalPort | undefined
  merge?: ScriptMergePort | undefined
  clock: { now(): number; setTimer(ms: number, callback: () => void): Timer }
  get(workflowId: WorkflowId): WorkflowRun | undefined
  /** Applies a reducer step, saves it, pumps the scheduler (the service's `change`). */
  update(workflowId: WorkflowId, apply: (run: WorkflowRun) => WorkflowRun): WorkflowRun | undefined
  cancelTasks(run: WorkflowRun, taskIds: Iterable<string>): void
  disposed(): boolean
  /** The daemon's routing check of an agent call (unknown engine or model, an engine that cannot enforce the call's limits): a problem string rejects the call before any session exists. */
  validateAgent?(directory: string, spec: Extract<WorkflowTaskSpec, { kind: "agent" }>): string | undefined
}

type Waiter = { kind: "agent" | "check" | "ask"; key: string; taskId: string; detail: boolean }
type HostRuntime = { handle: ScriptHostHandle; waiters: Map<number, Waiter>; occurrences: Map<string, number>; timers: Set<Timer>; intentional: boolean; started: number }

/** The journal entry of a finished call; `value` is what the script receives (parsed JSON with a schema, else the text). */
type CallEntry = { kind: "agent" | "check" | "ask" | "merge"; ok: boolean; value?: unknown; text?: string; detail?: string; taskId: string; workspace?: string; diff?: WorktreeSummary; label?: string; at: number }
type SpecEntry = { spec: WorkflowTaskSpec; key: string; cwd?: string }

export const MAX_SCRIPT_TASKS = 250
const TEXT_LIMIT = 32_000
const MEMO_LIMIT = 16 * 1024
const AGENT_KEYS = new Set(["label", "phase", "schema", "mode", "worktree", "model", "effort", "engine", "agent", "retry", "timeoutMinutes", "budget", "detail", "allowedTools"])
const CHECK_KEYS = new Set(["label", "phase", "timeoutSeconds", "in"])

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex")
export const scriptTaskId = (key: string) => `c${createHash("sha256").update(key).digest("hex").slice(0, 14)}`
const seedOf = (workflowId: string) => {
  let hash = 2166136261
  for (const char of workflowId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0 || 1
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const firstLine = (text: string) => text.trim().split("\n")[0]!.trim()

/** The answer without the machine blocks the task prompt asked for. */
export function answerText(answer: string): string {
  return answer.replace(/```(?:TASK_RESULT|WORKFLOW_OUTPUT)\b[\s\S]*?```/g, "").trim()
}

type AgentCall = { identity: unknown; build(id: string): unknown; mode: "read" | "work"; label: string; title: string; phase?: string; isolated: boolean; detail: boolean }

function normalizeAgent(prompt: unknown, opts: unknown): AgentCall | { error: string } {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8_000) return { error: "agent(prompt): the prompt must be 1 to 8000 characters" }
  const options = opts === undefined ? {} : opts
  if (!record(options)) return { error: "agent options must be an object" }
  for (const key of Object.keys(options)) if (!AGENT_KEYS.has(key)) return { error: `unknown agent option "${key}" (allowed: ${[...AGENT_KEYS].join(", ")})` }
  const text = (key: string, max: number) => (typeof options[key] === "string" && options[key].length <= max ? (options[key] as string) : undefined)
  const label = text("label", 80)
  const phase = text("phase", 80)
  const mode = options.mode === undefined ? "read" : options.mode
  if (mode !== "read" && mode !== "work") return { error: 'mode must be "read" or "work"' }
  if (options.worktree !== undefined && typeof options.worktree !== "boolean") return { error: "worktree must be a boolean" }
  if (options.detail !== undefined && typeof options.detail !== "boolean") return { error: "detail must be a boolean" }
  if (options.model !== undefined && (typeof options.model !== "string" || !options.model)) return { error: "model must be a model id string" }
  if (options.effort !== undefined && (typeof options.effort !== "string" || options.model === undefined)) return { error: "effort needs a model and must be a string" }
  if (options.engine !== undefined && (typeof options.engine !== "string" || !WorkflowEngineId.safeParse(options.engine).success)) return { error: 'engine must be "native", "claude", "codex", "pi" or "acp:<name>"' }
  if (options.schema !== undefined) {
    const problems = schemaProblems(options.schema)
    if (problems.length) return { error: `schema: ${problems[0]}` }
  }
  const retry = options.retry === undefined ? undefined : typeof options.retry === "number" ? { maxAttempts: options.retry, backoffMs: 0, retryOn: ["transient", "environment", "quality"] } : options.retry
  const worktree = options.worktree === true
  const identity = { kind: "agent", prompt, schema: options.schema, mode, worktree, model: options.model, effort: options.effort, engine: options.engine, agent: options.agent, allowedTools: options.allowedTools, budget: options.budget }
  const title = clip(label ?? firstLine(prompt), 80)
  return {
    identity,
    mode,
    label: label ?? title,
    title,
    ...(phase ? { phase } : {}),
    isolated: worktree,
    detail: options.detail === true,
    build: (id: string) => ({
      kind: "agent",
      id,
      title,
      prompt,
      needs: [],
      mode,
      ...(options.schema !== undefined ? { output: { kind: "json", schema: options.schema } } : {}),
      ...(options.timeoutMinutes !== undefined ? { timeoutMinutes: options.timeoutMinutes } : {}),
      ...(retry ? { retry } : {}),
      ...(options.model !== undefined ? { model: { model: options.model, ...(options.effort !== undefined ? { effort: options.effort } : {}) } } : {}),
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(worktree ? { workspace: { mode: "per-run-worktree" } } : {}),
      ...(record(options.budget) ? { budget: { ...(options.budget.tokens !== undefined ? { maxTokens: options.budget.tokens } : {}), ...(options.budget.usd !== undefined ? { maxCost: options.budget.usd } : {}) } } : {}),
    }),
  }
}

export function createScriptEngine(ctx: Context) {
  const hosts = new Map<WorkflowId, HostRuntime>()
  const specs = new Map<string, SpecEntry>()
  const journal = ctx.journal

  const read = <T>(workflowId: string, key: string): T | undefined => {
    const payload = journal?.get(workflowId, key)
    if (payload === undefined) return undefined
    try {
      return JSON.parse(payload) as T
    } catch {
      return undefined
    }
  }
  const write = (workflowId: string, key: string, value: unknown) => {
    if (!journal) throw new Error("the workflow journal is not available")
    journal.set(workflowId, key, JSON.stringify(value))
  }
  const specEntry = (workflowId: string, taskId: string): SpecEntry | undefined => {
    const memo = `${workflowId}/${taskId}`
    const known = specs.get(memo)
    if (known) return known
    const stored = read<SpecEntry>(workflowId, `spec:${taskId}`)
    if (stored) specs.set(memo, stored)
    return stored
  }
  scriptSpecRegistry.addLoader((workflowId, taskId) => specEntry(workflowId, taskId)?.spec)

  function reply(runtime: HostRuntime, id: number, outcome: { ok: true; value?: unknown } | { ok: false; error: string }, at = ctx.clock.now()) {
    runtime.handle.send({ t: "reply", id, at, ...outcome })
  }

  /** The stable key of a call: its content hash plus how many identical calls came before it in this replay. */
  function nextKey(runtime: HostRuntime, identity: unknown): string {
    const hash = digest(identity).slice(0, 32)
    const n = runtime.occurrences.get(hash) ?? 0
    runtime.occurrences.set(hash, n + 1)
    return `${hash}.${n}`
  }

  function shape(entry: CallEntry, waiter: Waiter): unknown {
    if (waiter.kind === "check") return { ok: entry.ok, detail: entry.detail ?? "" }
    if (waiter.kind === "agent" && waiter.detail) return { value: entry.value, text: entry.text ?? "", taskId: entry.taskId, ...(entry.workspace ? { workspace: entry.workspace } : {}), ...(entry.diff ? { branch: entry.diff.branch, diff: { commit: entry.diff.commit, files: entry.diff.files, insertions: entry.diff.insertions, deletions: entry.diff.deletions, changed: entry.diff.changed } } : {}), ...(entry.label ? { label: entry.label } : {}) }
    return entry.value
  }

  /** Answers every waiting call whose result is now in the journal (or whose task failed). */
  function deliver(workflowId: WorkflowId) {
    const runtime = hosts.get(workflowId)
    const run = ctx.get(workflowId)
    if (!runtime || !run) return
    for (const [id, waiter] of [...runtime.waiters]) {
      const entry = read<CallEntry>(workflowId, `call:${waiter.key}`)
      if (entry) {
        runtime.waiters.delete(id)
        reply(runtime, id, { ok: true, value: shape(entry, waiter) }, entry.at)
        continue
      }
      const task = run.tasks.find((candidate) => candidate.id === waiter.taskId)
      if (task?.state === "failed") {
        runtime.waiters.delete(id)
        reply(runtime, id, { ok: false, error: `${waiter.kind === "ask" ? "ask" : waiter.kind}("${task.label ?? task.title}") failed: ${task.reason ?? "no reason"}` })
      }
    }
  }

  function capReason(run: WorkflowRun, incomingAgent = false): string | undefined {
    const budget = effectiveScriptBudget(run)
    const usage = run.tasks.length ? totalTaskUsage(run) : emptyTaskUsage()
    if (incomingAgent && (run.script?.calls ?? 0) >= (budget.agents ?? WORKFLOW_SCRIPT_MAX_AGENTS)) {
      const declared = run.plan.script?.meta.budget?.agents !== undefined || run.script?.budget?.agents !== undefined
      return declared ? `agent cap reached (${run.script?.calls}/${budget.agents})` : `agent cap reached (${run.script?.calls}/${budget.agents}): declare meta.budget.agents to run more than ${budget.agents} agents`
    }
    if (incomingAgent && run.tasks.length >= MAX_SCRIPT_TASKS) return `task limit reached (${MAX_SCRIPT_TASKS})`
    if (budget.tokens !== undefined && usage.input + usage.output >= budget.tokens) return `token cap reached (${usage.input + usage.output}/${budget.tokens})`
    if (budget.usd !== undefined && usage.costUnknown) return "cost cap cannot be enforced: provider price is unknown"
    if (budget.usd !== undefined && (usage.costMicros ?? 0) >= Math.round(budget.usd * 1_000_000)) return `cost cap reached ($${((usage.costMicros ?? 0) / 1_000_000).toFixed(4)}/$${budget.usd})`
    if (JSON.stringify(run).length > 150 * 1024) return "the run record is full (150 KB)"
    return undefined
  }

  /** A cap: the run pauses with the reason, running tasks go back to pending, the host stops. The user raises the cap and resumes. */
  function pauseForCap(workflowId: WorkflowId, reason: string, hint = `raise it with "workflow budget ${workflowId}" and resume`) {
    const run = ctx.get(workflowId)
    if (!run || run.state === "paused" || run.state === "stopped" || run.state === "completed") return
    ctx.cancelTasks(run, run.tasks.filter((task) => task.state === "running").map((task) => task.id))
    ctx.update(workflowId, (current) => pauseScriptRun(current, `${reason}; ${hint}`, ctx.clock.now()))
  }

  /**
   * `merge(results)` of a script: `prepare` builds the reviewed integration branch from the worktree results of this run, `apply`
   * merges it into the checkout (the script asked the user first). Both are journaled, so a resumed run never repeats a finished one.
   * A conflict is not a failure: the run pauses with the files, and resuming runs `prepare` again over what was resolved.
   */
  function mergeCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const port = ctx.merge
    const run = ctx.get(workflowId)!
    if (!port || !journal) return reply(runtime, id, { ok: false, error: "merge needs a git checkout and a daemon with worktree support" })
    let key: string
    let task: () => Promise<MergeOutcome>
    if (message.step === "prepare") {
      const results = message.results
      if (!Array.isArray(results) || !results.length || results.length > 16) return reply(runtime, id, { ok: false, error: "merge(results): between 1 and 16 results" })
      const known = journal.list(workflowId, "call:").map((row) => JSON.parse(row.payload) as CallEntry).filter((entry) => entry.workspace !== undefined)
      const workspaces: Array<{ workspace: string; branch?: string; taskId: string }> = []
      for (const result of results) {
        const wanted = record(result) ? (typeof result.taskId === "string" ? result.taskId : result.workspace) : undefined
        const entry = known.find((candidate) => candidate.taskId === wanted || candidate.workspace === wanted)
        if (!entry?.workspace) return reply(runtime, id, { ok: false, error: "merge(results): every result must come from agent(..., { worktree: true, detail: true }) of this run" })
        if (!workspaces.some((seen) => seen.taskId === entry.taskId)) workspaces.push({ workspace: entry.workspace, taskId: entry.taskId, ...(entry.diff ? { branch: entry.diff.branch } : {}) })
      }
      const note = typeof message.message === "string" ? clip(message.message, 200) : `workflow ${run.name}`
      key = nextKey(runtime, { kind: "merge", step: "prepare", tasks: workspaces.map((entry) => entry.taskId), note })
      task = () => port.prepare({ directory: run.directory, workflowId, workspaces: workspaces.map(({ workspace, branch }) => ({ workspace, ...(branch ? { branch } : {}) })), message: note })
    } else if (message.step === "apply") {
      const branch = message.branch
      const prepared = typeof branch === "string" ? journal.list(workflowId, "call:").map((row) => JSON.parse(row.payload) as CallEntry).find((entry) => entry.kind === "merge" && record(entry.value) && entry.value.branch === branch) : undefined
      if (typeof branch !== "string" || !prepared) return reply(runtime, id, { ok: false, error: "merge: apply needs the branch a merge(...) of this run prepared" })
      key = nextKey(runtime, { kind: "merge", step: "apply", branch })
      task = () => port.apply({ directory: run.directory, branch })
    } else return reply(runtime, id, { ok: false, error: "merge: bad step" })
    const done = read<CallEntry>(workflowId, `call:${key}`)
    if (done) return reply(runtime, id, { ok: true, value: done.value }, done.at)
    const current = () => !ctx.disposed() && hosts.get(workflowId) === runtime
    void task().then((outcome) => {
      if (!current()) return
      if (outcome.ok) {
        const at = ctx.clock.now()
        write(workflowId, `call:${key}`, { kind: "merge", ok: true, value: outcome.value, taskId: "", at } satisfies CallEntry)
        return reply(runtime, id, { ok: true, value: outcome.value }, at)
      }
      if (outcome.conflict) return pauseForCap(workflowId, outcome.message, "resolve them in the integration worktree, then resume (the merge continues from there)")
      reply(runtime, id, { ok: false, error: outcome.message })
    }, (error: unknown) => {
      if (current()) reply(runtime, id, { ok: false, error: `merge failed: ${error instanceof Error ? error.message : String(error)}` })
    })
  }

  function createTask(workflowId: WorkflowId, spec: WorkflowTaskSpec, key: string, extra: { mode?: "read" | "work"; label?: string; phase?: string; isolated?: boolean; cwd?: string }) {
    const routed = spec.kind === "agent" ? { ...(spec.engine ? { engine: spec.engine } : {}), ...(spec.model ? { modelId: spec.model.model } : {}) } : {}
    write(workflowId, `spec:${spec.id}`, { spec, key, ...(extra.cwd ? { cwd: extra.cwd } : {}) } satisfies SpecEntry)
    specs.set(`${workflowId}/${spec.id}`, { spec, key, ...(extra.cwd ? { cwd: extra.cwd } : {}) })
    scriptSpecRegistry.set(workflowId, spec)
    ctx.update(workflowId, (run) => addScriptTask(run, { id: spec.id, title: spec.title, kind: spec.kind, ...(extra.mode ? { mode: extra.mode } : {}), ...(extra.label ? { label: extra.label } : {}), ...(extra.phase ? { phase: extra.phase } : {}), ...(extra.isolated ? { isolated: true } : {}), ...routed }, ctx.clock.now()))
  }

  function agentCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const normalized = normalizeAgent(message.prompt, message.opts)
    if ("error" in normalized) return reply(runtime, id, { ok: false, error: normalized.error })
    const key = nextKey(runtime, normalized.identity)
    const taskId = scriptTaskId(key)
    const spec = WorkflowAgentTaskSpec.safeParse(normalized.build(taskId))
    if (!spec.success) return reply(runtime, id, { ok: false, error: `agent options: ${spec.error.issues[0]?.path.join(".") || "(root)"} ${spec.error.issues[0]?.message ?? "invalid"}` })
    const run = ctx.get(workflowId)!
    const existing = run.tasks.find((task) => task.id === taskId)
    const journaled = read<CallEntry>(workflowId, `call:${key}`)
    if (!existing && !journaled) {
      const problem = ctx.validateAgent?.(run.directory, spec.data)
      if (problem) return reply(runtime, id, { ok: false, error: problem })
    }
    runtime.waiters.set(id, { kind: "agent", key, taskId, detail: normalized.detail })
    if (!existing && !journaled) {
      const reason = capReason(run, true)
      if (reason) {
        runtime.waiters.delete(id)
        return pauseForCap(workflowId, reason)
      }
      createTask(workflowId, spec.data, key, { mode: normalized.mode, label: normalized.label, ...(normalized.phase ? { phase: normalized.phase } : {}), isolated: normalized.isolated })
    }
    deliver(workflowId)
  }

  function checkCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const opts = message.opts === undefined ? {} : message.opts
    if (!record(opts)) return reply(runtime, id, { ok: false, error: "check options must be an object" })
    for (const key of Object.keys(opts)) if (!CHECK_KEYS.has(key)) return reply(runtime, id, { ok: false, error: `unknown check option "${key}" (allowed: ${[...CHECK_KEYS].join(", ")})` })
    const command = message.command
    if (typeof command !== "string") return reply(runtime, id, { ok: false, error: "check(command): command must be a string" })
    const parsed = parseCheck(command)
    if ("error" in parsed) return reply(runtime, id, { ok: false, error: `check: ${parsed.error}` })
    let cwd: string | undefined
    if (opts.in !== undefined) {
      const wanted = typeof opts.in === "string" ? opts.in : record(opts.in) ? (typeof opts.in.taskId === "string" ? opts.in.taskId : typeof opts.in.workspace === "string" ? opts.in.workspace : undefined) : undefined
      cwd = wanted === undefined ? undefined : journal?.list(workflowId, "call:").map((row) => JSON.parse(row.payload) as CallEntry).find((entry) => entry.workspace !== undefined && (entry.taskId === wanted || entry.workspace === wanted))?.workspace
      if (cwd === undefined) return reply(runtime, id, { ok: false, error: "check: `in` must be the result of an agent({ worktree: true, detail: true }) call of this run" })
    }
    const key = nextKey(runtime, { kind: "check", command, cwd, timeoutSeconds: opts.timeoutSeconds })
    const taskId = scriptTaskId(key)
    const label = typeof opts.label === "string" ? clip(opts.label, 80) : clip(command, 80)
    const spec = WorkflowCheckTaskSpec.safeParse({ kind: "check", id: taskId, title: label, command, needs: [], ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}) })
    if (!spec.success) return reply(runtime, id, { ok: false, error: `check options: ${spec.error.issues[0]?.path.join(".") || "(root)"} ${spec.error.issues[0]?.message ?? "invalid"}` })
    runtime.waiters.set(id, { kind: "check", key, taskId, detail: false })
    const run = ctx.get(workflowId)!
    if (!run.tasks.some((task) => task.id === taskId) && !read(workflowId, `call:${key}`)) {
      const reason = capReason(run, true)
      if (reason) {
        runtime.waiters.delete(id)
        return pauseForCap(workflowId, reason)
      }
      createTask(workflowId, spec.data, key, { label, ...(typeof opts.phase === "string" ? { phase: clip(opts.phase, 80) } : {}), ...(cwd ? { cwd } : {}) })
    }
    deliver(workflowId)
  }

  function askCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const question = message.question
    const options = message.options
    if (typeof question !== "string" || !question.trim() || question.length > 2_000) return reply(runtime, id, { ok: false, error: "ask(question): the question must be 1 to 2000 characters" })
    if (options !== undefined && (!Array.isArray(options) || options.length > 12 || options.some((entry) => typeof entry !== "string" || !entry || entry.length > 120))) return reply(runtime, id, { ok: false, error: "ask(question, options): up to 12 short strings" })
    const key = nextKey(runtime, { kind: "ask", question, options })
    const taskId = scriptTaskId(key)
    const spec = WorkflowHumanTaskSpec.safeParse({ kind: "human", id: taskId, title: clip(firstLine(question), 80), prompt: `${question}${options ? `\nAnswer with one of: ${options.join(" | ")}` : ""}`, needs: [] })
    if (!spec.success) return reply(runtime, id, { ok: false, error: "ask: invalid question" })
    runtime.waiters.set(id, { kind: "ask", key, taskId, detail: false })
    const run = ctx.get(workflowId)!
    if (!run.tasks.some((task) => task.id === taskId) && !read(workflowId, `call:${key}`)) createTask(workflowId, spec.data, key, { label: spec.data.title })
    deliver(workflowId)
  }

  function sleepCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const ms = message.ms
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 300_000) return reply(runtime, id, { ok: false, error: "sleep: ms must be between 0 and 300000" })
    const key = nextKey(runtime, { kind: "sleep", ms })
    const done = read<{ at: number }>(workflowId, `sleep:${key}`)
    if (done) return reply(runtime, id, { ok: true }, done.at)
    const timer = ctx.clock.setTimer(ms, () => {
      runtime.timers.delete(timer)
      if (ctx.disposed() || hosts.get(workflowId) !== runtime) return
      const at = ctx.clock.now()
      write(workflowId, `sleep:${key}`, { at })
      reply(runtime, id, { ok: true }, at)
    })
    runtime.timers.add(timer)
  }

  function memoCall(workflowId: WorkflowId, runtime: HostRuntime, id: number, message: Record<string, unknown>) {
    const key = message.key
    if (typeof key !== "string" || !key || key.length > 120) return reply(runtime, id, { ok: false, error: "memo: key must be a short string" })
    const name = `memo:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`
    if (message.step === "get") {
      const stored = read<{ value: unknown }>(workflowId, name)
      return reply(runtime, id, { ok: true, value: stored ? { hit: true, value: stored.value } : { hit: false } })
    }
    if (message.step !== "set") return reply(runtime, id, { ok: false, error: "memo: bad step" })
    const encoded = JSON.stringify({ value: message.value ?? null })
    if (encoded.length > MEMO_LIMIT) return reply(runtime, id, { ok: false, error: `memo: value is larger than ${MEMO_LIMIT / 1024} KiB` })
    journal?.set(workflowId, name, encoded)
    reply(runtime, id, { ok: true })
  }

  function onMessage(workflowId: WorkflowId, runtime: HostRuntime, message: Record<string, unknown>) {
    if (ctx.disposed() || hosts.get(workflowId) !== runtime) return
    const run = ctx.get(workflowId)
    if (!run?.script) return
    switch (message.t) {
      case "phase":
        if (typeof message.title === "string") ctx.update(workflowId, (current) => setScriptPhase(current, clip(message.title as string, 80), ctx.clock.now()))
        return
      case "log":
        if (typeof message.message === "string" && Number.isInteger(message.n)) ctx.update(workflowId, (current) => appendScriptLog(current, message.n as number, message.message as string, ctx.clock.now()))
        return
      case "done": {
        const result = message.result === undefined ? undefined : JSON.stringify(message.result)
        if (result !== undefined) try { write(workflowId, "result", { value: message.result }) } catch {}
        stopHost(workflowId, "the script returned")
        ctx.update(workflowId, (current) => finishScript(current, result, ctx.clock.now()))
        return
      }
      case "error":
        stopHost(workflowId, "the script threw")
        failRun(workflowId, `the script failed: ${typeof message.message === "string" ? clip(message.message, 400) : "unknown error"}`)
        return
      case "call": {
        const id = message.id
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return
        try {
          if (message.kind === "agent") agentCall(workflowId, runtime, id, message)
          else if (message.kind === "check") checkCall(workflowId, runtime, id, message)
          else if (message.kind === "ask") askCall(workflowId, runtime, id, message)
          else if (message.kind === "merge") mergeCall(workflowId, runtime, id, message)
          else if (message.kind === "sleep") sleepCall(workflowId, runtime, id, message)
          else if (message.kind === "memo") memoCall(workflowId, runtime, id, message)
          else reply(runtime, id, { ok: false, error: `unknown call ${String(message.kind)}` })
        } catch (error) {
          reply(runtime, id, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      default:
    }
  }

  function failRun(workflowId: WorkflowId, message: string) {
    const run = ctx.get(workflowId)
    if (!run) return
    ctx.cancelTasks(run, run.tasks.filter((task) => task.state === "running").map((task) => task.id))
    ctx.update(workflowId, (current) => {
      let next = current
      for (const task of current.tasks) if (task.state === "running") next = { ...next, tasks: next.tasks.map((entry) => (entry.id === task.id ? { ...entry, state: "pending" as const } : entry)) }
      return failScript(next, message, ctx.clock.now())
    })
  }

  function stopHost(workflowId: WorkflowId, reason: string) {
    const runtime = hosts.get(workflowId)
    if (!runtime) return
    hosts.delete(workflowId)
    runtime.intentional = true
    for (const timer of runtime.timers) timer.cancel()
    runtime.timers.clear()
    try {
      runtime.handle.kill(reason)
    } catch {}
  }

  /** Starts the host when the run should be executing its script and none runs. Idempotent. */
  function ensureHost(workflowId: WorkflowId) {
    const run = ctx.get(workflowId)
    if (!run?.script || !run.plan.script || ctx.disposed()) return
    if (hosts.has(workflowId) || run.script.host === "done" || run.script.host === "failed") return
    if (run.state !== "running" && run.state !== "needs_input") return
    if (!ctx.host || !ctx.journal) return void failRun(workflowId, "workflow scripts cannot run in this daemon (no isolated host or journal)")
    const parsed = parseScript(run.plan.script.source)
    if (!parsed.ok) return void failRun(workflowId, `the script is no longer valid: ${parsed.problems[0]}`)
    const reason = capReason(run)
    if (reason) return void pauseForCap(workflowId, reason)
    const runtime: HostRuntime = { handle: undefined as unknown as ScriptHostHandle, waiters: new Map(), occurrences: new Map(), timers: new Set(), intentional: false, started: ctx.clock.now() }
    hosts.set(workflowId, runtime)
    try {
      runtime.handle = ctx.host.start({
        workflowId,
        body: parsed.body,
        meta: run.plan.script.meta,
        args: run.plan.script.args ?? {},
        seed: seedOf(workflowId),
        now: run.startedAt,
        directory: run.directory,
        onMessage: (message) => onMessage(workflowId, runtime, message),
        onExit: (info) => {
          if (runtime.intentional || hosts.get(workflowId) !== runtime || ctx.disposed()) return
          hosts.delete(workflowId)
          for (const timer of runtime.timers) timer.cancel()
          failRun(workflowId, `the script host stopped: ${info.reason}`)
        },
      })
    } catch (error) {
      hosts.delete(workflowId)
      return void failRun(workflowId, `the script host could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    ctx.update(workflowId, (current) => scriptHostStarted(current, ctx.clock.now()))
  }

  /** After every saved change of a script run: answer what the journal can now answer, and stop a host that should not run. */
  function onChanged(run: WorkflowRun) {
    if (!run.script) return
    if (hosts.has(run.workflowId)) {
      if (run.state !== "running" && run.state !== "needs_input") {
        stopHost(run.workflowId, `the run is ${run.state}`)
        if (run.script.host === "running") ctx.update(run.workflowId, (current) => scriptHostIdle(current, ctx.clock.now()))
        return
      }
      deliver(run.workflowId)
    }
  }

  const SPEC_KEY = (workflowId: string, taskId: string) => specEntry(workflowId, taskId)

  /** A finished agent task: validates its answer (schema) and journals it. `error` asks the service for one repair turn. */
  function recordAgent(run: WorkflowRun, taskId: string, answer: string, diff?: WorktreeSummary): { ok: true } | { ok: false; error: string } {
    const entry = SPEC_KEY(run.workflowId, taskId)
    const task = run.tasks.find((candidate) => candidate.id === taskId)
    if (!entry || entry.spec.kind !== "agent" || !task) return { ok: false, error: "unknown script task" }
    const text = clip(answerText(answer), TEXT_LIMIT)
    let value: unknown = text
    if (entry.spec.output?.kind === "json") {
      try {
        const output = captureOutput(entry.spec, answer, TEXT_LIMIT)
        value = output ? JSON.parse(output.value) : text
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const workspace = entry.spec.workspace?.mode === "per-run-worktree" ? task.execution?.directory : undefined
    write(run.workflowId, `call:${entry.key}`, { kind: "agent", ok: true, value, text, taskId, ...(workspace ? { workspace } : {}), ...(diff ? { diff } : {}), ...(task.label ? { label: task.label } : {}), at: ctx.clock.now() } satisfies CallEntry)
    return { ok: true }
  }

  function recordCheck(run: WorkflowRun, taskId: string, ok: boolean, detail: string) {
    const entry = SPEC_KEY(run.workflowId, taskId)
    if (!entry) return
    write(run.workflowId, `call:${entry.key}`, { kind: "check", ok, detail: clip(detail, 2_000), taskId, at: ctx.clock.now() } satisfies CallEntry)
  }

  /** The user's answer to an `ask`: an approval carries the note (checked against the options), a rejection rejects the call. */
  function recordAsk(run: WorkflowRun, taskId: string, decision: "approve" | "reject", note: string | undefined): string | undefined {
    const entry = SPEC_KEY(run.workflowId, taskId)
    if (!entry || entry.spec.kind !== "human") return undefined
    if (decision === "reject") return undefined
    const answer = note?.trim() || "approved"
    const options = /Answer with one of: (.*)$/m.exec(entry.spec.prompt)?.[1]?.split(" | ")
    let value = answer
    if (options) {
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1
      const chosen = options[index] ?? options.find((option) => option.toLowerCase() === answer.toLowerCase())
      if (chosen === undefined) return `answer one of: ${options.join(", ")}`
      value = chosen
    }
    write(run.workflowId, `call:${entry.key}`, { kind: "ask", ok: true, value, taskId, at: ctx.clock.now() } satisfies CallEntry)
    return undefined
  }

  function cwdOf(run: WorkflowRun, taskId: string): string | undefined {
    return SPEC_KEY(run.workflowId, taskId)?.cwd
  }

  /** The caps again after usage was recorded. */
  function checkCaps(workflowId: WorkflowId) {
    const run = ctx.get(workflowId)
    if (!run?.script || run.state === "paused" || run.state === "stopped") return
    const reason = capReason(run)
    if (reason) pauseForCap(workflowId, reason)
  }

  /** Raise or set the caps of a script run (the declared ones stay in the frozen plan; these replace them). */
  function setBudget(workflowId: WorkflowId, budget: unknown): { run: WorkflowRun } | { error: string } {
    const run = ctx.get(workflowId)
    if (!run?.script) return { error: "not a script workflow" }
    const parsed = WorkflowScriptBudget.safeParse(budget)
    if (!parsed.success || !Object.keys(parsed.data).length) return { error: "give at least one cap: agents, tokens, usd or minutes" }
    const merged = { ...run.script.budget, ...parsed.data }
    const next = ctx.update(workflowId, (current) => ({ ...current, updatedAt: ctx.clock.now(), script: { ...current.script!, budget: merged } }))
    return next ? { run: next } : { error: "unknown workflow" }
  }

  /** Swaps in an edited script. Calls that are still queued or running are dropped (the replay asks again for those it still wants); finished ones stay in the journal. */
  function replaceScript(workflowId: WorkflowId, source: string, args?: Record<string, unknown>): { run: WorkflowRun } | { error: string } {
    const run = ctx.get(workflowId)
    if (!run?.script || !run.plan.script) return { error: "not a script workflow" }
    if (!["paused", "failed", "blocked"].includes(run.state)) return { error: `pause the workflow first (it is ${run.state})` }
    const parsed = parseScript(source)
    if (!parsed.ok) return { error: parsed.problems.join("; ") }
    const script = { ...run.plan.script, source, hash: parsed.hash, meta: parsed.meta, ...(args ? { args } : {}) }
    const plan = { ...run.plan, script }
    ctx.cancelTasks(run, run.tasks.filter((task) => task.state === "running").map((task) => task.id))
    const next = ctx.update(workflowId, (current) => {
      const kept = current.tasks.filter((task) => !["pending", "running", "needs_input"].includes(task.state))
      const { definitionId: _definitionId, revisionId: _revisionId, revision: _revision, ...rest } = current
      return resetScriptHost({ ...rest, plan, planHash: workflowPlanHash(plan), tasks: kept, updatedAt: ctx.clock.now(), script: { ...current.script!, calls: kept.filter((task) => task.kind === "agent").length } })
    })
    return next ? { run: next } : { error: "unknown workflow" }
  }

  return {
    isScript: (run: WorkflowRun | undefined): run is WorkflowRun & { script: NonNullable<WorkflowRun["script"]> } => !!run?.script,
    ensureHost,
    stopHost,
    onChanged,
    deliver,
    recordAgent,
    recordCheck,
    recordAsk,
    cwdOf,
    checkCaps,
    setBudget,
    replaceScript,
    capReason,
    pauseForCap,
    /** The frozen spec of a script task (journal-backed). */
    specOf: (workflowId: string, taskId: string) => specEntry(workflowId, taskId)?.spec,
    /** A run was deleted: its journal and spec views go. */
    forget(workflowId: WorkflowId) {
      stopHost(workflowId, "the run was deleted")
      scriptSpecRegistry.clear(workflowId)
      for (const key of [...specs.keys()]) if (key.startsWith(`${workflowId}/`)) specs.delete(key)
      journal?.removeRun(workflowId)
    },
    hasHost: (workflowId: WorkflowId) => hosts.has(workflowId),
    dispose() {
      for (const workflowId of [...hosts.keys()]) stopHost(workflowId, "the daemon is stopping")
      specs.clear()
    },
  }
}
export type ScriptEngine = ReturnType<typeof createScriptEngine>
