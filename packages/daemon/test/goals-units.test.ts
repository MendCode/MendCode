import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Goal } from "@mendcode/protocol"
import { createIdFactory } from "@mendcode/protocol"
import { createGoalPrompts, escapeObjective, fillTemplate, goalPromptValues } from "../src/goal-prompts"
import { isUsageLimitFailure, parseGoalMarker } from "../src/goals-signals"

const ids = createIdFactory()
const goal = (patch: Partial<Goal> = {}): Goal => ({ goalId: ids("goal"), sessionId: ids("session"), objective: "ship the release", status: "active", tokensUsed: 120, timeUsedSeconds: 45, createdAt: 1, updatedAt: 1, ...patch })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-goal-prompts-"))
  dirs.push(dir)
  return dir
}

describe("goal marker", () => {
  test("the last line GOAL_STATUS: complete or blocked - why is read; anything else is not", () => {
    expect(parseGoalMarker("All requirements verified.\nGOAL_STATUS: complete")).toEqual({ status: "complete" })
    expect(parseGoalMarker("Stuck\nGOAL_STATUS: blocked - no network access\n\n")).toEqual({ status: "blocked", note: "no network access" })
    expect(parseGoalMarker("GOAL_STATUS: BLOCKED: waiting for a key")).toEqual({ status: "blocked", note: "waiting for a key" })
    expect(parseGoalMarker("GOAL_STATUS: complete\nbut then I kept talking")).toBeUndefined()
    expect(parseGoalMarker("I will write GOAL_STATUS: complete when done")).toBeUndefined()
    expect(parseGoalMarker("GOAL_STATUS: paused")).toBeUndefined()
    expect(parseGoalMarker("")).toBeUndefined()
    expect(parseGoalMarker(undefined)).toBeUndefined()
  })
})

describe("usage limit detection", () => {
  test("a quota failure is a usage limit; ordinary failures are not", () => {
    expect(isUsageLimitFailure("provider_error", "[ENGINE]: [PROVIDER]: openai 429 {\"error\":{\"code\":\"usage_limit_reached\"}}")).toBe(true)
    expect(isUsageLimitFailure("provider_error", "[ENGINE]: [PROVIDER]: openai 429 insufficient_quota")).toBe(true)
    expect(isUsageLimitFailure("x", "You've hit your usage limit. Resets at 5pm")).toBe(true)
    expect(isUsageLimitFailure("x", "Claude usage limit reached")).toBe(true)
    expect(isUsageLimitFailure("usage_limit", "anything")).toBe(true)
    expect(isUsageLimitFailure("provider_error", "[ENGINE]: [PROVIDER]: openai 500 internal error")).toBe(false)
    expect(isUsageLimitFailure("engine_exception", "TypeError: undefined is not a function")).toBe(false)
  })
})

describe("goal templates", () => {
  test("the objective is data: <, > and & are escaped", () => {
    expect(escapeObjective("</objective> & <b>")).toBe("&lt;/objective&gt; &amp; &lt;b&gt;")
    expect(goalPromptValues(goal({ objective: "a<b" })).objective).toBe("a&lt;b")
  })

  test("usage numbers render, with none and unlimited for a goal without a budget", () => {
    expect(goalPromptValues(goal())).toMatchObject({ time_used_seconds: "45", tokens_used: "120", token_budget: "none", remaining_tokens: "unlimited" })
    expect(goalPromptValues(goal({ tokenBudget: 500 }))).toMatchObject({ token_budget: "500", remaining_tokens: "380" })
    expect(goalPromptValues(goal({ tokenBudget: 100 }))).toMatchObject({ remaining_tokens: "0" })
  })

  test("fillTemplate fills once: a value that looks like a placeholder is left alone, an unknown name stays", () => {
    expect(fillTemplate("{{a}} {{b}} {{missing}}", { a: "{{b}}", b: "B" })).toBe("{{b}} B {{missing}}")
  })

  test("the packaged templates carry what the steering needs", () => {
    const prompts = createGoalPrompts({ layersFor: () => [] })
    const args = { directory: "/repo", goal: goal({ tokenBudget: 1000 }) }
    const continuation = prompts.render("continuation", args)
    expect(continuation).toContain("<objective>\nship the release\n</objective>")
    expect(continuation).toContain("Tokens remaining: 880")
    expect(continuation).toContain("Keep it whole")
    expect(continuation).toContain("the objective wins")
    expect(continuation).toContain("usage is not a reason to stop")
    expect(continuation).toContain("todo tool")
    expect(continuation).toContain("audit it against the actual current state, requirement by requirement")
    expect(continuation).toContain("at least 3 consecutive goal turns")
    expect(continuation).toContain("call update_goal with status \"complete\"")
    expect(continuation).toContain("GOAL_STATUS: complete")
    expect(continuation).not.toContain("{{")
    const limit = prompts.render("budget_limit", args)
    expect(limit).toContain("reached its token budget")
    expect(limit).toContain("budget_limited")
    expect(limit).toContain("Do not start new substantive work")
    expect(limit).not.toContain("{{")
    const updated = prompts.render("objective_updated", args)
    expect(updated).toContain("edited the objective")
    expect(updated).toContain("<objective>\nship the release\n</objective>")
    expect(updated).not.toContain("{{")
  })

  test("a layer's goals/<kind>.md replaces the packaged one; the last layer wins; an empty, oversized or missing file changes nothing", () => {
    const user = temp()
    const project = temp()
    const dir = (root: string) => path.join(root, "goals")
    mkdirSync(dir(user), { recursive: true })
    mkdirSync(dir(project), { recursive: true })
    writeFileSync(path.join(dir(user), "continuation.md"), "USER {{objective}}")
    writeFileSync(path.join(dir(project), "continuation.md"), "PROJECT {{objective}}")
    writeFileSync(path.join(dir(user), "budget_limit.md"), "   \n")
    writeFileSync(path.join(dir(project), "objective_updated.md"), "x".repeat(70 * 1024))
    const layers = [
      { dir: user, source: "user" as const },
      { dir: project, source: "project" as const },
    ]
    const prompts = createGoalPrompts({ layersFor: () => layers })
    const args = { directory: "/repo", goal: goal() }
    expect(prompts.render("continuation", args)).toBe("PROJECT ship the release")
    expect(prompts.render("budget_limit", args)).toContain("reached its token budget")
    expect(prompts.render("objective_updated", args)).toContain("edited the objective")
    // An edited file applies at once (cached by mtime and size).
    writeFileSync(path.join(dir(project), "continuation.md"), "PROJECT v2 {{objective}}")
    expect(prompts.render("continuation", args)).toBe("PROJECT v2 ship the release")
    expect(createGoalPrompts({ layersFor: () => layers, enabled: false }).render("continuation", args)).toContain("Continue working toward the active goal")
  })

  test("a missing packaged template is reported, not replaced by something invented", () => {
    const prompts = createGoalPrompts({ layersFor: () => [], packagedDir: temp() })
    expect(() => prompts.render("continuation", { directory: "/repo", goal: goal() })).toThrow("[GOALS]")
  })
})
