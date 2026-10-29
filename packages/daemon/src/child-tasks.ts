import type { TaskPort } from "@mendcode/kernel"
import { createHash } from "node:crypto"
import type { Store } from "@mendcode/store"
import type { BlobRef, ModelChoice, PermissionMode, QueueId, SessionEvent, SessionId, TaskInput, TaskRecord } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { worktreeFooter, type TaskWorktrees } from "./task-worktree"

const ACTIVE = new Set(["queued", "running", "needs_input"])
/** Tools whose successful call wrote a file; a task's `stats.files` lists what they named. */
const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "notebook_edit"])
const MAX_FILES = 20

/** The files one edit call named: its path argument, or the file headers of a patch. */
function editedFiles(toolInput: string | undefined): string[] {
  let args: Record<string, unknown>
  try { args = JSON.parse(toolInput ?? "") as Record<string, unknown> } catch { return [] }
  if (!args || typeof args !== "object") return []
  for (const key of ["path", "file_path", "filePath", "notebook_path"]) if (typeof args[key] === "string") return [(args[key] as string).slice(0, 300)]
  const patch = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : ""
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim().slice(0, 300))
}

/** Usage and edits of one child, counted from its session's events while a generation runs and kept on the record when it ends. */
type Tally = { input: number; output: number; costMicros: number; priced: boolean; files: string[]; tools: Map<string, string> }
const tallyOf = (task: TaskRecord): Tally => ({ input: task.stats?.input ?? 0, output: task.stats?.output ?? 0, costMicros: task.stats?.costMicros ?? 0, priced: !task.stats || task.stats.costMicros !== undefined || task.stats.input + task.stats.output === 0, files: [...(task.stats?.files ?? [])], tools: new Map() })
const statsOf = (tally: Tally): NonNullable<TaskRecord["stats"]> => ({ input: tally.input, output: tally.output, ...(tally.priced && tally.costMicros ? { costMicros: tally.costMicros } : {}), files: tally.files })

