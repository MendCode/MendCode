import type { WorkflowId, WorkflowRunState, WorkflowSummary, WorkflowTaskState, WorkflowTaskSummary } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { SPINNER_FRAMES } from "./tool-card"
import { clip, fit } from "./deck"
import { kvList, page, pageChrome, section, type PageStatus, type PageTab } from "./page"
import { shortenMiddle, truncateEnd } from "./session-list"
import { formatElapsed, todayTimeOrDateTime } from "./time"
import { textWidth, wrap } from "./wrap"

/**
 * `/workflows`: the runs grouped by the work item they are about, and one run as a graph of its phases with the steps under them
 * (the live one with its model and what it does now). The page standard (`page()`): title, scope tabs, rule; the keys on the
 * title row, as `/usage`, `/model`, `/reviews` and `/release` draw them. See docs/workflows.md, "The page".
 */

export type WorkflowsScope = "project" | "all" | "saved"
/** `f` steps through these: every run, the ones in play, the ones that need you, the failed, the finished. */
export type WorkflowFilter = "active" | "needs" | "failed" | "done"
const FILTERS: ReadonlyArray<WorkflowFilter | undefined> = [undefined, "active", "needs", "failed", "done"]
const FILTER_LABEL: Record<WorkflowFilter, string> = { active: "active", needs: "needs you", failed: "failed", done: "finished" }
/** A saved workflow as the Saved tab lists it: yours, a package's or the project's, run as `/name`. */
export type SavedWorkflow = { name: string; kind: "script" | "plan"; source: string; pkg?: string; description?: string; problem?: string }
export type WorkflowControlAction = "pause" | "resume" | "stop" | "verify" | "delete"

/**
 * The cursor is held by key, so a run that arrives or leaves never moves it: `row` is a list row (`g:` group, `r:` run, `b:` batch,
 * `f:` fold), `step` a row of the run's timeline (`p:` phase, `t:` task, `v` verification). `opened` and `closed` are the groups,
 * batches and folds the user opened or closed by hand (a group with a live run is open until closed); `checks` the phases whose
 * checks are listed (`<workflowId>\0<phase key>`).
 */
export type WorkflowsPageState = {
  scope: WorkflowsScope
  focus: "list" | "run"
  row?: string
  opened?: readonly string[]
  closed?: readonly string[]
  step?: string
  checks?: readonly string[]
  info?: boolean
  /** Rows of the info view scrolled past (↑↓ while it is shown). */
  infoOffset?: number
  keys?: boolean
  /** Which runs the list shows (`f`); every run when unset. */
  filter?: WorkflowFilter
  /** Finished phases of a live run whose steps the user opened (`<workflowId>\0<phase key>`); the others are folded into one row. */
  unfolded?: readonly string[]
  /** The cursor on the Saved tab. */
  saved?: string
  confirm?: { kind: "stop" | "delete" | "restart"; workflowId: WorkflowId; taskId?: string }
}

export type WorkflowsPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "open"; sessionId: string }
  | { type: "control"; workflowId: WorkflowId; action: WorkflowControlAction }
  | { type: "retry"; workflowId: WorkflowId; taskId: string }
  /** `y` / `n` on a human task that waits for the user. */
  | { type: "answer"; workflowId: WorkflowId; taskId: string; decision: "approve" | "reject" }
  /** Accepting by hand needs a reason, which the user types in the prompt. */
  | { type: "accept"; workflowId: WorkflowId }
  | { type: "scope"; scope: WorkflowsScope }
  /** `s`: keep the run's script (or plan) as a saved workflow; the user names it in the prompt. */
  | { type: "save"; workflowId: WorkflowId }
  /** Enter on a saved workflow writes `/name ` in the prompt for its arguments; `r` starts it now. */
  | { type: "runSaved"; name: string; kind: "script" | "plan"; now: boolean }

const NONE: WorkflowsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l"])

/** Below this the page shows one pane (the list, or the run after enter); from it the list and the run side by side. */
const WIDE = 110
/** From this width a third column holds the run's facts (start, folder, limits, models, log). */
const FACTS_AT = 170
const RAIL_MIN = 38
const RAIL_MAX = 46
const RAIL_SHARE = 0.38
const FACTS_WIDTH = 40
const RUN_MAX = 112
/** Runs of the same name started this close together are one batch (a council's reviewers, one per model). */
const BATCH_WINDOW_MS = 2_000
const STEP_LABEL_MAX = 24
const CHECK_ROWS_MAX = 8
const FAILURE_ROWS = 3
const TIME_CELLS = 7
const LABEL_WIDTH = 11
/** Below these widths of the run pane a step drops its tokens, then its effort, then its engine. */
/** From this width a phase draws its agents' bar, this many cells at most. */
const BAR_AT = 64
const BAR_CELLS = 8
const TOKENS_AT = 90
const EFFORT_AT = 70
const ENGINE_AT = 58

const STATE: Record<WorkflowRunState, { label: string; fg: ColorName }> = {
  running: { label: "running", fg: "text" },
  needs_input: { label: "needs input", fg: "warning" },
  verifying: { label: "verifying", fg: "warning" },
  paused: { label: "paused", fg: "muted" },
  completed: { label: "completed", fg: "success" },
  failed: { label: "failed", fg: "error" },
  blocked: { label: "blocked", fg: "error" },
  stopped: { label: "stopped", fg: "muted" },
  queued: { label: "queued", fg: "muted" },
}
const TERMINAL = new Set<WorkflowRunState>(["completed", "failed", "stopped"])
/** A run that is not over: its group sorts first and is open. */
const LIVE = new Set<WorkflowRunState>(["running", "needs_input", "verifying", "queued", "paused", "blocked"])
const TICKING = new Set<WorkflowRunState>(["running", "needs_input", "verifying"])
const PRIORITY: WorkflowTaskState[] = ["needs_input", "running", "failed"]
/** How a script's own outcome word reads: the first match wins, anything else is a success. */
const OUTCOME_TONE: ReadonlyArray<[RegExp, "error" | "warning"]> = [[/^(blocked|failed|error|rejected)/i, "error"], [/^(draft|partial|needs)/i, "warning"]]
/** Marks from worst to best: a batch shows its worst run's. */
const MARK_RANK = ["fail", "ask", "dot", "done", "ok", "sep"] as const
type MarkKind = (typeof MARK_RANK)[number]

// ---------------------------------------------------------------------------------------------- levels (static plans)

/** Topological level of every task: 1 + the highest level it needs, 1 without needs. Unknown needs and cycles count as nothing. */
export function workflowLevels(tasks: Array<Pick<WorkflowTaskSummary, "id" | "needs">>): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const levels = new Map<string, number>()
  const visiting = new Set<string>()
  const levelOf = (id: string): number => {
    const known = levels.get(id)
    if (known !== undefined) return known
    const task = byId.get(id)
    if (!task || visiting.has(id)) return 0
    visiting.add(id)
    const level = 1 + Math.max(0, ...task.needs.map(levelOf))
    visiting.delete(id)
    levels.set(id, level)
    return level
  }
  for (const task of tasks) levelOf(task.id)
  return levels
}

/** Tasks in display order: by level, plan order within a level. */
export function workflowTaskOrder(run: Pick<WorkflowSummary, "tasks">): Array<{ task: WorkflowTaskSummary; level: number }> {
  const levels = workflowLevels(run.tasks)
  return run.tasks
    .map((task, index) => ({ task, level: levels.get(task.id) ?? 1, index }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map(({ task, level }) => ({ task, level }))
}

// ---------------------------------------------------------------------------------------------- one run, as phases and steps

type PhaseState = "pending" | "running" | "done" | "blocked"
type Phase = {
  key: string
  title: string
  detail?: string
  state: PhaseState
  /** Pending with nothing in it while a later phase already ran: the script skipped it. */
  notRun: boolean
  waiting: boolean
  startedAt?: number
  endedAt?: number
  agents: number
  checks: number
  checksFailed: number
  /** Agent, human and map tasks, and failed checks: the rows under the phase. */
  steps: WorkflowTaskSummary[]
  checkTasks: WorkflowTaskSummary[]
}
type Outcome = { word: string; reason?: string; tone: "error" | "warning" | "success" }
type RunView = {
  phases: Phase[]
  /** Phases worth a stepper: named ones, more than one. */
  stepper: boolean
  /** The phase in progress (1-based) and how many there are; undefined without phases. */
  position?: { index: number; total: number; title: string }
  outcome?: Outcome
  waiting?: WorkflowTaskSummary
  running?: WorkflowTaskSummary
  failed?: WorkflowTaskSummary
  labelWidth: number
  checksPassed: number
  checksFailed: number
  agentsFailed: number
}

const views = new WeakMap<WorkflowSummary, RunView>()

const isCheck = (task: WorkflowTaskSummary) => task.kind === "check"
const finishedTask = (task: WorkflowTaskSummary) => task.state === "done" || task.state === "failed" || task.state === "skipped" || task.state === "stopped"

/** A step's label without the work item it is about (`audit cu-vault-screen-button` → `audit`): the run's header already names it. */
function stepLabel(task: WorkflowTaskSummary, subject: string | undefined): string {
  const label = task.label ?? task.id
  if (!subject) return label
  const stripped = label.split(subject).join("").replace(/\s{2,}/g, " ").trim()
  return stripped || label
}

function phaseOfTasks(tasks: WorkflowTaskSummary[]): PhaseState {
  if (!tasks.length) return "pending"
  if (tasks.every((task) => task.state === "done" || task.state === "skipped")) return "done"
  if (tasks.every(finishedTask)) return "blocked"
  return tasks.some((task) => task.state !== "pending") ? "running" : "pending"
}

function span(tasks: WorkflowTaskSummary[]): { startedAt?: number; endedAt?: number } {
  const starts = tasks.flatMap((task) => (task.startedAt !== undefined ? [task.startedAt] : []))
  const ends = tasks.flatMap((task) => (task.endedAt !== undefined ? [task.endedAt] : []))
  return { ...(starts.length ? { startedAt: Math.min(...starts) } : {}), ...(ends.length && tasks.every(finishedTask) ? { endedAt: Math.max(...ends) } : {}) }
}

function makePhase(input: { key: string; title: string; detail?: string; state?: PhaseState; tasks: WorkflowTaskSummary[]; counts?: { agents?: number; checks?: number; checksFailed?: number; startedAt?: number; endedAt?: number } }): Phase {
  const { tasks, counts } = input
  const checkTasks = tasks.filter(isCheck)
  const times = span(tasks)
  const startedAt = counts?.startedAt ?? times.startedAt
  const endedAt = counts?.endedAt ?? times.endedAt
  return {
    key: input.key,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    state: input.state ?? phaseOfTasks(tasks),
    notRun: false,
    waiting: tasks.some((task) => task.state === "needs_input"),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    agents: counts?.agents ?? tasks.length - checkTasks.length,
    checks: counts?.checks ?? checkTasks.length,
    checksFailed: counts?.checksFailed ?? checkTasks.filter((task) => task.state === "failed").length,
    steps: tasks.filter((task) => !isCheck(task) || task.state === "failed"),
    checkTasks,
  }
}

function outcomeOf(run: WorkflowSummary): Outcome | undefined {
  const outcome = run.script?.outcome
  if (!outcome || !TERMINAL.has(run.state)) return undefined
  const tone = OUTCOME_TONE.find(([pattern]) => pattern.test(outcome.state))?.[1] ?? "success"
  return { word: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}), tone }
}

