import type { LoopBudget, LoopTrigger, LoopCostBudget, LoopApprovalPolicy } from "@mendcode/protocol"
import { checkProblems, describeTrigger, parseTrigger } from "@mendcode/loops"

export type LoopSpec = {
  name: string
  objective: string
  criteria?: string
  trigger: LoopTrigger
  budget: LoopBudget
  runNow: boolean
  checks?: string[]
  audit?: "none"
  costBudget?: LoopCostBudget
  approvalPolicy?: LoopApprovalPolicy
}

/**
 * `natural`: the schedule came from a phrase (`cada 5 minutos`, `daily at 9am`) or was left out (adaptive), so the app asks for a
 * one-line confirmation before starting. `interpret` on a failure: the phrase mentions a schedule the local parser did not
 * understand; the small role may convert it (`loop.interpret`).
 */
export type LoopParse = { ok: true; spec: LoopSpec; summary: string; when: string; budgetText: string; natural?: true; /** With `natural`: the same loop in the strict form, what `e` puts back in the prompt. */ strict?: string } | { ok: false; error: string; interpret?: string }

export const LOOP_USAGE = 'usage: /loop <every 30m|2h|1d | daily HH:MM | adaptive | now | a phrase like "cada 5 minutos ..."> [--goal [--check "cmd"] [--no-audit]] [--runs N] [--max-tokens N] [--max-cost USD] <objective> [until: <criteria>]'

const NAME_WORDS = 6
const MAX_NAME = 120
const MAX_OBJECTIVE = 8_000
const MAX_CRITERIA = 4_000
const MAX_RUNS = 1_000
const MAX_CHECKS = 5
const MAX_INTERVAL_MS = 30 * 86_400_000

const fail = (error: string): LoopParse => ({ ok: false, error })

/** The text does not start with the strict form: it may be a phrase, or no schedule at all. */
const NOT_STRICT = "not strict"
/** What `/loop` runs on when no interval is given: it paces itself (docs/loops.md, Adaptive). */
const DEFAULT_ADAPTIVE = "adaptive 10m"

function readTrigger(text: string): { trigger: LoopTrigger; runNow: boolean; rest: string } | string {
  const now = /^now\b\s*/i.exec(text)
  if (now) return { trigger: { kind: "manual" }, runNow: true, rest: text.slice(now[0].length) }
  const adaptive = /^adaptive\b(?:\s+(\d+)\s*(min|m|h|d)\b)?\s*/i.exec(text)
  if (adaptive) {
    const trigger = parseTrigger(adaptive[1] ? `adaptive ${adaptive[1]}${adaptive[2]}` : DEFAULT_ADAPTIVE)
    return trigger ? { trigger, runNow: false, rest: text.slice(adaptive[0].length) } : "adaptive interval must be 1m to 30d"
  }
  const every = /^every\s+(\d+)\s*(min|m|h|d)\b\s*/i.exec(text)
  if (every) {
    const trigger = parseTrigger(`every ${every[1]}${every[2]}`)
    const valid = trigger?.kind === "interval" && trigger.everyMs <= MAX_INTERVAL_MS
    return trigger && valid ? { trigger, runNow: false, rest: text.slice(every[0].length) } : "interval must be 1m to 30d"
  }
  const daily = /^daily\s+(\d{1,2}):(\d{2})\b\s*/i.exec(text)
  if (daily) {
    const trigger = parseTrigger(`daily ${daily[1]!.padStart(2, "0")}:${daily[2]}`)
    return trigger ? { trigger, runNow: false, rest: text.slice(daily[0].length) } : "daily time must be HH:MM (00:00-23:59)"
  }
  return NOT_STRICT
}

