import type { WorkflowId, WorkflowRunState, WorkflowSummary, WorkflowTaskState, WorkflowTaskSummary } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { clip, fit, panelGrid, spread } from "./deck"
import { page, type Hint, type PageStatus } from "./page"
import { shortenMiddle, truncateEnd } from "./session-list"
import { formatElapsed } from "./time"
import { textWidth, wrap } from "./wrap"

export type WorkflowsScope = "project" | "all"
export type WorkflowControlAction = "pause" | "resume" | "stop" | "verify" | "delete"

/**
 * `selected` indexes the runs shown. `task` is the task cursor over that run's tasks in display order
 * (level, then plan order); one past the last task is the verification block. Unset = the default target.
 */
export type WorkflowsPageState = {
  selected: number
  scope: WorkflowsScope
  task?: number
  confirm?: { kind: "stop" | "delete"; workflowId: WorkflowId }
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

const NONE: WorkflowsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l"])
const COMPACT_WIDTH = 70
const COMPACT_HEIGHT = 24
/** Rows the stacked layout wants for the detail before it shrinks the list. */
const DETAIL_ROWS = 14
const LABEL_WIDTH = 11
const NAME_MAX = 16
const SCRIPT_NAME_MAX = 28
const HINTS: Hint[] = [
  { key: "↑↓", label: "run" },
  { key: "←→", label: "task" },
  { key: "enter", label: "open" },
  { key: "p", label: "pause/resume" },
  { key: "x", label: "stop" },
  { key: "t", label: "retry" },
  { key: "v", label: "verify" },
  { key: "a", label: "accept" },
  { key: "d", label: "delete" },
  { key: "tab", label: "scope" },
]
const BACK: Hint = { key: "esc", label: "back" }

const STATE: Record<WorkflowRunState, { label: string; fg: ColorName; dot?: boolean }> = {
  running: { label: "running", fg: "text", dot: true },
  needs_input: { label: "needs input", fg: "warning" },
  verifying: { label: "verifying", fg: "warning", dot: true },
  paused: { label: "paused", fg: "muted" },
  completed: { label: "completed", fg: "success" },
  failed: { label: "failed", fg: "error" },
  blocked: { label: "blocked", fg: "error" },
  stopped: { label: "stopped", fg: "muted" },
  queued: { label: "queued", fg: "muted" },
}
const SUMMARY_ORDER: WorkflowRunState[] = ["blocked", "failed", "needs_input", "verifying", "running", "paused", "completed", "stopped", "queued"]
const TERMINAL = new Set<WorkflowRunState>(["completed", "failed", "stopped"])
const PRIORITY: WorkflowTaskState[] = ["needs_input", "running", "failed"]

// ---------------------------------------------------------------------------------------------- tasks

type Entry = { task: WorkflowTaskSummary; level: number }

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
export function workflowTaskOrder(run: Pick<WorkflowSummary, "tasks">): Entry[] {
  const levels = workflowLevels(run.tasks)
  return run.tasks
    .map((task, index) => ({ task, level: levels.get(task.id) ?? 1, index }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map(({ task, level }) => ({ task, level }))
}

const hasAudit = (run: WorkflowSummary) => run.verification?.audit !== undefined
const slotCount = (run: WorkflowSummary) => run.tasks.length + (hasAudit(run) ? 1 : 0)
const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** The task `enter` opens with no cursor: needs_input, then running, then failed (v1's priority). */
function defaultSlot(order: Entry[]): number | undefined {
  for (const state of PRIORITY) {
    const index = order.findIndex((entry) => entry.task.state === state)
    if (index >= 0) return index
  }
  return undefined
}

/** The slot the cursor is on: the explicit one, else the default target. */
function effectiveSlot(run: WorkflowSummary, state: WorkflowsPageState, order: Entry[]): number | undefined {
  return state.task !== undefined ? clamp(state.task, slotCount(run)) : defaultSlot(order)
}

/** The session `enter` opens: the cursor's task or the auditor; with no cursor the default task, else the latest one, else the run's root. */
function openTarget(run: WorkflowSummary, state: WorkflowsPageState, order: Entry[]): string | undefined {
  if (state.task !== undefined) {
    const slot = clamp(state.task, slotCount(run))
    return slot === order.length ? run.verification?.audit?.sessionId : order[slot]?.task.sessionId
  }
  const preferred = defaultSlot(order)
  const fromDefault = preferred === undefined ? undefined : order[preferred]?.task.sessionId
  if (fromDefault) return fromDefault
  const latest = [...run.tasks].filter((task) => task.sessionId).sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))[0]
  return latest?.sessionId ?? run.rootSessionId
}

/** The task `t` retries: the cursor's, or with no cursor the first failed one. Only failed tasks can be retried. */
function retryTarget(run: WorkflowSummary, state: WorkflowsPageState, order: Entry[]): WorkflowTaskSummary | undefined {
  const task = state.task !== undefined ? order[clamp(state.task, slotCount(run))]?.task : order.find((entry) => entry.task.state === "failed")?.task
  return task?.state === "failed" ? task : undefined
}

/** The human task `y` / `n` answer: the cursor's, or with no cursor the first one waiting. */
function humanTarget(run: WorkflowSummary, state: WorkflowsPageState, order: Entry[]): WorkflowTaskSummary | undefined {
  const task = state.task !== undefined ? order[clamp(state.task, slotCount(run))]?.task : order.find((entry) => entry.task.kind === "human" && entry.task.state === "needs_input")?.task
  return task?.kind === "human" && task.state === "needs_input" ? task : undefined
}

// ---------------------------------------------------------------------------------------------- state and keys

export function createWorkflowsPageState(scope: WorkflowsScope = "project"): WorkflowsPageState {
  return { selected: 0, scope }
}

const canPause = (run: WorkflowSummary) => run.state === "running" || run.state === "needs_input" || run.state === "verifying"
const canResume = (run: WorkflowSummary) => run.state === "paused" || run.state === "blocked"
const canStop = (run: WorkflowSummary) => !TERMINAL.has(run.state)
const canAccept = (run: WorkflowSummary) => !run.queuedBehind && (run.state === "blocked" || run.state === "failed" || run.state === "paused" || run.state === "verifying")
/** Verifying again makes sense once the tasks are finished and the contract is what is left. */
const canVerify = (run: WorkflowSummary) =>
  run.contract !== undefined && (run.state === "blocked" || (run.state === "paused" && run.tasks.every((task) => task.state === "done" || task.state === "skipped")))

const withTask = (state: WorkflowsPageState, task: number | undefined): WorkflowsPageState => {
  const { task: _task, ...rest } = state
  return task === undefined ? rest : { ...rest, task }
}

/** Handles one raw key over the runs shown. Returns the same state object when nothing changed. */
export function workflowsPageKey(state: WorkflowsPageState, key: string, runs: WorkflowSummary[]): { state: WorkflowsPageState; action: WorkflowsPageAction } {
  const selected = clamp(state.selected, runs.length)
  const target = runs[selected]
  const { confirm, ...withoutConfirm } = state
  if (confirm) {
    const confirmed = (confirm.kind === "stop" && (key === "x" || key === "y")) || (confirm.kind === "delete" && (key === "d" || key === "y"))
    if (confirmed && target?.workflowId === confirm.workflowId) return { state: withoutConfirm, action: { type: "control", workflowId: confirm.workflowId, action: confirm.kind } }
    return { state: withoutConfirm, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "\t") {
    const scope: WorkflowsScope = state.scope === "project" ? "all" : "project"
    return { state: { selected: 0, scope }, action: { type: "scope", scope } }
  }
  const moveRun = (index: number) => {
    const next = clamp(index, runs.length)
    return next === state.selected ? { state, action: NONE } : { state: withTask({ ...state, selected: next }, undefined), action: NONE }
  }
  if (UP.has(key)) return moveRun(selected - 1)
  if (DOWN.has(key)) return moveRun(selected + 1)
  if (!target) return { state, action: NONE }
  const order = workflowTaskOrder(target)
  const slots = slotCount(target)
  const moveTask = (delta: number) => {
    const base = effectiveSlot(target, state, order) ?? -1
    const next = Math.max(0, Math.min(base + delta, slots - 1))
    return slots === 0 || next === state.task ? { state, action: NONE } : { state: { ...state, selected, task: next }, action: NONE }
  }
  if (LEFT.has(key)) return moveTask(-1)
  if (RIGHT.has(key)) return moveTask(1)
  const control = (action: WorkflowControlAction): { state: WorkflowsPageState; action: WorkflowsPageAction } => ({ state, action: { type: "control", workflowId: target.workflowId, action } })
  if (key === "\r") {
    const sessionId = openTarget(target, state, order)
    return { state, action: sessionId ? { type: "open", sessionId } : NONE }
  }
  if (key === "p") return canPause(target) ? control("pause") : canResume(target) ? control("resume") : { state, action: NONE }
  if (key === "v") return canVerify(target) ? control("verify") : { state, action: NONE }
  if (key === "a") return canAccept(target) ? { state, action: { type: "accept", workflowId: target.workflowId } } : { state, action: NONE }
  if (key === "t") {
    const task = retryTarget(target, state, order)
    return task ? { state, action: { type: "retry", workflowId: target.workflowId, taskId: task.id } } : { state, action: NONE }
  }
  if (key === "y" || key === "n") {
    const task = humanTarget(target, state, order)
    return task ? { state, action: { type: "answer", workflowId: target.workflowId, taskId: task.id, decision: key === "y" ? "approve" : "reject" } } : { state, action: NONE }
  }
  if (key === "x" && canStop(target)) return { state: { ...state, selected, confirm: { kind: "stop", workflowId: target.workflowId } }, action: NONE }
  if (key === "d") return { state: { ...state, selected, confirm: { kind: "delete", workflowId: target.workflowId } }, action: NONE }
  return { state, action: NONE }
}

/** True while a shown run has a live clock (running, waiting for input or verifying): the page needs a 1 s tick. */
export function needsTick(runs: WorkflowSummary[]) {
  return runs.some((run) => run.state === "running" || run.state === "needs_input" || run.state === "verifying")
}

// ---------------------------------------------------------------------------------------------- rendering

function elapsed(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : formatElapsed(ms)
}

function runElapsed(run: WorkflowSummary, now: number) {
  const ticking = run.state === "running" || run.state === "needs_input"
  return elapsed((run.endedAt ?? (ticking ? now : run.updatedAt)) - run.startedAt)
}

function label(text: string, value: string, width: number, fg: ColorName = "body"): Line {
  return clip([{ text: text.padEnd(LABEL_WIDTH), fg: "muted" }, { text: truncateEnd(value, Math.max(0, width - LABEL_WIDTH)), fg }], width)
}

function wrapped(text: string, width: number, max: number, indent: string, fg: ColorName): Line[] {
  const lines = wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - indent.length))
  return lines.slice(0, max).map((line, i): Line => [{ text: indent }, { text: i === max - 1 && lines.length > max ? truncateEnd(`${line} …`, width - indent.length) : line, fg }])
}

/** The confirm question replaces the list's first row while a stop/delete is pending; `undefined` otherwise. */
function confirmRow(state: WorkflowsPageState, runs: WorkflowSummary[], width: number): Line | undefined {
  if (!state.confirm) return undefined
  const pending = runs.find((run) => run.workflowId === state.confirm!.workflowId)
  if (!pending) return undefined
  const key = state.confirm.kind === "stop" ? "x" : "d"
  const texts = [`${state.confirm.kind} "${pending.name}"? ${key} or y confirms · any key cancels`, `${state.confirm.kind}? ${key}/y confirm`]
  const fitted = texts.find((text) => textWidth(text) <= width) ?? texts[1]!
  return clip([{ text: fitted, fg: "warning", bold: true }], width)
}

type Column = { text: string; fg: ColorName; width: number }

function runRow(input: { run: WorkflowSummary; selected: boolean; width: number; now: number; glyphs: Glyphs }): Line {
  const { run, selected, width, now, glyphs } = input
  const style = STATE[run.state]
  const done = run.tasks.filter((task) => task.state === "done").length
  const columns: Column[] = [
    { text: `${style.dot ? `${glyphs.running} ` : ""}${style.label}`, fg: style.fg, width: 13 },
    // A script run's agent calls are made as it goes: progress is finished calls out of calls so far.
    { text: run.script ? `${run.script.counts.done}/${run.script.calls}` : `${done}/${run.tasks.length}`, fg: "muted", width: 8 },
    { text: run.state === "verifying" ? "in review" : runElapsed(run, now), fg: "muted", width: 10 },
  ]
  let shown = columns.length
  const nameRoom = () => width - 2 - columns.slice(0, shown).reduce((sum, column) => sum + column.width, 0)
  while (shown > 1 && nameRoom() < 14) shown--
  const room = Math.max(4, nameRoom())
  const name = truncateEnd(run.name, room - 1)
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: name, fg: selected ? "primary" : "text", bold: selected },
    { text: " ".repeat(Math.max(1, room - textWidth(name))) },
  ]
  for (const column of columns.slice(0, shown)) {
    const text = truncateEnd(column.text, column.width - 1)
    line.push({ text, fg: column.fg }, { text: " ".repeat(column.width - textWidth(text)) })
  }
  return clip(line, width)
}

