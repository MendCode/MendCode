import type { WorkflowAgentTaskSpec, WorkflowPhase, WorkflowRun, WorkflowTask, WorkflowTaskSpec, WorkflowArtifactSelector } from "@mendcode/protocol"

export const taskTerminal = (task: WorkflowTask) => ["done", "failed", "skipped", "stopped"].includes(task.state)

export function barrierSatisfied(run: WorkflowRun, phase: WorkflowPhase): boolean {
  const tasks = run.tasks.filter((task) => phase.tasks.includes(task.id))
  const done = tasks.filter((task) => task.state === "done").length
  if (phase.barrier.kind === "quorum") return done >= phase.barrier.quorum
  if (phase.barrier.kind === "best-effort") return tasks.length > 0 && tasks.every(taskTerminal)
  if (phase.barrier.kind === "condition" && !["true", "all", "completed"].includes(phase.barrier.expression.trim().toLowerCase())) return false
  return tasks.length > 0 && done === tasks.length
}

export function phaseReady(run: WorkflowRun, task: WorkflowTask): boolean {
  if (task.mapParentId && !run.tasks.some((parent) => parent.id === task.mapParentId && parent.state === "running" && parent.expanded) || task.mapRetired) return false
  const phases = run.plan.phases
  if (!phases) return true
  const index = phases.findIndex((phase) => phase.tasks.includes(task.mapParentId ?? task.id))
  return index >= 0 && phases.slice(0, index).every((phase) => barrierSatisfied(run, phase))
}

/**
 * The specs of a script run's tasks. They are created while the script runs, so they live in the run's journal; this is the
 * in-memory view of them, filled as tasks are created and (after a restart) on first use through the engine's loader.
 */
const scriptSpecs = new Map<string, Map<string, WorkflowTaskSpec>>()
const scriptSpecLoaders = new Set<(workflowId: string, taskId: string) => WorkflowTaskSpec | undefined>()
export const scriptSpecRegistry = {
  set(workflowId: string, spec: WorkflowTaskSpec) {
    let specs = scriptSpecs.get(workflowId)
    if (!specs) scriptSpecs.set(workflowId, (specs = new Map()))
    specs.set(spec.id, spec)
  },
  get(workflowId: string, taskId: string): WorkflowTaskSpec | undefined {
    const known = scriptSpecs.get(workflowId)?.get(taskId)
    if (known) return known
    for (const load of scriptSpecLoaders) {
      const spec = load(workflowId, taskId)
      if (spec) {
        scriptSpecRegistry.set(workflowId, spec)
        return spec
      }
    }
    return undefined
  },
  clear(workflowId: string) {
    scriptSpecs.delete(workflowId)
  },
  addLoader(load: (workflowId: string, taskId: string) => WorkflowTaskSpec | undefined) {
    scriptSpecLoaders.add(load)
    return () => void scriptSpecLoaders.delete(load)
  },
}

export function taskSpec(run: WorkflowRun, taskId: string): WorkflowTaskSpec | undefined {
  const declared = run.plan.tasks.find((spec) => spec.id === taskId)
  if (declared) return declared
  if (run.plan.script) return scriptSpecRegistry.get(run.workflowId, taskId)
  const task = run.tasks.find((task) => task.id === taskId)
  const parent = run.plan.tasks.find((spec) => spec.id === task?.mapParentId)
  if (parent?.kind !== "map" || task?.mapIndex === undefined) return undefined
  return { ...parent.map.taskTemplate, kind: "agent", id: taskId, title: task.title, needs: [...parent.needs], ...(parent.workspace && !parent.map.taskTemplate.workspace ? { workspace: parent.workspace } : {}) }
}

export function selectOutput(run: WorkflowRun, selector: WorkflowArtifactSelector): unknown {
  const producer = run.tasks.find((task) => task.id === selector.taskId)
  if (producer?.state !== "done" || !producer.output) {
    if (selector.required === false) return undefined
    throw new Error(`missing output from ${selector.taskId}`)
  }
  let value: unknown = outputValue(producer.output)
  for (const selection of [selector.path, selector.projection]) {
    if (!selection || selection === "$") continue
    const parts = selection.startsWith("/") ? selection.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")) : selection.replace(/^\$\.?/, "").split(".")
    for (const part of parts) {
      if (["__proto__", "prototype", "constructor"].includes(part)) throw new Error("unsafe output selector")
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
        if (selector.required === false) return undefined
        throw new Error(`output ${selector.taskId} has no ${selection}`)
      }
      value = (value as Record<string, unknown>)[part]
    }
  }
  return value
}

export function outputValue(output: NonNullable<WorkflowTask["output"]>): unknown {
  if (output.kind === "text") return output.value
  try { return JSON.parse(output.value) }
  catch {
    if (output.kind === "artifact") return output.value
    throw new Error("stored output is not valid JSON")
  }
}