const NUMBER_WORDS: Record<string, number> = { un: 1, una: 1, uno: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5, seis: 6, six: 6, siete: 7, seven: 7, ocho: 8, eight: 8, nueve: 9, nine: 9, diez: 10, ten: 10, doce: 12, twelve: 12, quince: 15, fifteen: 15, veinte: 20, twenty: 20, treinta: 30, thirty: 30, cuarenta: 40, forty: 40, sesenta: 60, sixty: 60 }
const NUMBER = `(\\d+|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`
const UNIT = "(minutes?|minutos?|mins?|m|hours?|horas?|hrs?|h|days?|dias?|d|weeks?|semanas?|seconds?|segundos?|secs?|s)"
const HINT = /\b(?:(?:every|each|cada)\s+(?:\w+\s+){0,2}(?:minut|min\b|hour|hora|day|dia|week|semana|month|mes\b|second|segundo|lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|hourly|weekly|monthly|diari|semanal|mensual|todos\s+los|todas\s+las|weekday|dias\s+laborables)/

/** Lower case without accents, the same length as the text, so a match in it cuts the original. */
const flatten = (text: string) => text.normalize("NFC").toLowerCase().replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i").replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")

const countOf = (word: string | undefined) => (word === undefined ? 1 : /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word] ?? 1)

/** `a las 9`, `at 9:30pm`, `18:00`, `9 de la noche`: HH:MM and the part of the text it took, or undefined. */
function readTime(flat: string): { at: string; from: number; to: number } | undefined {
  const match = /(?:\b(?:a\s+las?|at|@)\s*(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|hs?|hrs))?\b|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b)(?:\s+de\s+la\s+(manana|tarde|noche))?/.exec(flat)
  if (!match) return undefined
  let hour = Number(match[1] ?? match[4])
  const minute = Number(match[2] ?? match[5] ?? 0)
  const suffix = match[3] ?? match[6]
  const part = match[7]
  if (suffix === "pm" && hour < 12) hour += 12
  else if (suffix === "am" && hour === 12) hour = 0
  else if ((part === "tarde" || part === "noche") && hour < 12) hour += 12
  if (hour > 23 || minute > 59) return undefined
  return { at: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, from: match.index, to: match.index + match[0].length }
}

const inMinutes = (count: number, unit: string): number | undefined => {
  const kind = unit[0]!
  if (/^(?:s|secs?|seconds?|segundos?)$/.test(unit)) return undefined
  if (kind === "m") return count
  if (kind === "h") return count * 60
  if (kind === "d") return count * 1_440
  if (kind === "w" || kind === "s") return count * 10_080
  return undefined
}

/** A span as the strict form writes it (`90m` stays minutes, whole hours and days are shortened). */
const strictSpan = (minutes: number) => (minutes % 1_440 === 0 ? `${minutes / 1_440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`)

/**
 * The schedule in a phrase, in the strict form's words, and the text left once it is cut out. No pattern covers a phrase that
 * mentions a schedule the parser does not know (`interpret`), and a phrase without any schedule runs adaptive.
 * Spanish and English: `cada 5 minutos`, `cada hora`, `cada media hora`, `todos los días a las 9`, `every five minutes`, `daily at 9am`, `hourly`.
 */