/** The run as phases and steps, built once per update of the run (the daemon sends a new object for each change). */
function runView(run: WorkflowSummary): RunView {
  const known = views.get(run)
  if (known) return known
  let phases: Phase[]
  if (run.script?.phases.length) {
    const titled = new Set(run.script.phases.map((phase) => phase.title))
    const loose = run.tasks.filter((task) => !task.phase || !titled.has(task.phase))
    phases = [
      ...(loose.length ? [makePhase({ key: "p:", title: "", tasks: loose })] : []),
      ...run.script.phases.map((phase) => makePhase({
        key: `p:${phase.title}`, title: phase.title, ...(phase.detail ? { detail: phase.detail } : {}), state: phase.state,
        tasks: run.tasks.filter((task) => task.phase === phase.title),
        counts: {
          ...(phase.agents !== undefined ? { agents: phase.agents } : {}), ...(phase.checks !== undefined ? { checks: phase.checks } : {}), ...(phase.checksFailed !== undefined ? { checksFailed: phase.checksFailed } : {}),
          ...(phase.startedAt !== undefined ? { startedAt: phase.startedAt } : {}), ...(phase.endedAt !== undefined ? { endedAt: phase.endedAt } : {}),
        },
      })),
    ]
  } else if (run.phases?.length) {
    phases = run.phases.map((phase) => makePhase({ key: `p:${phase.id}`, title: phase.title, state: phase.state, tasks: run.tasks.filter((task) => phase.tasks.includes(task.id)) }))
  } else {
    const order = workflowTaskOrder(run)
    const levels = [...new Set(order.map((entry) => entry.level))]
    phases = levels.length > 1
      ? levels.map((level) => makePhase({ key: `p:${level}`, title: `Step ${level}`, tasks: order.filter((entry) => entry.level === level).map((entry) => entry.task) }))
      : [makePhase({ key: "p:", title: "", tasks: run.tasks })]
  }
  // A run that ended has no phase in progress: the one its script was in when it ended is done (or where it stopped).
  if (TERMINAL.has(run.state)) for (const phase of phases) if (phase.state === "running" && ![...phase.steps, ...phase.checkTasks].some((task) => !finishedTask(task))) phase.state = run.state === "completed" ? "done" : "blocked"
  // A phase whose tasks were all skipped or stopped after an earlier failure did not run; it did not fail.
  for (const phase of phases) if (phase.state === "blocked" && !phase.waiting && ![...phase.steps, ...phase.checkTasks].some((task) => task.state === "failed")) Object.assign(phase, { state: "pending", notRun: true })
  // A pending phase with nothing in it, once a later one has started, was skipped by the script.
  phases.forEach((phase, index) => {
    if (phase.state === "pending" && phase.agents + phase.checks === 0 && phases.slice(index + 1).some((later) => later.state !== "pending" || later.agents + later.checks > 0)) phase.notRun = true
  })
  const named = phases.filter((phase) => phase.title)
  const at = named.findIndex((phase) => phase.state === "running" || phase.state === "blocked" || phase.waiting)
  // Nothing in play: the last phase that got anywhere, else (a run not started) the first.
  const last = named.reduce((found, phase, index) => (phase.state !== "pending" ? index : found), -1)
  const current = at >= 0 ? at : Math.max(0, last)
  const find = (state: WorkflowTaskState) => run.tasks.find((task) => task.state === state && !isCheck(task)) ?? run.tasks.find((task) => task.state === state)
  const outcome = outcomeOf(run)
  const steps = phases.flatMap((phase) => phase.steps)
  const view: RunView = {
    phases,
    stepper: named.length > 1,
    ...(named.length && current >= 0 ? { position: { index: current + 1, total: named.length, title: named[current]!.title } } : {}),
    ...(outcome ? { outcome } : {}),
    ...(find("needs_input") ? { waiting: find("needs_input")! } : {}),
    ...(find("running") ? { running: find("running")! } : {}),
    ...(find("failed") ? { failed: find("failed")! } : {}),
    labelWidth: Math.min(STEP_LABEL_MAX, Math.max(4, ...steps.map((task) => textWidth(stepLabel(task, run.subject))))),
    checksPassed: phases.reduce((sum, phase) => sum + phase.checks - phase.checksFailed, 0),
    checksFailed: phases.reduce((sum, phase) => sum + phase.checksFailed, 0),
    agentsFailed: run.tasks.filter((task) => !isCheck(task) && task.state === "failed").length,
  }
  views.set(run, view)
  return view
}

// ---------------------------------------------------------------------------------------------- the list: groups, batches, folds

type Entry = { kind: "run"; key: string; run: WorkflowSummary } | { kind: "batch" | "fold"; key: string; runs: WorkflowSummary[] }
type Group = { key: string; title: string; directory: string; entries: Entry[]; runs: WorkflowSummary[]; live: boolean; newest: number }
type Row =
  | { kind: "heading"; key: string; text: string; count: number }
  | { kind: "group"; key: string; group: Group; open: boolean }
  | { kind: "pack"; key: string; entry: Extract<Entry, { kind: "batch" | "fold" }>; depth: number; open: boolean; parent?: string }
  | { kind: "run"; key: string; run: WorkflowSummary; depth: number; parent?: string }

const entryRuns = (entry: Entry) => (entry.kind === "run" ? [entry.run] : entry.runs)
const outcomeText = (run: WorkflowSummary) => `${run.script?.outcome?.state ?? run.state}\0${run.script?.outcome?.reason ?? run.reason ?? ""}`
const foldable = (run: WorkflowSummary) => TERMINAL.has(run.state) && run.script !== undefined && run.script.calls === 0

function groupKeyOf(run: WorkflowSummary) {
  return `g:${run.directory}\0${run.subject ? `s:${run.subject}` : run.originSessionId ? `o:${run.originSessionId}` : `r:${run.workflowId}`}`
}

/** A group's runs, newest first, as entries: runs of one batch together, instant repeats with the same outcome folded. */
function entriesOf(runs: WorkflowSummary[]): Entry[] {
  const entries: Entry[] = []
  for (const run of runs) {
    const last = entries.at(-1)
    const first = last ? entryRuns(last)[0]! : undefined
    if (last && first && last.kind !== "fold" && first.name === run.name && Math.abs(first.startedAt - run.startedAt) <= BATCH_WINDOW_MS) {
      entries[entries.length - 1] = { kind: "batch", key: `b:${first.workflowId}`, runs: [...entryRuns(last), run] }
      continue
    }
    if (last && first && last.kind !== "batch" && foldable(first) && foldable(run) && first.name === run.name && outcomeText(first) === outcomeText(run)) {
      entries[entries.length - 1] = { kind: "fold", key: `f:${first.workflowId}`, runs: [...entryRuns(last), run] }
      continue
    }
    entries.push({ kind: "run", key: `r:${run.workflowId}`, run })
  }
  return entries
}

function groupsOf(runs: WorkflowSummary[]): Group[] {
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  const byKey = new Map<string, WorkflowSummary[]>()
  for (const run of sorted) {
    const key = groupKeyOf(run)
    byKey.set(key, [...(byKey.get(key) ?? []), run])
  }
  return [...byKey].map(([key, members]): Group => ({
    key,
    title: members[0]!.subject ?? members[0]!.name,
    directory: members[0]!.directory,
    entries: entriesOf(members),
    runs: members,
    live: members.some((run) => LIVE.has(run.state)),
    newest: Math.max(...members.map((run) => run.updatedAt)),
  })).sort((a, b) => Number(b.live) - Number(a.live) || b.newest - a.newest)
}

function matchesFilter(run: WorkflowSummary, filter: WorkflowFilter): boolean {
  switch (filter) {
    case "active": return run.state === "running" || run.state === "verifying" || run.state === "queued" || run.state === "paused"
    case "needs": return run.state === "needs_input" || run.state === "blocked" || run.tasks.some((task) => task.state === "needs_input")
    case "failed": return run.state === "failed" || runView(run).outcome?.tone === "error"
    case "done": return run.state === "completed" || run.state === "stopped"
  }
}

let filtered: { runs: WorkflowSummary[]; filter: WorkflowFilter; out: WorkflowSummary[] } | undefined

/** The runs the list shows: all of them, or the ones `f` picked. The same array while neither changes, so the list memo holds. */
function visibleRuns(runs: WorkflowSummary[], state: WorkflowsPageState): WorkflowSummary[] {
  const filter = state.filter
  if (!filter) return runs
  if (filtered && filtered.runs === runs && filtered.filter === filter) return filtered.out
  filtered = { runs, filter, out: runs.filter((run) => matchesFilter(run, filter)) }
  return filtered.out
}

const basename = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory

let memo: { runs: WorkflowSummary[]; scope: WorkflowsScope; opened?: readonly string[]; closed?: readonly string[]; reveal?: string; groups: Group[]; rows: Row[] } | undefined

/** The rows of the list. Memoized on the runs array, the scope and what is open, so a frame does no sort and no grouping. */
function listRows(runs: WorkflowSummary[], state: WorkflowsPageState): { groups: Group[]; rows: Row[] } {
  const reveal = state.row?.startsWith("r:") ? state.row.slice(2) : undefined
  if (memo && memo.runs === runs && memo.scope === state.scope && memo.opened === state.opened && memo.closed === state.closed && memo.reveal === reveal) return memo
  const groups = memo?.runs === runs ? memo.groups : groupsOf(runs)
  const opened = new Set(state.opened ?? [])
  const closed = new Set(state.closed ?? [])
  const holds = (members: WorkflowSummary[]) => reveal !== undefined && members.some((run) => run.workflowId === reveal)
  const rows: Row[] = []
  const entryRows = (entry: Entry, depth: number, parent?: string) => {
    if (entry.kind === "run") return void rows.push({ kind: "run", key: entry.key, run: entry.run, depth, ...(parent ? { parent } : {}) })
    const open = opened.has(entry.key) || holds(entry.runs)
    rows.push({ kind: "pack", key: entry.key, entry, depth, open, ...(parent ? { parent } : {}) })
    if (open) for (const run of entry.runs) rows.push({ kind: "run", key: `r:${run.workflowId}`, run, depth: depth + 1, parent: entry.key })
  }
  const groupRows = (group: Group) => {
    if (group.entries.length === 1) return entryRows(group.entries[0]!, 0)
    const open = (group.live && !closed.has(group.key)) || opened.has(group.key) || holds(group.runs)
    rows.push({ kind: "group", key: group.key, group, open })
    if (open) for (const entry of group.entries) entryRows(entry, 1, group.key)
  }
  if (state.scope === "all") {
    const folders = new Map<string, Group[]>()
    for (const group of groups) {
      const folder = group.directory.length > 1 ? group.directory.replace(/\/+$/, "") : group.directory
      folders.set(folder, [...(folders.get(folder) ?? []), group])
    }
    for (const [directory, members] of folders) {
      rows.push({ kind: "heading", key: `h:${directory}`, text: basename(directory), count: members.reduce((sum, group) => sum + group.runs.length, 0) })
      members.forEach(groupRows)
    }
  } else groups.forEach(groupRows)
  memo = { runs, scope: state.scope, ...(state.opened ? { opened: state.opened } : {}), ...(state.closed ? { closed: state.closed } : {}), ...(reveal ? { reveal } : {}), groups, rows }
  return memo
}

const selectable = (row: Row | undefined) => row !== undefined && row.kind !== "heading"

/** The cursor's row: the one held, else (its run hidden in a closed group) the row that holds it, else the first selectable row. */
function cursorAt(rows: Row[], state: WorkflowsPageState): number {
  const exact = rows.findIndex((row) => row.key === state.row)
  if (exact >= 0) return exact
  if (state.row?.startsWith("r:")) {
    const id = state.row.slice(2)
    const holder = rows.findIndex((row) => (row.kind === "group" && row.group.runs.some((run) => run.workflowId === id)) || (row.kind === "pack" && row.entry.runs.some((run) => run.workflowId === id)))
    if (holder >= 0) return holder
  }
  return Math.max(0, rows.findIndex(selectable))
}

/** The run a row stands for: itself, a group's live (else newest) run, a batch's or fold's newest. */
function runOfRow(row: Row | undefined): WorkflowSummary | undefined {
  if (!row || row.kind === "heading") return undefined
  if (row.kind === "run") return row.run
  if (row.kind === "pack") return row.entry.runs[0]
  return row.group.runs.find((run) => LIVE.has(run.state)) ?? row.group.runs[0]
}

/** The run the cursor is on, or that the row under it stands for (the `b` evidence key and the app use it). */
export function selectedWorkflow(state: WorkflowsPageState, all: WorkflowSummary[]): WorkflowSummary | undefined {
  const runs = visibleRuns(all, state)
  if (state.row?.startsWith("r:")) {
    const found = runs.find((run) => run.workflowId === state.row!.slice(2))
    if (found) return found
  }
  const { rows } = listRows(runs, state)
  return runOfRow(rows[cursorAt(rows, state)])
}

// ---------------------------------------------------------------------------------------------- state and keys

export function createWorkflowsPageState(scope: WorkflowsScope = "project", workflowId?: WorkflowId): WorkflowsPageState {
  return workflowId ? { scope, focus: "run", row: `r:${workflowId}` } : { scope, focus: "list" }
}

