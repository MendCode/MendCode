import type { Loop, LoopRun, LoopState, LoopTemplateInfo } from "@mendcode/protocol"
import { adaptiveBounds } from "@mendcode/protocol/wire"
import { describeTrigger } from "@mendcode/loops"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { fit, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { budgetRows, evidenceRows } from "./loop-evidence"
import { editLoopForm, FALLBACK_TEMPLATES, FIRE_COMMAND, loopFormKey, newLoopForm, renderLoopForm, type LoopCreateFields, type LoopForm } from "./loop-form"
import { tabsRow, type PageTab } from "./page"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"
import { formatPaddedElapsed } from "./time"

export type LoopsScope = "project" | "all"
export type LoopControlAction = "pause" | "resume" | "stop" | "run" | "delete"
/**
 * `tab` is 0 for Active (still going, blocked or waiting) and 1 for History (completed or stopped); unset means Active.
 * `form` is the create/edit form while it is open; `templates` are the daemon's `loop.templates` (the app sets them).
 */
export type LoopsPageState = { scroll?: number; selected: number; scope: LoopsScope; tab?: number; confirm?: { kind: "stop" | "delete"; loopId: string }; form?: LoopForm; templates?: readonly LoopTemplateInfo[] }

export type LoopsPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "open"; sessionId: string }
  | { type: "control"; loopId: string; action: LoopControlAction }
  | { type: "scope"; scope: LoopsScope }
  /** Accepting completion by hand needs a reason, which the user types in the prompt. */
  | { type: "accept"; loopId: string }
  | { type: "review"; loopId: string; action: "waive" | "approve"; target: string }
  /** The form saved: create a loop, or update `replaces` in place. */
  | { type: "save"; fields: LoopCreateFields; summary: string; replaces?: { loopId: string; name: string; state: LoopState }; form: LoopForm }
  /** An external loop: start a run now (`loop.fire`). */
  | { type: "fire"; loopId: string }
  /** Put `text` (the fire command) on the clipboard. */
  | { type: "copy"; text: string }

const NONE: LoopsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const MAX_OBJECTIVE_LINES = 4
const MAX_RUNS_SHOWN = 5
const PAGE_TABS: PageTab[] = [{ key: "1", label: "Active" }, { key: "2", label: "History" }]
const FINISHED = new Set<LoopState>(["completed", "stopped"])

const STATE: Record<LoopState, { label: string; fg: ColorName; dot?: boolean }> = {
  active: { label: "active", fg: "primary" },
  running: { label: "running", fg: "text", dot: true },
  needs_input: { label: "needs input", fg: "warning" },
  verifying: { label: "verifying", fg: "warning", dot: true },
  paused: { label: "paused", fg: "muted" },
  completed: { label: "completed", fg: "success" },
  blocked: { label: "blocked", fg: "error" },
  stopped: { label: "stopped", fg: "muted" },
}

const EXAMPLES = ["/loop every 30m check CI and fix failing tests", "/loop daily 09:00 --goal triage open issues until: no untriaged issues remain", "/loop now --runs 2 say hi"]

