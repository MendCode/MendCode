import type { Loop, LoopBudget, LoopCostBudget, LoopRubric, LoopApprovalPolicy, LoopState, LoopTemplateInfo, LoopTrigger } from "@mendcode/protocol"
import { adaptiveBounds } from "@mendcode/protocol/wire"
import { describeTrigger, parseTrigger } from "@mendcode/loops"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * The create/edit form of `/loops`: template, name, objective, trigger (manual, interval, daily with a time zone,
 * adaptive with bounds, external), budget, report-only and worktree. An edit sends `loop.update` and keeps its history.
 */

export type TriggerChoice = "default" | "manual" | "interval" | "daily" | "adaptive" | "external"
export type BudgetChoice = "default" | "monitor" | "goal" | "fixed"
/** `default` leaves the choice to the template; `on`/`off` are explicit. */
export type Tri = "default" | "on" | "off"

export type LoopForm = {
  /** Set when editing: the loop to update. */
  replaces?: { loopId: string; name: string; state: LoopState }
  hadCostBudget?: boolean
  hadRubric?: boolean
  hadApprovalPolicy?: boolean
  template: string
  name: string
  objective: string
  criteria: string
  trigger: TriggerChoice
  every: string
  at: string
  timezone: string
  min: string
  max: string
  budget: BudgetChoice
  runs: string
  reportOnly: Tri
  worktree: boolean
  runNow: boolean
  /** Carried over from the loop being edited (the form has no rows for them; /loop --check sets them). */
  checks?: string[]
  audit?: "independent" | "none"
  maxTokens: string
  maxCost: string
  unknownCost: "block" | "allow"
  rubric: string
  approvalActions: string
  row: number
  error?: string
}

/** The body of a `loop.create` command as the form builds it (the app adds `type`, `directory` and the request base). */
export type LoopCreateFields = {
  name: string
  objective?: string
  criteria?: string
  trigger?: LoopTrigger
  budget?: LoopBudget
  runNow?: boolean
  checks?: string[]
  audit?: "independent" | "none"
  template?: string
  reportOnly?: boolean
  workspace?: "in-place" | "worktree"
  costBudget?: LoopCostBudget
  rubric?: LoopRubric
  approvalPolicy?: LoopApprovalPolicy
}

/** `form` rides along on a save so the app can put it back when the daemon refuses the loop. */
export type FormAction = { type: "none" } | { type: "cancel" } | { type: "save"; fields: LoopCreateFields; replaces?: NonNullable<LoopForm["replaces"]>; summary: string; form: LoopForm }

/** Templates known without asking the daemon (docs/loops.md); used only when `loop.templates` did not answer. */
export const FALLBACK_TEMPLATES: readonly LoopTemplateInfo[] = [
  { id: "pr-watch", name: "PR watch", description: "Watch a PR until checks and review are resolved; ask before push or merge", summary: "adaptive 15m (5m..2h) · goal" },
  { id: "ci-repair", name: "CI repair", description: "Investigate failing CI, focused fixes, narrow validation", summary: "every 10m · goal" },
  { id: "research-digest", name: "Research digest", description: "Research a topic from primary sources and keep a journal", summary: "adaptive 1h (30m..24h) · monitor · report-only" },
  { id: "repo-maintenance", name: "Repo maintenance", description: "Focused hygiene, no broad refactors", summary: "every 30m · monitor" },
]

type RowId = "template" | "name" | "objective" | "trigger" | "every" | "at" | "timezone" | "min" | "max" | "external" | "budget" | "runs" | "criteria" | "reportOnly" | "worktree" | "runNow" | "maxTokens" | "maxCost" | "unknownCost" | "rubric" | "approvalActions" | "submit"

const TEXT_ROWS = new Set<RowId>(["name", "objective", "every", "at", "timezone", "min", "max", "runs", "criteria", "maxTokens", "maxCost", "rubric", "approvalActions"])
const TRIGGERS: readonly TriggerChoice[] = ["manual", "interval", "daily", "adaptive", "external"]
const BUDGETS: readonly BudgetChoice[] = ["monitor", "goal", "fixed"]
const MAX_INTERVAL_MS = 30 * 86_400_000
const MAX_RUNS = 1_000
const NAME_WORDS = 6
const MAX_LEN: Partial<Record<RowId, number>> = { name: 120, objective: 8_000, criteria: 4_000, every: 12, at: 5, timezone: 64, min: 12, max: 12, runs: 4, maxTokens: 16, maxCost: 20, rubric: 15_000, approvalActions: 100 }

