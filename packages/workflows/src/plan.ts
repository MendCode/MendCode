import { parseCheck } from "@mendcode/loops"
import { WorkflowPlan, WorkflowScriptPlan, type WorkflowContract } from "@mendcode/protocol"
import { routingProblems } from "./routing"
import { agentSpecs, compositionProblems } from "./composition"
import { outputSchemaProblems } from "./outputs"
import { scriptPlanProblems } from "./script-plan"

/** Total characters of every agent prompt in one plan (the stored run stays bounded, P11). */
export const MAX_PLAN_PROMPT_CHARS = 48_000
/** A rejected plan reports at most this many problems, so the model or user fixes the first ones and asks again. */
export const MAX_PLAN_PROBLEMS = 5

export type PlanValidation = { ok: true; plan: WorkflowPlan } | { ok: false; problems: string[] }

type Node = { id: string; needs: readonly string[] }

/**
 * Checks a plan before anything is approved or started: the shape (with defaults filled in), then the graph
 * and contract rules. Problems name the offending id and there are at most `MAX_PLAN_PROBLEMS`.
 */
export function validatePlan(input: unknown): PlanValidation {
  // A script plan has its own shape (no static tasks, up to 16 concurrent); everything else is held to the static plan's limits.
  const parsed = (input && typeof input === "object" && "script" in input ? WorkflowScriptPlan : WorkflowPlan).safeParse(input)
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, MAX_PLAN_PROBLEMS).map((issue) => `${describePath(issue.path, input)}${issue.message}`) }
  const problems = [...scriptPlanProblems(parsed.data), ...taskProblems(parsed.data), ...contractProblems(parsed.data), ...routingProblems(parsed.data), ...compositionProblems(parsed.data), ...outputSchemaProblems(parsed.data)]
  return problems.length ? { ok: false, problems: problems.slice(0, MAX_PLAN_PROBLEMS) } : { ok: true, plan: parsed.data }
}

/** The 1-based level of each task in plan order: 1 when it needs nothing, else one more than its deepest need. */
export function levels(plan: { tasks: readonly Node[] }): Map<string, number> {
  const needs = new Map(plan.tasks.map((task) => [task.id, task.needs]))
  const level = new Map<string, number>()
  const visiting = new Set<string>()
  const of = (id: string): number => {
    const known = level.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const deepest = Math.max(0, ...(needs.get(id) ?? []).filter((need) => needs.has(need)).map(of))
    visiting.delete(id)
    level.set(id, deepest + 1)
    return deepest + 1
  }
  return new Map(plan.tasks.map((task) => [task.id, of(task.id)]))
}

/**
 * Freezes a contract named by the plan: replaces the name with the contract `lookup` finds and validates the result again,
 * because a layer's contract names tasks (`owners`) the plan may not have. A plan with an inline contract or none passes through.
 */
export function resolveContract(plan: WorkflowPlan, lookup: (name: string) => WorkflowContract | undefined): PlanValidation {
  if (typeof plan.contract !== "string") return validatePlan(plan)
  const contract = lookup(plan.contract)
  if (!contract) return { ok: false, problems: [`contract "${plan.contract}" was not found in any extension layer`] }
  return validatePlan({ ...plan, contract })
}

/** `task "survey" (tasks[0]): ` for an issue inside a task, else the dotted path; empty for the plan itself. */
function describePath(path: readonly PropertyKey[], input: unknown) {
  if (path.length === 0) return ""
  const [head, index] = path
  const rest = path.slice(2).map(String).join(".")
  if (head === "tasks" && typeof index === "number") {
    const raw = (input as { tasks?: Array<{ id?: unknown }> } | null)?.tasks?.[index]
    const name = typeof raw?.id === "string" ? `task "${raw.id}"` : `tasks[${index}]`
    return `${name}${rest ? ` ${rest}` : ""}: `
  }
  return `${path.map(String).join(".")}: `
}