const canPause = (run: WorkflowSummary) => run.state === "running" || run.state === "needs_input" || run.state === "verifying"
const canResume = (run: WorkflowSummary) => run.state === "paused" || run.state === "blocked"
const canStop = (run: WorkflowSummary) => !TERMINAL.has(run.state)
const canAccept = (run: WorkflowSummary) => !run.queuedBehind && (run.state === "blocked" || run.state === "failed" || run.state === "paused" || run.state === "verifying")
/** Verifying again makes sense once the tasks are finished and the contract is what is left. */
const canVerify = (run: WorkflowSummary) =>
  run.contract !== undefined && (run.state === "blocked" || (run.state === "paused" && run.tasks.every((task) => task.state === "done" || task.state === "skipped")))
/**
 * A finished phase of a run that still lives is one row (its agents' results folded into it) so the room goes to what is running;
 * `space` on it opens the steps. A run that ended shows every step.
 */
function folded(run: WorkflowSummary, phase: Phase, state: WorkflowsPageState): boolean {
  return LIVE.has(run.state) && phase.title !== "" && phase.state === "done" && phase.steps.filter((task) => !isCheck(task)).length >= 2 && !state.unfolded?.includes(checksKey(run, phase.key))
}
const hasVerify = (run: WorkflowSummary) => run.contract !== undefined || run.verification !== undefined
const checksKey = (run: WorkflowSummary, phase: string) => `${run.workflowId}\0${phase}`
const toggled = (list: readonly string[] | undefined, key: string) => (list?.includes(key) ? list.filter((each) => each !== key) : [...(list ?? []), key])

/** The keys of the run's timeline rows the cursor can stand on, in order. */
function timelineKeys(run: WorkflowSummary, state: WorkflowsPageState): string[] {
  const view = runView(run)
  const keys: string[] = []
  for (const phase of view.phases) {
    if (phase.title) keys.push(phase.key)
    if (!folded(run, phase, state)) for (const task of phase.steps) keys.push(`t:${task.id}`)
  }
  if (hasVerify(run)) keys.push("v")
  return keys
}

/** Where the cursor stands in the run with none chosen: what waits for the user, else what runs, else what failed. */
function defaultStep(run: WorkflowSummary): string | undefined {
  const view = runView(run)
  for (const state of PRIORITY) {
    const task = state === "needs_input" ? view.waiting : state === "running" ? view.running : view.failed
    if (task && !isCheck(task)) return `t:${task.id}`
  }
  return undefined
}

const stepOf = (run: WorkflowSummary, state: WorkflowsPageState) => state.step ?? defaultStep(run)
const taskOf = (run: WorkflowSummary, step: string | undefined) => (step?.startsWith("t:") ? run.tasks.find((task) => task.id === step.slice(2)) : undefined)
const phaseOfStep = (run: WorkflowSummary, step: string | undefined) => runView(run).phases.find((phase) => phase.key === step || phase.steps.some((task) => `t:${task.id}` === step))

/** The session `enter` opens from the run: the cursor's step, the auditor on the verification block, else the latest step's, else the run's own. */
function openTarget(run: WorkflowSummary, step: string | undefined): string | undefined {
  if (step === "v") return run.verification?.audit?.sessionId ?? run.rootSessionId
  const task = taskOf(run, step)
  if (task?.sessionId) return task.sessionId
  const latest = [...run.tasks].filter((each) => each.sessionId).sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))[0]
  return latest?.sessionId ?? run.rootSessionId
}

/** Handles one raw key over the runs shown. Returns the same state object when nothing changed. */
export function workflowsPageKey(state: WorkflowsPageState, key: string, all: WorkflowSummary[], saved: readonly SavedWorkflow[] = []): { state: WorkflowsPageState; action: WorkflowsPageAction } {
  const same = { state, action: NONE }
  const runs = visibleRuns(all, state)
  const { rows } = listRows(runs, state)
  const at = cursorAt(rows, state)
  const row = rows[at]
  // Actions need one run: a run's own row (a group, batch or fold opens first).
  const run = row?.kind === "run" ? row.run : undefined
  const { confirm, ...withoutConfirm } = state
  if (confirm) {
    const confirmed = (confirm.kind === "stop" && (key === "x" || key === "y")) || (confirm.kind === "delete" && (key === "d" || key === "y")) || (confirm.kind === "restart" && (key === "r" || key === "y"))
    if (confirmed && run?.workflowId === confirm.workflowId) {
      if (confirm.kind === "restart") return confirm.taskId ? { state: withoutConfirm, action: { type: "retry", workflowId: confirm.workflowId, taskId: confirm.taskId } } : { state: withoutConfirm, action: NONE }
      return { state: withoutConfirm, action: { type: "control", workflowId: confirm.workflowId, action: confirm.kind } }
    }
    return { state: withoutConfirm, action: NONE }
  }
  if (key === "?") return { state: { ...state, keys: !state.keys }, action: NONE }
  if (state.keys && key === "\x1b") return { state: { ...state, keys: false }, action: NONE }
  if (key === "q") return { state, action: { type: "close" } }
  const scoped = (scope: WorkflowsScope) => (scope === state.scope ? same : { state: createWorkflowsPageState(scope), action: { type: "scope" as const, scope } })
  if (key === "\t") return scoped(state.scope === "project" ? "all" : "project")
  if (key === "1") return scoped("project")
  if (key === "2") return scoped("all")
  if (key === "3") return scoped("saved")
  if (state.scope === "saved") {
    // The Saved tab: workflows of the user, the packages and the project, each run as `/name`.
    const at = Math.max(0, saved.findIndex((entry) => entry.name === state.saved))
    const entry = saved[at]
    if (key === "\x1b") return { state, action: { type: "close" } }
    if (UP.has(key) || DOWN.has(key)) {
      const next = saved[Math.max(0, Math.min(saved.length - 1, at + (UP.has(key) ? -1 : 1)))]
      return next && next.name !== entry?.name ? { state: { ...state, saved: next.name }, action: NONE } : same
    }
    if (entry && !entry.problem && (key === "\r" || RIGHT.has(key) || key === "r")) return { state, action: { type: "runSaved", name: entry.name, kind: entry.kind, now: key === "r" } }
    return same
  }
  if (key === "f") {
    const next = FILTERS[(FILTERS.indexOf(state.filter) + 1) % FILTERS.length]
    const { filter: _filter, ...rest } = state
    return { state: next ? { ...rest, filter: next } : rest, action: NONE }
  }
  const inRun = state.focus === "run" && run !== undefined
  if (key === "\x1b") {
    if (!inRun) return { state, action: { type: "close" } }
    const { step: _step, info: _info, ...rest } = state
    return { state: { ...rest, focus: "list" }, action: NONE }
  }

  if (!inRun) {
    const move = (delta: number) => {
      for (let index = at + delta; index >= 0 && index < rows.length; index += delta) {
        if (!selectable(rows[index])) continue
        const { step: _step, info: _info, ...rest } = state
        return { state: { ...rest, focus: "list" as const, row: rows[index]!.key }, action: NONE }
      }
      return same
    }
    if (UP.has(key)) return move(-1)
    if (DOWN.has(key)) return move(1)
    if (!row || row.kind === "heading") return same
    const toggle = (target: Row): WorkflowsPageState => {
      if (target.kind === "group" && target.group.live) return target.open ? { ...state, row: target.key, closed: [...(state.closed ?? []), target.key], opened: (state.opened ?? []).filter((each) => each !== target.key) } : { ...state, row: target.key, closed: (state.closed ?? []).filter((each) => each !== target.key), opened: [...(state.opened ?? []), target.key] }
      return { ...state, row: target.key, opened: toggled(state.opened, target.key) }
    }
    if (key === "\r" || RIGHT.has(key)) {
      if (row.kind === "run") return { state: { ...state, row: row.key, focus: "run" }, action: NONE }
      return row.kind === "group" || row.kind === "pack" ? { state: toggle(row), action: NONE } : same
    }
    if (key === " ") {
      if (row.kind === "group" || row.kind === "pack") return { state: toggle(row), action: NONE }
      const parent = row.parent ? rows.find((each) => each.key === row.parent) : undefined
      return parent ? { state: toggle(parent), action: NONE } : same
    }
    if (LEFT.has(key)) {
      const parent = row.kind !== "group" && row.parent ? rows.find((each) => each.key === row.parent) : row.kind === "group" || row.kind === "pack" ? row : undefined
      return parent && (parent.kind === "group" || parent.kind === "pack") && parent.open ? { state: toggle(parent), action: NONE } : same
    }
  } else {
    const keys = timelineKeys(run, state)
    const current = stepOf(run, state)
    const index = current === undefined ? -1 : keys.indexOf(current)
    const moveStep = (delta: number) => {
      const next = keys[index < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, index + delta))]
      return next === undefined || next === state.step ? same : { state: { ...state, step: next }, action: NONE }
    }
    if (state.info && (UP.has(key) || DOWN.has(key))) {
      const offset = Math.max(0, (state.infoOffset ?? 0) + (UP.has(key) ? -1 : 1))
      return offset === (state.infoOffset ?? 0) ? same : { state: { ...state, infoOffset: offset }, action: NONE }
    }
    if (UP.has(key)) return moveStep(-1)
    if (DOWN.has(key)) return moveStep(1)
    if (LEFT.has(key)) {
      const { step: _step, info: _info, ...rest } = state
      return { state: { ...rest, focus: "list" }, action: NONE }
    }
    if (key === "i") {
      const { infoOffset: _offset, ...rest } = state
      return { state: { ...rest, info: !state.info }, action: NONE }
    }
    const phase = phaseOfStep(run, current)
    if (key === " " || ((key === "\r" || RIGHT.has(key)) && current?.startsWith("p:"))) {
      if (!phase) return same
      // A folded phase opens its steps first; an opened one lists its checks, or folds again.
      if (folded(run, phase, state)) return { state: { ...state, unfolded: [...(state.unfolded ?? []), checksKey(run, phase.key)] }, action: NONE }
      if (phase.checks > 0) return { state: { ...state, checks: toggled(state.checks, checksKey(run, phase.key)) }, action: NONE }
      if (key === " " && LIVE.has(run.state) && phase.state === "done" && phase.steps.length >= 2) return { state: { ...state, unfolded: toggled(state.unfolded, checksKey(run, phase.key)), step: phase.key }, action: NONE }
      return same
    }
    if (key === "\r" || RIGHT.has(key)) {
      const sessionId = openTarget(run, current)
      return { state, action: sessionId ? { type: "open", sessionId } : NONE }
    }
  }

  if (!run) return same
  const control = (action: WorkflowControlAction): { state: WorkflowsPageState; action: WorkflowsPageAction } => ({ state, action: { type: "control", workflowId: run.workflowId, action } })
  if (key === "p") return canPause(run) ? control("pause") : canResume(run) ? control("resume") : same
  if (key === "v") return canVerify(run) ? control("verify") : same
  if (key === "a") return canAccept(run) ? { state, action: { type: "accept", workflowId: run.workflowId } } : same
  const cursor = inRun ? taskOf(run, stepOf(run, state)) : undefined
  if (key === "t") {
    const task = cursor?.state === "failed" ? cursor : run.tasks.find((each) => each.state === "failed" && !isCheck(each)) ?? run.tasks.find((each) => each.state === "failed")
    return task ? { state, action: { type: "retry", workflowId: run.workflowId, taskId: task.id } } : same
  }
  if (key === "y" || key === "n") {
    const task = cursor?.kind === "human" && cursor.state === "needs_input" ? cursor : run.tasks.find((each) => each.kind === "human" && each.state === "needs_input")
    return task ? { state, action: { type: "answer", workflowId: run.workflowId, taskId: task.id, decision: key === "y" ? "approve" : "reject" } } : same
  }
  if (key === "s") return { state, action: { type: "save", workflowId: run.workflowId } }
  if (key === "r" && inRun && cursor && !isCheck(cursor) && cursor.kind !== "human" && cursor.state !== "pending" && cursor.state !== "skipped" && !TERMINAL.has(run.state) && run.state !== "verifying") {
    return { state: { ...state, confirm: { kind: "restart", workflowId: run.workflowId, taskId: cursor.id } }, action: NONE }
  }
  if (key === "x" && canStop(run)) return { state: { ...state, confirm: { kind: "stop", workflowId: run.workflowId } }, action: NONE }
  if (key === "d") return { state: { ...state, confirm: { kind: "delete", workflowId: run.workflowId } }, action: NONE }
  return same
}

/** True while an agent of a shown run works (running or verifying, not waiting for the user): the page animates its spinners. */
export function isMoving(runs: WorkflowSummary[]) {
  return runs.some((run) => run.state === "running" || run.state === "verifying")
}