const UP = new Set(["\x1b[A", "\x1bOA", "\x1b[Z"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\t"])
const LEFT = new Set(["\x1b[D", "\x1bOD"])
const RIGHT = new Set(["\x1b[C", "\x1bOC"])

export const FIRE_COMMAND = (loopId: string | undefined) => `${PROGRAM_NAME} loop fire ${loopId ?? "<id>"}`

/** A blank form. With a template, what the template fills in stays `default`. */
export function newLoopForm(template = ""): LoopForm {
  const base: LoopForm = { template: "", name: "", objective: "", criteria: "", trigger: "interval", every: "30m", at: "09:00", timezone: "", min: "", max: "", budget: "monitor", runs: "", reportOnly: "off", worktree: false, runNow: false, maxTokens: "", maxCost: "", unknownCost: "block", rubric: "", approvalActions: "", row: 0 }
  return template ? withTemplate(base, template) : base
}

function withTemplate(form: LoopForm, template: string): LoopForm {
  if (!template) return { ...form, template: "", trigger: form.trigger === "default" ? "interval" : form.trigger, budget: form.budget === "default" ? "monitor" : form.budget, reportOnly: form.reportOnly === "default" ? "off" : form.reportOnly }
  return { ...form, template, trigger: "default", budget: "default", reportOnly: form.worktree ? "off" : "default" }
}

const spanText = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes % 1_440 === 0 ? `${minutes / 1_440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

/** A form prefilled from an existing loop: saving updates it in place. */
export function editLoopForm(loop: Loop): LoopForm {
  const form = newLoopForm()
  const { trigger, budget } = loop
  return {
    ...form,
    replaces: { loopId: loop.loopId, name: loop.name, state: loop.state },
    hadCostBudget: !!loop.costBudget,
    hadRubric: !!loop.rubric,
    hadApprovalPolicy: !!loop.approvalPolicy,
    maxTokens: loop.costBudget?.maxTokens?.toString() ?? "",
    maxCost: loop.costBudget?.maxCost?.toString() ?? "",
    unknownCost: loop.costBudget?.unknownCost ?? "block",
    rubric: loop.rubric ? JSON.stringify(loop.rubric) : "",
    approvalActions: loop.approvalPolicy?.requireApprovalFor.join(",") ?? "",
    name: loop.name,
    objective: loop.objective,
    criteria: loop.criteria ?? "",
    trigger: trigger.kind,
    every: trigger.kind === "interval" || trigger.kind === "adaptive" ? spanText(trigger.everyMs) : form.every,
    at: trigger.kind === "daily" ? trigger.at : form.at,
    timezone: trigger.kind === "daily" ? (trigger.timezone ?? "") : "",
    // Only bounds the loop was given are prefilled; empty keeps the defaults (a quarter and eight times the pace, not whole minutes).
    min: trigger.kind === "adaptive" && trigger.minMs !== undefined ? spanText(trigger.minMs) : "",
    max: trigger.kind === "adaptive" && trigger.maxMs !== undefined ? spanText(trigger.maxMs) : "",
    budget: budget.mode,
    runs: budget.mode === "monitor" ? "" : String(budget.maxRuns ?? ""),
    reportOnly: loop.reportOnly ? "on" : "off",
    worktree: loop.workspace === "worktree",
    ...(loop.checks?.length ? { checks: loop.checks } : {}),
    ...(loop.audit ? { audit: loop.audit } : {}),
  }
}

/** The rows the form shows for its current choices, in order. */
export function formRows(form: LoopForm): RowId[] {
  const rows: RowId[] = ["template", "name", "objective", "trigger"]
  if (form.trigger === "interval" || form.trigger === "adaptive") rows.push("every")
  if (form.trigger === "daily") rows.push("at", "timezone")
  if (form.trigger === "adaptive") rows.push("min", "max")
  if (form.trigger === "external") rows.push("external")
  rows.push("budget")
  if (form.budget === "goal" || form.budget === "fixed") rows.push("runs")
  if (form.budget === "goal") rows.push("criteria")
  rows.push("maxTokens", "maxCost", "unknownCost", ...(form.budget === "goal" ? ["rubric" as const] : []), "approvalActions", "reportOnly", "worktree", "runNow", "submit")
  return rows
}

const rowAt = (form: LoopForm): RowId => {
  const rows = formRows(form)
  return rows[Math.max(0, Math.min(form.row, rows.length - 1))]!
}

/** Any edit clears the last validation message. */
function withoutError(form: LoopForm): LoopForm {
  const { error, ...rest } = form
  void error
  return rest
}

function cycle<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const at = list.indexOf(current)
  return list[(at + direction + list.length) % list.length]!
}

const triggerChoices = (form: LoopForm): readonly TriggerChoice[] => (form.template ? ["default", ...TRIGGERS] : TRIGGERS)
const budgetChoices = (form: LoopForm): readonly BudgetChoice[] => (form.template ? ["default", ...BUDGETS] : BUDGETS)
const reportChoices = (form: LoopForm): readonly Tri[] => (form.template ? ["default", "on", "off"] : ["off", "on"])

/** Changes the focused row's choice one step; a toggle keeps report-only and worktree exclusive (a report-only run never edits, so it has no worktree). */
function change(form: LoopForm, direction: 1 | -1, templates: readonly LoopTemplateInfo[]): LoopForm {
  const row = rowAt(form)
  const clean = withoutError(form)
  switch (row) {
    case "template": {
      const ids = ["", ...templates.map((template) => template.id)]
      return withTemplate(clean, cycle(ids, form.template, direction))
    }
    case "trigger":
      return { ...clean, trigger: cycle(triggerChoices(form), form.trigger, direction) }
    case "budget":
      return { ...clean, budget: cycle(budgetChoices(form), form.budget, direction) }
    case "reportOnly": {
      const reportOnly = cycle(reportChoices(form), form.reportOnly, direction)
      return { ...clean, reportOnly, worktree: reportOnly === "on" ? false : form.worktree }
    }
    case "worktree": {
      const worktree = !form.worktree
      return { ...clean, worktree, reportOnly: worktree && form.reportOnly !== "off" ? "off" : form.reportOnly }
    }
    case "unknownCost":
      return { ...clean, unknownCost: form.unknownCost === "block" ? "allow" : "block" }
    case "runNow":
      return { ...clean, runNow: !form.runNow }
    default:
      return clean
  }
}

function typed(form: LoopForm, row: RowId, update: (value: string) => string): LoopForm {
  const key = row as "name" | "objective" | "every" | "at" | "timezone" | "min" | "max" | "runs" | "criteria" | "maxTokens" | "maxCost" | "rubric" | "approvalActions"
  const limit = MAX_LEN[row] ?? 200
  return { ...withoutError(form), [key]: update(form[key]).slice(0, limit) }
}

/** Handles one raw key. Returns the form to keep (undefined closes it) and what the app should do. */
export function loopFormKey(form: LoopForm, key: string, input: { directory: string; templates: readonly LoopTemplateInfo[] }): { form: LoopForm | undefined; action: FormAction } {
  const NONE: FormAction = { type: "none" }
  const rows = formRows(form)
  const row = rowAt(form)
  const move = (index: number) => ({ form: { ...form, row: Math.max(0, Math.min(index, rows.length - 1)) }, action: NONE })
  if (key === "\x1b") return { form: undefined, action: { type: "cancel" } }
  if (UP.has(key)) return move(form.row - 1)
  if (DOWN.has(key)) return move(form.row + 1)
  if (row === "submit" && key === "\r") {
    const built = buildLoopFields(form, input.templates)
    if (!built.ok) return { form: { ...form, error: built.error }, action: NONE }
    return { form: undefined, action: { type: "save", fields: built.fields, ...(form.replaces ? { replaces: form.replaces } : {}), summary: built.summary, form } }
  }
  if (key === "\r") return move(form.row + 1)
  if (TEXT_ROWS.has(row)) {
    if (key === "\x7f" || key === "\b") return { form: typed(form, row, (value) => value.slice(0, -1)), action: NONE }
    if (key === "\x15") return { form: typed(form, row, () => ""), action: NONE }
    if (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(key)) return { form: typed(form, row, (value) => value + key), action: NONE }
    return { form, action: NONE }
  }
  if (LEFT.has(key)) return { form: change(form, -1, input.templates), action: NONE }
  if (RIGHT.has(key) || key === " ") return { form: change(form, 1, input.templates), action: NONE }
  return { form, action: NONE }
}

const units = /^(\d+)\s*(m|min|h|d)$/i

/** `30m`, `2h`, `1d` (a leading `every` is tolerated) as a span, or undefined. */
function readSpan(text: string): string | undefined {
  const match = units.exec(text.trim().replace(/^every\s+/i, ""))
  return match ? `${match[1]}${match[2]!.toLowerCase()}` : undefined
}

function readTrigger(form: LoopForm): { trigger?: LoopTrigger } | string {
  switch (form.trigger) {
    case "default":
      return {}
    case "manual":
      return { trigger: { kind: "manual" } }
    case "external":
      return { trigger: { kind: "external" } }
    case "interval": {
      const span = readSpan(form.every)
      const trigger = span ? parseTrigger(`every ${span}`) : undefined
      if (trigger?.kind !== "interval") return "every needs a span such as 30m, 2h or 1d (at least 1m)"
      return trigger.everyMs <= MAX_INTERVAL_MS ? { trigger } : "interval must be 1m to 30d"
    }
    case "daily": {
      const at = /^(\d{1,2}):(\d{2})$/.exec(form.at.trim())
      if (!at) return "at needs HH:MM (00:00-23:59)"
      const zone = form.timezone.trim()
      const trigger = parseTrigger(`daily ${at[1]!.padStart(2, "0")}:${at[2]}${zone ? ` ${zone}` : ""}`)
      if (trigger?.kind !== "daily") return zone ? "at needs HH:MM and timezone an IANA name such as Europe/Madrid" : "at needs HH:MM (00:00-23:59)"
      return { trigger }
    }
    case "adaptive": {
      const span = readSpan(form.every)
      if (!span) return "every needs a span such as 30m, 2h or 1d (at least 1m)"
      const min = form.min.trim() ? readSpan(form.min) : undefined
      const max = form.max.trim() ? readSpan(form.max) : undefined
      if ((form.min.trim() && !min) || (form.max.trim() && !max)) return "min and max need a span such as 5m or 4h, or stay empty for the defaults"
      const base = parseTrigger(`adaptive ${span}`)
      if (base?.kind !== "adaptive") return "adaptive every must be at least 1m"
      const bounds = adaptiveBounds(base)
      const text = `adaptive ${span}${min || max ? ` ${min ?? spanText(bounds.minMs)}..${max ?? spanText(bounds.maxMs)}` : ""}`
      const trigger = parseTrigger(text)
      return trigger?.kind === "adaptive" ? { trigger } : "adaptive needs min <= every <= max, each from 1m to 30d"
    }
  }
}

function readBudget(form: LoopForm): { budget?: LoopBudget } | string {
  const runs = form.runs.trim() ? Number(form.runs) : undefined
  const validRuns = runs === undefined || (Number.isInteger(runs) && runs >= 1 && runs <= MAX_RUNS)
  if (!validRuns) return `runs needs a whole number from 1 to ${MAX_RUNS}`
  switch (form.budget) {
    case "default":
      return {}
    case "monitor":
      return { budget: { mode: "monitor" } }
    case "goal":
      return { budget: { mode: "goal", ...(runs !== undefined ? { maxRuns: runs } : {}) } }
    case "fixed":
      return runs === undefined ? "fixed needs runs" : { budget: { mode: "fixed", maxRuns: runs } }
  }
}

/** Validates the form and builds the `loop.create` fields; `summary` is the one-line confirmation. */
export function buildLoopFields(form: LoopForm, templates: readonly LoopTemplateInfo[] = FALLBACK_TEMPLATES): { ok: true; fields: LoopCreateFields; summary: string } | { ok: false; error: string } {
  const objective = form.objective.trim()
  if (!form.template && !objective) return { ok: false, error: "objective is empty" }
  const trigger = readTrigger(form)
  if (typeof trigger === "string") return { ok: false, error: trigger }
  const budget = readBudget(form)
  if (typeof budget === "string") return { ok: false, error: budget }
  if (form.worktree && form.reportOnly === "on") return { ok: false, error: "a report-only loop never edits, so it has no worktree" }
  const criteria = form.budget === "goal" ? form.criteria.trim() : ""
  const name = form.name.trim() || objective.split(/\s+/).slice(0, NAME_WORDS).join(" ").slice(0, MAX_LEN.name) || (templates.find((template) => template.id === form.template)?.name ?? form.template)
  const maxTokens = form.maxTokens.trim() ? Number(form.maxTokens) : undefined
  const maxCost = form.maxCost.trim() ? Number(form.maxCost) : undefined
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) return { ok: false, error: "token cap needs a positive whole number" }
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost < 0.000001)) return { ok: false, error: "USD cap needs at least 0.000001" }
  let rubric: LoopRubric | undefined
  if (form.rubric.trim()) {
    if (form.budget !== "goal") return { ok: false, error: "a rubric needs a goal loop" }
    try {
      const value = JSON.parse(form.rubric)
      if (!value || typeof value !== "object" || !Array.isArray(value.criteria)) throw new Error()
      rubric = value as LoopRubric
    } catch { return { ok: false, error: "rubric needs JSON with a criteria array" } }
  }
  const actions = [...new Set(form.approvalActions.split(",").map((action) => action.trim()).filter(Boolean))]
  if (actions.some((action) => !["push", "merge", "deploy", "publish", "delete"].includes(action))) return { ok: false, error: "approval actions: push, merge, deploy, publish, delete" }
  const fields: LoopCreateFields = {
    name,
    ...(maxTokens !== undefined || maxCost !== undefined || form.hadCostBudget ? { costBudget: { ...(maxTokens !== undefined ? { maxTokens } : {}), ...(maxCost !== undefined ? { maxCost, unknownCost: form.unknownCost } : {}) } } : {}),
    ...(rubric ? { rubric } : form.hadRubric ? { rubric: { criteria: [] } } : {}),
    ...(actions.length || form.hadApprovalPolicy ? { approvalPolicy: { requireApprovalFor: actions as LoopApprovalPolicy["requireApprovalFor"] } } : {}),
    ...(objective ? { objective } : {}),
    ...(criteria || form.replaces ? { criteria } : {}),
    ...trigger,
    ...budget,
    ...(form.runNow ? { runNow: true } : {}),
    ...(form.checks?.length && form.budget === "goal" ? { checks: form.checks } : {}),
    ...(form.audit && form.budget === "goal" ? { audit: form.audit } : {}),
    ...(form.template ? { template: form.template } : {}),
    ...(form.reportOnly === "on" ? { reportOnly: true } : form.reportOnly === "off" && (form.template || form.replaces) ? { reportOnly: false } : {}),
    ...(form.worktree ? { workspace: "worktree" as const } : form.replaces ? { workspace: "in-place" as const } : {}),
  }
  return { ok: true, fields, summary: summarize(fields) }
}

function summarize(fields: LoopCreateFields): string {
  const parts = [fields.template ? `template ${fields.template}` : "", fields.trigger ? describeTrigger(fields.trigger) : "template trigger"]
  const budget = fields.budget
  parts.push(!budget ? "template budget" : budget.mode === "monitor" ? "monitor" : budget.mode === "fixed" ? `${budget.maxRuns} runs` : budget.maxRuns ? `goal ≤${budget.maxRuns}` : "goal")
  if (fields.reportOnly) parts.push("report-only")
  if (fields.workspace === "worktree") parts.push("worktree")
  if (fields.runNow) parts.push("run now")
  return parts.filter(Boolean).join(" · ")
}

const LABEL: Record<RowId, string> = {
  template: "template",
  name: "name",
  objective: "objective",
  trigger: "trigger",
  every: "every",
  at: "at",
  timezone: "timezone",
  min: "min",
  max: "max",
  external: "fire",
  budget: "budget",
  runs: "runs",
  criteria: "until",
  maxTokens: "token cap",
  maxCost: "USD cap",
  unknownCost: "unknown USD",
  rubric: "rubric JSON",
  approvalActions: "approval",
  reportOnly: "report-only",
  worktree: "worktree",
  runNow: "run now",
  submit: "",
}
const LABEL_WIDTH = 12

function hintFor(form: LoopForm, row: RowId, templates: readonly LoopTemplateInfo[]): string {
  switch (row) {
    case "template": {
      const picked = templates.find((template) => template.id === form.template)
      if (!form.template) return "← → pick a built-in template, or none to write the loop yourself"
      return picked ? `${picked.description} · fills in ${picked.summary}` : form.template
    }
    case "name":
      return "shown in the list; empty uses the first words of the objective"
    case "objective":
      return form.template ? "optional with a template: added as “Specifically: …”" : "what every run does"
    case "trigger":
      return form.trigger === "default" ? "the template's own trigger" : form.trigger === "adaptive" ? "doubles after a run that found nothing, halves after one that acted" : form.trigger === "manual" ? "never by itself: n in /loops runs it (or set run now)" : form.trigger === "external" ? "fired from cron or CI, never by itself" : form.trigger === "daily" ? "every day at a wall-clock time; empty timezone is this machine's" : "every span after the last run ends"
    case "every":
      return form.trigger === "adaptive" ? "the starting pace: 30m, 2h, 1d" : "30m, 2h, 1d · 1m to 30d"
    case "at":
      return "HH:MM, 24 hours"
    case "timezone":
      return "IANA name such as Europe/Madrid; empty uses this machine's clock"
    case "min":
      return "fastest pace; empty is a quarter of every"
    case "max":
      return "slowest pace; empty is eight times every"
    case "external":
      return "run this from cron or CI; it starts a run now (or right after the current one)"
    case "budget":
      return form.budget === "default" ? "the template's own budget" : form.budget === "goal" ? "stops when a run reports the goal done; runs is only a safety cap" : form.budget === "fixed" ? "exactly this many runs" : "repeats until stopped"
    case "runs":
      return form.budget === "fixed" ? "number of runs, 1 to 1000" : "optional cap, 1 to 1000"
    case "criteria":
      return "what must be true to finish"
    case "maxTokens": return "total input, output, reasoning and cache tokens across runs and audits; empty disables"
    case "maxCost": return "API USD cap across runs and audits; empty disables"
    case "unknownCost": return "block refuses unknown prices under a USD cap; allow is an explicit opt-in"
    case "rubric": return 'JSON: {"criteria":[{"id":"tests","description":"Tests pass","evidenceRequired":["success checks"]}]}'
    case "approvalActions": return "comma-separated actions: push, merge, deploy, publish, delete; empty disables"
    case "reportOnly":
      return "runs report but never edit: their session is read-only"
    case "worktree":
      return "each run edits its own git worktree and branch, never your checkout"
    case "runNow":
      return form.replaces ? "run after saving if active; disabled loops stay disabled" : "start the first run as soon as the loop exists"
    case "submit":
      return form.replaces ? `updates “${form.replaces.name}” (id and history stay)` : "creates the loop"
  }
}

function valueSpans(form: LoopForm, row: RowId, on: boolean, templates: readonly LoopTemplateInfo[], room: number, glyphs: Glyphs): Span[] {
  const choice = (text: string, fg: ColorName = "text"): Span[] => [{ text: "‹ ", fg: "muted" }, { text: truncateEnd(text, Math.max(1, room - 4)), fg, bold: on }, { text: " ›", fg: "muted" }]
  const toggle = (value: boolean): Span[] => [{ text: value ? "[x] on" : "[ ] off", fg: value ? "success" : "muted", bold: on }]
  const text = (value: string, placeholder: string): Span[] => {
    const shown = value === "" ? placeholder : value
    const tail = textWidth(shown) > room - 1 ? `…${shown.slice(shown.length - (room - 2))}` : shown
    return [{ text: tail, fg: value === "" ? "muted" : "text", bold: on && value !== "" }, ...(on ? [{ text: "▏", fg: "primary" as const }] : [])]
  }
  switch (row) {
    case "template":
      return choice(form.template ? (templates.find((template) => template.id === form.template)?.name ?? form.template) : "none")
    case "name":
      return text(form.name, "from the objective")
    case "objective":
      return text(form.objective, form.template ? "from the template" : "required")
    case "trigger":
      return choice(form.trigger === "default" ? "template default" : form.trigger)
    case "every":
      return text(form.every, "30m")
    case "at":
      return text(form.at, "09:00")
    case "timezone":
      return text(form.timezone, "this machine")
    case "min":
      return text(form.min, "default")
    case "max":
      return text(form.max, "default")
    case "external":
      return [{ text: FIRE_COMMAND(form.replaces?.loopId), fg: "text" }]
    case "budget":
      return choice(form.budget === "default" ? "template default" : form.budget)
    case "runs":
      return text(form.runs, form.budget === "fixed" ? "required" : "no cap")
    case "criteria":
      return text(form.criteria, "optional")
    case "maxTokens": return text(form.maxTokens, "off")
    case "maxCost": return text(form.maxCost, "off")
    case "unknownCost": return choice(form.unknownCost)
    case "rubric": return text(form.rubric, "off")
    case "approvalActions": return text(form.approvalActions, "off")
    case "reportOnly":
      return form.template ? choice(form.reportOnly === "default" ? "template default" : form.reportOnly) : toggle(form.reportOnly === "on")
    case "worktree":
      return toggle(form.worktree)
    case "runNow":
      return toggle(form.runNow)
    case "submit":
      return [{ text: form.replaces ? "save loop" : "create loop", fg: on ? "primary" : "text", bold: true }]
  }
}

const FORM_HINTS = ["↑↓ row · ←→ change · type to edit · enter next · esc cancel", "↑↓ · ←→ · enter · esc cancel", "esc cancel"]

/** Renders exactly `height` lines of at most `width` cells. */
export function renderLoopForm(input: { form: LoopForm; templates: readonly LoopTemplateInfo[]; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { form, templates, width, height } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 4)
  const rows = formRows(form)
  const focused = rowAt(form)
  const hints = FORM_HINTS.find((text) => textWidth(text) <= Math.max(20, width - 2))!
  const room = Math.max(0, height - 2)
  const valueRoom = Math.max(8, inner - 2 - LABEL_WIDTH)
  const body: Line[] = []
  if (form.replaces) body.push(...wrap(`editing “${form.replaces.name}”: id, history and state stay`, inner).slice(0, 2).map((text): Line => [{ text, fg: "muted", dim: true }]), [])
  let focusRow = 0
  rows.forEach((row) => {
    const on = row === focused
    if (row === "submit") body.push([])
    if (on) focusRow = body.length
    const marker: Span = on ? { text: "❯ ", fg: "primary", bold: true } : { text: "  " }
    if (row === "submit") body.push(clip([marker, ...valueSpans(form, row, on, templates, valueRoom, glyphs)], inner))
    else body.push(clip([marker, { text: LABEL[row].padEnd(LABEL_WIDTH), fg: on ? "primary" : "text", bold: on }, ...valueSpans(form, row, on, templates, valueRoom, glyphs)], inner))
  })
  const hint = wrap(hintFor(form, focused, templates), Math.max(8, inner - 2)).slice(0, 2)
  body.push([], ...hint.map((text): Line => [{ text: `  ${text}`, fg: "muted", dim: true }]))
  const preview = buildLoopFields(form, templates)
  if (form.error) body.push([{ text: truncateEnd(`✗ ${form.error}`, inner), fg: "error" }])
  else if (preview.ok) body.push([{ text: truncateEnd(`→ ${preview.summary}`, inner), fg: "body" }])
  else body.push([{ text: truncateEnd(`· ${preview.error}`, inner), fg: "warning" }])
  const scroll = Math.max(0, focusRow + 5 - room)
  return pickerFrame(`Loops / ${form.replaces ? "Edit" : "New"}`, hints, width, height, panelGrid({ width, compact: false, padding: true, heights: [room], maxColumns: 1, rows: [[{ title: form.replaces ? form.replaces.name : "New loop", body, scroll, active: true }]] }), form.error || (preview.ok ? preview.summary : preview.error))
}