export function createLoopsPageState(scope: LoopsScope = "project"): LoopsPageState {
  return { selected: 0, scope }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

const canPause = (loop: Loop) => loop.state === "active" || loop.state === "needs_input" || loop.state === "verifying"
const canAccept = (loop: Loop) => loop.state !== "running" && loop.state !== "needs_input" && loop.state !== "completed" && loop.reviewInvalidatedAt === undefined
const canResume = (loop: Loop) => loop.state === "paused" || loop.state === "blocked"
const canRun = (loop: Loop) => canPause(loop) || canResume(loop)
const canStop = (loop: Loop) => loop.state !== "stopped" && loop.state !== "completed"
/** `loop.fire` is refused unless the loop is external and waiting (active or needs_input), not paused, blocked or finished. */
const canFire = (loop: Loop) => loop.trigger.kind === "external" && (loop.state === "active" || loop.state === "running")

/** The loops one tab lists: Active is everything not finished, History is completed and stopped loops. */
function loopsForTab(loops: Loop[], tab: number | undefined): Loop[] {
  return loops.filter((loop) => FINISHED.has(loop.state) === (tab === 1))
}

/** Handles one raw key over the loops of the current tab. Returns the same state object when nothing changed. */
export function loopsPageKey(state: LoopsPageState, key: string, all: Loop[]): { state: LoopsPageState; action: LoopsPageAction } {
  const loops = loopsForTab(all, state.tab)
  const selected = clamp(state.selected, loops.length)
  const target = loops[selected]
  const { confirm, ...withoutConfirm } = state
  if (state.form) {
    const result = loopFormKey(state.form, key, { directory: "", templates: state.templates ?? FALLBACK_TEMPLATES })
    const { form: _closed, ...rest } = state
    void _closed
    return { state: result.form ? { ...rest, form: result.form } : rest, action: result.action.type === "save" ? result.action : NONE }
  }
  if (confirm) {
    const confirmed = (confirm.kind === "stop" && (key === "s" || key === "y")) || (confirm.kind === "delete" && (key === "d" || key === "y"))
    if (confirmed && target?.loopId === confirm.loopId) return { state: withoutConfirm, action: { type: "control", loopId: confirm.loopId, action: confirm.kind } }
    return { state: withoutConfirm, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "\t") {
    const scope: LoopsScope = state.scope === "project" ? "all" : "project"
    return { state: { selected: 0, scope, ...(state.tab ? { tab: state.tab } : {}), ...(state.templates ? { templates: state.templates } : {}) }, action: { type: "scope", scope } }
  }
  const templates = state.templates ?? FALLBACK_TEMPLATES
  if (key === "c") return { state: { ...state, form: newLoopForm() }, action: NONE }
  if (key === "t") return { state: { ...state, form: newLoopForm(templates[0]?.id) }, action: NONE }
  const switchTab = (tab: number) => (tab === (state.tab ?? 0) ? { state, action: NONE } : { state: { ...state, tab, selected: 0, scroll: 0 }, action: NONE })
  if (key === "1" || key === "2") return switchTab(Number(key) - 1)
  if (key === "\x1b[Z") return switchTab(state.tab === 1 ? 0 : 1)
  const move = (index: number) => {
    const next = clamp(index, loops.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next, scroll: 0 }, action: NONE }
  }
  if (key === "\x1b[6~" || key === "\x1b[5~") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "\x1b[6~" ? 5 : -5)) }, action: NONE }
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  if (!target) return { state, action: NONE }
  const control = (action: LoopControlAction): { state: LoopsPageState; action: LoopsPageAction } => ({ state, action: { type: "control", loopId: target.loopId, action } })
  if (key === "\r") return { state, action: { type: "open", sessionId: target.sessionId } }
  if (key === "e") return { state: { ...state, selected, form: editLoopForm(target) }, action: NONE }
  if (key === "y" && target.trigger.kind === "external") return { state, action: { type: "copy", text: FIRE_COMMAND(target.loopId) } }
  if (key === "f") return canFire(target) ? { state, action: { type: "fire", loopId: target.loopId } } : { state, action: NONE }
  if (key === "p") return canPause(target) ? control("pause") : canResume(target) ? control("resume") : { state, action: NONE }
  if (key === "n") return canRun(target) ? control("run") : { state, action: NONE }
  if (key === "w" && target.history.at(-1)?.checkpointHash && target.reviewInvalidatedAt === undefined) {
    const gate = target.history.at(-1)?.gates?.find((gate) => gate.status === "fail" && !["budget", "policy", "integrity"].includes(gate.failureClass ?? "") && !["cost-budget", "approval-policy"].includes(gate.id))
    if (gate) return { state, action: { type: "review", loopId: target.loopId, action: "waive", target: gate.id } }
  }
  if (key === "o" && target.reviewInvalidatedAt === undefined && target.history.at(-1)?.gates?.some((gate) => gate.id === "approval-policy" && gate.status === "fail")) {
    const policy = target.history.at(-1)?.gates?.find((gate) => gate.id === "approval-policy")
    const action = target.approvalPolicy?.requireApprovalFor.find((action) => policy?.detail?.includes(action) && !target.history.at(-1)?.approvals?.some((entry) => entry.action === action))
    if (action) return { state, action: { type: "review", loopId: target.loopId, action: "approve", target: action } }
  }
  if (key === "a") return canAccept(target) ? { state, action: { type: "accept", loopId: target.loopId } } : { state, action: NONE }
  if (key === "s" && canStop(target)) return { state: { ...state, selected, confirm: { kind: "stop", loopId: target.loopId } }, action: NONE }
  if (key === "d") return { state: { ...state, selected, confirm: { kind: "delete", loopId: target.loopId } }, action: NONE }
  return { state, action: NONE }
}