function taskGlyph(state: WorkflowTaskState, glyphs: Glyphs): Span {
  switch (state) {
    case "done":
      return { text: glyphs.ok, fg: "success" }
    case "running":
      return { text: glyphs.running, fg: "text" }
    case "needs_input":
      return { text: glyphs.ask, fg: "warning" }
    case "failed":
      return { text: glyphs.fail, fg: "error" }
    case "skipped":
    case "stopped":
      return { text: "–", fg: "muted" }
    case "pending":
      return { text: "·", fg: "muted" }
  }
}

function taskNote(task: WorkflowTaskSummary, byId: Map<string, WorkflowTaskSummary>): Span {
  if (task.kind === "map" && task.expanded) {
    const children = [...byId.values()].filter((entry) => entry.mapParentId === task.id && !entry.mapRetired)
    return { text: `${children.filter((entry) => entry.state === "done").length}/${children.length} items${task.reason ? ` · ${task.reason}` : ""}`, fg: task.state === "failed" ? "error" : "body" }
  }
  switch (task.state) {
    case "running":
      return { text: task.latest ? `▸ ${task.latest}` : "", fg: "body" }
    case "needs_input":
      return { text: task.kind === "human" ? `y approve · n reject${task.latest ? ` · ${task.latest}` : ""}` : "needs input", fg: "warning" }
    case "pending": {
      if (task.reason?.startsWith("retrying")) return { text: task.reason, fg: "warning" }
      const waits = task.needs.filter((id) => byId.get(id)?.state !== "done")
      return { text: waits.length ? `waits ${waits.join(", ")}` : "queued", fg: "muted" }
    }
    case "failed":
      return { text: task.reason ?? "failed", fg: "error" }
    case "skipped":
    case "stopped":
      return { text: task.reason ?? task.state, fg: "muted" }
    case "done":
      return { text: [task.outputKind, task.attempt > 1 ? `attempt ${task.attempt}` : undefined].filter(Boolean).join(" · "), fg: "muted" }
  }
}