export function compositionProblems(plan: WorkflowRun["plan"]): string[] {
  const problems: string[] = []
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]))
  const phaseOf = new Map<string, number>()
  const phaseIds = new Set<string>()
  for (const [index, phase] of (plan.phases ?? []).entries()) {
    if (phaseIds.has(phase.id)) problems.push(`duplicate phase "${phase.id}"`)
    phaseIds.add(phase.id)
    if (phase.barrier.kind === "quorum" && phase.barrier.quorum > phase.tasks.length) problems.push(`phase "${phase.id}": quorum exceeds task count`)
    if (phase.barrier.kind === "condition" && !["true", "all", "completed", "false"].includes(phase.barrier.expression.toLowerCase())) problems.push(`phase "${phase.id}": unsupported condition (use true, all, completed or false)`)
    for (const id of phase.tasks) {
      if (!tasks.has(id)) problems.push(`phase "${phase.id}": unknown task "${id}"`)
      if (phaseOf.has(id)) problems.push(`task "${id}" occurs in more than one phase`)
      phaseOf.set(id, index)
    }
  }
  const dependsOn = (id: string, producer: string, visited = new Set<string>()): boolean => {
    if (visited.has(id)) return false
    visited.add(id)
    return (tasks.get(id)?.needs ?? []).some((need) => need === producer || dependsOn(need, producer, visited))
  }
  let expanded = plan.tasks.length
  for (const task of plan.tasks) {
    if (plan.phases && !phaseOf.has(task.id)) problems.push(`task "${task.id}" is not assigned to a phase`)
    for (const need of task.needs) if ((phaseOf.get(need) ?? 0) > (phaseOf.get(task.id) ?? 0)) problems.push(`task "${task.id}" depends on later phase task "${need}"`)
    const agent = task.kind === "map" ? task.map.taskTemplate : task.kind === "agent" ? task : undefined
    const selectors = [...(agent?.inputs ?? []), ...(task.kind === "map" ? [task.map.source] : [])]
    for (const selector of selectors) {
      if (!tasks.has(selector.taskId)) problems.push(`task "${task.id}": unknown output producer "${selector.taskId}"`)
      else if (!dependsOn(task.id, selector.taskId)) problems.push(`task "${task.id}": output producer "${selector.taskId}" must be a dependency`)
      if ([selector.path, selector.projection].some((path) => path?.split(/[./]/).some((part) => ["__proto__", "prototype", "constructor"].includes(part)))) problems.push(`task "${task.id}": unsafe output selector`)
    }
    if (task.kind === "map") {
      expanded += task.map.maxItems
      if (task.id.length > 35) problems.push(`map task "${task.id}": id must leave room for child suffixes (35 characters)`)
      for (let index = 0; index < task.map.maxItems; index++) if (tasks.has(`${task.id}-${index + 1}`)) problems.push(`map task "${task.id}": child id collides with "${task.id}-${index + 1}"`)
    }
  }
  if (expanded > 32) problems.push(`bounded map expansion reserves ${expanded} tasks; the limit is 32`)
  if (plan.overlapKey && !plan.overlapPolicy) problems.push("overlapKey requires an explicit overlapPolicy")
  if (plan.overlapPolicy === "replace" && (plan.permissions?.mode === "report-only" || plan.workspace?.mode === "read-only" || !plan.tasks.some((task) => task.kind === "check") && agentSpecs(plan).every((task) => task.mode === "read"))) problems.push("read-only workflows cannot replace other runs")
  if (plan.phases || plan.tasks.some((task) => task.kind === "map" || task.kind === "agent" && task.output)) {
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 48 * 1024) problems.push("composed plan exceeds 48 KiB")
  }
  return problems
}

export function expandedTasks(run: WorkflowRun, task: WorkflowTask): WorkflowTask[] {
  const spec = taskSpec(run, task.id)
  if (spec?.kind !== "map") throw new Error("not a map task")
  const items = selectOutput(run, spec.map.source)
  if (!Array.isArray(items)) throw new Error(`map ${task.id}: source must be a JSON array`)
  if (items.length > spec.map.maxItems) throw new Error(`map ${task.id}: ${items.length} items exceed maxItems ${spec.map.maxItems}`)
  const previous = run.tasks.filter((child) => child.mapParentId === task.id)
  if (run.tasks.length + Math.max(0, items.length - previous.length) > 32) throw new Error("map expansion exceeds 32 tasks")
  const children = items.map((item, index): WorkflowTask => {
    const old = previous.find((child) => child.mapIndex === index)
    return {
      id: `${task.id}-${index + 1}`, title: `${spec.map.taskTemplate.title} ${index + 1}`.slice(0, 80), kind: "agent", mode: spec.map.taskTemplate.mode,
      needs: [...spec.needs], state: "pending", attempt: old?.attempt ?? 0, mapParentId: task.id, mapIndex: index, mapItem: JSON.stringify(item),
      ...(old?.usage ? { usage: old.usage } : {}), ...(old?.execution ? { execution: old.execution } : {}), ...(old?.sessionId ? { sessionId: old.sessionId } : {}),
      ...(task.phaseId ? { phaseId: task.phaseId } : {}),
    }
  })
  if (children.some((child) => child.mapItem!.length > 8_000)) throw new Error("map item exceeds 8000 characters")
  if (compositionBytes([...run.tasks.filter((child) => child.mapParentId !== task.id), ...children]) > 24 * 1024) throw new Error("workflow output/item storage exceeds 24 KiB")
  return children
}

export function compositionBytes(tasks: WorkflowTask[]): number {
  return new TextEncoder().encode(JSON.stringify(tasks.map((task) => [task.output?.value ?? "", task.mapItem ?? ""]))).byteLength
}

export function agentSpecs(plan: WorkflowRun["plan"]): WorkflowAgentTaskSpec[] {
  return plan.tasks.flatMap((task) => task.kind === "agent" ? [task] : task.kind === "map" ? [{ ...task.map.taskTemplate, kind: "agent" as const, id: task.id, needs: task.needs, ...(task.workspace && !task.map.taskTemplate.workspace ? { workspace: task.workspace } : {}) }] : [])
}