/** True while a shown run has a live clock (running, waiting for input or verifying): the page needs a 1 s tick. */
export function needsTick(runs: WorkflowSummary[]) {
  return runs.some((run) => TICKING.has(run.state))
}

// ---------------------------------------------------------------------------------------------- rendering helpers

function elapsed(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : formatElapsed(ms)
}

function runElapsed(run: WorkflowSummary, now: number) {
  return elapsed((run.endedAt ?? (TICKING.has(run.state) ? now : run.updatedAt)) - run.startedAt)
}

function taskElapsed(task: WorkflowTaskSummary, now: number) {
  if (task.startedAt === undefined) return ""
  if (task.state === "running" || task.state === "needs_input") return elapsed(now - task.startedAt)
  return task.endedAt !== undefined ? elapsed(task.endedAt - task.startedAt) : ""
}

/**
 * The mark of work in progress: one spinner frame while the page animates (a run is live, motion is on), else the dot. Set for the
 * length of one render by `renderWorkflowsPage`; a spinner turns only where it says an agent is alive.
 */
let motion: string | undefined
const dotMark = (glyphs: Glyphs) => motion ?? glyphs.dot
const ASCII_SPIN = ["|", "/", "-", "\\"]

/** The literals the page writes besides the glyph set, in ASCII when the glyphs are. */
function literals(glyphs: Glyphs) {
  const ascii = glyphs.rule === "-"
  return { activity: ascii ? ">" : "▸", skipped: ascii ? "-" : "–", times: ascii ? "x" : "×", more: ascii ? ".." : "…" }
}

/** `left` and `right` on one row of `width` cells, the left cut first. */
function spread(left: Line, right: Line, width: number): Line {
  const rightWidth = Math.min(width, right.reduce((sum, each) => sum + textWidth(each.text), 0))
  const room = Math.max(0, width - rightWidth - 1)
  const head = clip(left, room)
  const gap = width - head.reduce((sum, each) => sum + textWidth(each.text), 0) - rightWidth
  return [...head, { text: " ".repeat(Math.max(1, gap)) }, ...clip(right, rightWidth)]
}

const pad = (text: string, cells: number) => text + " ".repeat(Math.max(0, cells - textWidth(text)))
const padStart = (text: string, cells: number) => " ".repeat(Math.max(0, cells - textWidth(text))) + text

/** The cursor's row: `❯` in its gutter (bright in the focused pane) and the element background across it. */
function cursorRow(line: Line, width: number, glyphs: Glyphs, focused: boolean): Line {
  // The marker takes the row's first two blank cells, so nothing after it moves.
  const first = line[0]?.text ?? ""
  const body = first.startsWith("  ") ? [...(first.length > 2 ? [{ ...line[0]!, text: first.slice(2) }] : []), ...line.slice(1)] : line
  return fit([{ text: `${glyphs.user} `, fg: focused ? "primary" : "muted", bold: focused }, ...body], width).map((each) => ({ ...each, bg: "element" as const }))
}

function markSpan(kind: MarkKind, glyphs: Glyphs): Span {
  switch (kind) {
    case "fail": return { text: glyphs.fail, fg: "error" }
    case "ask": return { text: glyphs.ask, fg: "warning" }
    case "dot": return { text: dotMark(glyphs), fg: "primary" }
    case "done": return { text: glyphs.done, fg: "warning" }
    case "ok": return { text: glyphs.ok, fg: "success" }
    case "sep": return { text: glyphs.sep, fg: "muted" }
  }
}

/** A run at a glance: live, waiting, failed, ended with a draft-like outcome, done, or at rest. */
function markOf(run: WorkflowSummary): MarkKind {
  if (run.state === "needs_input") return "ask"
  if (run.state === "running" || run.state === "verifying") return "dot"
  if (run.state === "failed" || run.state === "blocked") return "fail"
  if (run.state === "completed") {
    const outcome = runView(run).outcome
    return outcome?.tone === "error" ? "fail" : outcome?.tone === "warning" ? "done" : "ok"
  }
  return "sep"
}

/** A batch takes as long as its slowest run. */
const slowest = (runs: WorkflowSummary[], now: number) => runs.reduce((longest, run) => ((run.endedAt ?? now) - run.startedAt > (longest.endedAt ?? now) - longest.startedAt ? run : longest))
const worst = (kinds: MarkKind[]) => MARK_RANK.find((kind) => kinds.includes(kind)) ?? "sep"

/** What a run's row says instead of a count: where it is (`Audit 5/7`) while it lives, how it ended once it has. */
function statusOf(run: WorkflowSummary, group = false): { text: string; fg: ColorName } {
  const view = runView(run)
  const position = view.position ? `${view.position.title} ${view.position.index}/${view.position.total}` : undefined
  switch (run.state) {
    case "needs_input": return { text: group ? "needs you" : position ?? "needs input", fg: "warning" }
    case "verifying": return { text: "in review", fg: "warning" }
    case "running": {
      if (position) return { text: position, fg: "text" }
      const agents = run.script ? run.script.calls : 0
      return { text: run.script ? `${agents} agent${agents === 1 ? "" : "s"}` : `step ${Math.max(1, view.phases.findIndex((phase) => phase.state === "running") + 1)}/${Math.max(1, view.phases.length)}`, fg: "text" }
    }
    case "failed":
    case "blocked": return { text: position && !group ? position : STATE[run.state].label, fg: "error" }
    case "completed": return view.outcome ? { text: view.outcome.word, fg: view.outcome.tone } : { text: "done", fg: "success" }
    default: return { text: STATE[run.state].label, fg: "muted" }
  }
}

/** A batch's status: `3 reviews` when every run made one agent call of the same kind, else `3 runs`; `1 of 3 failed` when any failed. */
function batchStatus(runs: WorkflowSummary[]): { text: string; fg: ColorName } {
  const failed = runs.filter((run) => markOf(run) === "fail").length
  if (failed) return { text: `${failed} of ${runs.length} failed`, fg: "error" }
  const words = runs.map((run) => {
    const agents = run.tasks.filter((task) => !isCheck(task))
    return agents.length === 1 ? (agents[0]!.label ?? "").split(/\s+/)[0]?.toLowerCase() : undefined
  })
  const word = words[0] && words.every((each) => each === words[0]) ? words[0] : "run"
  return { text: `${runs.length} ${word}s`, fg: runs.some((run) => LIVE.has(run.state)) ? "text" : "success" }
}

// ---------------------------------------------------------------------------------------------- the list

/** One list row in `width` cells: indent, mark, name, status, time (and on the full-width list, how many runs or when it started). */
function listLine(row: Exclude<Row, { kind: "heading" }>, input: { width: number; now: number; glyphs: Glyphs; full: boolean }): Line {
  const { width, now, glyphs, full } = input
  const lit = literals(glyphs)
  const depth = row.kind === "group" ? 0 : row.depth
  let name: string
  let mark: MarkKind
  let status: { text: string; fg: ColorName }
  let time: string
  let extra = ""
  let bright: boolean
  if (row.kind === "group") {
    const live = row.group.runs.find((run) => LIVE.has(run.state))
    const shown = live ?? row.group.runs[0]!
    name = row.group.title
    // A finished group reads as its newest entry: how the item stands now, not every attempt before.
    mark = live ? markOf(live) : worst(entryRuns(row.group.entries[0]!).map(markOf))
    status = live ? statusOf(live, true) : row.group.entries[0]!.kind === "batch" ? batchStatus(entryRuns(row.group.entries[0]!)) : statusOf(shown, true)
    time = live && TICKING.has(live.state) ? runElapsed(live, now) : todayTimeOrDateTime(shown.startedAt, now)
    extra = `${row.group.runs.length} runs`
    bright = live !== undefined
  } else if (row.kind === "pack") {
    const runs = row.entry.runs
    name = `${runs[0]!.name} ${lit.times}${runs.length}`
    mark = worst(runs.map(markOf))
    status = row.entry.kind === "batch" ? batchStatus(runs) : statusOf(runs[0]!)
    // A batch takes as long as its slowest run.
    time = runElapsed(slowest(runs, now), now)
    extra = todayTimeOrDateTime(runs[0]!.startedAt, now)
    bright = runs.some((run) => LIVE.has(run.state))
  } else {
    // A run alone at the top level stands for its item: the item names the row, the workflow follows.
    name = row.depth === 0 && row.run.subject ? `${row.run.subject} ${glyphs.sep} ${row.run.name}` : row.run.name
    mark = markOf(row.run)
    status = statusOf(row.run)
    time = runElapsed(row.run, now)
    extra = todayTimeOrDateTime(row.run.startedAt, now)
    bright = LIVE.has(row.run.state)
  }
  const statusCells = full ? 15 : width >= 44 ? 13 : 0
  const timeCells = full ? 9 : 8
  const extraCells = full ? 10 : 0
  const lead = 2 + depth * 2
  const nameRoom = Math.max(4, width - lead - 2 - statusCells - timeCells - extraCells)
  const line: Line = [
    { text: " ".repeat(lead) },
    markSpan(mark, glyphs),
    { text: " " },
    { text: pad(truncateEnd(name, nameRoom - 1), nameRoom), fg: bright ? "text" : "muted", bold: bright && row.kind === "group" },
  ]
  if (statusCells) line.push({ text: pad(truncateEnd(status.text, statusCells - 1), statusCells), fg: status.fg })
  line.push({ text: padStart(truncateEnd(time, timeCells - 1), timeCells), fg: "muted" })
  if (extraCells) line.push({ text: padStart(truncateEnd(extra, extraCells - 1), extraCells), fg: "muted" })
  return clip(line, width)
}

function listPane(input: { runs: WorkflowSummary[]; state: WorkflowsPageState; width: number; rows: number; now: number; glyphs: Glyphs; full: boolean; focused: boolean }): Line[] {
  const { runs, state, width, rows: room, now, glyphs, full, focused } = input
  const { rows } = listRows(runs, state)
  const at = cursorAt(rows, state)
  const offset = Math.min(Math.max(0, at - room + 1), Math.max(0, rows.length - room))
  return rows.slice(offset, offset + room).map((row, index): Line => {
    if (row.kind === "heading") return clip([{ text: row.text, fg: "muted", bold: true }, { text: ` · ${row.count}`, fg: "muted" }], width)
    const line = listLine(row, { width, now, glyphs, full })
    return offset + index === at ? cursorRow(line, width, glyphs, focused) : line
  })
}

// ---------------------------------------------------------------------------------------------- the run

/** The phases in one row: `✓ Plan ── ● Audit ── ◇ Card`, narrower joiners, then marks only for the phases not in play. */
function stepperRow(view: RunView, width: number, glyphs: Glyphs): Line | undefined {
  if (!view.stepper) return undefined
  const lit = literals(glyphs)
  const named = view.phases.filter((phase) => phase.title)
  const marks = named.map((phase) => phaseMark(phase, glyphs, lit.skipped))
  const build = (joiner: string, titled: (phase: Phase) => boolean): Line => named.flatMap((phase, index): Span[] => [
    ...(index ? [{ text: joiner, fg: "border" as const }] : []),
    marks[index]!,
    ...(titled(phase) ? [{ text: ` ${phase.title}`, fg: phase.state === "pending" ? "muted" as const : "text" as const }] : []),
  ])
  const width_ = (line: Line) => line.reduce((sum, each) => sum + textWidth(each.text), 0)
  const inPlay = (phase: Phase) => phase.state === "running" || phase.state === "blocked" || phase.waiting
  for (const line of [build(` ${glyphs.rule.repeat(2)} `, () => true), build(` ${glyphs.rule} `, () => true), build(glyphs.rule, inPlay)]) if (width_(line) <= width) return line
  return clip(build(glyphs.rule, inPlay), width)
}

function phaseMark(phase: Phase, glyphs: Glyphs, skipped: string): Span {
  if (phase.waiting) return { text: glyphs.ask, fg: "warning" }
  if (phase.state === "done") return { text: glyphs.ok, fg: "success" }
  if (phase.state === "running") return { text: dotMark(glyphs), fg: "primary" }
  if (phase.state === "blocked") return { text: glyphs.fail, fg: "error" }
  return phase.notRun ? { text: skipped, fg: "muted" } : { text: glyphs.collapsed, fg: "muted" }
}