function taskElapsed(task: WorkflowTaskSummary, now: number) {
  if (task.startedAt === undefined) return ""
  if (task.state === "running" || task.state === "needs_input") return elapsed(now - task.startedAt)
  return task.endedAt !== undefined ? elapsed(task.endedAt - task.startedAt) : ""
}

/** The row painted on the element background, padded to the full width, for the cursor. */
function highlighted(line: Line, width: number): Line {
  return fit(line, width).map((span) => ({ ...span, bg: "element" as const }))
}

function taskRow(input: { entry: Entry; showLevel: boolean; nameWidth: number; byId: Map<string, WorkflowTaskSummary>; cursor: boolean; compact: boolean; width: number; now: number; glyphs: Glyphs }): Line {
  const { entry, showLevel, nameWidth, byId, cursor, compact, width, now, glyphs } = input
  const { task } = entry
  const note = taskNote(task, byId)
  const time = taskElapsed(task, now)
  const line: Line = [
    { text: `${showLevel ? `L${entry.level}` : ""}`.padEnd(4), fg: "muted" },
    taskGlyph(task.state, glyphs),
    { text: " " },
    { text: truncateEnd(task.label ?? task.id, nameWidth - 1).padEnd(nameWidth), fg: task.state === "pending" || task.state === "skipped" || task.state === "stopped" ? "muted" : "text", bold: cursor },
  ]
  if (!compact) line.push({ text: (task.kind === "map" ? "map" : task.kind === "check" ? "check" : task.kind === "human" ? "human" : task.execution?.readOnly ? "read" : (task.mode ?? "work")).padEnd(6), fg: "muted" })
  if (!compact && task.engine) line.push({ text: `${truncateEnd(`${task.engine}${task.modelId ? `/${task.modelId}` : ""}`, 22)} `, fg: "accent" })
  line.push({ text: time.padEnd(8), fg: "muted" }, note)
  const row = clip([{ text: "  " }, ...line], width)
  return cursor ? highlighted(row, width) : row
}

