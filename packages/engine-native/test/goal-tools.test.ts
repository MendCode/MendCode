import { describe, expect, test } from "bun:test"
import type { Goal } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type AgentProfile, type GoalPort } from "../src"
import { callTool, echoTool, ids, scriptedProvider, stop, turn } from "./harness"

const secondTool = defineTool({ name: "other", description: "another tool", permission: "read", args: z.object({}), execute: async () => ({ output: "x", truncated: false, title: "other", isError: false }) })

function goal(patch: Partial<Goal> = {}): Goal {
  return { goalId: ids("goal"), sessionId: ids("session"), objective: "ship the release", status: "active", tokensUsed: 120, timeUsedSeconds: 30, createdAt: 1, updatedAt: 1, ...patch }
}

function port(initial?: Goal) {
  let current = initial
  const calls: string[] = []
  const goals: GoalPort = {
    get: () => current,
    create: ({ objective, tokenBudget }) => {
      calls.push(`create ${objective} ${tokenBudget ?? "-"}`)
      if (current && current.status !== "complete") return { ok: false, message: "already has an unfinished goal" }
      current = goal({ objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) })
      return { ok: true, goal: current }
    },
    update: ({ status, note }) => {
      calls.push(`update ${status} ${note ?? "-"}`)
      if (!current) return { ok: false, message: "this session has no goal" }
      current = { ...current, status, ...(note ? { note } : {}) }
      return { ok: true, goal: current }
    },
  }
  return { goals, calls }
}

const toolMessages = (requests: Array<{ messages: Array<{ role: string }> }>) => requests.at(-1)!.messages.filter((message) => message.role === "tool") as unknown as Array<{ name: string; output: string; isError: boolean }>

describe("goal tools", () => {
  test("with a goal port the main agent gets get_goal, create_goal and update_goal; without one they do not exist", async () => {
    const withPort = scriptedProvider([stop("hi")])
    const engine = createNativeEngine({ provider: withPort.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", goals: () => port().goals })
    await engine.runTurn(turn({ text: "hello" }).input)
    expect(withPort.requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_goal", "create_goal", "update_goal"]))
    const update = withPort.requests[0]!.tools.find((tool) => tool.name === "update_goal")!
    expect(update.parameters).toMatchObject({ properties: { status: { enum: ["complete", "blocked", "paused"] } } })
    expect(update.description).toContain("at least 3 consecutive goal turns")
    expect(update.description).toContain("cannot use this tool to resume")
    const create = withPort.requests[0]!.tools.find((tool) => tool.name === "create_goal")!
    expect(create.description).toContain("only when explicitly requested by the user")

    const without = scriptedProvider([stop("hi")])
    await createNativeEngine({ provider: without.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C" }).runTurn(turn({ text: "hello" }).input)
    expect(without.requests[0]!.tools.map((tool) => tool.name)).not.toContain("update_goal")
  })

  test("the tools run against the session's goal and report what the agent needs", async () => {
    const { goals, calls } = port(goal({ tokenBudget: 1000, tokensUsed: 400 }))
    const { provider, requests } = scriptedProvider([
      callTool("get_goal", {}),
      callTool("update_goal", { status: "complete", note: "all green" }),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", goals: () => goals })
    const t = turn({ text: "continue" })
    expect(await engine.runTurn(t.input)).toEqual({ status: "ok" })
    const outputs = toolMessages(requests)
    expect(JSON.parse(outputs[0]!.output)).toEqual({ goal: { status: "active", objective: "ship the release", tokenBudget: 1000, tokensUsed: 400, remainingTokens: 600, timeUsedSeconds: 30 } })
    expect(calls).toEqual(["update complete all green"])
    expect(outputs[1]!.output).toContain("Goal marked complete. Report the final token usage to the user: 400 of 1000 tokens used.")
    expect(outputs[1]!.isError).toBe(false)
    // Goal tools never ask for approval.
    expect(t.asked).toEqual([])
  })

  test("errors from the port and bad arguments come back as tool errors", async () => {
    const { goals } = port()
    const { provider, requests } = scriptedProvider([callTool("update_goal", { status: "complete" }), callTool("update_goal", { status: "resumed" }), callTool("create_goal", { objective: "" }), callTool("create_goal", { objective: "first", token_budget: 50 }), callTool("create_goal", { objective: "second" }), stop("ok")])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", goals: () => goals })
    await engine.runTurn(turn({ text: "go" }).input)
    const outputs = toolMessages(requests)
    expect(outputs[0]).toMatchObject({ isError: true, output: "this session has no goal" })
    expect(outputs[1]!.isError).toBe(true)
    expect(outputs[1]!.output).toContain("invalid arguments for update_goal")
    expect(outputs[2]!.output).toContain("invalid arguments for create_goal")
    // The stub's new goal already shows 120 tokens used, so nothing of the 50 is left.
    expect(JSON.parse(outputs[3]!.output).goal).toMatchObject({ objective: "first", tokenBudget: 50, remainingTokens: 0 })
    expect(outputs[4]).toMatchObject({ isError: true, output: "already has an unfinished goal" })
  })

  test("a custom agent with a tool list still has the goal tools", async () => {
    const { goals } = port()
    const { provider, requests } = scriptedProvider([stop("hi")])
    const agent: AgentProfile = { name: "reviewer", description: "Reviews changes", mode: "primary", prompt: "Review only.", tools: ["echo"] }
    const engine = createNativeEngine({ provider, tools: [echoTool, secondTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", goals: () => goals, agents: { primary: () => agent, subagents: () => [] } })
    await engine.runTurn(turn({ text: "hello" }).input)
    const names = requests[0]!.tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["echo", "get_goal", "create_goal", "update_goal"]))
    expect(names).not.toContain("other")
  })
})