function stepMark(task: WorkflowTaskSummary, glyphs: Glyphs, skipped: string): Span {
  switch (task.state) {
    case "done": return { text: glyphs.ok, fg: "success" }
    case "running": return { text: dotMark(glyphs), fg: "primary" }
    case "needs_input": return { text: glyphs.ask, fg: "warning" }
    case "failed": return { text: glyphs.fail, fg: "error" }
    case "skipped":
    case "stopped": return { text: skipped, fg: "muted" }
    case "pending": return { text: glyphs.collapsed, fg: "muted" }
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const compactCount = (value: number) => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${+(value / 1_000).toFixed(1)}k` : String(value))

function phaseTime(phase: Phase, now: number): string {
  if (phase.startedAt === undefined) return ""
  if (phase.state === "running" || phase.waiting) return elapsed(now - phase.startedAt)
  return phase.endedAt !== undefined ? elapsed(phase.endedAt - phase.startedAt) : ""
}

/** Tokens a phase's steps used, when every one of them is listed (a run that dropped old steps from its summary would undercount). */
function phaseTokens(run: WorkflowSummary, phase: Phase): number {
  if (run.script?.omitted) return 0
  return phase.steps.reduce((sum, task) => sum + (task.usage ? task.usage.input + task.usage.output : 0), 0)
}

/**
 * A phase's agents as one row of cells: done, failed, running, waiting their turn. The share of each is what the bar says, so a
 * long phase reads at a glance; a phase of one agent has no bar.
 */
function agentBar(phase: Phase, cells: number, glyphs: Glyphs): Span[] {
  const agents = phase.steps.filter((task) => !isCheck(task))
  if (agents.length < 2 || cells < 3) return []
  const count = (...states: WorkflowTaskState[]) => agents.filter((task) => states.includes(task.state)).length
  const shares = [
    { n: count("done"), fg: "success" as const, text: glyphs.barFull },
    { n: count("failed", "stopped"), fg: "error" as const, text: glyphs.barFull },
    // Running reads apart from done by its glyph as well as its colour.
    { n: count("running", "needs_input"), fg: "primary" as const, text: glyphs.barFull === "█" ? "▓" : "+" },
    { n: count("pending", "skipped"), fg: "border" as const, text: glyphs.barEmpty },
  ]
  const width = Math.min(cells, agents.length)
  // Whole cells by share, the rest to the largest; a live agent always shows.
  const sizes = shares.map((share) => Math.floor((share.n / agents.length) * width))
  for (let left = width - sizes.reduce((sum, size) => sum + size, 0); left > 0; left--) sizes[sizes.indexOf(Math.max(...sizes))]!++
  const live = shares.findIndex((share) => share.fg === "primary" && share.n > 0)
  if (live >= 0 && sizes[live] === 0) {
    sizes[live] = 1
    sizes[sizes.indexOf(Math.max(...sizes))]!--
  }
  return shares.flatMap((share, index) => (sizes[index]! > 0 ? [{ text: share.text.repeat(sizes[index]!), fg: share.fg }] : []))
}

function phaseLine(phase: Phase, input: { run: WorkflowSummary; titleWidth: number; width: number; now: number; glyphs: Glyphs; folded: boolean }): Line {
  const { run, titleWidth, width, now, glyphs } = input
  const lit = literals(glyphs)
  const pending = phase.state === "pending"
  const failedSteps = phase.steps.filter((task) => task.state === "failed" && !isCheck(task)).length
  const note: Span[] = phase.notRun ? [{ text: "not run", fg: "muted" }]
    : phase.waiting ? [{ text: "waiting for you", fg: "warning" }]
    : pending && phase.agents + phase.checks === 0 ? (phase.detail ? [{ text: phase.detail, fg: "muted" }] : [])
    : [
      ...(failedSteps ? [{ text: `${plural(failedSteps, "agent")} failed`, fg: "error" as const }] : []),
      ...(phase.checksFailed ? [{ text: `${plural(phase.checksFailed, "check")} failed`, fg: "error" as const }] : []),
      ...(phase.agents - failedSteps > 0 ? [{ text: plural(phase.agents - failedSteps, "agent"), fg: "muted" as const }] : []),
      ...(phase.checks - phase.checksFailed > 0 ? [{ text: plural(phase.checks - phase.checksFailed, "check"), fg: "muted" as const }] : []),
      ...(phaseTokens(run, phase) > 0 ? [{ text: `${compactCount(phaseTokens(run, phase))} tok`, fg: "muted" as const }] : []),
    ].flatMap((each, index): Span[] => (index ? [{ text: ` ${glyphs.sep} `, fg: "muted" }, each] : [each]))
  const bar = !phase.notRun && !pending && width >= BAR_AT ? agentBar(phase, BAR_CELLS, glyphs) : []
  return [
    { text: "  " },
    phaseMark(phase, glyphs, lit.skipped),
    { text: " " },
    { text: pad(phase.title, titleWidth), fg: pending ? "muted" : "text" },
    { text: padStart(phaseTime(phase, now), TIME_CELLS), fg: "muted" },
    { text: "  " },
    ...(bar.length ? [...bar, { text: " " }] : []),
    ...note,
    ...(input.folded ? [{ text: "  space opens", fg: "muted" as const, dim: true }] : []),
  ]
}

/** A step: mark, label, what it runs on (or `you`), its tokens and time, the time against the right edge. */
function stepLine(task: WorkflowTaskSummary, input: { run: WorkflowSummary; labelWidth: number; width: number; now: number; glyphs: Glyphs }): Line {
  const { run, labelWidth, width, now, glyphs } = input
  const lit = literals(glyphs)
  const model = task.modelId ?? task.execution?.model?.model
  const effort = task.execution?.model?.variant ? `#${task.execution.model.variant}` : task.execution?.model?.effort
  const route: Span[] = task.kind === "human" ? [{ text: "you", fg: "warning" }]
    : task.kind === "check" ? [{ text: "check", fg: "muted" }]
    : task.kind === "map" ? [{ text: "map", fg: "muted" }]
    : model ? [
      { text: model, fg: "accent" },
      ...(width >= ENGINE_AT ? [{ text: ` ${glyphs.sep} ${task.engine ?? "native"}`, fg: "muted" as const }] : []),
      ...(width >= EFFORT_AT && effort ? [{ text: ` ${glyphs.sep} ${effort}`, fg: "muted" as const }] : []),
      ...(task.attempt > 1 ? [{ text: ` ${glyphs.sep} attempt ${task.attempt}`, fg: "muted" as const }] : []),
    ] : []
  const tokens = task.usage && width >= TOKENS_AT ? `${compactCount(task.usage.input + task.usage.output)} tok` : ""
  const time = taskElapsed(task, now)
  const right: Span[] = [...(tokens ? [{ text: `${tokens}   `, fg: "muted" as const }] : []), { text: padStart(time, TIME_CELLS), fg: "muted" }]
  const left: Line = [
    { text: "  " },
    { text: `${glyphs.track} `, fg: "border" },
    stepMark(task, glyphs, lit.skipped),
    { text: " " },
    { text: pad(truncateEnd(stepLabel(task, run.subject), labelWidth), labelWidth), fg: task.state === "pending" || task.state === "skipped" ? "muted" : "text", bold: task.state === "running" || task.state === "needs_input" },
    { text: "  " },
    ...route,
  ]
  return spread(left, right, width)
}

/** What goes under a step: what it does now, the question it asks, why it failed or why it waits to retry. */
function stepDetail(task: WorkflowTaskSummary, input: { run: WorkflowSummary; width: number; glyphs: Glyphs }): Line[] {
  const { run, width, glyphs } = input
  const lit = literals(glyphs)
  const lead: Span[] = [{ text: "  " }, { text: `${glyphs.track}   `, fg: "border" }]
  const room = Math.max(1, width - 6)
  const rows = (text: string, max: number, fg: ColorName): Line[] => {
    const lines = wrap(text.replace(/\s+/g, " ").trim(), room)
    return lines.slice(0, max).map((each, index): Line => [...lead, { text: index === max - 1 && lines.length > max ? truncateEnd(`${each} ${lit.more}`, room) : each, fg }])
  }
  if (task.kind === "map" && task.expanded) {
    const children = run.tasks.filter((entry) => entry.mapParentId === task.id && !entry.mapRetired)
    return [[...lead, { text: `${children.filter((entry) => entry.state === "done").length}/${children.length} items`, fg: "muted" }]]
  }
  switch (task.state) {
    case "running": return task.latest ? [clip([...lead, { text: `${lit.activity} ${task.latest.replace(/\s+/g, " ")}`, fg: "body" }], width)] : []
    case "needs_input": return task.kind === "human" ? rows(task.latest ?? "y approve · n reject", 2, "body") : [clip([...lead, { text: "needs your approval · enter opens the session", fg: "warning" }], width)]
    case "failed": return rows(task.reason ?? "failed", FAILURE_ROWS, "error")
    case "pending": return task.reason?.startsWith("retrying") ? rows(task.reason, 1, "warning") : []
    default: return []
  }
}

/** Checks of an opened phase, grouped by label: `✓ 38 × node … check   9.8s`. */
function checkRows(phase: Phase, input: { width: number; glyphs: Glyphs }): Line[] {
  const { width, glyphs } = input
  const lit = literals(glyphs)
  const groups = new Map<string, { label: string; state: WorkflowTaskState; count: number; ms: number }>()
  for (const task of phase.checkTasks) {
    const label = task.label ?? task.id
    const key = `${label}\0${task.state}`
    const entry = groups.get(key) ?? { label, state: task.state, count: 0, ms: 0 }
    entry.count++
    entry.ms += task.startedAt !== undefined && task.endedAt !== undefined ? task.endedAt - task.startedAt : 0
    groups.set(key, entry)
  }
  const all = [...groups.values()]
  const shown = all.slice(0, CHECK_ROWS_MAX).map((entry): Line => {
    const time = padStart(elapsed(entry.ms), TIME_CELLS)
    const left: Line = [{ text: "  " }, { text: `${glyphs.track} `, fg: "border" }, stepMark({ state: entry.state } as WorkflowTaskSummary, glyphs, lit.skipped), { text: ` ${String(entry.count).padStart(2)} ${lit.times} `, fg: "muted" }, { text: shortenMiddle(entry.label, Math.max(8, width - 18)), fg: "body" }]
    return spread(left, [{ text: time, fg: "muted" }], width)
  })
  return all.length > CHECK_ROWS_MAX ? [...shown, [{ text: "  " }, { text: `${glyphs.track} `, fg: "border" }, { text: `${lit.more} ${all.length - CHECK_ROWS_MAX} more`, fg: "muted" }]] : shown
}

type Item = { key?: string; line: Line }

/** Tokens and cost of a run so far: the script's live totals, else the sum of its steps. */
function usageOf(run: WorkflowSummary): { tokens: number; costMicros: number } {
  if (run.script) return { tokens: run.script.usage.tokens, costMicros: run.script.usage.costMicros ?? 0 }
  return run.tasks.reduce((sum, task) => ({ tokens: sum.tokens + (task.usage ? task.usage.input + task.usage.output : 0), costMicros: sum.costMicros + (task.usage?.costMicros ?? 0) }), { tokens: 0, costMicros: 0 })
}
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(micros >= 10_000_000 ? 0 : 2)}`

/**
 * What a run that ended made: one line of totals, then what each phase produced (the first lines of its agents' answers), and how
 * to go further. The first rows of the timeline, before the phases, so a long run opens on its result.
 */
function summaryRows(run: WorkflowSummary, view: RunView, input: { width: number; now: number; glyphs: Glyphs }): Line[] {
  const { width, now, glyphs } = input
  const lit = literals(glyphs)
  const agents = run.tasks.filter((task) => !isCheck(task) && task.kind !== "human")
  if (!agents.length) return []
  const named = view.phases.filter((phase) => phase.title)
  const usage = usageOf(run)
  const total = [
    ...(named.length > 1 ? [plural(named.length, "phase")] : []),
    plural(run.script?.usage.agents ?? agents.length, "agent"),
    runElapsed(run, now),
    ...(usage.tokens ? [`${compactCount(usage.tokens)} tok`] : []),
    ...(usage.costMicros ? [dollars(usage.costMicros)] : []),
  ].join(` ${glyphs.sep} `)
  const label = Math.min(14, Math.max(7, ...named.map((phase) => textWidth(phase.title))))
  const inner = Math.max(1, width - 2)
  const rows: Line[] = [[{ text: "  " }, { text: pad("Summary", label + 3), fg: "text", bold: true }, { text: truncateEnd(total, Math.max(1, inner - label - 3)), fg: "body" }]]
  for (const phase of named) {
    const made = [...new Set(phase.steps.flatMap((task) => (task.produced ? [task.produced] : [])))]
    const failed = phase.steps.find((task) => task.state === "failed")
    const text = failed ? `${stepLabel(failed, run.subject)} failed${failed.reason ? `: ${failed.reason.replace(/\s+/g, " ")}` : ""}` : made.length ? `${made[0]}${made.length > 1 ? ` ${glyphs.sep} +${made.length - 1} more` : ""}` : phase.notRun ? "not run" : plural(phase.agents, "agent")
    rows.push([{ text: "  " }, phaseMark(phase, glyphs, lit.skipped), { text: " " }, { text: pad(truncateEnd(phase.title, label), label + 1), fg: "muted" }, { text: " " }, { text: truncateEnd(text, Math.max(1, inner - label - 4)), fg: failed ? "error" : "body" }])
  }
  rows.push([{ text: "  " }, { text: truncateEnd(`enter opens an agent's session ${glyphs.sep} s keeps this as a /command ${glyphs.sep} r runs a step again`, inner), fg: "muted", dim: true }], [])
  return rows
}

