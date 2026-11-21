import { redactSecrets, type SessionEvent, type SessionId, type TaskRecord } from "@mendcode/protocol"

/**
 * "How far along is this sub-agent?", answered on demand (`task_status` action `progress`, the bridge's `task_progress`): the
 * sub-agent's own recorded thread (prompt, calls, texts, todo list, time) goes to a cheap model that says what it did, what it does
 * now and what seems left. Nothing runs unless the main agent asks: no timer, no stored row, loaded on first use.
 */
export const PROGRESS_LIMITS = {
  steps: 15,
  promptChars: 1_500,
  titleChars: 140,
  textChars: 240,
  todoChars: 800,
  /** About 6k tokens of the request. */
  inputChars: 24_000,
  /** About 200 tokens of the answer. */
  answerChars: 800,
  answerLines: 5,
  /** Events read from the end of a thread; its first events are read apart for the prompt. */
  tailEvents: 1_500,
  headEvents: 40,
  timeoutMs: 30_000,
} as const

export const PROGRESS_SYSTEM = [
  "You report on a running sub-agent to the agent that started it. You see only the sub-agent's prompt, its time, the number of tool calls, a list of its latest steps and its todo list, if it has one.",
  "Answer in 3 to 5 short lines, plain text: what it has done, what it is doing now, what seems left given its prompt, and a rough estimate of the remaining time or work labelled \"Estimate:\" (write \"Estimate: cannot estimate\" when the data does not support one).",
  "Use only what is given. Do not invent steps, files or results. When there is too little data, say so.",
].join(" ")

type Event = SessionEvent
export type AgentDigest = {
  label: string
  /** Where the sub-agent runs: a child session of MendCode or an engine's own sub-agent (Claude Code's Agent tool). */
  source: "child" | "engine"
  state: string
  finished: boolean
  prompt: string
  startedAt: number | undefined
  endedAt: number | undefined
  tools: number
  steps: string[]
  todos: string | undefined
  report: string | undefined
}

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text)
const oneLine = (text: string, length: number) => clip(redactSecrets(text).text.replace(/\s+/g, " ").trim(), length)
const TODO_TOOL = /^(todo|todowrite|taskcreate|taskupdate|tasklist)\b/i

/** The thread's facts from its events; `parent` selects the items of one engine sub-agent among a session's events, none takes them all. */
export function foldThread(events: readonly Event[], parent?: string): Pick<AgentDigest, "prompt" | "tools" | "steps" | "todos" | "report" | "startedAt" | "endedAt"> & { ended?: { status: string } } {
  type Step = { kind: "tool" | "said"; text: string; failed: boolean; done: boolean }
  const owned = new Map<string, { kind: string; title: string; step?: Step }>()
  const steps: Step[] = []
  let prompt = ""
  let tools = 0
  let todos: string | undefined
  let report: string | undefined
  /** The agent's latest ordinary text: the report when its end marker carries none (the summary repeated it). */
  let lastSaid: string | undefined
  let ended: { status: string } | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const event of events) {
    if (event.type === "item.started") {
      if (parent !== undefined && event.meta?.agentParent !== parent) continue
      // New activity after an end: the agent was woken again (Claude Code does on a later message) and is running, not finished.
      if (ended) { ended = undefined; report = undefined; lastSaid = undefined }
      const title = typeof event.meta?.tool === "string" ? event.meta.tool : ""
      const entry: { kind: string; title: string; step?: Step } = { kind: event.kind, title }
      owned.set(event.itemId, entry)
      startedAt ??= event.at
      if (event.kind === "tool_call") {
        tools++
        entry.step = { kind: "tool", text: oneLine(title || "tool", PROGRESS_LIMITS.titleChars), failed: false, done: false }
        steps.push(entry.step)
      } else if (event.kind === "agent_message") {
        entry.step = { kind: "said", text: "", failed: false, done: false }
        steps.push(entry.step)
      }
      continue
    }
    if (event.type !== "item.completed") continue
    const entry = owned.get(event.itemId)
    if (!entry) continue
    endedAt = event.at
    const text = event.text ?? ""
    if (entry.kind === "user_message" && !prompt && event.meta?.sentToAgent !== true) prompt = clip(redactSecrets(text).text.trim(), PROGRESS_LIMITS.promptChars)
    if (entry.kind === "tool_call") {
      if (entry.step) { entry.step.done = true; entry.step.failed = event.status === "error" }
      if (TODO_TOOL.test(entry.title.split(":")[0]!.trim()) && event.status === "ok" && text.trim()) todos = clip(redactSecrets(text).text.trim(), PROGRESS_LIMITS.todoChars)
    }
    if (entry.kind === "agent_message") {
      if (event.meta?.agentEnd === true) {
        ended = { status: event.status === "ok" ? "completed" : event.status === "cancelled" ? "cancelled" : "failed" }
        report = text.trim() ? oneLine(text, PROGRESS_LIMITS.textChars) : lastSaid
        const index = steps.indexOf(entry.step!)
        if (index >= 0) steps.splice(index, 1)
      } else if (entry.step) {
        entry.step.text = oneLine(text, PROGRESS_LIMITS.textChars); entry.step.done = true
        if (entry.step.text) lastSaid = entry.step.text
      }
    }
  }
  return {
    prompt, tools, todos, report, startedAt, endedAt: ended ? endedAt : undefined, ...(ended ? { ended } : {}),
    steps: steps.filter((step) => step.kind === "tool" || step.text).slice(-PROGRESS_LIMITS.steps).map((step) => step.kind === "tool" ? `tool: ${step.text}${step.failed ? " (failed)" : step.done ? "" : " (running)"}` : `said: ${step.text}`),
  }
}

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** The request the cheap model gets: facts only, bounded. */
export function progressPrompt(digest: AgentDigest, now: number): string {
  const lines = [
    `Sub-agent: ${digest.label}`,
    `State: ${digest.state}`,
    ...(digest.startedAt !== undefined ? [`Running for: ${elapsed((digest.endedAt ?? now) - digest.startedAt)}`] : ["Running for: unknown"]),
    `Tool calls so far: ${digest.tools}`,
    `Its prompt:\n${digest.prompt || "(not recorded)"}`,
    `Latest steps (oldest first, ${digest.steps.length}):\n${digest.steps.length ? digest.steps.map((step, index) => `${index + 1}. ${step}`).join("\n") : "(none yet)"}`,
    `Its todo list:\n${digest.todos ?? "(none)"}`,
  ]
  return clip(lines.join("\n\n"), PROGRESS_LIMITS.inputChars)
}

