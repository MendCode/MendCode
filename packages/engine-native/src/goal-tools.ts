import type { Goal } from "@mendcode/protocol"
import type { ToolResult } from "@mendcode/tools"
import { z } from "zod"

/**
 * What the goal tools may do for one session (docs/goals.md): read its goal, create one when the user asked for it, and
 * mark the goal complete, blocked or paused. They cannot resume a goal, change its budget or limit it: those stay with
 * the user and the daemon. The daemon implements this per session; the engine only calls it.
 */
export type GoalPort = {
  get(): Goal | undefined
  create(input: { objective: string; tokenBudget?: number | undefined }): { ok: true; goal: Goal } | { ok: false; message: string }
  update(input: { status: "complete" | "blocked" | "paused"; note?: string | undefined }): { ok: true; goal: Goal } | { ok: false; message: string }
}

export const GET_GOAL_TOOL = {
  name: "get_goal",
  description: "Get the current goal of this session: its objective, status, token budget, tokens and time used, and the tokens remaining. Takes no arguments.",
  args: z.object({}),
}

export const CREATE_GOAL_TOOL = {
  name: "create_goal",
  description:
    "Create a goal only when explicitly requested by the user or by system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal already exists.",
  args: z.object({
    objective: z.string().min(1).max(8_000).describe("The objective to work on, exactly as the user stated it"),
    token_budget: z.number().int().min(1).optional().describe("Token budget, only when the user asked for one"),
  }),
}

export const UPDATE_GOAL_TOOL = {
  name: "update_goal",
  description: [
    "Update the existing goal. Use it only to mark the goal complete, blocked or paused.",
    "Set status `complete` only when the objective has actually been achieved and no required work remains. Do not mark a goal complete because its budget is nearly used or because you are stopping work.",
    "Set status `blocked` only after the same blocking condition has recurred for at least 3 consecutive goal turns and you need the user to change something (a missing credential, an unavailable service, a decision only they can make). A resumed goal starts a fresh audit.",
    "Set status `paused` only when the user explicitly asks you to pause the goal.",
    "You cannot use this tool to resume a goal, change its budget, or mark it budget-limited or usage-limited: those are controlled by the user and the system.",
    "When you mark a goal with a token budget complete, report the final token usage from the result to the user.",
  ].join(" "),
  args: z.object({
    status: z.enum(["complete", "blocked", "paused"]).describe("The new status"),
    note: z.string().max(1_000).optional().describe("One or two sentences: what was achieved, or what blocks the goal and what the user must change"),
  }),
}

/** The goal tools' names: the engine offers them to the main agent only, and an agent's tool list never hides them. */
export const GOAL_TOOL_NAMES: ReadonlySet<string> = new Set([GET_GOAL_TOOL.name, CREATE_GOAL_TOOL.name, UPDATE_GOAL_TOOL.name])
export const GOAL_TOOLS = [GET_GOAL_TOOL, CREATE_GOAL_TOOL, UPDATE_GOAL_TOOL] as const

function facts(goal: Goal) {
  const remaining = goal.tokenBudget !== undefined ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : undefined
  return {
    status: goal.status,
    objective: goal.objective,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    remainingTokens: remaining ?? null,
    timeUsedSeconds: goal.timeUsedSeconds,
    ...(goal.note ? { note: goal.note } : {}),
  }
}

const done = (title: string, payload: unknown): ToolResult => ({ output: JSON.stringify(payload, null, 2), truncated: false, title, isError: false })
const fail = (title: string, message: string): ToolResult => ({ output: message, truncated: false, title, isError: true })

/** Runs one goal tool against the session's port; the arguments were already validated against the tool's schema. */
export function runGoalTool(port: GoalPort, name: string, args: unknown): ToolResult {
  if (name === GET_GOAL_TOOL.name) {
    const goal = port.get()
    return goal ? done("get_goal", { goal: facts(goal) }) : done("get_goal", { goal: null })
  }
  if (name === CREATE_GOAL_TOOL.name) {
    const input = args as z.infer<typeof CREATE_GOAL_TOOL.args>
    const created = port.create({ objective: input.objective, tokenBudget: input.token_budget })
    return created.ok ? done("goal created", { goal: facts(created.goal) }) : fail("create_goal", created.message)
  }
  const input = args as z.infer<typeof UPDATE_GOAL_TOOL.args>
  const updated = port.update({ status: input.status, note: input.note })
  if (!updated.ok) return fail("update_goal", updated.message)
  const { goal } = updated
  const usage = goal.tokenBudget !== undefined ? ` Report the final token usage to the user: ${goal.tokensUsed} of ${goal.tokenBudget} tokens used.` : ""
  const message = goal.status === "complete" ? `Goal marked complete.${usage}` : goal.status === "blocked" ? "Goal marked blocked. Tell the user what blocks it and what they must change; continuation stops until they resume it." : "Goal paused."
  return done(`goal ${goal.status}`, { goal: facts(goal), message })
}