function taskProblems(plan: WorkflowPlan): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const task of plan.tasks) {
    if (seen.has(task.id)) problems.push(`task id "${task.id}" is used more than once`)
    seen.add(task.id)
  }
  for (const task of plan.tasks) {
    const listed = new Set<string>()
    for (const need of task.needs) {
      if (need === task.id) problems.push(`task "${task.id}" needs itself`)
      else if (!seen.has(need)) problems.push(`task "${task.id}" needs unknown task "${need}"`)
      if (listed.has(need)) problems.push(`task "${task.id}" lists "${need}" twice`)
      listed.add(need)
    }
    if (task.kind === "check") {
      const parsed = parseCheck(task.command)
      if ("error" in parsed) problems.push(`check task "${task.id}": ${parsed.error}`)
    }
  }
  const cycle = findCycle(plan.tasks)
  if (cycle) problems.push(`tasks form a cycle: ${cycle.join(" needs ")}`)
  const prompts = agentSpecs(plan).map((task) => ({ id: task.id, chars: task.prompt.length }))
  const total = prompts.reduce((sum, prompt) => sum + prompt.chars, 0)
  if (total > MAX_PLAN_PROMPT_CHARS) {
    const longest = prompts.reduce((a, b) => (b.chars > a.chars ? b : a))
    problems.push(`prompts total ${total} characters but the limit is ${MAX_PLAN_PROMPT_CHARS}; the longest is task "${longest.id}" (${longest.chars})`)
  }
  return problems
}

function contractProblems(plan: WorkflowPlan): string[] {
  const { contract } = plan
  if (contract === undefined || typeof contract === "string") return []
  return validateContract(contract, new Set(plan.tasks.map((task) => task.id)))
}

/**
 * Every problem in a contract: ids unique, `covers` naming criteria, commands plain argv and, when the tasks are known,
 * `owners` naming them. A saved contract (no plan yet) is checked without `taskIds`; the plan that uses it checks the owners at start.
 */
export function validateContract(contract: WorkflowContract, taskIds?: ReadonlySet<string>): string[] {
  const problems: string[] = []
  const criterionIds = new Set<string>()
  for (const criterion of contract.criteria) {
    if (criterionIds.has(criterion.id)) problems.push(`criterion id "${criterion.id}" is used more than once`)
    criterionIds.add(criterion.id)
    for (const owner of criterion.owners ?? []) if (taskIds && !taskIds.has(owner)) problems.push(`criterion "${criterion.id}" names unknown owner task "${owner}"`)
  }
  const checkIds = new Set<string>()
  for (const check of contract.checks) {
    if (checkIds.has(check.id)) problems.push(`contract check id "${check.id}" is used more than once`)
    checkIds.add(check.id)
    const parsed = parseCheck(check.command)
    if ("error" in parsed) problems.push(`contract check "${check.id}": ${parsed.error}`)
    for (const covered of check.covers ?? []) if (!criterionIds.has(covered)) problems.push(`contract check "${check.id}" covers unknown criterion "${covered}"`)
    for (const owner of check.owners ?? []) if (taskIds && !taskIds.has(owner)) problems.push(`contract check "${check.id}" names unknown owner task "${owner}"`)
  }
  return problems
}

/** One dependency cycle as ids that each need the next (first id repeated at the end), or undefined. Unknown needs are ignored. */
function findCycle(tasks: readonly Node[]): string[] | undefined {
  const needs = new Map(tasks.map((task) => [task.id, task.needs]))
  const done = new Set<string>()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    path.push(id)
    for (const need of needs.get(id) ?? []) {
      if (!needs.has(need)) continue
      const at = path.indexOf(need)
      if (at >= 0) return [...path.slice(at), need]
      if (done.has(need)) continue
      const found = visit(need)
      if (found) return found
    }
    path.pop()
    done.add(id)
    return undefined
  }
  for (const task of tasks) {
    if (done.has(task.id)) continue
    const found = visit(task.id)
    if (found) return found
  }
  return undefined
}