/** "in 42s", "in 12m 03s", "in 3h 05m", "in 2d 4h"; "due" once the time has passed. */
export function formatCountdown(target: number, now: number): string {
  const total = Math.ceil((target - now) / 1000)
  if (total <= 0) return "due"
  if (total < 60) return `in ${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `in ${minutes}m ${String(total % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, "0")}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatDuration(ms: number): string {
  return Math.floor(ms / 1000) < 1 ? "<1s" : formatPaddedElapsed(ms)
}

export function describeBudget(loop: Loop): string {
  const { budget } = loop
  if (budget.mode === "monitor") return "monitor"
  if (budget.mode === "fixed") return `fixed ${loop.runs}/${budget.maxRuns}`
  return budget.maxRuns ? `goal ≤${budget.maxRuns}` : "goal"
}

function nextText(loop: Loop, now: number) {
  if (loop.state === "running") return "running"
  if (loop.state === "active" || loop.state === "needs_input") return loop.nextWakeAt === undefined ? "—" : formatCountdown(loop.nextWakeAt, now)
  return "—"
}

/** True while some loop shows a live countdown, i.e. the page needs a 1 s tick. */
export function needsTick(loops: Loop[]) {
  return loops.some((loop) => loop.nextWakeAt !== undefined && (loop.state === "active" || loop.state === "needs_input"))
}

/** The confirm question replaces the panel's first row while a stop/delete is pending; `undefined` otherwise. */
function confirmRow(state: LoopsPageState, loops: Loop[], width: number): Line | undefined {
  if (!state.confirm) return undefined
  const pending = loops.find((loop) => loop.loopId === state.confirm!.loopId)
  if (!pending) return undefined
  const key = state.confirm.kind === "stop" ? "s" : "d"
  const texts = [`${state.confirm.kind} "${pending.name}"? ${key}/y confirm`, `${state.confirm.kind} "${pending.name}"? ${key} or y confirms · any key cancels`, `${state.confirm.kind}? ${key}/y confirm`]
  const fit = texts.find((text) => textWidth(text) <= width) ?? texts[1]!
  return clampLine([{ text: fit, fg: "warning", bold: true }], width)
}

const spanText = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes % 1_440 === 0 ? `${minutes / 1_440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

/** The list's trigger column: an adaptive loop shows the pace it is on now, not the one it started at. */
export function triggerShort(loop: Loop): string {
  const { trigger } = loop
  return trigger.kind === "adaptive" ? `adaptive ${spanText(loop.adaptiveMs ?? trigger.everyMs)}` : describeTrigger(trigger)
}

type Column = { text: string; fg: ColorName; width: number }

function loopRow(input: { loop: Loop; selected: boolean; width: number; now: number; glyphs: Glyphs }): Line {
  const { loop, selected, width, now, glyphs } = input
  const style = STATE[loop.state]
  const columns: Column[] = [
    { text: `${style.dot ? `${glyphs.running} ` : ""}${style.label}`, fg: style.fg, width: 13 },
    { text: nextText(loop, now), fg: "muted", width: 12 },
    { text: triggerShort(loop), fg: "muted", width: 14 },
    { text: describeBudget(loop), fg: "muted", width: 12 },
    { text: `runs ${loop.runs}`, fg: "muted", width: 8 },
  ]
  let shown = columns.length
  const nameRoom = () => width - 2 - columns.slice(0, shown).reduce((sum, column) => sum + column.width, 0)
  while (shown > 1 && nameRoom() < 14) shown--
  const room = Math.max(4, nameRoom())
  const name = truncateEnd(loop.name, room - 1)
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: name, fg: selected ? "primary" : "text", bold: selected },
    { text: " ".repeat(Math.max(1, room - textWidth(name))) },
  ]
  for (const column of columns.slice(0, shown)) {
    const text = truncateEnd(column.text, column.width - 1)
    line.push({ text, fg: column.fg }, { text: " ".repeat(column.width - textWidth(text)) })
  }
  return clampLine(line, width)
}

const OUTCOME: Record<NonNullable<LoopRun["outcome"]>, ColorName> = { completed: "success", failed: "error", cancelled: "warning", interrupted: "warning" }
const CHECKPOINT: Record<NonNullable<LoopRun["checkpoint"]>["status"], ColorName> = { complete: "success", continue: "muted", blocked: "error" }

function wrapped(text: string, width: number, max: number, indent: string, fg: ColorName): Line[] {
  const lines = wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - indent.length))
  return lines.slice(0, max).map((line, i): Line => [{ text: indent }, { text: i === max - 1 && lines.length > max ? truncateEnd(`${line} …`, width - indent.length) : line, fg }])
}

function runRow(run: LoopRun, width: number, now: number): Line {
  const outcome = run.outcome ?? "running"
  const duration = formatDuration((run.endedAt ?? now) - run.startedAt)
  const status = run.checkpoint?.status
  const left: Span[] = [
    { text: `  #${String(run.run).padEnd(4)}`, fg: "muted" },
    { text: outcome.padEnd(12), fg: run.outcome ? OUTCOME[run.outcome] : "text" },
    { text: duration.padEnd(8), fg: "muted" },
    { text: (status ?? "").padEnd(10), fg: status ? CHECKPOINT[status] : "muted" },
  ]
  const room = width - left.reduce((sum, span) => sum + textWidth(span.text), 0)
  const summary = run.checkpoint?.summary.replace(/\s+/g, " ") ?? ""
  return clampLine([...left, { text: truncateEnd(summary, Math.max(0, room)), fg: "body" }], width)
}

