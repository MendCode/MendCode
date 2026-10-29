import { GOAL_MAX_OBJECTIVE_CHARS, GOAL_MAX_TOKEN_BUDGET, type GoalStatus } from "@mendcode/protocol/wire"
import type { Goal, GoalBy, GoalChange } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { titledRule } from "./chat-blocks"
import { wrapSpans } from "./markdown"
import type { InfoCard } from "./rewind-card"

/**
 * Session goals in the terminal (docs/goals.md): the `/goal` command's arguments, the footer indicator, the transcript
 * card and the facts a summary shows. Pure: a goal and a clock in, styled rows out.
 */

const INDENT = "  "
const OBJECTIVE_ROWS = 3

export type GoalCommand =
  | { kind: "summary" }
  | { kind: "set"; objective: string; tokenBudget?: number }
  | { kind: "edit" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "budget"; tokens: number | null }

export type GoalParse = { ok: true; command: GoalCommand } | { ok: false; error: string }

export const GOAL_USAGE = "/goal <objective> · edit · pause · resume · clear · budget <tokens|off>"

/** `50000`, `50k`, `1.5m`, `2b`: a whole number of tokens; undefined when the text is not one, null for `off`. */
export function parseTokenCount(text: string): number | null | undefined {
  const value = text.trim().toLowerCase().replace(/[_,]/g, "")
  if (value === "off" || value === "none") return null
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(value)
  if (!match) return undefined
  const scale = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : match[2] === "b" ? 1e9 : 1
  const tokens = Math.round(Number(match[1]) * scale)
  return tokens >= 1 && tokens <= GOAL_MAX_TOKEN_BUDGET ? tokens : undefined
}

/**
 * The arguments of `/goal`. A bare word (`pause`, `resume`, `clear`, `edit`) or `budget <n>` is a subcommand; anything
 * else is the objective, so "pause the deploy after the tests" still sets a goal. `--budget <n>` may lead the objective.
 */
export function parseGoalCommand(args: string): GoalParse {
  const text = args.trim()
  if (!text) return { ok: true, command: { kind: "summary" } }
  const lower = text.toLowerCase()
  if (lower === "pause" || lower === "resume" || lower === "clear" || lower === "edit") return { ok: true, command: { kind: lower } }
  const budget = /^budget(?:\s+(\S+))?$/i.exec(text)
  if (budget) {
    const tokens = budget[1] === undefined ? undefined : parseTokenCount(budget[1])
    return tokens === undefined ? { ok: false, error: `budget needs a token count like 50000, 50k or 1.5m, or off (max ${GOAL_MAX_TOKEN_BUDGET.toLocaleString("en-US")})` } : { ok: true, command: { kind: "budget", tokens } }
  }
  let objective = text
  let tokenBudget: number | undefined
  const flag = /^--budget(?:=|\s+)(\S+)\s*([\s\S]*)$/.exec(text)
  if (flag) {
    const tokens = parseTokenCount(flag[1]!)
    if (typeof tokens !== "number") return { ok: false, error: "--budget needs a token count like 50000, 50k or 1.5m" }
    tokenBudget = tokens
    objective = flag[2]!.trim()
    if (!objective) return { ok: false, error: `the goal needs an objective: ${GOAL_USAGE}` }
  }
  if (objective.length > GOAL_MAX_OBJECTIVE_CHARS) return { ok: false, error: `the objective is ${objective.length.toLocaleString("en-US")} characters; the limit is ${GOAL_MAX_OBJECTIVE_CHARS.toLocaleString("en-US")}` }
  return { ok: true, command: { kind: "set", objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) } }
}

/** 640 / 1.2k / 12k / 1.5m: the size of a token count in a short space. */
export function shortTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)))
  const units: Array<[number, string]> = [[1e3, "k"], [1e6, "m"], [1e9, "b"], [1e12, "t"]]
  let at = value < 1e6 ? 0 : value < 1e9 ? 1 : value < 1e12 ? 2 : 3
  const format = (unit: number) => {
    const scaled = value / unit
    return scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled))
  }
  let text = format(units[at]![0])
  if (Number(text) >= 1_000 && at < units.length - 1) text = format(units[++at]![0])
  return `${text}${units[at]![1]}`
}