/** The run's timeline: one row per phase, its steps under it with what each does now, the opened checks, then verification. */
function timeline(run: WorkflowSummary, input: { state: WorkflowsPageState; width: number; now: number; glyphs: Glyphs }): Item[] {
  const { state, width, now, glyphs } = input
  const view = runView(run)
  const titleWidth = Math.max(0, ...view.phases.map((phase) => textWidth(phase.title)))
  const labelWidth = Math.min(view.labelWidth, Math.max(6, width - 30))
  const items: Item[] = []
  if (run.script?.omitted) items.push({ line: [{ text: "  " }, { text: `${literals(glyphs).more} ${plural(run.script.omitted, "earlier call")} not listed`, fg: "muted" }] })
  if (TERMINAL.has(run.state)) for (const line of summaryRows(run, view, { width, now, glyphs })) items.push({ line })
  for (const phase of view.phases) {
    const fold = phase.title !== "" && folded(run, phase, state)
    if (phase.title) items.push({ key: phase.key, line: phaseLine(phase, { run, titleWidth, width, now, glyphs, folded: fold }) })
    if (fold) {
      // The results of a finished phase, folded into one line under it.
      const made = [...new Set(phase.steps.flatMap((task) => (task.produced ? [task.produced] : [])))].slice(0, 2).join(` ${glyphs.sep} `)
      if (made) items.push({ line: [{ text: "  " }, { text: `${glyphs.track}   `, fg: "border" }, { text: truncateEnd(made, Math.max(1, width - 6)), fg: "muted" }] })
      continue
    }
    if (state.checks?.includes(checksKey(run, phase.key))) for (const line of checkRows(phase, { width, glyphs })) items.push({ line })
    for (const task of phase.steps) {
      items.push({ key: `t:${task.id}`, line: stepLine(task, { run, labelWidth, width, now, glyphs }) })
      for (const line of stepDetail(task, { run, width, glyphs })) items.push({ line })
    }
  }
  if (hasVerify(run)) {
    const rows = verificationRows(run, Math.max(1, width - 2), glyphs)
    items.push({ line: [] })
    rows.forEach((line, index) => items.push({ ...(index === 0 ? { key: "v" } : {}), line: [{ text: "  " }, ...line] }))
  }
  return items
}

/** One row under the header: what waits for the user, why it stopped, how it ended, or what the run is for. */
function noticeRow(run: WorkflowSummary, view: RunView, width: number, glyphs: Glyphs): Line {
  const sep = ` ${glyphs.sep} `
  const row = (text: string, fg: ColorName): Line => [{ text: "  " }, { text: truncateEnd(text.replace(/\s+/g, " ").trim(), Math.max(1, width - 2)), fg }]
  if (view.waiting) return row(view.waiting.kind === "human" ? `Waiting for you: ${stepLabel(view.waiting, run.subject)}${sep}y approve${sep}n reject` : `${stepLabel(view.waiting, run.subject)} needs your approval${sep}enter opens its session`, "warning")
  if (run.state === "failed" || run.state === "blocked") {
    const phase = view.failed ? view.phases.find((each) => each.steps.includes(view.failed!)) : undefined
    if (view.failed) return row(`Stopped${phase?.title ? ` in ${phase.title}` : ""}: ${stepLabel(view.failed, run.subject)} failed${sep}t retry`, "error")
    return row(run.reason ?? run.script?.error ?? STATE[run.state].label, "error")
  }
  if (view.outcome) return row(`${view.outcome.word}${view.outcome.reason ? `: ${view.outcome.reason}` : ""}`, view.outcome.tone)
  if (run.queuedBehind) return row(`waits for ${run.queuedBehind}`, "muted")
  if (run.state === "paused" && run.reason) return row(run.reason, "warning")
  return row(run.objective, "muted")
}

/** The run's header: mark, name and work item; its state and time on the right. */
function headerRow(run: WorkflowSummary, input: { width: number; now: number; glyphs: Glyphs }): Line {
  const { width, now, glyphs } = input
  const mark = markSpan(markOf(run), glyphs)
  const state = run.state === "completed" && runView(run).outcome ? { label: runView(run).outcome!.word, fg: runView(run).outcome!.tone as ColorName } : STATE[run.state]
  const left: Line = [{ text: "  " }, mark, { text: " " }, { text: run.name, fg: "text", bold: true }, ...(run.subject ? [{ text: ` ${glyphs.sep} ${run.subject}`, fg: "text" as const }] : [])]
  return spread(left, [{ text: state.label, fg: state.fg }, { text: ` ${glyphs.sep} ${run.state === "verifying" ? "in review" : runElapsed(run, now)}`, fg: "muted" }], width)
}

/** `phase 5 of 7 · 1 of 16 agents · 52 checks passed · 1 failed`. */
function progressRow(run: WorkflowSummary, view: RunView, width: number, glyphs: Glyphs): Line | undefined {
  const sep = ` ${glyphs.sep} `
  const parts: Span[] = []
  const add = (text: string, fg: ColorName = "muted") => parts.push(...(parts.length ? [{ text: sep, fg: "muted" as const }] : []), { text, fg })
  if (view.position) add(`phase ${view.position.index} of ${view.position.total}`)
  if (run.script) add(`${run.script.usage.agents} of ${run.script.budget.agents ?? "-"} agents`)
  else if (run.tasks.length) add(`${run.tasks.filter((task) => task.state === "done").length} of ${plural(run.tasks.length, "task")} done`)
  const spent = usageOf(run)
  if (spent.tokens) add(`${compactCount(spent.tokens)} tok`)
  if (spent.costMicros) add(dollars(spent.costMicros))
  if (view.checksPassed) add(`${plural(view.checksPassed, "check")} passed`)
  if (view.checksFailed) add(`${view.checksFailed} failed`, "error")
  if (view.agentsFailed) add(`${plural(view.agentsFailed, "agent")} failed`, "error")
  return parts.length ? clip([{ text: "  " }, ...parts], width) : undefined
}

/** Ids, hashes, limits and the cursor step's policy: what `i` shows in place of the timeline. */
function infoRows(run: WorkflowSummary, input: { step: string | undefined; width: number; now: number }): Line[] {
  const { step, width, now } = input
  const inner = Math.max(1, width - 2)
  const identity = kvList([
    { label: "workflow", value: run.workflowId },
    ...(run.definitionId ? [{ label: "definition", value: run.definitionId }] : []),
    ...(run.revisionId ? [{ label: "revision", value: `#${run.revision} ${"·"} ${run.revisionId}` }] : []),
    { label: "plan hash", value: shortenMiddle(run.planHash, Math.max(8, inner - LABEL_WIDTH)) },
    ...(run.script ? [{ label: "script", value: `${run.script.origin} · sha ${run.script.hash.slice(0, 12)}${run.script.host === "running" || run.script.host === "done" ? "" : ` · host ${run.script.host}`}` }] : []),
    { label: "folder", value: shortenMiddle(run.directory, Math.max(8, inner - LABEL_WIDTH)) },
  ], inner)
  const contract = contractText(run)
  const script = run.script
  const minutes = Math.floor(((run.endedAt ?? now) - run.startedAt) / 60_000)
  // The static plan's phase under the cursor (else the one in progress) and when it counts as done.
  const stepTask = taskOf(run, step)
  const barrier = run.phases?.find((phase) => (stepTask ? phase.tasks.includes(stepTask.id) : `p:${phase.id}` === step)) ?? run.phases?.find((phase) => phase.state === "running")
  const limits = kvList([
    { label: "permission", value: permsText(run) },
    { label: "contract", value: contract.text, tone: contract.fg },
    ...(script ? [{ label: "caps", value: [
      `agents ${script.usage.agents}/${script.budget.agents ?? "-"}`,
      `tokens ${compactCount(script.usage.tokens)}${script.budget.tokens !== undefined ? `/${compactCount(script.budget.tokens)}` : ""}`,
      ...(script.budget.usd !== undefined || script.usage.costMicros ? [`$${((script.usage.costMicros ?? 0) / 1_000_000).toFixed(2)}${script.budget.usd !== undefined ? `/$${script.budget.usd}` : ""}`] : []),
      ...(script.budget.minutes !== undefined ? [`${minutes}/${script.budget.minutes} min`] : []),
    ].join(" · ") }] : []),
    ...(script && Object.keys(script.usage.engines ?? {}).length ? [{ label: "engines", value: Object.entries(script.usage.engines ?? {}).map(([name, entry]) => `${name} ${plural(entry.agents, "agent")} ${compactCount(entry.tokens)} tok`).join(" · ") }] : []),
    ...(run.overlapPolicy ? [{ label: "overlap", value: `${run.overlapPolicy}${run.queuedBehind ? ` · waits ${run.queuedBehind}` : ""}` }] : []),
    ...(barrier ? [{ label: "barrier", value: `${barrier.title} · ${barrier.barrier.kind}${barrier.barrier.kind === "quorum" ? ` ${barrier.barrier.quorum}` : barrier.barrier.kind === "condition" ? ` ${barrier.barrier.expression}` : ""}` }] : []),
  ], inner)
  // How the cursor's step runs; with no step chosen, the first step that has a recorded execution.
  const task = stepTask?.execution ? stepTask : run.tasks.find((each) => each.execution)
  const execution = task?.execution
  const stepRows = execution ? kvList([
    { label: "agent", value: [execution.agent, execution.model?.model, execution.model?.variant ? `#${execution.model.variant}` : execution.model?.effort].filter(Boolean).join(" · ") || (execution.readOnly ? "read-only" : execution.permission) },
    { label: "workspace", value: `${execution.workspace.mode}${execution.directory !== run.directory ? ` · ${shortenMiddle(execution.directory, Math.max(8, inner - 24))}` : ""}` },
    { label: "permission", value: execution.readOnly ? "read-only" : execution.permission },
  ], inner) : []
  const indent = (lines: Line[]) => lines.map((line): Line => [{ text: "  " }, ...line])
  // The cursor's step first: on a short terminal it is what the user opened `i` for.
  return [
    ...(stepRows.length && task ? [...indent(section({ title: stepLabel(task, run.subject), body: stepRows, width: inner })), []] : []),
    ...indent(section({ title: "Limits", body: limits, width: inner })), [],
    ...indent(section({ title: "Identity", body: identity, width: inner })),
    ...(script?.result && !script.outcome ? [[], ...indent(section({ title: "Result", body: wrap(script.result, inner).slice(0, 4).map((text): Line => [{ text, fg: "body" }]), width: inner }))] : []),
    ...(script?.logs.length ? [[], ...indent(section({ title: "Log", body: script.logs.slice(-5).map((text): Line => [{ text: truncateEnd(text.replace(/\s+/g, " "), inner), fg: "body" }]), width: inner }))] : []),
  ]
}