const RUN_ORIGIN: Record<NonNullable<LoopRun["trigger"]>, string> = { schedule: "schedule", manual: "by you", external: "external fire" }

/** When it wakes and how: the trigger with an adaptive loop's current pace, what a run may do, the fire command and the last run's outcome. */
function scheduleRows(loop: Loop, width: number, now: number): Line[] {
  const rows: Line[] = []
  const { trigger } = loop
  const when: Span[] = [{ text: "trigger   ", fg: "muted" }, { text: describeTrigger(trigger), fg: "body" }]
  if (trigger.kind === "adaptive") {
    const { minMs, maxMs } = adaptiveBounds(trigger)
    const pace = loop.adaptiveMs ?? trigger.everyMs
    when.push({ text: " · now every ", fg: "muted" }, { text: spanText(pace), fg: pace >= maxMs ? "warning" : "text", bold: true }, { text: pace <= minMs ? " (fastest)" : pace >= maxMs ? " (slowest)" : "", fg: "muted" })
  }
  rows.push(when)
  const mode = [loop.reportOnly ? "report-only" : "", loop.workspace === "worktree" ? "worktree" : "", loop.template ? `template ${loop.template}` : ""].filter(Boolean)
  if (mode.length) rows.push([{ text: "mode      ", fg: "muted" }, { text: mode.join(" · "), fg: loop.reportOnly ? "warning" : "body" }])
  if (trigger.kind === "external") {
    rows.push([{ text: "fire      ", fg: "muted" }, { text: FIRE_COMMAND(loop.loopId), fg: "text" }])
    if (loop.pendingFire) rows.push([{ text: "          queued fire", fg: "warning" }, { text: loop.pendingFire.note ? `: ${loop.pendingFire.note}` : "", fg: "body" }])
  }
  const last = loop.history[loop.history.length - 1]
  if (last) {
    const outcome = last.outcome ?? "running"
    const activity = last.checkpoint?.activity
    const ended = last.endedAt === undefined ? "" : ` · ${relativeTime(now, last.endedAt)}${relativeTime(now, last.endedAt) === "now" ? "" : " ago"}`
    rows.push([{ text: "last run  ", fg: "muted" }, { text: outcome, fg: last.outcome ? OUTCOME[last.outcome] : "text" }, ...(activity ? [{ text: ` · ${activity}`, fg: activity === "acted" ? "success" : "muted" } as Span] : []), { text: ended, fg: "muted" }, { text: ` · run ${last.run}`, fg: "muted" }, ...(last.trigger ? [{ text: ` · ${RUN_ORIGIN[last.trigger]}`, fg: "muted", dim: true } as Span] : [])])
    if (last.worktree) rows.push([{ text: "          worktree ", fg: "muted" }, { text: last.worktree.branch, fg: "body" }, { text: ` ${last.worktree.state}`, fg: last.worktree.state === "retained" ? "warning" : "muted" }])
  }
  return rows.flatMap((line) => wrap(line.map((span) => span.text).join(""), width).map((text): Line => [{ text, fg: "body" }]))
}