export function readSchedule(text: string): { trigger: string; rest: string } | { error: string } | { interpret: true } {
  const flat = flatten(text)
  const cuts: Array<[number, number]> = []
  let minutes: number | undefined
  let daily = false
  const half = /\b(?:cada\s+media\s+hora|every\s+half(?:\s+an)?[\s-]hour)\b/.exec(flat)
  const quarter = /\b(?:cada\s+(?:un\s+)?cuarto\s+de\s+hora|every\s+(?:a\s+)?quarter(?:\s+of\s+an)?[\s-]hour)\b/.exec(flat)
  const every = new RegExp(`\\b(?:cada|every|each)\\s+(?:${NUMBER}\\s*)?${UNIT}\\b`).exec(flat)
  const dayWords = /\b(?:todos\s+los\s+dias|a\s+diario|diariamente|diario|daily|everyday|every\s+day|cada\s+dia)\b/.exec(flat)
  const hourly = /\bhourly\b/.exec(flat)
  const weekly = /\b(?:weekly|semanalmente|semanal)\b/.exec(flat)
  if (half) { minutes = 30; cuts.push([half.index, half.index + half[0].length]) }
  else if (quarter) { minutes = 15; cuts.push([quarter.index, quarter.index + quarter[0].length]) }
  else if (hourly) { minutes = 60; cuts.push([hourly.index, hourly.index + hourly[0].length]) }
  else if (weekly) { minutes = 10_080; cuts.push([weekly.index, weekly.index + weekly[0].length]) }
  else if (every && !(dayWords && dayWords.index <= every.index && /^(?:cada|every)\s+(?:dia|day)$/.test(dayWords[0]))) {
    const count = countOf(every[1])
    const unit = every[2]!
    minutes = inMinutes(count, unit)
    if (minutes === undefined) return { error: "interval must be 1m to 30d" }
    cuts.push([every.index, every.index + every[0].length])
  } else if (dayWords) {
    minutes = 1_440
    daily = true
    cuts.push([dayWords.index, dayWords.index + dayWords[0].length])
  }
  if (minutes === undefined) return HINT.test(flat) ? { interpret: true } : { trigger: DEFAULT_ADAPTIVE, rest: text }
  if (minutes < 1 || minutes > 30 * 1_440) return { error: "interval must be 1m to 30d" }
  if (minutes === 1_440) daily = true
  const time = daily ? readTime(flat) : undefined
  if (time) cuts.push([time.from, time.to])
  const trigger = daily && time ? `daily ${time.at}` : `every ${strictSpan(minutes)}`
  let rest = text
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) rest = `${rest.slice(0, from)} ${rest.slice(to)}`
  rest = rest.replace(/\s+/g, " ").trim().replace(/^(?:[,;:.]|-(?=\s)|y\b|and\b|then\b|luego\b|entonces\b)+\s*/i, "").replace(/\s*(?:[,;:.]|\s-|\sy|\sand)$/i, "").trim()
  return { trigger, rest }
}