type AuditCriteria = NonNullable<NonNullable<WorkflowSummary["verification"]>["audit"]>["criteria"]

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
  const head: Span[] = [{ text: "verification".padEnd(LABEL_WIDTH + 3), fg: "muted" }]
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

type ScriptInfo = NonNullable<WorkflowSummary["script"]>

const compactCount = (value: number) => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${+(value / 1_000).toFixed(1)}k` : String(value))

function scriptPhaseLine(script: ScriptInfo, width: number): Line {
  return label("phases", script.phases.map((phase) => `${phase.title} ${phase.completed}/${phase.total}${phase.state === "running" ? "…" : phase.state === "blocked" ? " !" : ""}`).join(" · "), width)
}

/** Script runs: where the script came from, the live use of every cap, the log tail and how it ended. Rows that fit nowhere else are dropped first in compact mode. */
function scriptRows(input: { run: WorkflowSummary; script: ScriptInfo; width: number; now: number; compact: boolean }): Line[] {
  const { run, script, width, now, compact } = input
  const caps = script.budget
  const minutes = Math.floor(((run.endedAt ?? now) - run.startedAt) / 60_000)
  const used = [
    `agents ${script.usage.agents}/${caps.agents ?? "-"}`,
    `tokens ${compactCount(script.usage.tokens)}${caps.tokens !== undefined ? `/${compactCount(caps.tokens)}` : ""}`,
    ...(caps.usd !== undefined || script.usage.costMicros ? [`$${((script.usage.costMicros ?? 0) / 1_000_000).toFixed(2)}${caps.usd !== undefined ? `/$${caps.usd}` : ""}`] : []),
    ...(caps.minutes !== undefined ? [`${minutes}/${caps.minutes} min`] : []),
  ]
  const nearCap = (caps.agents !== undefined && script.usage.agents >= caps.agents) || (caps.tokens !== undefined && script.usage.tokens >= caps.tokens)
  const rows: Line[] = [label("caps", used.join(" · "), width, nearCap ? "warning" : "body")]
  if (!compact) rows.unshift(label("script", `${script.origin} · sha ${script.hash.slice(0, 12)}${script.host === "running" || script.host === "done" ? "" : ` · host ${script.host}`}`, width))
  const engines = Object.entries(script.usage.engines ?? {})
  if (engines.length) rows.push(label("engines", engines.map(([name, entry]) => `${name} ${entry.agents} agent${entry.agents === 1 ? "" : "s"} ${compactCount(entry.tokens)} tok`).join(" · "), width))
  if (!compact && script.logs.length) rows.push(label("log", script.logs.at(-1)!, width, "muted"))
  if (script.error) rows.push(label("error", script.error.replace(/\s+/g, " "), width, "error"))
  else if (script.result) rows.push(label("result", script.result.replace(/\s+/g, " "), width))
  if (script.omitted) rows.push(label("older", `${script.omitted} finished calls not listed`, width, "muted"))
  return rows
}

/** The selected run: where it lives, its objective and contract, the tasks by level, and the verification block, fitted to `rows`. */
function detailRows(input: { run: WorkflowSummary; state: WorkflowsPageState; width: number; rows: number; now: number; glyphs: Glyphs; compact: boolean }): Line[] {
  const { run, state, width, rows, now, glyphs, compact } = input
  const order = workflowTaskOrder(run)
  const byId = new Map(run.tasks.map((task) => [task.id, task]))
  const slot = effectiveSlot(run, state, order)
  const contract = contractText(run)
  const head: Line[] = []
  if (!compact) head.push([{ text: shortenMiddle(run.directory, width), fg: "muted", dim: true }])
  head.push(label("objective", run.objective.replace(/\s+/g, " ").trim(), width))
  if (!compact) head.push(label("contract", contract.text, width, contract.fg))
  if (run.revisionId) {
    head.push(label("revision", `#${run.revision} · ${run.revisionId}`, width))
    if (!compact) head.push(label("definition", run.definitionId ?? "", width), label("plan hash", run.planHash, width))
  }
  if (!compact) head.push(label("perms", permsText(run), width))
  if (run.overlapPolicy) head.push(label("overlap", `${run.overlapPolicy}${run.queuedBehind ? ` · waits ${run.queuedBehind}` : ""}`, width))
  if (run.script) head.push(...scriptRows({ run, script: run.script, width, now, compact }))
  const phaseLine = run.phases?.length ? label("phases", run.phases.map((phase) => `${phase.id} ${phase.completed}/${phase.total} ${phase.state}`).join(" · "), width) : run.script?.phases.length ? scriptPhaseLine(run.script, width) : undefined
  if (phaseLine) head.push(phaseLine)
  if (run.reason) head.push(label("reason", run.reason.replace(/\s+/g, " ").trim(), width, run.state === "blocked" || run.state === "failed" ? "error" : "warning"))
  const focused = order[slot === undefined ? 0 : slot]?.task
  const phase = run.phases?.find((entry) => entry.id === focused?.phaseId)
  if (phase && !compact) head.push(label("barrier", `${phase.title} · ${phase.barrier.kind}${phase.barrier.kind === "quorum" ? ` ${phase.barrier.quorum}` : phase.barrier.kind === "condition" ? ` ${phase.barrier.expression}` : ""}`, width))
  const execution = focused?.execution
  if (execution) {
    const model = execution.model
    const route = [execution.agent, model?.model, model?.variant ? `#${model.variant}` : model?.effort].filter(Boolean).join(" · ")
    head.push(label(focused!.id, route || (execution.readOnly ? "read-only" : execution.permission), width))
    head.push(label("workspace", `${execution.workspace.mode}${execution.directory !== run.directory && !compact ? ` · ${execution.directory}` : ""}`, width))
    const policy = execution.permissions
    const restrictions = [execution.readOnly ? "read-only" : execution.permission, ...(policy?.allowedTools ? [`tools: ${policy.allowedTools.join(", ") || "none"}`] : []), ...(policy?.approvalRequiredFor?.length ? [`ask: ${policy.approvalRequiredFor.join(", ")}`] : []), ...(policy?.allowEdits === false ? ["no edits"] : []), ...(policy?.allowMutatingCommands === false ? ["no commands"] : []), ...(policy?.allowExternalSend === false ? ["no sends"] : [])]
    if (!compact && rows >= 16) head.push(label("policy", restrictions.join(" · "), width))
    const budget = execution.budget
    const usage = focused?.usage
    const limits = [budget?.maxTokens !== undefined ? `${(usage?.input ?? 0) + (usage?.output ?? 0)}/${budget.maxTokens} tokens` : undefined, budget?.maxCost !== undefined ? `${usage?.costUnknown ? "unknown cost" : `$${((usage?.costMicros ?? 0) / 1_000_000).toFixed(4)}`}/$${budget.maxCost}` : undefined, budget?.maxTurns !== undefined ? `${usage?.calls ?? 0}/${budget.maxTurns} calls` : undefined, budget?.maxRuntimeMs !== undefined ? `${Math.round(budget.maxRuntimeMs / 1000)}s` : undefined, budget?.maxChildren !== undefined ? `${usage?.children ?? 0}/${budget.maxChildren} children` : undefined, budget?.maxDepth !== undefined ? `depth ${budget.maxDepth}` : undefined].filter(Boolean)
    if (limits.length) head.push(label("budget", limits.join(" · "), width))
  }

  const verification = verificationRows(run, width, glyphs)
  const shownHead = compact && phaseLine ? [phaseLine, ...head.filter((line) => line !== phaseLine)].slice(0, Math.max(0, rows - 1 - Math.min(order.length, 2))) : head
  const fixed = shownHead.length + 1
  const minTasks = Math.min(order.length, 3, Math.max(0, rows - fixed))
  const verificationRoom = Math.max(0, rows - fixed - minTasks)
  const shownVerification = verification.slice(0, verificationRoom)
  const taskRoom = Math.max(0, rows - fixed - shownVerification.length)
  const cursorIndex = slot === undefined ? 0 : Math.min(slot, order.length - 1)
  const offset = Math.min(Math.max(0, cursorIndex - taskRoom + 1), Math.max(0, order.length - taskRoom))
  // A script's calls are labelled by the script and have no levels (no static dependencies): they get a wider name column and no L marker.
  const nameWidth = Math.min(run.script ? SCRIPT_NAME_MAX : NAME_MAX, Math.max(6, ...order.map((entry) => textWidth(entry.task.label ?? entry.task.id) + 1)))

  const taskRows: Line[] = []
  for (let index = offset; index < Math.min(order.length, offset + taskRoom); index++) {
    const entry = order[index]!
    const showLevel = !run.script && (index === offset || order[index - 1]!.level !== entry.level)
    taskRows.push(taskRow({ entry, showLevel, nameWidth, byId, cursor: index === slot, compact: compact || width < 60, width, now, glyphs }))
  }
  if (slot === order.length && shownVerification[0]) shownVerification[0] = highlighted(shownVerification[0], width)
  return [...shownHead, [{ text: "tasks", fg: "muted" }], ...taskRows, ...shownVerification]
}