export function createChildTasks(options: {
  store: Store
  now(): number
  id(): SessionId
  queueId(): QueueId
  changed(task: TaskRecord): void
  wake(): void
  background(task: TaskRecord): void
  /**
   * `isolation: "worktree"`: why a parent may not isolate a child now (tier, safe mode, plan mode), else undefined, and the
   * worktrees themselves. Absent: isolation is refused.
   */
  isolation?: { refused(parent: SessionId): string | undefined; worktrees: TaskWorktrees }
  agent(parent: SessionId, name: string, command?: boolean): boolean
  model(parent: SessionId, input: TaskInput): ModelChoice | undefined
  /** What a child launched with `model` (or with none of its own) will run on, for its record. */
  describe?(parent: SessionId, model: ModelChoice | undefined): TaskRecord["run"]
  permission(parent: SessionId): PermissionMode
  submit(session: SessionId, text: string, mode: PermissionMode, command?: { displayText: string; attachments: BlobRef[]; model?: ModelChoice }): Promise<void>
  cancel(session: SessionId): Promise<void>
}) {
  const { store, now } = options
  const get = (id: string) => store.tasks.list().find((task) => task.taskId === id)
  const lineage = (id: SessionId): { rootId: SessionId; depth: number } => {
    const task = get(id)
    if (task) return task
    const saved = store.meta.get(`orchestration.lineage:${id}`)
    return saved ? JSON.parse(saved) : { rootId: id, depth: 0 }
  }
  const admit = (rootId: SessionId) => {
    const key = `orchestration.spawns:${rootId}`
    const count = Number(store.meta.get(key) ?? store.tasks.list().filter((task) => task.rootId === rootId).length)
    if (count >= 256) throw new Error("subagent accumulated-spawn limit reached; resume an existing task")
    store.meta.set(key, String(count + 1))
  }
  const change = (task: TaskRecord, patch: Partial<TaskRecord>, announce = true) => {
    const next = { ...task, ...patch, updatedAt: now() }
    if (ACTIVE.has(task.state) && !ACTIVE.has(next.state) && next.background) store.sessionBackground.wakes.finish(next, options.queueId())
    else store.tasks.put(next)
    if (announce) {
      options.changed(next)
      if (next.background) options.background(next)
      if (!ACTIVE.has(next.state) && next.background) options.wake()
    }
    return next
  }
  /** Answers the live children are writing, by item. */
  const answers = new Set<string>()
  /** What each live child spent and wrote in its running generation, from its earlier generations on. */
  const tallies = new Map<string, Tally>()
  // The previous process cannot own a live child in this single-writer store.
  for (const task of store.tasks.list()) if (ACTIVE.has(task.state)) change(task, { state: "interrupted", result: "Daemon restarted; resume with task_id." }, false)

  async function wait(parentId: SessionId, taskId: string, timeoutMs: number, signal: AbortSignal) {
    const end = Date.now() + timeoutMs
    while (true) {
      const task = get(taskId)
      if (!task || task.parentId !== parentId) throw new Error("unknown child task for this session")
      if (!ACTIVE.has(task.state) || signal.aborted || Date.now() >= end) return task
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
        const timer = setTimeout(done, Math.min(20, Math.max(1, end - Date.now())))
        signal.addEventListener("abort", done, { once: true })
      })
    }
  }
  /** `byModel`: the owner's model reads the answer itself, so a finished background child's completion notice would only repeat it. */
  async function status(parentId: SessionId, input: Parameters<TaskPort["status"]>[1], signal: AbortSignal, byModel: boolean) {
    if (!input.task_id) return store.tasks.list().filter((task) => task.parentId === parentId).slice(-40).map((task) => `${task.taskId} · ${task.state} · ${task.description}`).join("\n") || "No child tasks"
    let task = get(input.task_id)
    if (!task || task.parentId !== parentId) throw new Error("unknown child task for this session")
    if (input.action === "cancel" && ACTIVE.has(task.state)) await options.cancel(task.taskId)
    if (input.action === "wait") task = await wait(parentId, task.taskId, Math.max(1, Math.min(input.timeout_ms ?? 30_000, 300_000)), signal)
    else task = get(task.taskId)!
    if (byModel && task.background && !ACTIVE.has(task.state) && !signal.aborted) store.sessionBackground.wakes.delivered({ task, queueId: options.queueId() })
    return `task_id: ${task.taskId}\nstate: ${task.state}\nagent: ${task.agent}\ndepth: ${task.depth}\ngeneration: ${task.generation}${input.action === "wait" ? `\nwait_timed_out: ${ACTIVE.has(task.state)}` : ""}\n${task.result}`
  }
  const port = {
    isChild: (sessionId) => get(sessionId) !== undefined,
    forkOf: (sessionId) => { const task = get(sessionId); return task?.fork ? task.parentId : undefined },
    async run(parentId, input, signal, command?: { displayText: string; attachments: BlobRef[]; model?: ModelChoice }) {
      if (!store.hasSession(parentId)) throw new Error("unknown parent session")
      const requestKey = input.clientRequestId ? `orchestration.task-request:${parentId}:${createHash("sha256").update(input.clientRequestId).digest("hex")}` : undefined
      const digest = createHash("sha256").update(JSON.stringify([Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))), command])).digest("hex")
      const receipt = requestKey ? store.meta.get(requestKey) : undefined
      if (receipt) {
        const accepted = JSON.parse(receipt) as { digest: string; taskId: string; generation: number }
        if (accepted.digest !== digest) throw new Error("Conflicting clientRequestId")
        const task = get(accepted.taskId)
        if (!task || task.parentId !== parentId || task.generation !== accepted.generation) throw new Error("Task receipt is no longer replayable; inspect the target")
        if (!input.background && !command && ACTIVE.has(task.state)) return wait(parentId, task.taskId, Number.MAX_SAFE_INTEGER, signal)
        return task
      }
      const requestCountKey = `orchestration.task-request-count:${parentId}`
      const requestCount = Number(store.meta.get(requestCountKey) ?? 0)
      if (requestKey && requestCount >= 256) throw new Error("Task receipt limit reached")
      const previous = input.task_id ? get(input.task_id) : undefined
      if (input.task_id && (!previous || previous.parentId !== parentId)) throw new Error("task_id is not a child of this session")
      if (previous && ACTIVE.has(previous.state)) throw new Error("task is already active")
      const parent = lineage(parentId)
      const depth = previous?.depth ?? parent.depth + 1
      const rootId = parent.rootId
      const settings = store.settings.get()
      if (depth > (settings.subagentDepth ?? 1)) throw new Error("subagent depth limit reached; resume the current task")
      const active = store.tasks.list().filter((task) => ACTIVE.has(task.state))
      // The limits name their number and where the user raises them: an agent told only "limit reached" guesses.
      const children = settings.subagentMaxChildren ?? 4
      if (active.filter((task) => task.parentId === parentId).length >= children) throw new Error(`subagent direct-child limit reached: ${children} children of this agent run at once; launch the next when one ends (the user raises it in /settings, Subagents · at once)`)
      const tree = settings.subagentMaxDescendants ?? 16
      if (active.filter((task) => task.rootId === rootId).length >= tree) throw new Error(`subagent descendant limit reached: ${tree} sub-agents run at once in this conversation; launch the next when one ends (the user raises it in /settings, Subagents · whole tree)`)
      if (input.fork && !featureOn(settings, "task_fork")) throw new Error("fork needs the task_fork feature (/tier task_fork on)")
      const agent = input.agent ?? previous?.agent ?? "general"
      if (!options.agent(parentId, agent, command !== undefined)) throw new Error(`unknown subagent ${agent}`)
      const model = command?.model ?? options.model(parentId, input)
      // Logical admissions, not active concurrency. Deleting old task rows cannot reset this tree's budget.
      const taskId = previous?.taskId ?? options.id()
      // A resumed child stays where it is; only a new one gets a worktree, made before it counts against the budget.
      let isolated: Awaited<ReturnType<TaskWorktrees["create"]>> | undefined
      if (!previous && input.isolation === "worktree") {
        const refused = options.isolation ? options.isolation.refused(parentId) : "isolation is not available here"
        if (refused) throw new Error(`isolation: "worktree" ${refused}`)
        isolated = await options.isolation!.worktrees.create(store.sessionDirectory(parentId)!, taskId)
      }
      if (!previous) {
        admit(rootId)
        store.meta.set(`orchestration.lineage:${taskId}`, JSON.stringify({ rootId, depth }))
        store.createSession({ id: taskId, directory: isolated?.directory ?? store.sessionDirectory(parentId)!, title: input.description, parentId })
        store.secrets.copy(parentId, taskId)
      }
      store.setSessionAgent(taskId, agent)
      if (model) store.setSessionModel(taskId, model)
      const task: TaskRecord = {
        taskId, parentId, rootId, depth, generation: (previous?.generation ?? 0) + 1, description: input.description,
        agent, background: input.background === true, state: "queued", result: "", createdAt: previous?.createdAt ?? now(), startedAt: now(), updatedAt: now(),
        ...(previous?.stats ? { stats: previous.stats } : {}),
        ...(isolated ? { worktree: isolated.worktree } : previous?.worktree ? { worktree: { path: previous.worktree.path, base: previous.worktree.base } } : {}),
        // Only a new child that works where its parent does can start from the parent's context.
        ...(previous?.fork || (!previous && input.fork && !isolated) ? { fork: true as const } : {}),
      }
      const run = options.describe?.(parentId, model ?? store.sessionModel(taskId))
      if (run) task.run = run
      store.tasks.put(task)
      if (requestKey) {
        store.meta.set(requestCountKey, String(requestCount + 1))
        store.meta.set(requestKey, JSON.stringify({ digest, taskId, generation: task.generation }))
      }
      options.changed(task)
      if (task.background) options.background(task)
      const abort = () => { void options.cancel(taskId) }
      if (!task.background) signal.addEventListener("abort", abort, { once: true })
      try {
        if (signal.aborted) throw new Error("task cancelled before submission")
        await options.submit(taskId, input.prompt, options.permission(parentId), command)
        if (task.background || command) return get(taskId)!
        const result = await wait(parentId, taskId, Number.MAX_SAFE_INTEGER, signal)
        if (signal.aborted) await options.cancel(taskId)
        return result
      } catch (error) {
        change(get(taskId) ?? task, { state: "failed", result: String(error).slice(0, 20_000) })
        throw error
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
    status: (parentId, input, signal) => status(parentId, input, signal, false),
  } satisfies TaskPort
  return {
    port,
    /** The port the engine gives the owner's model: what its `task_status` shows of a finished child is not announced again. */
    modelPort: { ...port, status: (parentId, input, signal) => status(parentId, input, signal, true) } satisfies TaskPort,
    admitIdle(parentId: SessionId, childId: SessionId) {
      const parent = lineage(parentId)
      const depth = parent.depth + 1
      if (depth > (store.settings.get().subagentDepth ?? 1)) throw new Error("subagent depth limit reached")
      admit(parent.rootId)
      store.meta.set(`orchestration.lineage:${childId}`, JSON.stringify({ rootId: parent.rootId, depth }))
    },
    start: (parentId: SessionId, input: TaskInput, command: { displayText: string; attachments: BlobRef[]; model?: ModelChoice }) => port.run(parentId, input, new AbortController().signal, command),
    get,
    list: (parentId?: SessionId) => store.tasks.list().filter((task) => !parentId || task.parentId === parentId).slice(-40),
    detach(parentId: SessionId, taskId: SessionId) {
      const task = get(taskId)
      if (!task || task.parentId !== parentId) throw new Error("unknown child task for this session")
      return change(task, { background: true })
    },
    observe(event: SessionEvent) {
      const task = get(event.sessionId)
      if (!task || !ACTIVE.has(task.state)) return
      if (event.type === "turn.started" || event.type === "server.request.resolved") change(task, { state: "running" })
      if (event.type === "server.request") change(task, { state: "needs_input" })
      // The child's answers are known from their start: a streamed answer is hundreds of events long, so its start is not looked up among the latest ones.
      if (event.type === "item.started" && event.kind === "agent_message") answers.add(event.itemId)
      if (event.type === "item.completed" && answers.delete(event.itemId) && event.status === "ok") change(task, { result: (event.text ?? "").slice(0, 20_000) })
      const tally = tallies.get(task.taskId) ?? tallies.set(task.taskId, tallyOf(task)).get(task.taskId)!
      if (event.type === "usage.recorded") {
        tally.input += event.input + event.cacheRead + event.cacheWrite
        tally.output += event.output
        if (event.costMicros === undefined) tally.priced = false
        else tally.costMicros += event.costMicros
      }
      if (event.type === "item.started" && event.kind === "tool_call") tally.tools.set(event.itemId, String(event.meta?.tool ?? "").split(":")[0]!)
      if (event.type === "item.completed" && tally.tools.has(event.itemId)) {
        if (event.status === "ok" && EDIT_TOOLS.has(tally.tools.get(event.itemId)!)) for (const file of editedFiles(event.toolInput)) if (!tally.files.includes(file) && tally.files.length < MAX_FILES) tally.files.push(file)
        tally.tools.delete(event.itemId)
      }
      const ends = { "turn.completed": "completed", "turn.failed": "failed", "turn.cancelled": "cancelled", "turn.interrupted": "interrupted" } as const
      if (!(event.type in ends)) return
      tallies.delete(task.taskId)
      const patch = { state: ends[event.type as keyof typeof ends], stats: statsOf(tally), ...(event.type === "turn.failed" ? { result: event.error.message } : {}) }
      const worktrees = options.isolation?.worktrees
      if (!task.worktree || !worktrees) return void change(get(task.taskId)!, patch)
      // An isolated child ends once its changes are on its branch, so whoever waits on it (a foreground parent, the owner wake) reads where they are.
      void worktrees.settle(get(task.taskId)!).catch(() => undefined).then((worktree) => {
        const current = get(task.taskId)
        if (!current || !ACTIVE.has(current.state)) return
        const result = "result" in patch ? patch.result : current.result
        const footer = worktree ? worktreeFooter(worktree) : ""
        change(current, { ...patch, ...(worktree ? { worktree } : {}), result: `${result.slice(0, 20_000 - footer.length)}${footer}` })
      })
    },
  }
}
