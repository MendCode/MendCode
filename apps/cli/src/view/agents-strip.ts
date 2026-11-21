import type { ForegroundState, TaskRecord } from "@mendcode/protocol"
import { subagentColor } from "./agent-color"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { compact } from "./format"
import { clip, fit, lineWidth, spread } from "./deck"
import { formatElapsed } from "./time"
import { truncateEnd } from "./wrap"
import { backgroundName, type BackgroundItem } from "./background-row"
import { markOpenRow } from "./agent-cue"

/** Rows of sub-agents the strip keeps when commands fill their share too; with fewer commands the sub-agents take the rows left. */
export const AGENTS_SHOWN = 4
/** A sub-agent that just ended stays in the strip this long, so its outcome is seen before the row goes. */
export const AGENT_DONE_MS = 8_000
/** Background commands the strip keeps when sub-agents fill their share too; with fewer sub-agents the commands take the rows left. */
export const COMMANDS_SHOWN = 3
/** Rows of sub-agents and commands together before the rest fold into `+N more`. */
export const STRIP_ROWS = AGENTS_SHOWN + COMMANDS_SHOWN

const ACTIVE: ReadonlySet<TaskRecord["state"]> = new Set(["queued", "running", "needs_input"])

/** What a row of the strip needs of a sub-agent: a child task of the daemon, or a thread an engine reports inside the session. */
export type StripTask = Pick<TaskRecord, "taskId" | "description" | "agent" | "background" | "state" | "createdAt" | "updatedAt" | "startedAt"> & { run?: TaskRecord["run"]; /** How full its context is: the tokens, and the limit when it is known. */ context?: { tokens: number; limit?: number | undefined } | undefined; /** Stopped by the user's esc: its row stays, saying how to start it again. */ stoppedByUser?: true }

/**
 * What a sub-agent runs on, in one line: `Sol 6.1 · openai · native · low · fast`. Each fact has its own colour, so the line reads
 * at a glance and is not one run of grey: the model as body text, the engine, the effort, and `fast` when calls ask for priority.
 * The provider is left out when it is the engine's own name.
 */
export function runSpans(run: NonNullable<TaskRecord["run"]>, shownModel: (id: string) => string, sep: string): Span[] {
  const facts: Span[] = [
    { text: shownModel(run.model), fg: "body" },
    ...(run.provider && run.provider !== run.engine ? [{ text: run.provider, fg: "muted" as const }] : []),
    { text: run.engine, fg: "info" },
    ...(run.variant ? [{ text: run.variant, fg: "synType" as const }] : []),
    ...(run.effort ? [{ text: run.effort, fg: "warning" as const }] : []),
    ...(run.fast ? [{ text: "fast", fg: "success" as const }] : []),
  ]
  return facts.flatMap((fact, at): Span[] => (at ? [{ text: ` ${sep} `, fg: "muted" }, fact] : [fact]))
}

/** What the daemon's activity push says of a sub-agent's session while its turn runs. */
export type AgentActivity = { state: ForegroundState; since?: number; tool?: string; pending?: string; paused?: boolean }

/**
 * The sub-agents of the open session worth a row now: the ones at work, then the ones that ended a moment ago or that the user stopped.
 * The one open in the chat (`open`) keeps its row however long ago it ended, so the list never loses the agent being read.
 */
export function stripTasks<T extends StripTask>(tasks: readonly T[], now: number, open?: string): T[] {
  const shown = tasks.filter((task) => ACTIVE.has(task.state) || task.stoppedByUser || task.taskId === open || now - task.updatedAt < AGENT_DONE_MS)
  return [...shown.filter((task) => ACTIVE.has(task.state)), ...shown.filter((task) => !ACTIVE.has(task.state))]
}

/** Whether any sub-agent in the strip is still at work (the strip then animates and counts time). */
export function stripActive(tasks: readonly StripTask[]): boolean {
  return tasks.some((task) => ACTIVE.has(task.state))
}

