import { WORKFLOW_SCRIPT_MAX_BYTES, WorkflowDefinition, WorkflowDefinitionId, WorkflowSlug, WorkflowStaticPlanInput } from "@mendcode/protocol"
import { defineTool, fail } from "@mendcode/tools"
import { z } from "zod"

/**
 * The model proposes a workflow through ordinary tools (§3.7): `workflow_start` asks for approval unless the session
 * is in full mode, and its approval lists every check command verbatim; `workflow_status` only reads.
 */
export const workflowStartTool = defineTool({
  name: "workflow_start",
  description: [
    "Start a workflow: several agent tasks (each in its own session) and host checks, run in dependency order, then verified against a completion contract.",
    "Use it for work that splits into independent or ordered pieces; do simple work yourself.",
    "Declare a contract unless the work is read-only research. Anything that needs running (tests, typecheck, build) goes in contract.checks with `covers` naming the criteria it proves; the auditor can only read.",
    "Keep every task prompt self-contained: the task agent sees only the objective, its prompt and the results of the tasks it needs.",
    "Task mode read = cannot change anything; work = edits (one work task at a time per directory).",
    "A human task (kind human) waits for the user to approve or reject it in /workflows: use it for approval gates, never to ask the user something you could decide. You cannot answer it yourself.",
    "retry on an agent or check task starts a failed attempt again (maxAttempts counts the first start; retryOn lists failure classes, default transient and environment). retention bounds the evidence ledger.",
    "After it starts, do not poll: tell the user it runs in /workflows. workflow_status reads it when asked; workflow_events and workflow_artifacts read its recorded history and task outputs.",
  ].join(" "),
  permission: "execute",
  args: WorkflowStaticPlanInput,
  async preview(plan, context) {
    if (!context.workflows) return undefined
    const checked = await context.workflows.preview(plan).catch(() => undefined)
    if (!checked) return undefined
    return checked.problems.length ? `Problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}` : checked.detail
  },
  async execute(plan, context) {
    if (!context.workflows) return fail({ title: "workflow_start", message: "workflows are not available here" })
    const started = await context.workflows.start(plan)
    if (!started.ok) return fail({ title: "workflow", message: started.message })
    return {
      output: `Workflow "${started.name}" started (${started.workflowId}) with ${started.tasks} tasks. It runs on its own; the user follows it in /workflows. Do not poll it.`,
      truncated: false,
      title: `◇ Workflow ${started.name} · ${started.tasks} tasks · started — /workflows`,
      isError: false,
      meta: { workflowId: started.workflowId, tasks: started.tasks },
    }
  },
})

/**
 * Script workflows (a second kind of plan on the same engine). Not a primary tool: its schema reaches the model only after
 * `tool_search` finds it, so it costs no context until it is used. Every call that starts a script asks the user, showing the
 * meta, the declared caps, the source hash and the source, in every permission mode.
 */