/** 45s / 4m / 1h 5m: whole units, never a fraction. */
export function shortElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Time spent on the goal: what the daemon counted plus the turn running right now. */
export function goalElapsedMs(goal: Goal, now: number): number {
  return goal.timeUsedSeconds * 1000 + (goal.status === "active" && goal.activeSince !== undefined ? Math.max(0, now - goal.activeSince) : 0)
}

const STATUS_LABEL: Readonly<Record<GoalStatus, string>> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usage_limited: "usage limit",
  budget_limited: "budget reached",
  complete: "complete",
}

const STATUS_COLOR: Readonly<Record<GoalStatus, ColorName>> = {
  active: "primary",
  paused: "muted",
  blocked: "warning",
  usage_limited: "warning",
  budget_limited: "warning",
  complete: "success",
}

/** `12k of 50k tokens` / `12k tokens`. */
const tokenFacts = (goal: Goal) => (goal.tokenBudget !== undefined ? `${shortTokens(goal.tokensUsed)} of ${shortTokens(goal.tokenBudget)} tokens` : `${shortTokens(goal.tokensUsed)} tokens`)

/** The footer's goal indicator: `◎ goal 12k/50k · 4m` while it works, `◎ goal · paused` (and so on) when it does not. */
export function goalSpans(goal: Goal, now: number, glyphs: Glyphs): Span[] {
  const stalled = goal.status === "active" && goal.stalled !== undefined
  const color: ColorName = stalled ? "warning" : STATUS_COLOR[goal.status]
  const head: Span[] = [{ text: `${glyphs.goal} goal`, fg: color }]
  if (goal.status === "active" && !stalled) {
    const used = goal.tokenBudget !== undefined ? `${shortTokens(goal.tokensUsed)}/${shortTokens(goal.tokenBudget)}` : goal.tokensUsed > 0 ? shortTokens(goal.tokensUsed) : ""
    return [...head, ...(used ? [{ text: ` ${used}`, fg: "text" as const }] : []), { text: ` · ${shortElapsed(goalElapsedMs(goal, now))}`, fg: "muted" }]
  }
  return [...head, { text: ` · ${stalled ? "stalled" : STATUS_LABEL[goal.status]}`, fg: color }]
}

/** The facts under a goal's objective: status, tokens, time. */
export function goalFacts(goal: Goal, now: number): string {
  const parts = [goal.status === "active" && goal.stalled !== undefined ? "active, not continuing" : STATUS_LABEL[goal.status], tokenFacts(goal), shortElapsed(goalElapsedMs(goal, now))]
  return parts.join(" · ")
}

/** The title a `goal.changed` event earns a card for; undefined for changes the footer shows on its own (pause, resume, usage). */
export function goalCardTitle(change: GoalChange, goal: Goal): { title: string; color: ColorName } | undefined {
  if (change === "created") return { title: "Goal set", color: "heading" }
  if (change === "stalled") return goal.status === "active" && goal.stalled !== undefined ? { title: "Goal waiting", color: "warning" } : undefined
  if (change !== "status") return undefined
  switch (goal.status) {
    case "complete":
      return { title: "Goal complete", color: "success" }
    case "blocked":
      return { title: "Goal blocked", color: "warning" }
    case "budget_limited":
      return { title: "Goal budget reached", color: "warning" }
    case "usage_limited":
      return { title: "Goal stopped · usage limit", color: "warning" }
    default:
      return undefined
  }
}

/** The objective, clipped to a few rows; a clipped one ends in an ellipsis. */
function objectiveRows(objective: string, width: number): Line[] {
  const rows = objective
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => wrapSpans([{ text: line, fg: "text" }], width, [{ text: INDENT }]))
  if (rows.length <= OBJECTIVE_ROWS) return rows
  return [...rows.slice(0, OBJECTIVE_ROWS - 1), [{ text: INDENT }, { text: `… ${rows.length - OBJECTIVE_ROWS + 1} more lines`, fg: "muted", dim: true }]]
}

export type GoalCard = { change: GoalChange; goal: Goal; by?: GoalBy; reason?: string; at: number }