/** The answer cut to its bounds: a model that rambles still gives the main agent a short text. */
export function boundAnswer(text: string): string {
  const lines = redactSecrets(text).text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim())
  return clip(lines.slice(0, PROGRESS_LIMITS.answerLines).join("\n"), PROGRESS_LIMITS.answerChars)
}

export type AgentProgressInput = {
  now(): number
  tasks: { get(taskId: string): TaskRecord | undefined; list(parentId: SessionId): TaskRecord[] }
  events: {
    /** The newest `limit` events of a session. */
    tail(sessionId: SessionId, limit: number): readonly Event[]
    /** The first `limit` events of a session. */
    head(sessionId: SessionId, limit: number): readonly Event[]
  }
  /** One cheap-model completion; undefined when no helper model is available here. Counted as an auxiliary call by the caller. */
  ask(input: { sessionId: SessionId; system: string; prompt: string; signal: AbortSignal }): Promise<string | undefined>
}

type Target = { digest: AgentDigest } | { listing: string }

export function createAgentProgress(input: AgentProgressInput) {
  const ACTIVE = new Set(["queued", "running", "needs_input"])

  function child(task: TaskRecord): AgentDigest {
    const head = foldThread(input.events.head(task.taskId as SessionId, PROGRESS_LIMITS.headEvents))
    const tail = foldThread(input.events.tail(task.taskId as SessionId, PROGRESS_LIMITS.tailEvents))
    const finished = !ACTIVE.has(task.state)
    return {
      label: `${task.description} (${task.taskId}, agent ${task.agent})`, source: "child", state: task.state, finished,
      prompt: head.prompt || tail.prompt || oneLine(task.description, PROGRESS_LIMITS.promptChars),
      startedAt: task.startedAt ?? task.createdAt, endedAt: finished ? task.updatedAt : undefined,
      tools: tail.tools, steps: tail.steps, todos: tail.todos, report: finished ? oneLine(task.result, PROGRESS_LIMITS.textChars * 2) : undefined,
    }
  }

  /** The sub-agent calls an engine recorded in this session's recent events (Claude Code's Agent tool), newest last. */
  function engineCalls(parentId: SessionId) {
    const events = input.events.tail(parentId, PROGRESS_LIMITS.tailEvents * 2)
    return events.flatMap((event) => event.type === "item.started" && event.meta?.subagent === true ? [{ itemId: event.itemId as string, title: String(event.meta.tool ?? "agent").replace(/^agent\s+/, "") || "agent", at: event.at }] : []).map((call) => ({ ...call, events }))
  }

  function engine(call: { itemId: string; title: string; at: number }, events: readonly Event[]): AgentDigest {
    const folded = foldThread(events, call.itemId)
    const failed = events.some((event) => event.type === "item.completed" && event.itemId === call.itemId && event.status === "error")
    const finished = folded.ended !== undefined || failed
    return {
      label: `${call.title} (${call.itemId})`, source: "engine", state: folded.ended?.status ?? (failed ? "failed" : "running"), finished,
      prompt: folded.prompt || oneLine(call.title, PROGRESS_LIMITS.promptChars),
      startedAt: call.at, endedAt: finished ? folded.endedAt : undefined,
      tools: folded.tools, steps: folded.steps, todos: folded.todos, report: finished ? folded.report : undefined,
    }
  }

  function resolve(parentId: SessionId, taskId: string | undefined): Target {
    const children = input.tasks.list(parentId)
    const calls = engineCalls(parentId)
    const wanted = taskId?.trim()
    if (wanted) {
      const lower = wanted.toLowerCase()
      const task = children.find((entry) => entry.taskId === wanted) ?? children.find((entry) => entry.taskId.endsWith(wanted))
      if (task) return { digest: child(task) }
      const call = calls.find((entry) => entry.itemId === wanted) ?? calls.filter((entry) => entry.title.toLowerCase().includes(lower)).at(-1)
      if (call) return { digest: engine(call, call.events) }
      const named = children.filter((entry) => entry.description.toLowerCase().includes(lower)).at(-1)
      if (named) return { digest: child(named) }
      return { listing: `Unknown sub-agent ${wanted}. ${known(children, calls)}` }
    }
    const running = [
      ...children.filter((entry) => ACTIVE.has(entry.state)).map((task) => ({ task })),
      ...calls.filter((call) => !engine(call, call.events).finished).map((call) => ({ call })),
    ]
    if (running.length === 1) {
      const only = running[0]!
      return { digest: "task" in only ? child(only.task) : engine(only.call, only.call.events) }
    }
    if (running.length === 0) return { listing: `No sub-agent is running. ${known(children, calls)}` }
    return { listing: `${running.length} sub-agents are running; pass task_id for one of them: ${running.map((entry) => "task" in entry ? `${entry.task.taskId} (${entry.task.description})` : `${entry.call.itemId} (${entry.call.title})`).join("; ")}` }
  }

  function known(children: TaskRecord[], calls: Array<{ itemId: string; title: string }>): string {
    const names = [...children.slice(-8).map((task) => `${task.taskId} · ${task.state} · ${oneLine(task.description, 60)}`), ...calls.slice(-8).map((call) => `${call.itemId} · ${oneLine(call.title, 60)}`)]
    return names.length ? `Known: ${names.join("; ")}` : "This conversation has started none."
  }

  return {
    async progress(parentId: SessionId, taskId: string | undefined, signal: AbortSignal): Promise<string> {
      const target = resolve(parentId, taskId)
      if ("listing" in target) return target.listing
      const { digest } = target
      const facts = `${digest.label}\nState: ${digest.state}${digest.startedAt !== undefined ? ` · ${elapsed((digest.endedAt ?? input.now()) - digest.startedAt)}` : ""} · ${digest.tools} tool call${digest.tools === 1 ? "" : "s"}`
      // A finished sub-agent has nothing left to estimate: its result is the answer, and no model is called.
      if (digest.finished) return `${facts}\nIt has finished${digest.report ? `. Result: ${digest.report}` : "; it left no report."}`
      if (digest.tools === 0 && digest.steps.length === 0) return `${facts}\nIt has recorded no step yet, so there is nothing to report on its progress.`
      let answer: string | undefined
      try { answer = await input.ask({ sessionId: parentId, system: PROGRESS_SYSTEM, prompt: progressPrompt(digest, input.now()), signal }) }
      catch (error) { if (signal.aborted) throw error }
      const bounded = answer ? boundAnswer(answer) : ""
      if (bounded) return `${facts}\n${bounded}`
      // No helper model: the recorded steps themselves, never a guess.
      return `${facts}\nNo helper model was available to summarize it. Latest steps:\n${digest.steps.slice(-5).join("\n") || "(none)"}`
    },
  }
}