/** What a row says it is doing now, or how it ended. */
export function doing(task: StripTask, activity: AgentActivity | undefined, sep: string): Span {
  if (task.state === "completed") return { text: "done", fg: "success" }
  if (task.state === "failed") return { text: "failed", fg: "error" }
  if (task.stoppedByUser) return { text: `stopped by you ${sep} /relaunch`, fg: "warning" }
  if (task.state === "cancelled") return { text: "cancelled", fg: "muted" }
  if (task.state === "interrupted") return { text: "interrupted", fg: "warning" }
  if (task.state === "needs_input" || activity?.state === "waiting_approval") return { text: activity?.pending ? `needs you: ${activity.pending}` : "needs you", fg: "warning" }
  if (activity?.paused) return { text: "paused", fg: "warning" }
  if (task.state === "queued") return { text: "queued", fg: "muted" }
  if (activity?.state === "tool" && activity.tool) return { text: activity.tool, fg: "body" }
  if (activity?.state === "compacting") return { text: "compacting", fg: "muted" }
  return { text: "thinking", fg: "muted" }
}

/** `ctx 42%` against a known limit (amber from 60 %, red from 85 %, as the footer's), else the tokens alone: `ctx 42K`. */
export function contextText(context: NonNullable<StripTask["context"]>): { text: string; fg: ColorName } {
  if (!context.limit) return { text: `ctx ${compact(context.tokens)}`, fg: "muted" }
  const percent = Math.round((context.tokens / context.limit) * 100)
  return { text: `ctx ${percent}%`, fg: percent >= 85 ? "error" : percent >= 60 ? "warning" : "muted" }
}

/** Rows the strip may take when each sub-agent says what it runs on a line of its own; past it the model goes on the row. */
export const DETAIL_ROWS = 8

/**
 * The sub-agents of the open session, live, as a tree hanging from the working line: one row each with what it was asked, whether
 * the session waits for it (`await`) or it runs on its own (`async`), what it is doing now and for how long. The agent's name is a
 * column only when the rows differ in it. Without a working line (`root`: the session rests while they work) a head line counts
 * them and names the key that opens one. Rows carry no spinner: the working line has the only one, so the two never read as one list.
 * What a sub-agent runs on (`run`) is a line of its own under its row while the strip fits in `DETAIL_ROWS`, or the model alone on
 * the row past it. `ids` names what each row opens (a sub-agent, a background item), so a click never counts rows to find it.
 */