/** The run pane: header, notice, stepper, progress, then the timeline (or the info view), scrolled to keep the cursor in sight. */
function runPane(run: WorkflowSummary, input: { state: WorkflowsPageState; width: number; rows: number; now: number; glyphs: Glyphs; focused: boolean }): Line[] {
  const { state, width, rows, now, glyphs, focused } = input
  const view = runView(run)
  const stepper = stepperRow(view, Math.max(1, width - 2), glyphs)
  const progress = progressRow(run, view, width, glyphs)
  const head: Line[] = [headerRow(run, { width, now, glyphs }), noticeRow(run, view, width, glyphs), [], ...(stepper ? [[{ text: "  " }, ...stepper]] : []), ...(progress ? [progress] : []), []]
  const step = state.focus === "run" ? stepOf(run, state) : undefined
  if (state.info) {
    const info = infoRows(run, { step, width, now })
    const room = Math.max(0, rows - head.length)
    // Scrolled no further than the last row reaching the bottom.
    const offset = Math.min(state.infoOffset ?? 0, Math.max(0, info.length - room))
    return [...head, ...info.slice(offset, offset + room)]
  }
  const items = timeline(run, { state, width, now, glyphs })
  const room = Math.max(0, rows - head.length)
  const at = step === undefined ? -1 : items.findIndex((item) => item.key === step)
  // The cursor's step with its detail rows in sight.
  const tail = at >= 0 ? at + items.slice(at + 1).findIndex((item) => item.key !== undefined || item.line.length === 0) : -1
  const last = at < 0 ? -1 : tail < at ? items.length - 1 : tail
  const offset = at < 0 ? 0 : Math.min(Math.max(0, last - room + 1), Math.max(0, items.length - room), at)
  const body = items.slice(offset, offset + room).map((item, index) => (offset + index === at && focused ? cursorRow(item.line, width, glyphs, true) : offset + index === at ? cursorRow(item.line, width, glyphs, false) : clip(item.line, width)))
  return [...head, ...body]
}

/** A batch or a fold: each of its runs as a lane, with its one agent, its time and its phases in marks. */
function packPane(entry: Extract<Entry, { kind: "batch" | "fold" }>, input: { width: number; now: number; glyphs: Glyphs }): Line[] {
  const { width, now, glyphs } = input
  const lit = literals(glyphs)
  const first = entry.runs[0]!
  const status = entry.kind === "batch" ? batchStatus(entry.runs) : statusOf(first)
  const header = spread([{ text: "  " }, markSpan(worst(entry.runs.map(markOf)), glyphs), { text: " " }, { text: `${first.name} ${lit.times}${entry.runs.length}`, fg: "text", bold: true }, ...(first.subject ? [{ text: ` ${glyphs.sep} ${first.subject}`, fg: "text" as const }] : [])], [{ text: status.text, fg: status.fg }, { text: ` ${glyphs.sep} ${runElapsed(slowest(entry.runs, now), now)}`, fg: "muted" }], width)
  const lanes = entry.runs.map((run): Line => {
    const agent = run.tasks.find((task) => !isCheck(task))
    const model = agent?.modelId ?? agent?.execution?.model?.model
    const marks = runView(run).phases.filter((phase) => phase.title).map((phase) => phaseMark(phase, glyphs, lit.skipped))
    const left: Line = [{ text: "  " }, markSpan(markOf(run), glyphs), { text: " " }, { text: agent ? stepLabel(agent, run.subject) : "no agent", fg: "text" }, ...(model ? [{ text: `  ${model}`, fg: "accent" as const }, { text: ` ${glyphs.sep} ${agent?.engine ?? "native"}`, fg: "muted" as const }] : [])]
    return spread(left, [{ text: `${padStart(runElapsed(run, now), TIME_CELLS)}   `, fg: "muted" }, ...marks.flatMap((mark, index): Span[] => [...(index ? [{ text: glyphs.rule, fg: "border" as const }] : []), mark])], width)
  })
  return [header, [{ text: "  " }, { text: truncateEnd(first.objective.replace(/\s+/g, " "), Math.max(1, width - 2)), fg: "muted" }], [], ...lanes, [], [{ text: "  " }, { text: `space opens the ${entry.kind === "batch" ? "batch" : "runs"}`, fg: "muted" }]]
}

/** The third column from 170 cells: when and where the run is, how much of its limits it used, the models it ran on, its log. */
function factsPane(run: WorkflowSummary, input: { width: number; now: number }): Line[] {
  const { width, now } = input
  const worktree = run.tasks.map((task) => task.execution?.directory).find((directory) => directory && directory !== run.directory)
  const script = run.script
  const minutes = Math.floor(((run.endedAt ?? now) - run.startedAt) / 60_000)
  const models = new Map<string, { agents: number; tokens: number }>()
  for (const task of run.tasks) {
    const model = task.modelId ?? task.execution?.model?.model
    if (!model || isCheck(task)) continue
    const key = `${model}\0${task.engine ?? "native"}`
    const entry = models.get(key) ?? { agents: 0, tokens: 0 }
    models.set(key, { agents: entry.agents + 1, tokens: entry.tokens + (task.usage ? task.usage.input + task.usage.output : 0) })
  }
  const atCap = script && script.budget.agents !== undefined && script.usage.agents >= script.budget.agents
  const logs = (script?.logs ?? []).slice(-3).flatMap((text) => wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width)).slice(0, 3)).map((text): Line => [{ text, fg: "body" }])
  return [
    ...section({ title: "Run", body: kvList([
      { label: "started", value: todayTimeOrDateTime(run.startedAt, now) },
      { label: "folder", value: shortenMiddle(run.directory.replace(/^\/Users\/[^/]+/, "~"), Math.max(8, width - 12)) },
      ...(worktree ? [{ label: "worktree", value: shortenMiddle(worktree.startsWith(`${run.directory}/`) ? worktree.slice(run.directory.length + 1) : worktree, Math.max(8, width - 12)) }] : []),
      { label: "permission", value: run.permission },
    ], width), width }), [],
    ...(script ? [...section({ title: "Limits", body: kvList([
      { label: "agents", value: `${script.usage.agents} / ${script.budget.agents ?? "-"}`, ...(atCap ? { tone: "warning" as const } : {}) },
      { label: "tokens", value: `${compactCount(script.usage.tokens)}${script.budget.tokens !== undefined ? ` / ${compactCount(script.budget.tokens)}` : ""}` },
      ...(script.budget.minutes ?? run.maxRuntimeMinutes ? [{ label: "time", value: `${minutes} / ${script.budget.minutes ?? run.maxRuntimeMinutes} min` }] : []),
    ], width), width }), []] : []),
    ...(models.size ? [...section({ title: "Models", body: kvList([...models].map(([key, entry]) => {
      const [model, engine] = key.split("\0")
      return { label: model!, value: `${engine} · ${plural(entry.agents, "agent")}${entry.tokens ? ` · ${compactCount(entry.tokens)}` : ""}` }
    }), width), width }), []] : []),
    ...(logs.length ? section({ title: "Log", body: logs, width }) : []),
  ]
}

// ---------------------------------------------------------------------------------------------- verification (unchanged)

type AuditCriteria = NonNullable<NonNullable<WorkflowSummary["verification"]>["audit"]>["criteria"]

function wrapped(text: string, width: number, max: number, indent: string, fg: ColorName): Line[] {
  const lines = wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - indent.length))
  return lines.slice(0, max).map((line, i): Line => [{ text: indent }, { text: i === max - 1 && lines.length > max ? truncateEnd(`${line} …`, width - indent.length) : line, fg }])
}

/** Per-criterion audit rows: `✓ id  evidence`, the evidence wrapped to two lines. */
function criterionRows(criteria: AuditCriteria, width: number, glyphs: Glyphs): Line[] {
  const rows: Line[] = []
  for (const criterion of criteria) {
    const mark: Span = criterion.status === "pass" ? { text: glyphs.ok, fg: "success" } : criterion.status === "fail" ? { text: glyphs.fail, fg: "error" } : { text: glyphs.ask, fg: "warning" }
    const body = wrap(`${criterion.id}  ${criterion.evidence}`.replace(/\s+/g, " ").trim(), Math.max(1, width - 6))
    body.slice(0, 2).forEach((text, i) => {
      const last = i === 1 && body.length > 2
      const shown = last ? truncateEnd(`${text} …`, Math.max(1, width - 6)) : text
      rows.push(i === 0 ? [{ text: "    " }, mark, { text: " " }, { text: shown, fg: "body" }] : [{ text: "      " }, { text: shown, fg: "body" }])
    })
  }
  return rows.map((row) => clip(row, width))
}

/** How completion is verified and what the last round found: checks, audit, criteria, rejection, override. Row 0 is the header. */
function verificationRows(run: WorkflowSummary, width: number, glyphs: Glyphs): Line[] {
  const v = run.verification
  const head: Span[] = [{ text: "Verify".padEnd(LABEL_WIDTH), fg: "text", bold: true }]
  // Blocked: the round could not finish (the audit stalled, failed or could not start); the reason line says why.
  if (run.state === "blocked" && run.contract && run.reason?.startsWith("audit ")) head.push({ text: `round ${run.rounds + 1} — did not finish`, fg: "warning" })
  else if (!v) head.push(run.contract ? { text: `round ${run.rounds} — ${run.state === "verifying" ? "running" : "not started"}`, fg: run.state === "verifying" ? "warning" : "body" } : { text: "none — tasks are not verified", fg: "muted" })
  else if (v.accepted) head.push({ text: `round ${v.round} — accepted`, fg: "success" })
  else if (run.state === "verifying") head.push({ text: `round ${v.round} — next round running`, fg: "warning" })
  else head.push({ text: `round ${v.round} — rejected`, fg: "error" })
  const rows: Line[] = [clip(head, width)]
  if (run.state === "blocked" && run.contract) rows.push(clip([{ text: "  " }, { text: "v", fg: "accent" }, { text: " verify again · ", fg: "muted" }, { text: "b", fg: "accent" }, { text: " evidence · ", fg: "muted" }, { text: "a", fg: "accent" }, { text: " accept", fg: "muted" }], width))
  if (v) {
    for (const gate of v.gates) {
      const detail = gate.status === "fail" && gate.detail ? gate.detail.replace(/\s+/g, " ").trim() : ""
      rows.push(clip([{ text: "  " }, gate.status === "pass" ? { text: `${glyphs.ok} `, fg: "success" } : { text: `${glyphs.fail} `, fg: "error" }, { text: gate.id, fg: "body" }, ...(detail ? [{ text: `  ${detail}`, fg: "muted" as const }] : [])], width))
    }
    if (v.audit) {
      const audit = v.audit
      const verdict = audit.workspaceChanged ? "void: workspace changed" : audit.verdict
      rows.push(clip([{ text: "  audit ", fg: "muted" }, { text: verdict, fg: audit.verdict === "pass" && !audit.workspaceChanged ? "success" : "error" }], width))
      rows.push(...criterionRows(audit.criteria, width, glyphs))
    }
    const unverified = v.criteria.filter((criterion) => criterion.status === "unverified").length
    if (unverified) rows.push(clip([{ text: "  ! ", fg: "warning" }, { text: `${unverified} unverified`, fg: "warning" }], width))
    if (!v.accepted && run.state !== "verifying" && v.audit?.findings) rows.push([{ text: "  rejected", fg: "muted" }], ...wrapped(v.audit.findings, width, 2, "    ", "warning"))
  }
  if (run.override) rows.push(clip([{ text: "accepted by you  ", fg: "muted" }, { text: run.override.reason, fg: "body" }], width))
  return rows
}

function contractText(run: WorkflowSummary): { text: string; fg: ColorName } {
  const c = run.contract
  if (!c) return { text: "none · completes when the tasks finish", fg: "muted" }
  const audit = c.audit === "independent" ? "independent audit" : c.audit === "auto" ? "auto audit" : "no audit"
  const parts = [c.checks ? `${c.checks} check${c.checks === 1 ? "" : "s"}` : "", audit, `${c.criteria} criteri${c.criteria === 1 ? "on" : "a"}`].filter(Boolean)
  return { text: parts.join(" · "), fg: "body" }
}

function permsText(run: WorkflowSummary): string {
  const parts: string[] = [run.permission]
  if (run.maxConcurrent) parts.push(`concurrency ${run.maxConcurrent}`)
  if (run.contract) parts.push(`repairs ${run.repairs}/${run.contract.maxRepairs}`)
  if (run.maxRuntimeMinutes) parts.push(`cap ${run.maxRuntimeMinutes}m`)
  return parts.join(" · ")
}

// ---------------------------------------------------------------------------------------------- keys and the page

type KeyHint = { key: string; label: string }
/** Every run has a ledger of events, artifacts and receipts (`b`, handled by the app). */
const EVIDENCE: KeyHint = { key: "b", label: "evidence" }

