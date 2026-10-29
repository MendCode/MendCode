/**
 * `workflow convert`: a static JSON plan as a script. Pure text in, text out (no schema library, so the terminal client's
 * startup graph stays small); the daemon validates the result like any other script when it is previewed or started.
 *
 * Mapping: tasks of the same dependency level run in `parallel`, a task's prompt gets the results of the tasks it needs (what the
 * static engine appends on its own), a check task throws when it fails (the static engine blocks its dependents), a human task is
 * `ask()`, the contract and phases move into `meta`. Map tasks have no script equivalent here: they are listed in the refusal.
 */
type Json = Record<string, unknown>
export type ConvertResult = { ok: true; script: string; notes: string[] } | { ok: false; problems: string[] }

const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const literal = (value: unknown) => JSON.stringify(value)
const variable = (id: string) => `r_${id.replace(/[^a-zA-Z0-9]/g, "_")}`

function levelsOf(tasks: Json[]): Json[][] {
  const byId = new Map(tasks.map((task) => [String(task.id), task]))
  const level = new Map<string, number>()
  const visit = (task: Json, seen: Set<string>): number => {
    const id = String(task.id)
    const known = level.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 1
    seen.add(id)
    const needs = Array.isArray(task.needs) ? task.needs.map(String).filter((need) => byId.has(need)) : []
    const value = 1 + Math.max(0, ...needs.map((need) => visit(byId.get(need)!, seen)))
    seen.delete(id)
    level.set(id, value)
    return value
  }
  for (const task of tasks) visit(task, new Set())
  const out: Json[][] = []
  for (const task of tasks) (out[level.get(String(task.id))! - 1] ??= []).push(task)
  return out.filter(Boolean)
}

function agentOptions(task: Json, plan: Json, phase: string | undefined): string {
  const options: string[] = [`label: ${literal(task.title ?? task.id)}`]
  if (phase) options.push(`phase: ${literal(phase)}`)
  if (task.mode === "work") options.push(`mode: "work"`)
  const workspace = object(task.workspace) ? task.workspace : object(plan.workspace) ? plan.workspace : undefined
  if (task.mode === "work" && workspace?.mode === "per-run-worktree") options.push("worktree: true")
  const model = object(task.model) ? task.model : undefined
  if (model && text(model.model)) {
    options.push(`model: ${literal(model.model)}`)
    if (text(model.effort)) options.push(`effort: ${literal(model.effort)}`)
  }
  if (text(task.agent)) options.push(`agent: ${literal(task.agent)}`)
  if (Array.isArray(task.allowedTools)) options.push(`allowedTools: ${literal(task.allowedTools)}`)
  if (object(task.retry) && typeof task.retry.maxAttempts === "number") options.push(`retry: ${literal(task.retry)}`)
  if (typeof task.timeoutMinutes === "number") options.push(`timeoutMinutes: ${task.timeoutMinutes}`)
  const output = object(task.output) ? task.output : undefined
  if (output?.kind === "json" && output.schema !== undefined) options.push(`schema: ${literal(output.schema)}`)
  return `{ ${options.join(", ")} }`
}

/** Phase title of a task in a plan with phases (the phase that lists it). */
function phaseOf(plan: Json, id: string): string | undefined {
  if (!Array.isArray(plan.phases)) return undefined
  const phase = plan.phases.find((entry) => object(entry) && Array.isArray(entry.tasks) && entry.tasks.includes(id))
  return object(phase) ? text(phase.title) ?? text(phase.id) : undefined
}

export function planToScript(input: unknown, source?: string): ConvertResult {
  if (!object(input)) return { ok: false, problems: ["the plan is not a JSON object"] }
  const plan = input
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.filter(object) : []
  if (!tasks.length) return { ok: false, problems: ["the plan has no tasks"] }
  const unsupported = tasks.filter((task) => task.kind === "map").map((task) => `task "${String(task.id)}" is a map task (fan-out over another task's output); write it as a loop over that result with parallel() instead`)
  if (unsupported.length) return { ok: false, problems: unsupported }
  const name = text(plan.name) ?? "converted"
  const notes: string[] = []
  const meta: Json = { name, description: text(plan.objective)?.slice(0, 300) ?? "" }
  if (Array.isArray(plan.phases) && plan.phases.length) {
    meta.phases = plan.phases.filter(object).map((phase) => ({ title: text(phase.title) ?? text(phase.id) ?? "Phase" }))
  }
  const agents = tasks.filter((task) => task.kind !== "check" && task.kind !== "human").length
  meta.budget = { agents: Math.min(200, Math.max(agents * 2, 4)) }
  if (typeof plan.maxRuntimeMinutes === "number") (meta.budget as Json).minutes = plan.maxRuntimeMinutes
  if (typeof plan.maxConcurrent === "number") meta.maxConcurrent = plan.maxConcurrent
  if (text(plan.permission)) meta.permission = plan.permission
  if (plan.contract !== undefined) meta.contract = plan.contract
  if (plan.model || plan.agent || plan.workspace || plan.permissions || plan.budget) notes.push("plan-level model, agent, workspace, permission policy and budget are not carried over; set them per agent() call if you need them")
  if (plan.retention) notes.push("retention is not carried over")

  const lines: string[] = []
  lines.push(`// Converted from the plan "${name}"${source ? ` (${source})` : ""}.`)
  lines.push("// Tasks of the same dependency level run together; a task's prompt carries the results of the tasks it needed.")
  lines.push(`export const meta = ${JSON.stringify(meta, null, 2)}`, "")
  const done = new Set<string>()
  const resultBlock = (needs: string[]) => (needs.length ? ` + "\\n\\nResults of the tasks you depend on:\\n" + ${needs.map((need) => `"## ${need}\\n" + String(${variable(need)})`).join(` + "\\n\\n" + `)}` : "")
  let lastPhase: string | undefined
  for (const group of levelsOf(tasks)) {
    const phase = phaseOf(plan, String(group[0]!.id))
    if (phase && phase !== lastPhase) {
      lines.push(`phase(${literal(phase)})`)
      lastPhase = phase
    }
    const thunk = (task: Json) => {
      const id = String(task.id)
      const needs = (Array.isArray(task.needs) ? task.needs.map(String) : []).filter((need) => done.has(need))
      if (task.kind === "check") return `check(${literal(task.command)}).then((outcome) => { if (!outcome.ok) throw new Error(${literal(`check ${id} failed: `)} + outcome.detail); return outcome.detail })`
      if (task.kind === "human") return `ask(${literal(text(task.prompt) ?? text(task.title) ?? id)})`
      return `agent(${literal(text(task.prompt) ?? "")}${resultBlock(needs)}, ${agentOptions(task, plan, phaseOf(plan, id))})`
    }
    if (group.length === 1) lines.push(`const ${variable(String(group[0]!.id))} = await ${thunk(group[0]!)}`)
    else {
      lines.push(`const [${group.map((task) => variable(String(task.id))).join(", ")}] = await parallel([`, ...group.map((task) => `  () => ${thunk(task)},`), "])")
    }
    for (const task of group) done.add(String(task.id))
  }
  const last = tasks.at(-1)!
  lines.push("", `return ${variable(String(last.id))}`, "")
  return { ok: true, script: lines.join("\n"), notes }
}