function detailRows(loop: Loop, width: number, now: number): Line[] {
  const rows: Line[] = [[{ text: shortenMiddle(loop.directory, width), fg: "muted", dim: true }]]
  rows.push([{ text: "objective", fg: "muted" }], ...wrapped(loop.objective, width, MAX_OBJECTIVE_LINES, "  ", "body"))
  if (loop.criteria) rows.push([{ text: "until", fg: "muted" }], ...wrapped(loop.criteria, width, 2, "  ", "body"))
  rows.push(...scheduleRows(loop, width, now))
  if (loop.reason) rows.push([{ text: "reason", fg: "muted" }], ...wrapped(loop.reason, width, 2, "  ", loop.state === "blocked" ? "error" : "warning"))
  if (loop.feedback) rows.push(...wrapped(loop.feedback, width, 3, "", "warning"))
  if (loop.override) rows.push(...wrapped(`accepted by you  ${loop.override.reason}`, width, 2, "", "body"))
  rows.push([{ text: "runs", fg: "muted" }])
  const recent = loop.history.slice(-MAX_RUNS_SHOWN).reverse()
  if (recent.length === 0) rows.push([{ text: "  no runs yet", fg: "muted", dim: true }])
  for (const run of recent) rows.push(runRow(run, width, now))
  return rows
}

function emptyRows(width: number): Line[] {
  const rows: Line[] = [
    [{ text: "no loops · ", fg: "muted" }, { text: "/loop every 1h <objective>", fg: "text" }],
    [{ text: "c", fg: "text", bold: true }, { text: " new loop form · ", fg: "muted" }, { text: "t", fg: "text", bold: true }, { text: " new loop from a template", fg: "muted" }],
    [],
    [{ text: "examples", fg: "muted" }],
    ...EXAMPLES.map((example): Line => [{ text: `  ${example}`, fg: "body" }]),
    [],
    [{ text: "triggers: every <n>m|h|d · daily HH:MM · now · (form: adaptive, external, time zone)    flags: --goal · --runs N · --check \"cmd\" · --no-audit", fg: "muted", dim: true }],
  ]
  return rows.map((line) => clampLine(line, width))
}