/** Parses the arguments of `/loop`: trigger, flags (--goal, --runs N), objective and an optional `until:` criteria. */
export function parseLoopCommand(args: string): LoopParse {
  const text = args.trim()
  if (!text) return fail(LOOP_USAGE)
  const read = readTrigger(text)
  if (read === NOT_STRICT) return parseNatural(text)
  if (typeof read === "string") return fail(read)
  let rest = read.rest
  let goal = false
  let runs: number | undefined
  let noAudit = false
  const checks: string[] = []
  const costBudget: LoopCostBudget = {}
  let approvalPolicy: LoopApprovalPolicy | undefined
  while (rest.startsWith("--")) {
    const flag = /^--(\S+)\s*/.exec(rest)!
    if (flag[1] === "goal") {
      goal = true
      rest = rest.slice(flag[0].length)
    } else if (flag[1] === "no-audit") {
      noAudit = true
      rest = rest.slice(flag[0].length)
    } else if (flag[1] === "check") {
      const value = /^--check\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/.exec(rest)
      if (!value) return fail(`--check needs a command, quoted when it has spaces: --check "bun test"`)
      const command = (value[1] ?? value[2] ?? value[3] ?? "").trim()
      const problem = checkProblems([command])[0]
      if (problem) return fail(problem)
      if (checks.length >= MAX_CHECKS) return fail(`at most ${MAX_CHECKS} checks`)
      checks.push(command)
      rest = rest.slice(value[0].length)
    } else if (["max-tokens", "max-cost", "unknown-cost", "require-approval"].includes(flag[1]!)) {
      const value = /^--\S+\s+(\S+)\s*/.exec(rest)
      if (!value) return fail(`--${flag[1]} needs a value`)
      const number = Number(value[1])
      if (flag[1] === "max-tokens") {
        if (!Number.isSafeInteger(number) || number < 1) return fail("--max-tokens needs a positive whole number")
        costBudget.maxTokens = number
      } else if (flag[1] === "max-cost") {
        if (!Number.isFinite(number) || number < 0.000001) return fail("--max-cost needs USD of at least 0.000001")
        costBudget.maxCost = number
      } else if (flag[1] === "unknown-cost") {
        if (value[1] !== "block" && value[1] !== "allow") return fail("--unknown-cost needs block or allow")
        costBudget.unknownCost = value[1]
      } else {
        const actions = [...new Set(value[1]!.split(","))]
        if (actions.some((action) => !["push", "merge", "deploy", "publish", "delete"].includes(action))) return fail("approval actions: push, merge, deploy, publish, delete")
        approvalPolicy = { requireApprovalFor: actions as LoopApprovalPolicy["requireApprovalFor"] }
      }
      rest = rest.slice(value[0].length)
    } else if (flag[1] === "runs") {
      const count = /^--runs\s+(\d+)\b\s*/.exec(rest)
      if (!count || Number(count[1]) < 1 || Number(count[1]) > MAX_RUNS) return fail(`--runs needs a number from 1 to ${MAX_RUNS}`)
      runs = Number(count[1])
      rest = rest.slice(count[0].length)
    } else return fail(`unknown flag --${flag[1]} (--goal, --runs N, --check "cmd", --no-audit)`)
  }
  if (costBudget.unknownCost && costBudget.maxCost === undefined) return fail("--unknown-cost needs --max-cost")
  if ((checks.length || noAudit) && !goal) return fail("--check and --no-audit need --goal")
  let objective = rest.trim()
  let criteria: string | undefined
  const until = goal ? /\s*\buntil:\s*/i.exec(objective) : null
  if (until) {
    criteria = objective.slice(until.index + until[0].length).trim()
    objective = objective.slice(0, until.index).trim()
    if (!criteria) return fail("until: needs the completion criteria")
  }
  if (!objective) return fail("/loop needs an objective")
  if (objective.length > MAX_OBJECTIVE) return fail("objective is too long")
  if (criteria && criteria.length > MAX_CRITERIA) return fail("criteria is too long")
  const budget: LoopBudget = goal ? { mode: "goal", ...(runs ? { maxRuns: runs } : {}) } : runs ? { mode: "fixed", maxRuns: runs } : { mode: "monitor" }
  const name = objective.split(/\s+/).slice(0, NAME_WORDS).join(" ").slice(0, MAX_NAME)
  const spec: LoopSpec = { name, ...(Object.keys(costBudget).length ? { costBudget } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), objective, ...(criteria ? { criteria } : {}), trigger: read.trigger, budget, runNow: read.runNow, ...(checks.length ? { checks } : {}), ...(noAudit ? { audit: "none" as const } : {}) }
  const verify = goal ? [checks.length ? `${checks.length} check${checks.length === 1 ? "" : "s"}` : "", noAudit ? "" : "audit"].filter(Boolean).join(" + ") : ""
  const budgetText = (budget.mode === "monitor" ? "monitor" : budget.mode === "fixed" ? `${budget.maxRuns} runs` : budget.maxRuns ? `goal ≤${budget.maxRuns}` : "goal") + (verify ? ` · ${verify}` : "")
  const when = read.runNow ? "now" : describeTrigger(read.trigger)
  return { ok: true, spec, summary: `loop: ${when} · ${budgetText}`, when, budgetText }
}

/** A phrase instead of the strict form: the local parser first (no tokens), adaptive when no schedule is said. */
function parseNatural(text: string): LoopParse {
  const schedule = readSchedule(text)
  if ("error" in schedule) return fail(schedule.error)
  if ("interpret" in schedule) return { ok: false, error: "that schedule was not understood", interpret: text }
  const strict = `${schedule.trigger} ${schedule.rest}`
  const parsed = parseLoopCommand(strict)
  return parsed.ok ? { ...parsed, natural: true, strict } : parsed
}
