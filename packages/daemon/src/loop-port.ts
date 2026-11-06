import { isAbsolute } from "node:path"
import type { CreateLoopInput, LoopService } from "@mendcode/loops"
import { createProblems, resolveCreateInput } from "../../loops/src/inputs"
import { describeTrigger, parseTrigger } from "../../loops/src/schedule"
import { checkProblems } from "../../loops/src/checks"
import type { Loop, LoopBudget, SessionId } from "@mendcode/protocol"
import type { LoopCreateInput, LoopPort } from "@mendcode/tools"

const MAX_LISTED = 20

function describeBudget(budget: LoopBudget) {
  return budget.mode === "goal" ? `until the goal is verified${budget.maxRuns ? ` (safety cap ${budget.maxRuns} runs)` : ""}` : budget.mode === "fixed" ? `${budget.maxRuns} runs` : "until stopped"
}

/** One line per loop for the `loop` tool's listing. */
function describeLoop(loop: Loop) {
  const next = loop.nextWakeAt !== undefined ? ` next ${new Date(loop.nextWakeAt).toISOString()}` : ""
  return `loopId=${loop.loopId} name=${JSON.stringify(loop.name)} state=${loop.state} ${describeTrigger(loop.trigger)} runs=${loop.runs}${next}${loop.reportOnly ? " report-only" : ""}${loop.workspace === "worktree" ? " worktree" : ""}`
}

/**
 * The `loop` tool's request as a service input: the trigger text is parsed, the budget assembled, and loops the agent
 * creates are report-only unless it says otherwise. Problems are listed in words the agent can act on.
 */
export function toCreateInput(directory: string, input: LoopCreateInput): { ok: true; input: CreateLoopInput } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const trigger = input.trigger !== undefined ? parseTrigger(input.trigger) : undefined
  if (input.trigger !== undefined && !trigger) problems.push(`unknown trigger "${input.trigger}" (use "every 30m", "daily 09:00 Europe/Madrid", "adaptive 30m", "external" or "manual")`)
  let budget: LoopBudget | undefined
  const mode = input.mode ?? (input.template ? undefined : "goal")
  if (mode === "fixed") {
    if (input.maxRuns === undefined) problems.push("a fixed loop needs maxRuns")
    else budget = { mode: "fixed", maxRuns: input.maxRuns }
  } else if (mode === "goal") budget = { mode: "goal", ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}) }
  else if (mode === "monitor") budget = { mode: "monitor" }
  const checks = input.checks ?? []
  problems.push(...checkProblems(checks))
  const built: CreateLoopInput = {
    name: input.name,
    ...(input.costBudget ? { costBudget: input.costBudget } : {}),
    ...(input.rubric ? { rubric: input.rubric } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    directory,
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(trigger ? { trigger } : {}),
    ...(budget ? { budget } : {}),
    ...(input.criteria ? { criteria: input.criteria } : {}),
    ...(checks.length ? { checks } : {}),
    reportOnly: input.reportOnly ?? true,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.runNow ? { runNow: true } : {}),
    ...(input.reads?.length ? { reads: input.reads } : {}),
    ...(input.notify ? { notify: input.notify } : {}),
  }
  const relative = input.reads?.find((path) => !isAbsolute(path))
  if (relative) problems.push(`reads must be absolute paths (got "${relative}")`)
  const problem = createProblems(built)
  if (problem) problems.push(problem)
  return problems.length ? { ok: false, problems } : { ok: true, input: built }
}

/** The approval text for a loop about to be created. */
function previewText(input: CreateLoopInput): string {
  const resolved = resolveCreateInput(input)
  return [
    `Loop "${input.name}" in ${input.directory}`,
    `Runs ${describeTrigger(resolved.trigger)}, ${describeBudget(resolved.budget)}${input.runNow ? ", first run now" : ""}.`,
    resolved.reportOnly ? "Each run may only read and report; it cannot edit files or run commands." : `Each run can edit files and run commands${input.workspace === "worktree" ? ", in its own git worktree" : " in the project"} (asking per the loop session's permission mode).`,
    ...(resolved.criteria ? [`Done when: ${resolved.criteria}`] : []),
    ...(input.costBudget ? [`Usage caps: ${JSON.stringify(input.costBudget)}`] : []),
    ...(input.rubric ? [`Runtime rubric: ${JSON.stringify(input.rubric)}`] : []),
    ...(input.approvalPolicy ? [`Approval required: ${input.approvalPolicy.requireApprovalFor.join(", ")}`] : []),
    ...(input.checks?.length ? [`Host checks: ${input.checks.join("; ")}`] : []),
    ...(input.reads?.length ? [`Reads outside the project (approved with this loop): ${input.reads.join(", ")}`] : []),
    input.notify === "none" ? "No notice is left in this session after a run." : "Each run leaves a short notice in this session.",
    "The loop inherits this session's permission mode (never more) and reads what this session could read without asking.",
    "",
    `Objective:\n${resolved.objective.slice(0, 600)}${resolved.objective.length > 600 ? "…" : ""}`,
  ].join("\n")
}

/**
 * The loop tool's port for one session's project: it creates through the same checks as `loop.create`, lists the
 * project's loops and pauses one of them. Nothing else (resume, stop, delete, accept) is reachable from the agent.
 */
export function createLoopPort(input: { directory: string; /** The session whose agent calls the tool: it becomes the loop's creator. */ sessionId?: SessionId; service: Pick<LoopService, "list" | "get" | "pause">; create(input: CreateLoopInput): Promise<{ ok: true; loop: Loop } | { ok: false; message: string }> }): LoopPort {
  const { directory, service } = input
  return {
    async preview(request) {
      const built = toCreateInput(directory, request)
      return built.ok ? { problems: [], detail: previewText(built.input) } : { problems: built.problems }
    },
    async create(request) {
      const built = toCreateInput(directory, request)
      if (!built.ok) return { ok: false, message: built.problems.join("; ") }
      const created = await input.create({ ...built.input, ...(input.sessionId ? { creatorSessionId: input.sessionId } : {}) })
      if (!created.ok) return created
      const { loop } = created
      return { ok: true, loopId: loop.loopId, text: `Loop "${loop.name}" created (${loop.loopId}), ${describeTrigger(loop.trigger)}. The user follows it in /loops; do not poll it.` }
    },
    list() {
      const loops = service.list(directory)
      if (loops.length === 0) return "No loops in this project."
      return [...loops.slice(0, MAX_LISTED).map(describeLoop), ...(loops.length > MAX_LISTED ? [`… and ${loops.length - MAX_LISTED} more`] : [])].join("\n")
    },
    pause(loopId) {
      const loop = service.get(loopId as Loop["loopId"])
      if (!loop || loop.directory !== directory) return { ok: false, message: "no such loop in this project" }
      const paused = service.pause(loop.loopId)
      return paused?.state === "paused" ? { ok: true, text: `Loop "${loop.name}" paused; the user can resume it in /loops.` } : { ok: false, message: `the loop is ${paused?.state ?? loop.state}; only an idle, blocked or verifying loop can be paused` }
    },
  }
}