/** Renders exactly `height` lines of at most `width` cells. `now` drives the countdowns. */
export function renderLoopsPage(input: { loops: Loop[]; state: LoopsPageState; width: number; height: number; now: number; glyphs?: Glyphs }): Line[] {
  const { loops: all, state, width, height, now } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  if (state.form) return renderLoopForm({ form: state.form, templates: state.templates ?? FALLBACK_TEMPLATES, width, height, glyphs })
  const tab = state.tab === 1 ? 1 : 0
  const loops = loopsForTab(all, tab)
  const selected = clamp(state.selected, loops.length)
  const target = loops[selected]
  const room = Math.max(0, height - 2)
  const hints = "b evidence · " + (target?.reviewInvalidatedAt !== undefined ? "n run · e edit · pgdn evidence · esc back" : `${target?.trigger.kind === "external" ? "y copy fire cmd · f fire · " : ""}w waive · a accept · o approve · pgdn evidence · ↑↓ select · e edit · c new · t template · p pause · n run · esc back`)
  const list = (w: number): Line[] => {
    const rows: Line[] = []
    const confirm = confirmRow(state, loops, w)
    if (confirm) rows.push(confirm)
    if (!loops.length) return all.length ? [[{ text: tab ? "No finished loops" : "No active loops", fg: "muted" }]] : emptyRows(w)
    const count = width < 110 ? Math.max(1, Math.min(loops.length, 4)) : Math.max(1, room - 4)
    const offset = Math.max(0, selected - count + 1)
    for (const loop of loops.slice(offset, offset + count)) rows.push(loopRow({ loop, selected: loop === target, width: w, now, glyphs }))
    return rows
  }
  const summary = `${state.scope === "all" ? "all projects" : "this project"}`
  const title = `Loops · ${summary}${state.confirm ? " · Confirm" : target?.reviewInvalidatedAt !== undefined ? " · Run required" : all.some((loop) => loop.state === "blocked") ? " · Blocked" : all.some((loop) => loop.state === "needs_input") ? " · Needs input" : ""}`
  let body: Line[]
  if (!target) body = panelGrid({ width, compact: false, padding: true, heights: [room], rows: [[{ title: "Loops", body: list, active: true }]] })
  else if (width < 70) {
    const combined = (w: number): Line[] => [...list(w), [], ...budgetRows(target, w), [], ...evidenceRows(target, w), [], ...detailRows(target, w, now)]
    body = panelGrid({ width, compact: false, padding: true, heights: [room], maxColumns: 1, rows: [[{ title: target.name, body: combined, scroll: state.scroll ?? 0, active: true }]] })
  } else if (width < 110) {
    const top = Math.min(10, Math.max(5, Math.floor(room * 0.4)))
    body = panelGrid({ width, compact: false, padding: true, maxColumns: 2, heights: [top, Math.max(0, room - top - 1)], rows: [
      [{ title: "Loops", body: list, active: true }, { title: "Budget", body: (w) => budgetRows(target, w) }],
      [{ title: target.name, body: (w) => detailRows(target, w, now), scroll: state.scroll ?? 0 }, { title: "Gates / Rubric", body: (w) => evidenceRows(target, w), scroll: state.scroll ?? 0 }],
    ] })
  } else body = panelGrid({ width, compact: false, padding: true, maxColumns: 3, heights: [room], rows: [[
    { title: "Loops", body: list, active: true, weight: 2 },
    { title: target.name, body: (w) => [...budgetRows(target, w), [], ...detailRows(target, w, now)], scroll: state.scroll ?? 0, weight: 3 },
    { title: "Gates / Rubric", body: (w) => evidenceRows(target, w), scroll: state.scroll ?? 0, weight: 3 },
  ]] })
  const frame = pickerFrame(title, hints, width, height, body)
  if (height > 1) frame[1] = fit(tabsRow(PAGE_TABS, tab, width), width)
  return frame
}
