import type { ExtensionLayer } from "@mendcode/packages"
import { redactSecrets, summarizeWorkflow, type LedgerPage, type ErrorCode, type PermissionMode, type QueueId, type SessionEvent, type SessionId, type TurnId, type WorkflowId, type WorkflowPlan, type WorkflowPlanInput, type WorkflowRun, type WorkflowSummary } from "@mendcode/protocol"
import type { CheckRunner } from "@mendcode/loops"
import type { WorkflowPort } from "@mendcode/tools"
import type { ScriptHostPort, ScriptJournalPort, ScriptMergePort, WorkflowDefinitionsPort, WorkflowService, WorkflowStorePort } from "@mendcode/workflows"
import type { WorkflowRevisionReceipt, WorkflowScriptInput, WorkflowScriptOrigin } from "@mendcode/protocol"

type Permission = WorkflowRun["permission"]
type Reply = { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }
type TimerHandle = { cancel(): void }
type Resolved = { plan: WorkflowPlan; receipt?: WorkflowRevisionReceipt } | { problems: string[] }
/** Who is asking: script workflows run code, so only a local client (not a remote address or an authenticated peer) may start or change one. `origin` is set by the daemon, never by a client. */
export type WorkflowAccess = { local: boolean; origin?: WorkflowScriptOrigin }
const LOCAL: WorkflowAccess = { local: true }
/** The model's own tools: a script it writes is `model`-origin and always goes through the tool's approval. */
const MODEL: WorkflowAccess = { local: true, origin: "model" }
const SCRIPT_WORK = /\bmode\s*:\s*["'`]work["'`]/

export type WorkflowCommand =
  | { type: "workflow.start"; directory: string; plan: WorkflowPlanInput; permission?: Permission | undefined; originSessionId?: SessionId | undefined; startKey?: string | undefined; loopId?: string | undefined; loopRunId?: string | undefined }
  | { type: "workflow.list"; directory?: string | undefined }
  | { type: "workflow.get"; workflowId: WorkflowId }
  | { type: "workflow.control"; workflowId: WorkflowId; action: "pause" | "resume" | "stop" | "retry" | "verify" | "accept" | "delete" | "approve" | "reject"; taskId?: string | undefined; reason?: string | undefined }
  | { type: "workflow.preview"; directory: string; plan: WorkflowPlanInput }
  | Omit<import("@mendcode/protocol").Command & { type: "workflow.save" }, "id" | "clientId">
  | { type: "workflow.definitions"; directory: string; limit?: number }
  | { type: "workflow.revision.get"; directory: string; revisionId: string }
  | Omit<Extract<import("@mendcode/protocol").Command, { type: "workflow.permissions" }>, "id" | "clientId">
  | Omit<Extract<import("@mendcode/protocol").Command, { type: "workflow.retry-phase" }>, "id" | "clientId">
  | Omit<Extract<import("@mendcode/protocol").Command, { type: "workflow.script" }>, "id" | "clientId">

/** Leading + trailing push per run (P12): a burst of task changes reaches clients as at most two events per window. */
export const WORKFLOW_CHANGED_COALESCE_MS = 250
const RANK: Record<Permission, number> = { ask: 0, edits: 1, full: 2 }

/** min(what the plan asks, what the user granted); `plan` mode grants nothing beyond ask. */
export function appliedPermission(requested: Permission | undefined, granted: PermissionMode | undefined): Permission {
  const grant: Permission = granted === "edits" || granted === "full" ? granted : "ask"
  if (!requested) return grant
  return RANK[requested] <= RANK[grant] ? requested : grant
}

const SCRIPT_LOCAL_ONLY = "script workflows run code and start only from the machine that runs them"
const fail = (code: ErrorCode, message: string): Reply => ({ ok: false, code, message: `[WORKFLOWS]: ${message}` })

/**
 * The daemon side of workflows (§3.6). `@mendcode/workflows` is imported, and the service built, only when a
 * `workflow.*` command arrives or the store has a live run at boot (P6: off = no module, no timer, no observer work).
 */
export function createWorkflowsHost(options: {
  store: WorkflowStorePort & { hasLive(): boolean }
  definitions: WorkflowDefinitionsPort
  clock: { now(): number; setTimer(ms: number, callback: () => void): TimerHandle }
  ids: Parameters<typeof import("@mendcode/workflows").createWorkflowService>[0]["ids"]
  layersFor(directory: string): ExtensionLayer[]
  /** The daemon's data directory: hidden from script hosts. */
  dataDir?: string
  /** Whether project files in this directory may run code (`trustedToolDirs`); absent means never. */
  isTrusted?(directory: string): boolean
  /** The journal of script workflows (the store's `workflowJournal`). Without it script runs fail clearly. */
  journal?: ScriptJournalPort
  /** The git side of script worktree results (branch and diff summary, reviewed integration branch). */
  merge?: ScriptMergePort
  /** Tests: a host other than the sandboxed process one. */
  scriptHost?: ScriptHostPort
  defaultPermission(directory: string): PermissionMode | undefined
  createSession(input: import("@mendcode/workflows").WorkflowSessionInput): SessionId
  prepareTask?: Parameters<typeof import("@mendcode/workflows").createWorkflowService>[0]["prepareTask"]
  routingProblems?(directory: string, plan: WorkflowPlan): string[]
  validateAgent?: Parameters<typeof import("@mendcode/workflows").createWorkflowService>[0]["validateAgent"]
  submit(input: { sessionId: SessionId; text: string }): Promise<{ queueId: QueueId } | { error: string }>
  cancelTurn(input: { sessionId: SessionId; turnId: TurnId }): unknown
  /** Removes a finished run's session; false when it cannot go now (a turn is running). */
  deleteSession(sessionId: SessionId): boolean
  runCheck: CheckRunner
  fingerprint(directory: string): Promise<string | undefined>
  /** One page of a run's evidence ledger; undefined when the run has none recorded. */
  ledger?(workflowId: WorkflowId, category: "event" | "artifact", query: { before?: number | undefined; limit: number }): LedgerPage | undefined
  emit(event: { type: "workflow.changed"; workflow: WorkflowSummary; deleted?: boolean }): void
}) {
  let service: WorkflowService | undefined
  let disposed = false
  let loading: Promise<WorkflowService> | undefined
  const windows = new Map<WorkflowId, { timer: TimerHandle; pending?: WorkflowRun }>()
  let definitions: ReturnType<typeof import("@mendcode/workflows").createWorkflowDefinitions> | undefined
  async function savedPlans() {
    const { createWorkflowDefinitions } = await import("@mendcode/workflows")
    return definitions ??= createWorkflowDefinitions({ store: options.definitions, now: () => options.clock.now() })
  }

  /** Leading edge now; later changes in the window collapse into one trailing push. */
  function changed(run: WorkflowRun, deleted?: boolean) {
    if (disposed) return
    if (deleted) {
      windows.get(run.workflowId)?.timer.cancel()
      windows.delete(run.workflowId)
      return options.emit({ type: "workflow.changed", workflow: summarizeWorkflow(run), deleted: true })
    }
    const window = windows.get(run.workflowId)
    if (window) return void (window.pending = run)
    options.emit({ type: "workflow.changed", workflow: summarizeWorkflow(run) })
    const open = (): TimerHandle =>
      options.clock.setTimer(WORKFLOW_CHANGED_COALESCE_MS, () => {
        const current = windows.get(run.workflowId)
        if (!current?.pending) return void windows.delete(run.workflowId)
        options.emit({ type: "workflow.changed", workflow: summarizeWorkflow(current.pending) })
        delete current.pending
        current.timer = open()
      })
    windows.set(run.workflowId, { timer: open() })
  }

  function load(): Promise<WorkflowService> {
    loading ??= Promise.all([import("@mendcode/workflows"), options.scriptHost || !options.journal || !options.dataDir ? undefined : import("./workflow-script-host")]).then(([{ createWorkflowService }, hosts]) => {
      const scriptHost = options.scriptHost ?? (options.dataDir ? hosts?.createProcessScriptHost({ dir: options.dataDir }) : undefined)
      service = createWorkflowService({
        store: options.store,
        clock: options.clock,
        ids: options.ids,
        ...(options.journal && scriptHost ? { scriptHost, journal: options.journal } : {}),
        ...(options.merge ? { merge: options.merge } : {}),
        createSession: options.createSession,
        ...(options.prepareTask ? { prepareTask: options.prepareTask } : {}),
        ...(options.validateAgent ? { validateAgent: options.validateAgent } : {}),
        submit: options.submit,
        cancelTurn: options.cancelTurn,
        runCheck: options.runCheck,
        fingerprint: options.fingerprint,
        onChange: changed,
      })
      service.start()
      return service
    })
    return loading
  }

  /** The plan to run: inline or a saved one by name, validated, with a named contract resolved and frozen. */
  async function resolve(directory: string, input: WorkflowPlanInput, access: WorkflowAccess = LOCAL): Promise<Resolved> {
    if ("definitionId" in input || "revisionId" in input) {
      try {
        const receipt = (await savedPlans()).get(directory, input)
        if (receipt.plan.script && !access.local) return { problems: [SCRIPT_LOCAL_ONLY] }
        return { plan: receipt.plan, receipt }
      } catch (error) {
        return { problems: [error instanceof Error ? error.message : String(error)] }
      }
    }
    if ("script" in input && typeof input.script === "string" || "scriptRef" in input) return resolveScript(directory, input as WorkflowScriptInput, access)
    const [{ readContracts, readWorkflowPlans }, { resolveContract, validatePlan }] = await Promise.all([import("./workflow-files"), import("@mendcode/workflows")])
    const layers = options.layersFor(directory)
    let raw: unknown = input
    if ("ref" in input) {
      const saved = readWorkflowPlans(layers).find((entry) => entry.name === input.ref)
      if (!saved) return { problems: [`no saved workflow named "${input.ref}"`] }
      if (!saved.plan) return { problems: [`workflows/${input.ref}.json: ${saved.problem}`] }
      raw = saved.plan
    }
    const checked = validatePlan(raw)
    if (!checked.ok) return { problems: checked.problems }
    if (checked.plan.script && !access.local) return { problems: [SCRIPT_LOCAL_ONLY] }
    const resolved = resolveContract(checked.plan, (name) => readContracts(layers).find((entry) => entry.name === name)?.contract)
    return resolved.ok ? { plan: resolved.plan } : { problems: resolved.problems }
  }

  /**
   * A script by source or by saved name (`workflows/<name>.js` in a layer). Its origin is decided here, not by the client: a
   * saved one is `user`, `project` or `package` by the layer it came from (project layers need a trusted directory), a typed-in
   * or model-written one is `inline`/`file`/`model`. Starting it still needs an approval that shows the meta, budget and hash.
   */
  async function resolveScript(directory: string, input: WorkflowScriptInput, access: WorkflowAccess): Promise<Resolved> {
    if (!access.local) return { problems: [SCRIPT_LOCAL_ONLY] }
    const [{ readContracts, readWorkflowScripts }, { buildScriptPlan, resolveContract, validatePlan }] = await Promise.all([import("./workflow-files"), import("@mendcode/workflows")])
    const layers = options.layersFor(directory)
    let source: string
    let origin: WorkflowScriptOrigin
    if ("script" in input) {
      source = input.script
      origin = access.origin ?? (input.origin === "file" ? "file" : "inline")
    } else {
      const found = readWorkflowScripts(layers).find((entry) => entry.name === input.scriptRef)
      if (!found) return { problems: [`no saved script named "${input.scriptRef}" (workflows/${input.scriptRef}.js)`] }
      if (found.text === undefined) return { problems: [`workflows/${input.scriptRef}.js: ${found.problem}`] }
      if (found.source === "project" && !options.isTrusted?.(directory)) return { problems: [`workflows/${input.scriptRef}.js comes from this project, which is not trusted for code. Trust it first (/tools trust)`] }
      source = found.text
      origin = found.pkg ? "package" : found.source
    }
    const built = buildScriptPlan({ source, args: input.args, origin })
    if (!built.ok) return { problems: built.problems }
    const checked = validatePlan(built.plan)
    if (!checked.ok) return { problems: checked.problems }
    const resolved = resolveContract(checked.plan, (name) => readContracts(layers).find((entry) => entry.name === name)?.contract)
    return resolved.ok ? { plan: resolved.plan } : { problems: resolved.problems }
  }

  function summaryOf(plan: WorkflowPlan, permission: Permission) {
    const contract = typeof plan.contract === "object" ? plan.contract : undefined
    return {
      name: plan.name,
      ...(plan.script ? { script: { hash: plan.script.hash, origin: plan.script.origin, meta: plan.script.meta, ...(plan.script.args ? { args: plan.script.args } : {}), source: plan.script.source } } : {}),
      tasks: plan.tasks.map((entry) => {
        if (entry.kind === "human") return { id: entry.id, kind: entry.kind, prompt: entry.prompt, needs: entry.needs }
        const task = entry.kind === "map" ? { ...entry.map.taskTemplate, kind: "agent" as const } : entry
        return { id: entry.id, kind: entry.kind, ...(task.kind !== "check" ? { mode: task.mode, output: task.output, inputs: task.inputs, routing: { model: task.model ?? plan.model, agent: task.agent ?? plan.agent, permission: appliedPermission(task.permission, permission), workflowPolicy: plan.permissions, taskPolicy: task.permissions, allowedTools: task.allowedTools, workflowBudget: plan.budget, taskBudget: task.budget } } : { command: task.command }), ...(entry.kind === "map" ? { map: { source: entry.map.source, maxItems: entry.map.maxItems, prompt: entry.map.taskTemplate.prompt } } : {}), workspace: task.workspace ?? entry.workspace ?? plan.workspace, ...(task.retry ? { retry: task.retry } : {}), needs: entry.needs }
      }),
      ...(plan.retention ? { retention: plan.retention } : {}),
      ...(plan.phases ? { phases: plan.phases } : {}),
      ...(plan.overlapPolicy ? { overlapPolicy: plan.overlapPolicy, overlapKey: plan.overlapKey ?? plan.name } : {}),
      checks: contract?.checks.map((check) => check.command) ?? [],
      permission,
      ...(plan.maxConcurrent ? { maxConcurrent: plan.maxConcurrent } : {}),
      ...(plan.maxRuntimeMinutes ? { maxRuntimeMinutes: plan.maxRuntimeMinutes } : {}),
    }
  }

  async function handle(command: WorkflowCommand, access: WorkflowAccess = LOCAL): Promise<Reply> {
      if (command.type === "workflow.script") {
        if (!access.local) return fail("forbidden", SCRIPT_LOCAL_ONLY)
        const workflows = await load()
        const run = workflows.get(command.workflowId)
        if (!run) return fail("target_mismatch", "unknown workflow")
        if (!run.plan.script) return fail("invalid_command", "not a script workflow")
        if (command.action === "budget" && !command.budget) return fail("invalid_command", "give at least one cap: agents, tokens, usd or minutes")
        if (command.action === "update" && !command.script) return fail("invalid_command", "give the edited script")
        const result = command.action === "budget" ? workflows.script.budget(command.workflowId, command.budget) : workflows.script.update(command.workflowId, command.script!, command.args)
        return "error" in result ? fail("busy", result.error) : { ok: true, result: { workflow: summarizeWorkflow(result.run) } }
      }
      if (command.type === "workflow.definitions") return { ok: true, result: { definitions: (await savedPlans()).list(command.directory, command.limit) } }
      if (command.type === "workflow.revision.get") {
        try {
          return { ok: true, result: { receipt: (await savedPlans()).get(command.directory, { revisionId: command.revisionId }) } }
        } catch (error) {
          return fail("target_mismatch", error instanceof Error ? error.message : String(error))
        }
      }
      if (command.type === "workflow.save") {
        const resolved = await resolve(command.directory, command.plan, access)
        if ("problems" in resolved) return fail("invalid_command", resolved.problems.join("; "))
        try {
          const receipt = (await savedPlans()).save({ ...command, plan: resolved.plan, saved: command.saved ?? true })
          return { ok: true, result: { receipt } }
        } catch (error) {
          return fail("invalid_command", error instanceof Error ? error.message : String(error))
        }
      }
      if (command.type === "workflow.preview" || command.type === "workflow.start") {
        const resolved = await resolve(command.directory, command.plan, access)
        if (!("problems" in resolved)) {
          const problems = options.routingProblems?.(command.directory, resolved.plan) ?? []
          if (problems.length) return command.type === "workflow.preview" ? { ok: true, result: { problems } } : fail("invalid_command", problems.join("; "))
        }
        if (command.type === "workflow.preview") {
          if ("problems" in resolved) return { ok: true, result: { problems: resolved.problems } }
          return { ok: true, result: { problems: [], summary: { ...summaryOf(resolved.plan, appliedPermission(resolved.plan.permission, options.defaultPermission(command.directory))), ...(resolved.receipt ? { definitionId: resolved.receipt.definitionId, revisionId: resolved.receipt.revisionId, revision: resolved.receipt.revision, planHash: resolved.receipt.planHash } : {}) } } }
        }
        if ("problems" in resolved) return fail("invalid_command", resolved.problems.join("; "))
        const workflows = await load()
        const previous = command.startKey ? workflows.list(command.directory).find((run) => run.startKey === command.startKey) : undefined
        if (previous) return { ok: true, result: { workflow: summarizeWorkflow(previous) } }
        // A script's agents are not known until it runs: it counts as changing the directory when its source asks for work agents.
        const hasWork = resolved.plan.script ? SCRIPT_WORK.test(resolved.plan.script.source) : resolved.plan.tasks.some((task) => task.kind === "agent" && task.mode === "work" || task.kind === "map" && task.map.taskTemplate.mode === "work")
        const clash = workflows.list(command.directory).find((run) => !["completed", "failed", "stopped"].includes(run.state) && run.tasks.some((task) => task.mode === "work"))
        if (hasWork && clash && !resolved.plan.overlapPolicy) return fail("busy", `workflow "${clash.name}" is already changing this directory`)
        const permission = appliedPermission(resolved.plan.permission, command.permission ?? options.defaultPermission(command.directory))
        const receipt = resolved.receipt ?? (await savedPlans()).save({ directory: command.directory, plan: resolved.plan, source: "session-generated", saved: false })
        try {
          const run = workflows.create({ plan: receipt.plan, planHash: receipt.planHash, definitionId: receipt.definitionId, revisionId: receipt.revisionId, revision: receipt.revision, name: receipt.definition.name, directory: command.directory, permission, ...(command.originSessionId ? { originSessionId: command.originSessionId } : {}), ...(command.startKey ? { startKey: command.startKey } : {}), ...(command.loopId ? { loopId: command.loopId } : {}), ...(command.loopRunId ? { loopRunId: command.loopRunId } : {}) })
          return { ok: true, result: { workflow: summarizeWorkflow(run) } }
        } catch (error) { return fail("busy", error instanceof Error ? error.message : String(error)) }
      }
      // Reads need no service when nothing was ever started: the store has the rows.
      if (command.type === "workflow.list") {
        const runs = service ? service.list(command.directory) : options.store.all().filter((run) => !command.directory || run.directory === command.directory)
        return { ok: true, result: { workflows: runs.sort((a, b) => b.updatedAt - a.updatedAt).map(summarizeWorkflow) } }
      }
      if (command.type === "workflow.get") {
        const run = service ? service.get(command.workflowId) : options.store.all().find((entry) => entry.workflowId === command.workflowId)
        return run ? { ok: true, result: { workflow: run } } : fail("target_mismatch", "unknown workflow")
      }
      const workflows = await load()
      const run = workflows.get(command.workflowId)
      if (!run) return fail("target_mismatch", "unknown workflow")
      if (command.type === "workflow.permissions" || command.type === "workflow.retry-phase") {
        const result = command.type === "workflow.permissions" ? workflows.permissions(command.workflowId, command) : workflows.control(command.workflowId, "retry-phase", command)
        return "error" in result ? fail("busy", result.error) : { ok: true, result: { workflow: summarizeWorkflow(result.run) } }
      }
      if (command.action === "delete") {
        // Sessions go first: a run whose session cannot be removed stays listed.
        const sessions = [run.rootSessionId, ...run.tasks.flatMap((task) => (task.sessionId ? [task.sessionId] : [])), ...run.verifications.flatMap((round) => (round.audit ? [round.audit.sessionId] : []))]
        if (!["completed", "failed", "stopped"].includes(run.state)) return fail("busy", "stop the workflow before deleting it")
        for (const sessionId of sessions) if (!options.deleteSession(sessionId)) return fail("busy", "a workflow session still has a turn running")
      }
      const result = workflows.control(command.workflowId, command.action, { ...(command.taskId ? { taskId: command.taskId } : {}), ...(command.reason ? { reason: command.reason } : {}) })
      if ("error" in result) return fail("busy", result.error)
      return { ok: true, result: command.action === "delete" ? {} : { workflow: summarizeWorkflow(result.run) } }
  }

  return {
    /** Loads the service at boot only when a run is still live (one indexed lookup otherwise). */
    boot() {
      if (options.store.hasLive()) void load()
    },
    loaded: () => service !== undefined,
    execution: (sessionId: SessionId) => service?.execution(sessionId),
    recordUsage: (sessionId: SessionId, event: Extract<SessionEvent, { type: "usage.recorded" }>) => service?.recordUsage(sessionId, event),
    handle,
    /** The workflow tools' view for one session: plans start in its directory, as its children. */
    port(sessionId: SessionId, directory: string): WorkflowPort {
      return {
        async preview(plan) {
          const reply = await handle({ type: "workflow.preview", directory, plan: plan as WorkflowPlanInput }, MODEL)
          if (!reply.ok) return { problems: [reply.message] }
          const problems = (reply.result?.problems ?? []) as string[]
          const summary = reply.result?.summary as ReturnType<typeof summaryOf> | undefined
          return summary ? { problems, detail: previewDetail(summary) } : { problems }
        },
        async start(plan) {
          const reply = await handle({ type: "workflow.start", directory, plan: plan as WorkflowPlanInput, originSessionId: sessionId }, MODEL)
          if (!reply.ok) return { ok: false, message: reply.message.replace(/^\[WORKFLOWS\]: /, "") }
          const workflow = reply.result!.workflow as WorkflowSummary
          return { ok: true, workflowId: workflow.workflowId, name: workflow.name, tasks: workflow.tasks.length }
        },
        async status(workflowId) {
          const runs = (workflowId ? [service?.get(workflowId as WorkflowId) ?? options.store.all().find((run) => run.workflowId === workflowId)] : (service?.list(directory) ?? options.store.all()).slice(0, 5)).filter((run): run is WorkflowRun => run !== undefined && run.directory === directory)
          if (!runs.length) return workflowId ? `unknown workflow ${workflowId}` : "no workflows in this project"
          return runs.map((run) => statusReceipt(summarizeWorkflow(run))).join("\n\n")
        },
        async previewControl(workflowId) {
          const run = service?.get(workflowId as WorkflowId) ?? options.store.all().find((entry) => entry.workflowId === workflowId)
          if (!run || run.directory !== directory) return "unknown workflow in this project"
          return `${statusReceipt(summarizeWorkflow(run))}\n\n${previewDetail(summaryOf(run.plan, run.permission))}`
        },
        async save(plan, extra = {}) {
          const reply = await handle({ type: "workflow.save", directory, plan: plan as WorkflowPlanInput, ...extra }, MODEL)
          return reply.ok ? { ok: true, receipt: reply.result!.receipt as WorkflowRevisionReceipt } : { ok: false, message: reply.message }
        },
        async ledger(workflowId, kind, query = {}) {
          const run = service?.get(workflowId as WorkflowId) ?? options.store.all().find((entry) => entry.workflowId === workflowId)
          if (!run || run.directory !== directory) return `unknown workflow ${workflowId}`
          const page = options.ledger?.(run.workflowId, kind === "events" ? "event" : "artifact", { ...(query.before ? { before: query.before } : {}), limit: query.limit ?? 20 })
          return page ? ledgerReceipt(kind, page) : `no ${kind} recorded for ${workflowId}`
        },
        async control(workflowId, action, extra = {}) {
          const run = service?.get(workflowId as WorkflowId) ?? options.store.all().find((entry) => entry.workflowId === workflowId)
          if (!run || run.directory !== directory) return { ok: false, message: "unknown workflow in this project" }
          const reply = await handle({ type: "workflow.control", workflowId: workflowId as WorkflowId, action, ...extra })
          return reply.ok ? { ok: true, output: action === "delete" ? `Deleted workflow ${workflowId}` : statusReceipt(reply.result!.workflow as WorkflowSummary) } : { ok: false, message: reply.message }
        },
      }
    },
    observe(event: SessionEvent) {
      service?.observe(event)
    },
    dispose() {
      disposed = true
      service?.dispose()
      for (const window of windows.values()) window.timer.cancel()
      windows.clear()
    },
  }
}
/** The approval text of `workflow_start`: exactly what will run. */
/** The approval text of a script: what it is, what it may spend, where it came from, its hash and the source itself (clipped). */
const SCRIPT_DETAIL_LINES = 80
function scriptDetail(summary: { name: string; script: { hash: string; origin: string; meta: { description?: string; phases?: Array<{ title: string; detail?: string | undefined }>; budget?: { agents?: number | undefined; tokens?: number | undefined; usd?: number | undefined; minutes?: number | undefined } | undefined; maxConcurrent?: number | undefined }; args?: unknown; source: string }; checks: string[]; permission: Permission; maxConcurrent?: number }) {
  const { script, permission } = summary
  const budget = script.meta.budget
  const caps = budget && Object.keys(budget).length ? Object.entries(budget).map(([key, value]) => `${key} ${value}`).join(", ") : "none declared (limited to 10 agent calls)"
  const lines = script.source.split("\n")
  return [
    `Script workflow "${summary.name}" · origin ${script.origin} · permission ${permission} · up to ${summary.maxConcurrent ?? 16} agents at once`,
    ...(script.meta.description ? [script.meta.description] : []),
    `Budget caps: ${caps}`,
    `Source sha256: ${script.hash}`,
    ...(script.meta.phases?.length ? [`Phases: ${script.meta.phases.map((phase) => phase.title).join(" > ")}`] : []),
    ...(script.args ? [`Arguments: ${JSON.stringify(script.args)}`] : []),
    ...(summary.checks.length ? ["Contract checks (run on this machine):", ...summary.checks.map((command) => `- ${command}`)] : ["No contract checks."]),
    "The script runs in an isolated process with no file, network or environment access; it can only start agents (which have the permission above), run checks and ask you questions.",
    "Source:",
    ...lines.slice(0, SCRIPT_DETAIL_LINES),
    ...(lines.length > SCRIPT_DETAIL_LINES ? [`... ${lines.length - SCRIPT_DETAIL_LINES} more lines`] : []),
  ].join("\n")
}

function previewDetail(summary: { name: string; script?: Parameters<typeof scriptDetail>[0]["script"]; tasks: Array<{ id: string; kind: string; mode?: string; command?: string; prompt?: string; retry?: unknown; needs: string[]; routing?: unknown; workspace?: unknown; map?: unknown; output?: unknown; inputs?: unknown }>; checks: string[]; permission: Permission; maxConcurrent?: number; maxRuntimeMinutes?: number; phases?: WorkflowPlan["phases"]; overlapPolicy?: string; overlapKey?: string; retention?: unknown }) {
  if (summary.script) return scriptDetail({ ...summary, script: summary.script })
  return [
    `Workflow "${summary.name}" · permission ${summary.permission} · concurrency ${summary.maxConcurrent ?? 2}${summary.maxRuntimeMinutes ? ` · runtime cap ${summary.maxRuntimeMinutes} min` : ""}`,
    "Tasks:",
    ...summary.tasks.map((task) => `- ${task.id} (${task.kind === "check" ? `check: ${task.command}` : task.kind === "map" ? `map · ${task.mode}` : task.kind === "human" ? "human: waits for you" : task.mode})${task.needs.length ? ` after ${task.needs.join(", ")}` : ""}`),
    ...summary.tasks.filter((task) => task.retry).map((task) => `  ${task.id}: retry ${JSON.stringify(task.retry)}`),
    ...(summary.retention ? [`Ledger retention: ${JSON.stringify(summary.retention)}`] : []),
    ...summary.tasks.filter((task) => task.routing || task.workspace).map((task) => `  ${task.id}: ${JSON.stringify({ routing: task.routing, workspace: task.workspace })}`),
    ...summary.tasks.filter((task) => task.map || task.output || task.inputs).map((task) => `  ${task.id}: ${JSON.stringify({ map: task.map, output: task.output, inputs: task.inputs })}`),
    ...(summary.phases?.map((phase) => `Phase ${phase.id}: ${phase.tasks.join(", ")} · ${JSON.stringify(phase.barrier)}`) ?? []),
    ...(summary.overlapPolicy ? [`Overlap: ${summary.overlapPolicy} · ${summary.overlapKey}`] : []),
    ...(summary.checks.length ? ["Contract checks (run on this machine):", ...summary.checks.map((command) => `- ${command}`)] : ["No contract checks."]),
  ].join("\n")
}

const LEDGER_RECEIPT_CHARS = 12_000
const LEDGER_DATA_CHARS = 1_500

/** One ledger page as bounded text for the model: secrets redacted, artifact payloads clipped, a cursor when more remains. */
export function ledgerReceipt(kind: "events" | "artifacts", page: LedgerPage): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  const lines = [`${page.ownerId} · ${kind} · retained ${page.retained} · latest #${page.latestSequence}${page.truncated ? " · older entries were dropped by retention" : ""}`]
  let next = page.nextBefore
  let used = lines[0]!.length
  for (const [index, entry] of page.entries.entries()) {
    const body = kind === "artifacts" ? `\n  ${clip(JSON.stringify(entry.data), LEDGER_DATA_CHARS)}` : ""
    const line = `#${entry.sequence} ${entry.kind}${entry.taskId ? ` [${entry.taskId}]` : ""} — ${clip(entry.title, 120)}: ${clip(entry.summary, 300)}${body}`
    if (used + line.length > LEDGER_RECEIPT_CHARS && index > 0) {
      next = page.entries[index - 1]!.sequence
      break
    }
    used += line.length
    lines.push(line)
  }
  if (!page.entries.length) lines.push("(no entries)")
  if (next) lines.push(`next_before: ${next}`)
  return redactSecrets(lines.join("\n")).text
}

/** A bounded status receipt for the model. */
function statusReceipt(run: WorkflowSummary) {
  const done = run.tasks.filter((task) => task.state === "done").length
  const last = run.verification
  return [
    `${run.workflowId} "${run.name}" · ${run.state}${run.reason ? ` (${run.reason})` : ""} · ${done}/${run.tasks.length} tasks`,
    ...(run.revisionId ? [`definition_id: ${run.definitionId}`, `revision_id: ${run.revisionId} (#${run.revision})`, `plan_hash: ${run.planHash}`] : []),
    ...run.tasks.map((task) => `- ${task.id}: ${task.state}${task.reason ? ` — ${task.reason}` : ""}`),
    ...(last ? [`verification round ${last.round}: ${last.accepted ? "accepted" : "rejected"} · ${last.criteria.map((entry) => `${entry.id} ${entry.status}`).join(", ")}`] : []),
  ].join("\n").slice(0, 4_000)
}

export type WorkflowsHost = ReturnType<typeof createWorkflowsHost>