export function renderAgentsStrip(input: { tasks: readonly StripTask[]; /** The sub-agent open in the chat's place: its row is marked and stays listed. */ open?: string; /** What a sub-agent runs on, when the rows say it. */ run?: (task: StripTask) => Span[] | undefined; activity(taskId: string): AgentActivity | undefined; now: number; width: number; inset: number; glyphs: Glyphs; root: boolean; openHint: string; /** The session's background commands (and engine tasks no thread names): rows of the same tree, so one block lists all that runs. */ commands?: readonly (BackgroundItem & { id?: string })[] }): { rows: Line[]; ids: Array<string | undefined> } {
  const tasks = stripTasks(input.tasks, input.now, input.open)
  if (!tasks.length) return { rows: [], ids: [] }
  const commands = input.commands ?? []
  const { width, glyphs: g } = input
  const pad: Span = { text: " ".repeat(input.inset) }
  const room = Math.max(1, width - input.inset * 2)
  const active = tasks.filter((task) => ACTIVE.has(task.state))
  const rows: Line[] = []
  const ids: Array<string | undefined> = []
  const push = (row: Line, id?: string) => { rows.push(row); ids.push(id) }
  if (input.root) {
    const needs = active.filter((task) => task.state === "needs_input" || input.activity(task.taskId)?.state === "waiting_approval").length
    const stopped = tasks.filter((task) => task.stoppedByUser).length
    const counts = [active.length ? `${active.length} running` : stopped ? `${stopped} stopped by you` : `${tasks.length} finished`, ...(needs ? [`${needs} ${needs === 1 ? "needs" : "need"} you`] : []), ...(commands.length ? [`${commands.length} command${commands.length === 1 ? "" : "s"}`] : [])].join(` ${g.sep} `)
    const head: Line = [{ text: "Agents", fg: "primary" }, { text: `  ${counts}`, fg: needs ? "warning" : "muted" }]
    const hint: Line = [{ text: commands.length ? `${input.openHint} ${g.sep} /ps` : input.openHint, fg: "muted" }]
    push([pad, ...(lineWidth(head) + lineWidth(hint) + 2 <= room ? spread(head, hint, room) : fit(head, room))])
  }
  // Sub-agents and commands share one budget of rows: each keeps its own share when both overflow, and rows one list leaves go to the other.
  const agentRows = Math.min(tasks.length, STRIP_ROWS - Math.min(commands.length, COMMANDS_SHOWN))
  const opened = tasks.findIndex((task) => task.taskId === input.open)
  // The sub-agent being read always keeps its row, in place of the last one that fits.
  const shown = opened >= agentRows ? [...tasks.slice(0, agentRows - 1), tasks[opened]!] : tasks.slice(0, agentRows)
  const shownCommands = commands.slice(0, STRIP_ROWS - shown.length)
  const more = tasks.length - shown.length + commands.length - shownCommands.length
  const cells = (text: string) => lineWidth([{ text }])
  const described = (task: StripTask) => task.description.replace(/\s+/g, " ") || task.agent
  // Every row has the same columns: rail, description, agent (only when they differ), mode, activity, time. The activity takes up to
  // half of what the fixed columns leave, the description the rest, and whatever short descriptions leave goes back to the activity.
  const agentWidth = room >= 90 && new Set(shown.map((task) => task.agent)).size > 1 ? Math.min(12, Math.max(...shown.map((task) => task.agent.length))) : 0
  const modeWidth = room >= 60 ? 5 : 0
  // What each one runs on (the full tier passes `run`): a line under its row while the strip fits, else the model on the row.
  const runs = new Map(shown.flatMap((task) => { const spans = input.run?.(task); return spans?.length ? [[task.taskId, spans] as const] : [] }))
  const detail = runs.size > 0 && rows.length + shown.length + runs.size + shownCommands.length + (more ? 1 : 0) <= DETAIL_ROWS
  const inline = detail ? new Map<string, Span[]>() : new Map([...runs].map(([id, spans]) => [id, spans.slice(0, 1)]))
  const runWidth = inline.size ? Math.min(20, Math.max(...[...inline.values()].map(lineWidth))) : 0
  // How full each one's context is, a column only when a row has the figure and the strip is wide enough for it.
  const contexts = new Map(shown.flatMap((task) => (task.context ? [[task.taskId, contextText(task.context)] as const] : [])))
  const ctxWidth = room >= 60 && contexts.size ? Math.max(...[...contexts.values()].map((entry) => cells(entry.text))) : 0
  const TIME = 9 + (ctxWidth ? ctxWidth + 1 : 0)
  const free = Math.max(8, room - 2 - (agentWidth ? agentWidth + 2 : 0) - (modeWidth ? modeWidth + 2 : 0) - (runWidth ? runWidth + 2 : 0) - 2 - TIME)
  const statusWant = Math.max(...shown.map((task) => cells(doing(task, input.activity(task.taskId), g.sep).text)))
  // A row the user stopped names the command that starts it again: that status is read whole, the descriptions give way.
  const statusRoom = shown.some((task) => task.stoppedByUser) ? statusWant : Math.max(8, Math.floor(free / 2))
  const titleWidth = Math.max(4, Math.min(Math.max(...shown.map((task) => cells(described(task))), ...shownCommands.map((item) => cells(backgroundName(item.command, 200)))), free - Math.min(statusWant, statusRoom)))
  const statusWidth = Math.max(1, free - titleWidth)
  shown.forEach((task, index) => {
    const activity = input.activity(task.taskId)
    const running = ACTIVE.has(task.state)
    const status = doing(task, activity, g.sep)
    // A resumed child counts from its current run, not from its first (which may be a day old).
    const since = task.startedAt ?? (running && activity?.since ? Math.min(activity.since, task.createdAt) : task.createdAt)
    const elapsed = formatElapsed((running ? input.now : task.updatedAt) - since)
    const last = index === shown.length - 1 && !more && !shownCommands.length
    const here = task.taskId === input.open
    const left: Line = [
      here ? { text: last ? "└▸" : "├▸", fg: subagentColor(task.description), bold: true } : { text: last ? "└ " : "├ ", fg: "muted" },
      ...fit([{ text: truncateEnd(described(task), titleWidth), fg: running || here ? subagentColor(task.description) : "muted", ...(here ? { bold: true } : {}) }], titleWidth),
      ...(agentWidth ? [{ text: `  ${task.agent.slice(0, agentWidth).padEnd(agentWidth)}`, fg: "muted" as const }] : []),
      ...(modeWidth ? [{ text: `  ${(task.background ? "async" : "await").padEnd(modeWidth)}`, fg: task.background ? ("muted" as const) : ("accent" as const) }] : []),
      ...(runWidth ? [{ text: "  " }, ...fit(clip(inline.get(task.taskId) ?? [], runWidth), runWidth)] : []),
      { text: "  " },
      { ...status, text: truncateEnd(status.text, statusWidth) },
    ]
    const ctx = contexts.get(task.taskId)
    // The sub-agent being read has its whole row filled, so the reader sees which one they are inside.
    const own = (line: Line): Line => (here ? markOpenRow(line) : line)
    push([pad, ...own([...fit(left, room - TIME), ...(ctxWidth ? [{ text: ` ${(ctx?.text ?? "").padStart(ctxWidth)}`, fg: ctx?.fg ?? ("muted" as const) }] : []), { text: elapsed.padStart(9), fg: "muted" }])], task.taskId)
    const facts = detail ? runs.get(task.taskId) : undefined
    if (facts) push([pad, ...own(here ? fit([{ text: last ? "    " : "│   ", fg: "muted" }, ...clip(facts, Math.max(1, room - 4))], room) : [{ text: last ? "    " : "│   ", fg: "muted" }, ...clip(facts, Math.max(1, room - 4))])], task.taskId)
  })
  // A command has no activity of its own to show: its line, `cmd` (or `agent` for an engine's own agent) and how long it has run.
  // A sub-agent is never labelled `bg`: that word reads as a background command, which a sub-agent is not.
  shownCommands.forEach((item, index) => {
    const left: Line = [
      { text: index === shownCommands.length - 1 && !more ? "└ " : "├ ", fg: "muted" },
      ...fit([{ text: truncateEnd(backgroundName(item.command, 200), titleWidth), fg: "body" }], titleWidth),
      ...(agentWidth ? [{ text: `  ${"".padEnd(agentWidth)}` }] : []),
      ...(modeWidth ? [{ text: `  ${(item.kind === "agent" ? "agent" : "cmd").padEnd(modeWidth)}`, fg: "muted" as const }] : []),
    ]
    push([pad, ...fit(left, room - TIME), ...(ctxWidth ? [{ text: " ".repeat(ctxWidth + 1) }] : []), { text: formatElapsed(input.now - item.startedAt).padStart(9), fg: "muted" }], item.id)
  })
  if (more) push([pad, { text: `└ +${more} more ${g.sep} ${commands.length > shownCommands.length ? "/ps" : "/tasks"}`, fg: "muted" }])
  return { rows, ids }
}
