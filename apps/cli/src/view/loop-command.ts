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

export type LoopParse = { ok: true; spec: LoopSpec; summary: string } | { ok: false; error: string }

export const LOOP_USAGE = 'usage: /loop <every 30m|2h|1d | daily HH:MM | now> [--goal [--check "cmd"] [--no-audit]] [--runs N] [--max-tokens N] [--max-cost USD] <objective> [until: <criteria>]'

const NAME_WORDS = 6
const MAX_NAME = 120
const MAX_OBJECTIVE = 8_000
const MAX_CRITERIA = 4_000
const MAX_RUNS = 1_000
const MAX_CHECKS = 5
const MAX_INTERVAL_MS = 30 * 86_400_000

const fail = (error: string): LoopParse => ({ ok: false, error })

function readTrigger(text: string): { trigger: LoopTrigger; runNow: boolean; rest: string } | string {
  const now = /^now\b\s*/i.exec(text)
  if (now) return { trigger: { kind: "manual" }, runNow: true, rest: text.slice(now[0].length) }
  const every = /^every\s+(\d+)\s*(min|m|h|d)\b\s*/i.exec(text)
  if (every) {
    const trigger = parseTrigger(`every ${every[1]}${every[2]}`)
    const valid = trigger?.kind === "interval" && trigger.everyMs <= MAX_INTERVAL_MS
    return trigger && valid ? { trigger, runNow: false, rest: text.slice(every[0].length) } : "interval must be 1m to 30d"
  }
  if (/^every\b/i.test(text)) return "interval needs a number and m, h or d (every 30m)"
  const daily = /^daily\s+(\d{1,2}):(\d{2})\b\s*/i.exec(text)
  if (daily) {
    const trigger = parseTrigger(`daily ${daily[1]!.padStart(2, "0")}:${daily[2]}`)
    return trigger ? { trigger, runNow: false, rest: text.slice(daily[0].length) } : "daily time must be HH:MM (00:00-23:59)"
  }
  if (/^daily\b/i.test(text)) return "daily needs a time (daily 09:00)"
  return "trigger must be every <n>m|h|d, daily HH:MM or now"
}

/** Parses the arguments of `/loop`: trigger, flags (--goal, --runs N), objective and an optional `until:` criteria. */
export function parseLoopCommand(args: string): LoopParse {
  const text = args.trim()
  if (!text) return fail(LOOP_USAGE)
  const read = readTrigger(text)
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
  return { ok: true, spec, summary: `loop: ${read.runNow ? "now" : describeTrigger(read.trigger)} · ${budgetText}` }
}
