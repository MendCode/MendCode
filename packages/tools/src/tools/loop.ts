import { LoopCostBudget, LoopRubric, LoopApprovalPolicy } from "@mendcode/protocol"
import { z } from "zod"
import { defineTool, type LoopCreateInput } from "../tool"
import { fail } from "../util"

/**
 * `loop`: lets the agent set up recurring work for the user (a loop: a goal or monitor that wakes on a schedule, runs in
 * its own session and reports). Creating one asks for approval and shows the schedule and what a run may do. The agent can
 * list the project's loops and pause one; resuming, stopping and deleting stay with the user.
 */
export const loopTool = defineTool({
  name: "loop",
  description: [
    "Set up recurring or long-running work as a loop the user can follow in /loops, or list and pause this project's loops.",
    "action create: give a name and an objective (or a template: pr-watch, ci-repair, research-digest, repo-maintenance) and a trigger:",
    '"every 30m", "daily 09:00" (add an IANA zone like "daily 09:00 Europe/Madrid"), "adaptive 30m" (backs off when runs find nothing, speeds up when they act), "external" (fired from outside) or "manual".',
    "mode goal stops when the goal is verified (give criteria, and checks the host can run); monitor repeats until stopped; fixed runs maxRuns times.",
    "Loops you create are report-only by default (runs read and report, never edit); set reportOnly false only when the user asked for edits, and workspace worktree to keep those edits off the user's checkout.",
    "The user approves every new loop. Do not create a loop for work you can do now.",
  ].join(" "),
  permission: "write",
  args: z.object({
    action: z.enum(["create", "list", "pause"]).describe("create a loop, list this project's loops, or pause one"),
    name: z.string().min(1).max(120).optional().describe("create: a short name"),
    objective: z.string().min(1).max(8_000).optional().describe("create: what every run should do (with a template: extra detail)"),
    template: z.string().min(1).max(40).optional().describe("create: a template id that fills objective, trigger and budget"),
    trigger: z.string().min(1).max(80).optional().describe('create: "every 30m", "daily 09:00 Europe/Madrid", "adaptive 30m", "external" or "manual"'),
    mode: z.enum(["goal", "monitor", "fixed"]).optional().describe("create: how it finishes (default: the template's, else goal)"),
    maxRuns: z.number().int().min(1).max(1_000).optional().describe("create: run cap (required for fixed; a safety cap for goal)"),
    criteria: z.string().min(1).max(4_000).optional().describe("create, goal: what must be true to finish"),
    checks: z.array(z.string().min(1).max(300)).max(5).optional().describe("create, goal: plain commands the host runs to verify completion (no pipes, redirection or chaining)"),
    reportOnly: z.boolean().optional().describe("create: runs may only read and report (default true)"),
    workspace: z.enum(["in-place", "worktree"]).optional().describe("create: worktree runs each wakeup in its own git worktree"),
    runNow: z.boolean().optional().describe("create: start the first run immediately"),
    costBudget: LoopCostBudget.optional().describe("create: opt-in total token/API USD caps; unknown USD blocks by default"),
    rubric: LoopRubric.optional().describe("create, goal: weighted runtime evidence criteria and mandatory blockers"),
    approvalPolicy: LoopApprovalPolicy.optional().describe("create: actions that need user approval; the agent cannot waive or approve gates"),
    loopId: z.string().min(1).max(64).optional().describe("pause: the loop id from list"),
  }),
  async preview(args, context) {
    if (args.action === "list") return "List this project's loops."
    if (args.action === "pause") return `Pause loop ${args.loopId ?? "(no id)"}.`
    if (!context.loops || !args.name) return undefined
    const checked = await context.loops.preview(createInput(args, args.name)).catch(() => undefined)
    if (!checked) return undefined
    return checked.problems.length ? `Problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}` : checked.detail
  },
  async execute(args, context) {
    const title = `loop ${args.action}`
    if (!context.loops) return fail({ title, message: "loops are not available here" })
    if (args.action === "list") return { output: context.loops.list(), truncated: false, title: "loops", isError: false }
    if (args.action === "pause") {
      if (!args.loopId) return fail({ title, message: "pause needs a loopId (from action list)" })
      const paused = context.loops.pause(args.loopId)
      if (!paused.ok) return fail({ title: `pause ${args.loopId}`, message: paused.message })
      return { output: paused.text, truncated: false, title: `loop ${args.loopId} paused`, isError: false, meta: { loopId: args.loopId } }
    }
    if (!args.name) return fail({ title, message: "create needs a name" })
    const created = await context.loops.create(createInput(args, args.name))
    if (!created.ok) return fail({ title: `loop ${args.name}`, message: created.message })
    return { output: created.text, truncated: false, title: `Loop ${args.name} created — /loops`, isError: false, meta: { loopId: created.loopId } }
  },
})

function createInput(args: { objective?: string | undefined; template?: string | undefined; trigger?: string | undefined; mode?: LoopCreateInput["mode"]; maxRuns?: number | undefined; criteria?: string | undefined; checks?: string[] | undefined; reportOnly?: boolean | undefined; workspace?: LoopCreateInput["workspace"]; runNow?: boolean | undefined; costBudget?: LoopCreateInput["costBudget"]; rubric?: LoopCreateInput["rubric"]; approvalPolicy?: LoopCreateInput["approvalPolicy"] }, name: string): LoopCreateInput {
  return { name, objective: args.objective, template: args.template, trigger: args.trigger, mode: args.mode, maxRuns: args.maxRuns, criteria: args.criteria, checks: args.checks, reportOnly: args.reportOnly, workspace: args.workspace, runNow: args.runNow, costBudget: args.costBudget, rubric: args.rubric, approvalPolicy: args.approvalPolicy }
}