export const workflowScriptTool = defineTool({
  name: "workflow_script",
  description: [
    "Start a dynamic script workflow: a JavaScript program that orchestrates sub-agents deterministically with agent(), parallel(), pipeline(), check() and ask(), with hard budget caps and a journal that resumes after a restart.",
    "Use it when the fan-out depends on earlier results (review each finding, migrate each directory, research then synthesize) or needs loops and branching that a fixed workflow_start plan cannot express.",
    "Call with help true first for the exact API. Pass script (the source, starting with a literal export const meta) or name (a saved workflows/<name>.js). The user approves every script you write.",
    "After it starts, do not poll: tell the user it runs in /workflows.",
  ].join(" "),
  permission: "execute",
  tier: "balanced",
  args: z.strictObject({
    help: z.boolean().optional().describe("Return the API reference instead of starting anything"),
    script: z.string().min(1).max(WORKFLOW_SCRIPT_MAX_BYTES).optional().describe("The script source"),
    name: WorkflowSlug.optional().describe("A saved script, workflows/<name>.js"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments the script reads as `args`"),
  }).refine((value) => value.help === true || (value.script !== undefined) !== (value.name !== undefined), { message: "give exactly one of script or name (or help true)" }),
  permissionFor: (args) => (args.help === true ? "read" : "execute"),
  approvalFor: (args) => args.help !== true,
  async preview(args, context) {
    if (args.help === true || !context.workflows) return undefined
    const checked = await context.workflows.preview(scriptInput(args)).catch(() => undefined)
    if (!checked) return undefined
    return checked.problems.length ? `Problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}` : checked.detail
  },
  async execute(args, context) {
    if (args.help === true) {
      const { SCRIPT_API_HELP } = await import("@mendcode/workflows")
      return { output: SCRIPT_API_HELP, truncated: false, title: "workflow_script help", isError: false }
    }
    if (!context.workflows) return fail({ title: "workflow_script", message: "workflows are not available here" })
    const started = await context.workflows.start(scriptInput(args))
    if (!started.ok) return fail({ title: "workflow_script", message: started.message })
    return {
      output: `Script workflow "${started.name}" started (${started.workflowId}). It runs on its own; the user follows it in /workflows and can raise its caps there. Do not poll it.`,
      truncated: false,
      title: `◇ Script workflow ${started.name} · started — /workflows`,
      isError: false,
      meta: { workflowId: started.workflowId },
    }
  },
})

const scriptInput = (args: { script?: string | undefined; name?: string | undefined; args?: Record<string, unknown> | undefined }) =>
  args.script !== undefined ? { script: args.script, ...(args.args ? { args: args.args } : {}) } : { scriptRef: args.name!, ...(args.args ? { args: args.args } : {}) }

export const workflowSaveTool = defineTool({
  name: "workflow_save",
  description: "Save a v2 workflow plan and its resolved contract as an immutable revision without running it. Supply definitionId to revise an existing definition; start a saved revision through workflow_start with { revisionId } or { definitionId }.",
  permission: "write",
  args: z.strictObject({ plan: WorkflowStaticPlanInput, definitionId: WorkflowDefinitionId.optional(), name: WorkflowDefinition.shape.name.optional(), description: WorkflowDefinition.shape.description.optional(), source: WorkflowDefinition.shape.source.optional() }),
  async execute({ plan, ...extra }, context) {
    if (!context.workflows?.save) return fail({ title: "workflow_save", message: "workflow saving is not available here" })
    const saved = await context.workflows.save(plan, extra)
    if (!saved.ok) return fail({ title: "workflow_save", message: saved.message })
    const r = saved.receipt
    return { output: `definition_id: ${r.definitionId}\nrevision_id: ${r.revisionId}\nrevision: ${r.revision}\nplan_hash: ${r.planHash}\ntasks: ${r.plan.tasks.length}\nsaved: true`, title: `Saved workflow revision #${r.revision}`, isError: false, truncated: false, meta: { definitionId: r.definitionId, revisionId: r.revisionId, revision: r.revision } }
  },
})

export const workflowControlTool = defineTool({
  name: "workflow_control",
  description: "Pause, resume, stop, delete a finished workflow, or retry a failed/input-waiting task in this project. Resume and retry can execute tasks and checks; use only when requested. Read events and artifacts with workflow_events and workflow_artifacts.",
  permission: "execute",
  args: z.strictObject({ workflowId: z.string(), action: z.enum(["pause", "resume", "stop", "retry", "delete"]), taskId: WorkflowSlug.optional(), reason: z.string().min(1).max(500).optional() }).refine((v) => v.action !== "retry" || !!v.taskId, { message: "retry needs taskId" }),
  async preview({ workflowId, action }, context) {
    if ((action === "resume" || action === "retry") && context.workflows?.previewControl) return context.workflows.previewControl(workflowId)
    return context.workflows?.status(workflowId)
  },
  async execute({ workflowId, action, ...extra }, context) {
    if (!context.workflows?.control) return fail({ title: "workflow_control", message: "workflow controls are not available here" })
    const result = await context.workflows.control(workflowId, action, extra)
    return result.ok ? { output: result.output, title: `Workflow ${action}`, isError: false, truncated: false } : fail({ title: `workflow ${action}`, message: result.message })
  },
})

const ledgerArgs = z.strictObject({
  workflowId: z.string().describe("A workflow id from workflow_start or workflow_status"),
  limit: z.number().int().min(1).max(50).optional().describe("Entries per page, newest first (default 20)"),
  before: z.number().int().positive().optional().describe("Sequence cursor: only entries older than this (the previous page's next_before)"),
})

function ledgerTool(kind: "events" | "artifacts", description: string) {
  const name = `workflow_${kind}`
  return defineTool({
    name,
    description,
    permission: "read",
    args: ledgerArgs,
    async execute({ workflowId, ...query }, context) {
      if (!context.workflows?.ledger) return fail({ title: name, message: "workflow history is not available here" })
      return { output: await context.workflows.ledger(workflowId, kind, query), truncated: false, title: `${name} ${workflowId}`, isError: false }
    },
  })
}

export const workflowEventsTool = ledgerTool("events", "Read the recorded events of one workflow in this project (state changes of the run and its tasks, permission changes), newest first, bounded and redacted. Pages with `before`. Read only.")
export const workflowArtifactsTool = ledgerTool("artifacts", "Read the recorded artifacts of one workflow in this project (frozen plan, task specs, task results and outputs, verification rounds, check gates, audit findings, user acceptance), newest first, bounded and redacted. Use it to read what finished tasks produced instead of asking the user. Pages with `before`. Read only.")

export const workflowStatusTool = defineTool({
  name: "workflow_status",
  description: "State of one workflow (by id) or of this project's recent workflows: tasks, verification, what waits for the user. Read only.",
  permission: "read",
  args: z.object({ workflowId: z.string().optional().describe("A workflow id from workflow_start; omit for this project's recent ones") }),
  async execute({ workflowId }, context) {
    if (!context.workflows) return fail({ title: "workflow_status", message: "workflows are not available here" })
    return { output: await context.workflows.status(workflowId), truncated: false, title: workflowId ? `workflow ${workflowId}` : "workflows", isError: false }
  },
})