/** The keys that act here, most useful first; the title row keeps the ones that fit, always `? keys` and the `esc` one. */
function keyHints(input: { run: WorkflowSummary | undefined; row: Row | undefined; state: WorkflowsPageState; empty: boolean }): KeyHint[] {
  const { run, row, state, empty } = input
  if (empty) return [{ key: "tab", label: "scope" }]
  if (state.focus === "run" && run) {
    const failed = run.tasks.some((task) => task.state === "failed")
    const waiting = run.tasks.some((task) => task.kind === "human" && task.state === "needs_input")
    const pause = canPause(run) ? [{ key: "p", label: "pause" }] : canResume(run) ? [{ key: "p", label: "resume" }] : []
    const stop = canStop(run) ? [{ key: "x", label: "stop" }] : []
    const checks = runView(run).phases.some((phase) => phase.checks > 0) ? [{ key: "space", label: "checks" }] : []
    if (waiting) return [{ key: "y", label: "approve" }, { key: "n", label: "reject" }, { key: "enter", label: "session" }, ...pause, ...stop, { key: "i", label: "info" }]
    if (failed || run.state === "blocked") return [...(failed ? [{ key: "t", label: "retry" }] : []), ...(canVerify(run) ? [{ key: "v", label: "verify" }] : []), ...(canAccept(run) ? [{ key: "a", label: "accept" }] : []), { key: "enter", label: "session" }, EVIDENCE, ...pause, { key: "d", label: "delete" }, { key: "i", label: "info" }]
    if (LIVE.has(run.state)) return [{ key: "enter", label: "session" }, { key: "↑↓", label: "step" }, ...checks, ...pause, ...stop, EVIDENCE, { key: "i", label: "info" }]
    return [{ key: "enter", label: "session" }, { key: "↑↓", label: "step" }, ...checks, EVIDENCE, { key: "d", label: "delete" }, { key: "i", label: "info" }]
  }
  const fold = row && (row.kind === "group" || row.kind === "pack") ? [{ key: "space", label: row.open ? "close" : "open" }] : []
  const own = row?.kind === "run" ? [...(canPause(row.run) ? [{ key: "p", label: "pause" }] : canResume(row.run) ? [{ key: "p", label: "resume" }] : []), ...(canStop(row.run) ? [{ key: "x", label: "stop" }] : [])] : []
  return [{ key: "enter", label: row?.kind === "run" ? "open" : "expand" }, { key: "↑↓", label: "select" }, ...fold, ...own, EVIDENCE, { key: "tab", label: "scope" }]
}

/** The hints that fit in `room` cells, in order, with `? keys` and the `esc` hint always kept. */
function keysText(hints: KeyHint[], escape: KeyHint, room: number, glyphs: Glyphs): string {
  const fixed = [{ key: "?", label: "keys" }, escape]
  const join = (list: KeyHint[]) => list.map((hint) => `${hint.key} ${hint.label}`).join(` ${glyphs.sep} `)
  const chosen: KeyHint[] = []
  for (const hint of hints) if (textWidth(join([...chosen, hint, ...fixed])) <= room) chosen.push(hint)
  const text = join([...chosen, ...fixed])
  return textWidth(text) <= room ? text : join([escape])
}

/** Every key, for `?`: as the first rows of the body, in as many columns as fit. */
function allKeysRows(width: number): Line[] {
  const keys: Array<[string, string]> = [
    ["↑↓ jk", "move"], ["enter →", "open run / session"], ["space", "fold · checks"], ["← esc", "list / back"], ["tab 1 2", "scope"], ["i", "info"],
    ["p", "pause · resume"], ["x", "stop"], ["d", "delete"], ["t", "retry failed step"], ["r", "run step again"], ["y n", "approve · reject"], ["v", "verify"], ["a", "accept"], ["b", "evidence"],
    ["s", "save as /command"], ["f", "filter runs"], ["3", "saved workflows"], ["q", "close"],
  ]
  const cell = 28
  const columns = Math.max(1, Math.floor((width - 2) / cell))
  const rows: Line[] = []
  for (let index = 0; index < keys.length; index += columns) {
    rows.push(clip([{ text: "  " }, ...keys.slice(index, index + columns).flatMap(([key, label]): Span[] => [{ text: pad(key, 9), fg: "accent" }, { text: pad(label, cell - 9), fg: "muted" }])], width))
  }
  return [...rows, []]
}

function emptyRows(state: WorkflowsPageState, width: number): Line[] {
  if (state.filter) return section({ title: `No ${FILTER_LABEL[state.filter]} workflows`, subtitle: "f shows the next set of runs.", body: [], width })
  return section({
    title: state.scope === "all" ? "No workflows" : "No workflows in this project",
    ...(state.scope === "project" ? { subtitle: "Runs started here show up as they start. Tab shows every project." } : {}),
    body: [[{ text: "/workflows <name|file> --yes", fg: "text" }], [{ text: "/workflows run <file.js> --yes · /workflows new <name>", fg: "muted" }]],
    width,
  })
}

type RenderInput = { runs: WorkflowSummary[]; saved?: readonly SavedWorkflow[]; state: WorkflowsPageState; width: number; height: number; now: number; glyphs?: Glyphs; directory?: string; /** The page's animation frame; unset (or `still`) draws a live run's dot instead of a spinner. */ frame?: number; still?: boolean }

/** Renders exactly `height` lines of at most `width` cells. `now` drives the elapsed times, `frame` the spinners of what is live. */
export function renderWorkflowsPage(input: RenderInput): Line[] {
  const glyphs = input.glyphs ?? defaultGlyphs()
  const ascii = glyphs.rule === "-"
  motion = input.frame === undefined || input.still || !isMoving(input.runs) ? undefined : (ascii ? ASCII_SPIN : SPINNER_FRAMES)[input.frame % (ascii ? ASCII_SPIN.length : SPINNER_FRAMES.length)]
  try {
    return renderPage({ ...input, glyphs })
  } finally {
    motion = undefined
  }
}

/** The Saved tab: workflows of the user, the packages and the project; enter writes `/name ` in the prompt, `r` starts it. */
function savedPane(saved: readonly SavedWorkflow[], input: { state: WorkflowsPageState; width: number; rows: number; glyphs: Glyphs }): Line[] {
  const { state, width, rows: room, glyphs } = input
  if (!saved.length) return section({ title: "No saved workflows", subtitle: "s on a run keeps it here, and a package can ship its own. Each runs as /name.", body: [[{ text: "/workflows saved", fg: "muted" }]], width })
  const at = Math.max(0, saved.findIndex((entry) => entry.name === state.saved))
  const nameCells = Math.min(24, Math.max(...saved.map((entry) => textWidth(entry.name))) + 2)
  const fromCells = 16
  const offset = Math.min(Math.max(0, at - room + 1), Math.max(0, saved.length - room))
  return saved.slice(offset, offset + room).map((entry, index): Line => {
    const from = entry.pkg ? `package ${entry.pkg}` : entry.source
    const line: Line = [
      { text: "  " },
      { text: pad(truncateEnd(`/${entry.name}`, nameCells), nameCells + 1), fg: entry.problem ? "error" : "text", bold: true },
      { text: pad(entry.kind, 8), fg: "muted" },
      { text: pad(truncateEnd(from, fromCells - 1), fromCells), fg: entry.pkg ? "accent" : "muted" },
      { text: truncateEnd(entry.problem ? `cannot run: ${entry.problem}` : entry.description ?? "", Math.max(1, width - nameCells - fromCells - 12)), fg: entry.problem ? "error" : "body" },
    ]
    return offset + index === at ? cursorRow(clip(line, width), width, glyphs, true) : clip(line, width)
  })
}

function renderPage(input: RenderInput & { glyphs: Glyphs }): Line[] {
  const { state, width, height, now, glyphs } = input
  const saved = input.saved ?? []
  if (height <= 0) return []
  const runs = visibleRuns(input.runs, state)
  const inner = Math.max(1, width - 2)
  const { rows } = listRows(runs, state)
  const row = rows[cursorAt(rows, state)]
  const shown = runOfRow(row)
  const run = row?.kind === "run" ? row.run : undefined
  const wide = width >= WIDE
  const inRun = state.focus === "run" && run !== undefined
  const tabs: PageTab[] = [
    { key: "1", label: "This project", short: "Project", ...(state.scope === "project" && runs.length ? { count: runs.length } : {}) },
    { key: "2", label: "All projects", short: "All", ...(state.scope === "all" && runs.length ? { count: runs.length } : {}) },
    { key: "3", label: "Saved", short: "Saved", ...(saved.length ? { count: saved.length } : {}) },
  ]
  // Under "All projects" the title says so in one word (the tabs below name the scope in full), so the key hints keep their room.
  const context = (!wide && inRun ? (run.subject ?? run.name) : state.scope === "all" ? "all" : state.scope === "saved" ? "saved" : input.directory ? basename(input.directory) : "this project") + (state.filter ? ` ${glyphs.sep} ${FILTER_LABEL[state.filter]}` : "")
  const confirmRun = state.confirm ? runs.find((each) => each.workflowId === state.confirm!.workflowId) : undefined
  const status: PageStatus | undefined = state.confirm && confirmRun ? { label: state.confirm.kind === "restart" ? `run "${(confirmRun.tasks.find((task) => task.id === state.confirm!.taskId)?.label ?? state.confirm.taskId ?? "step")}" again? r/y confirm` : `${state.confirm.kind} "${confirmRun.name}${confirmRun.subject ? ` · ${confirmRun.subject}` : ""}"? ${state.confirm.kind === "stop" ? "x" : "d"}/y confirm`, tone: "warn" } : undefined
  const escape = { key: "esc", label: inRun ? "list" : "back" }
  const titleWidth = textWidth(`Workflows · ${context}`) + 3
  const summary = status ? "" : state.scope === "saved" ? keysText([{ key: "enter", label: "type args" }, { key: "r", label: "run now" }, { key: "↑↓", label: "select" }, { key: "tab", label: "scope" }], escape, Math.max(8, inner - titleWidth), glyphs) : keysText(keyHints({ run: inRun ? run : row?.kind === "run" ? row.run : undefined, row, state, empty: runs.length === 0 }), escape, Math.max(8, inner - titleWidth), glyphs)
  const room = Math.max(0, height - pageChrome({ tabs: true, hints: [], back: false, width }))
  const frame = (body: Line[]) => page({ title: "Workflows", context, ...(summary ? { summary } : {}), ...(status ? { status } : {}), tabs, activeTab: state.scope === "project" ? 0 : 1, body, hints: [], back: false, width, height })
  const keys = state.keys ? allKeysRows(inner) : []
  const bodyRoom = Math.max(0, room - keys.length)

  if (state.scope === "saved") return frame([...keys, ...savedPane(saved, { state, width: inner, rows: bodyRoom, glyphs })])
  if (runs.length === 0) return frame([...keys, ...emptyRows(state, inner)])

  const runSide = (paneWidth: number, focused: boolean): Line[] => {
    if (row?.kind === "pack" && !inRun) return packPane(row.entry, { width: paneWidth, now, glyphs })
    return shown ? runPane(inRun ? run : shown, { state: inRun ? state : { ...state, focus: "list" }, width: paneWidth, rows: bodyRoom, now, glyphs, focused }) : []
  }

  if (!wide) {
    const body = inRun ? runSide(inner, true) : listPane({ runs, state, width: inner, rows: bodyRoom, now, glyphs, full: true, focused: true })
    return frame([...keys, ...body])
  }

  const facts = width >= FACTS_AT
  const railWidth = facts ? RAIL_MAX : Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.floor(inner * RAIL_SHARE)))
  const rest = inner - railWidth - 3 - (facts ? FACTS_WIDTH + 3 : 0)
  const runWidth = Math.max(1, facts ? Math.min(RUN_MAX, rest) : rest)
  const left = listPane({ runs, state, width: railWidth, rows: bodyRoom, now, glyphs, full: false, focused: !inRun })
  const middle = runSide(runWidth, inRun)
  const right = facts && shown && row?.kind !== "pack" ? factsPane(inRun ? run : shown, { width: FACTS_WIDTH, now }) : []
  const divider: Span = { text: ` ${glyphs.track} `, fg: "border" }
  const body = Array.from({ length: bodyRoom }, (_, index): Line => [
    ...fit(left[index] ?? [], railWidth), divider, ...fit(middle[index] ?? [], runWidth),
    ...(facts ? [divider, ...fit(right[index] ?? [], FACTS_WIDTH)] : []),
  ])
  return frame([...keys, ...body])
}