/** The transcript card of a goal event: a titled rule, the objective, the facts and what the agent or the daemon said. */
export function goalCardRows(card: GoalCard, width: number): Line[] {
  const head = goalCardTitle(card.change, card.goal)
  if (!head) return []
  const why = card.goal.stalled !== undefined && card.change === "stalled" ? card.goal.stalled : card.goal.note
  const rows: Line[] = [titledRule(head.title, width, head.color), ...objectiveRows(card.goal.objective, width)]
  rows.push(...wrapSpans([{ text: goalFacts(card.goal, card.at), fg: "muted" }], width, [{ text: INDENT }]))
  if (why) rows.push(...wrapSpans([{ text: why, fg: head.color === "success" ? "muted" : "warning" }], width, [{ text: INDENT }]))
  return rows
}

/** What `/goal` shows with no arguments, for the card over the transcript. */
export function goalSummaryBody(goal: Goal | undefined, now: number): Array<{ text: string; fg: ColorName; label?: string }> {
  if (!goal) return [{ text: "No goal in this session. Set one with /goal <objective>.", fg: "muted" }]
  const rows: Array<{ text: string; fg: ColorName; label?: string }> = [
    { label: "objective", text: clip(goal.objective, 600), fg: "text" },
    { label: "status", text: goal.status === "active" && goal.stalled !== undefined ? "active, not continuing" : STATUS_LABEL[goal.status], fg: goal.status === "active" && goal.stalled !== undefined ? "warning" : STATUS_COLOR[goal.status] === "primary" ? "text" : STATUS_COLOR[goal.status] },
    { label: "tokens", text: tokenFacts(goal), fg: "text" },
    { label: "time", text: shortElapsed(goalElapsedMs(goal, now)), fg: "text" },
  ]
  if (goal.stalled !== undefined) rows.push({ label: "waiting", text: goal.stalled, fg: "warning" })
  if (goal.note) rows.push({ label: "note", text: goal.note, fg: "muted" })
  return rows
}

/** The one key hint a summary ends with, by what the goal can do next. */
export function goalSummaryHint(goal: Goal | undefined): string {
  if (!goal) return "esc closes"
  const next =
    goal.status === "active" ? "/goal pause" : goal.status === "complete" ? "/goal <objective> starts another" : goal.status === "budget_limited" ? "/goal budget <tokens> raises it" : "/goal resume"
  return `${next} · /goal edit · /goal clear · esc closes`
}

/** What the card over the transcript asks or shows: the summary, a replacement that needs a yes, or a resume that does. */
export type GoalPrompt = { kind: "summary" } | { kind: "replace"; objective: string; tokenBudget?: number } | { kind: "resume"; question: string }

/** The question `/goal resume` asks, or why the goal cannot be resumed. */
export function goalResumeQuestion(goal: Goal | undefined): { ok: true; question: string } | { ok: false; reason: string } {
  if (!goal) return { ok: false, reason: "no goal in this session" }
  switch (goal.status) {
    case "paused":
      return { ok: true, question: "Resume paused goal?" }
    case "blocked":
      return { ok: true, question: "Resume blocked goal?" }
    case "usage_limited":
      return { ok: true, question: "Resume goal after the usage limit?" }
    case "active":
      return goal.stalled !== undefined ? { ok: true, question: "Continue the goal now?" } : { ok: false, reason: "the goal is already working" }
    case "budget_limited":
      return { ok: false, reason: "the goal reached its token budget: raise it with /goal budget <tokens>" }
    case "complete":
      return { ok: false, reason: "the goal is complete: /goal <objective> starts another" }
  }
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text)

/** The card for a prompt: a title, rows and the keys. */
export function goalPromptCard(prompt: GoalPrompt, goal: Goal | undefined, now: number): InfoCard {
  if (prompt.kind === "summary") return { title: "Goal", body: goalSummaryBody(goal, now), hint: goalSummaryHint(goal) }
  if (prompt.kind === "resume") return { title: prompt.question, body: goal ? goalSummaryBody(goal, now).filter((row) => row.label !== "note") : [], hint: "y resume · esc cancel" }
  const budget = prompt.tokenBudget !== undefined ? ` · budget ${shortTokens(prompt.tokenBudget)}` : ""
  return {
    title: "Replace the current goal?",
    body: [
      ...(goal ? [{ label: "current", text: clip(goal.objective, 300), fg: "muted" as const }, { label: "status", text: goalFacts(goal, now), fg: "muted" as const }] : []),
      { label: "new", text: `${clip(prompt.objective, 300)}${budget}`, fg: "text" as const },
    ],
    hint: "y replace it · esc cancel",
  }
}