function emptyRows(width: number): Line[] {
  const rows: Line[] = [
    [{ text: "No workflows", fg: "muted" }],
    [{ text: "/workflows <name|file> --yes", fg: "text" }],
    [{ text: "/workflows run <file.js> --yes · /workflows new <name>", fg: "muted" }],
  ]
  return rows.map((line) => clip(line, width))
}

/** Renders exactly `height` lines of at most `width` cells. `now` drives the elapsed times. */
export function renderWorkflowsPage(input: { runs: WorkflowSummary[]; state: WorkflowsPageState; width: number; height: number; now: number; glyphs?: Glyphs }): Line[] {
  const { runs, state, width, height, now } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const selected = clamp(state.selected, runs.length)

  const counts = new Map<WorkflowRunState, number>()
  for (const run of runs) counts.set(run.state, (counts.get(run.state) ?? 0) + 1)
  const summaryParts = SUMMARY_ORDER.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${STATE[s].label}`)
  const subtitle = state.scope === "all" ? "all projects" : "this project"
  const status: PageStatus | undefined = state.confirm
    ? { label: "Confirm", tone: "warn" }
    : counts.get("blocked")
      ? { label: "Blocked", tone: "error" }
      : counts.get("needs_input")
        ? { label: "Needs input", tone: "warn" }
        : counts.get("running") || counts.get("verifying")
          ? { label: "Live", tone: "live" }
          : undefined
  // The most urgent counts that still fit on the title row beside the title and the status.
  let summaryRoom = width - 2 - textWidth(`Workflows · ${subtitle}`) - 1 - (status && status.tone !== "live" ? textWidth(status.label) + 3 : 0)
  const fitted: string[] = []
  for (const part of summaryParts) {
    const cost = textWidth(part) + (fitted.length ? 3 : 0)
    if (cost > summaryRoom) break
    fitted.push(part)
    summaryRoom -= cost
  }
  const summary = summaryParts.length ? fitted.join(" · ") : "no workflows"

  const inner = Math.max(1, width - 2)
  const wide = width >= 110
  const compact = width < COMPACT_WIDTH || height < COMPACT_HEIGHT
  const room = Math.max(0, height - 5)
  const frame = (body: Line[]) => {
    const lines = page({ title: "Workflows", context: subtitle, summary, ...(status ? { status } : {}), body, hints: [], back: false, width, height })
    const hints = [{ key: "b", label: "evidence" }, ...(width >= 135 ? [...HINTS, BACK] : width < 70 ? [HINTS[0]!, HINTS[1]!, HINTS[2]!, BACK] : [HINTS[0]!, HINTS[1]!, HINTS[2]!, HINTS[3]!, HINTS[5]!, BACK])]
    lines[0] = [{ text: " " }, ...spread([], [{ text: hints.map((h) => `${h.key} ${h.label}`).join(" · "), fg: "muted" }], inner), { text: " " }]
    return lines
  }

  if (runs.length === 0) return frame(panelGrid({ width: inner, padding: true, compact: false, heights: [room], rows: [[{ title: "Workflows", body: emptyRows(inner - 4) }]] }))

  const listWidth = Math.min(56, Math.max(40, Math.floor(inner * 0.36)))
  const confirm = confirmRow(state, runs, wide ? listWidth - 4 : inner - 4)
  const confirmRows: Line[] = confirm ? [confirm] : []
  const windowed = (listRows: number, rowWidth: number): Line[] => {
    const offset = Math.min(Math.max(0, selected - listRows + 1), Math.max(0, runs.length - listRows))
    const rows: Line[] = []
    for (let index = offset; index < Math.min(runs.length, offset + listRows); index++) rows.push(runRow({ run: runs[index]!, selected: index === selected, width: rowWidth, now, glyphs }))
    return rows
  }

  if (wide) {
    return frame(panelGrid({ width: inner, padding: true, compact: false, heights: [room], rows: [[
      { title: "Workflows", weight: 2, active: true, body: (w) => [...confirmRows, ...windowed(Math.max(1, room - 4 - confirmRows.length), w)] },
      { title: runs[selected]!.revision ? `Detail · revision #${runs[selected]!.revision}` : "Detail", weight: 3, body: (w) => detailRows({ run: runs[selected]!, state, width: w, rows: Math.max(1, room - 4), now, glyphs, compact }) },
    ]] }))
  }

  const listRows = Math.max(1, Math.min(runs.length, room - DETAIL_ROWS - 9))
  const top = Math.min(room, listRows + confirmRows.length + 4)
  return frame(panelGrid({ width: inner, padding: true, compact: false, heights: [top, Math.max(0, room - top - 1)], rows: [
    [{ title: "Workflows", active: true, body: (w) => [...confirmRows, ...windowed(listRows, w)] }],
    [{ title: runs[selected]!.revision ? `Detail · revision #${runs[selected]!.revision}` : "Detail", body: (w) => detailRows({ run: runs[selected]!, state, width: w, rows: Math.max(1, room - top - 5), now, glyphs, compact }) }],
  ] }))
}
