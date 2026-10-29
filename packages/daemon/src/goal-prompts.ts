import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { ExtensionLayer } from "@mendcode/packages"
import type { Goal } from "@mendcode/protocol"
import continuation from "../prompts/goals/continuation.md" with { type: "file" }
import budget_limit from "../prompts/goals/budget_limit.md" with { type: "file" }
import objective_updated from "../prompts/goals/objective_updated.md" with { type: "file" }

/** The steering messages a goal sends the agent (prompts/goals/*.md). */
export const GOAL_PROMPTS = ["continuation", "budget_limit", "objective_updated"] as const
export type GoalPromptKind = (typeof GOAL_PROMPTS)[number]

/** A template file bigger than this is ignored: it would swamp the context it is meant to steer. */
export const MAX_GOAL_PROMPT_BYTES = 64 * 1024

const PACKAGED = { continuation, budget_limit, objective_updated }

/** The objective as data inside `<objective>`: `<`, `>` and `&` escaped so it can never close the tag or fake another. */
export function escapeObjective(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** The values a template may use, as `{{name}}`. */
export function goalPromptValues(goal: Goal): Record<string, string> {
  return {
    objective: escapeObjective(goal.objective),
    time_used_seconds: String(goal.timeUsedSeconds),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
    remaining_tokens: goal.tokenBudget === undefined ? "unlimited" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
  }
}

/** Fills `{{name}}` placeholders in one pass (a value that contains `{{x}}` is not filled again); unknown names stay as written. */
export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole)
}

type Cached = { signature: string; text: string }

/**
 * The goal templates: the packaged ones, overridable like the other prompts by `goals/<kind>.md` in an extension layer
 * (the last layer that has the file wins, so the project's own folder beats its packages, which beat the user's folder).
 * Reads are cached by mtime and size.
 */
export function createGoalPrompts(input: { layersFor(directory: string): ExtensionLayer[]; enabled?: boolean; packagedDir?: string }) {
  const cache = new Map<string, Cached>()

  function read(file: string): string | undefined {
    const info = statSync(file, { throwIfNoEntry: false })
    if (!info?.isFile() || info.size > MAX_GOAL_PROMPT_BYTES) return undefined
    const signature = `${info.mtimeMs}:${info.size}`
    const cached = cache.get(file)
    if (cached?.signature === signature) return cached.text
    try {
      const text = readFileSync(file, "utf8").trim()
      if (!text) return undefined
      cache.set(file, { signature, text })
      return text
    } catch {
      return undefined
    }
  }

  function templateFor(kind: GoalPromptKind, directory: string): string {
    if (input.enabled !== false) {
      for (const layer of [...input.layersFor(directory)].reverse()) {
        const text = read(path.join(layer.dir, "goals", `${kind}.md`))
        if (text) return text
      }
    }
    const packaged = read(input.packagedDir ? path.join(input.packagedDir, `${kind}.md`) : PACKAGED[kind])
    if (!packaged) throw new Error(`[GOALS]: the packaged ${kind} template is missing from ${input.packagedDir ?? PACKAGED[kind]}`)
    return packaged
  }

  return {
    /** The steering text for `goal` as a session in `directory` sends it. */
    render(kind: GoalPromptKind, { directory, goal }: { directory: string; goal: Goal }): string {
      return fillTemplate(templateFor(kind, directory), goalPromptValues(goal))
    },
  }
}
export type GoalPrompts = ReturnType<typeof createGoalPrompts>
