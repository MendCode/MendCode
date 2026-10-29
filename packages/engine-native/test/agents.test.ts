import { describe, expect, test } from "bun:test"
import { capPermission, createNativeEngine, memoryHistory, type AgentPort, type AgentProfile } from "../src"
import { callTool, echoTool, ids, scriptedProvider, stop, turn, writeTool } from "./harness"

const reviewer: AgentProfile = { name: "reviewer", description: "Reviews changes", mode: "primary", prompt: "Review only. Never edit.", tools: ["echo"], model: "gpt-6-sol", effort: "high", permission: "ask" }
const scout: AgentProfile = { name: "scout", description: "Finds things fast", mode: "subagent", prompt: "You are a scout. Answer in one line.", tools: ["echo"], model: "gpt-6-luna", effort: "low" }

function engineWith(input: { agents: AgentPort; steps: Parameters<typeof scriptedProvider>[0]; log?: string[]; extra?: Partial<Parameters<typeof createNativeEngine>[0]> }) {
  const { provider, requests } = scriptedProvider(input.steps)
  const engine = createNativeEngine({
    provider,
    tools: [echoTool, writeTool(input.log ?? [])],
    history: memoryHistory(),
    cwdFor: () => "/repo",
    system: () => "sys",
    compactionPrompt: "summarize",
    subagents: true,
    agents: input.agents,
    ...input.extra,
  })
  return { engine, requests }
}

describe("custom agents in the native engine", () => {
  test("a session's primary agent adds its prompt, narrows the tools and picks the model; another session is unchanged", async () => {
    const withAgent = ids("session")
    const plain = ids("session")
    const { engine, requests } = engineWith({
      agents: { primary: (sessionId) => (sessionId === withAgent ? reviewer : undefined), subagents: () => [] },
      steps: [stop("reviewed"), stop("plain")],
    })
    await engine.runTurn(turn({ text: "review", sessionId: withAgent }).input)
    await engine.runTurn(turn({ text: "work", sessionId: plain }).input)
    expect(requests[0]!.system).toBe("sys\n\n# Agent: reviewer\n\nReview only. Never edit.")
    // The allow list removes write and task; plan_submit stays so plan mode still works.
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["echo", "plan_submit", "plan_review", "plan_exit"])
    expect([requests[0]!.model, requests[0]!.effort]).toEqual(["gpt-6-sol", "high"])
    expect(requests[1]!.system).toBe("sys")
    expect(requests[1]!.tools.map((t) => t.name)).toEqual(["echo", "write", "plan_submit", "task", "plan_review", "plan_exit"])
    expect(requests[1]!.model).toBeUndefined()
  })

  test("deny removes tools after the allow list, and a trailing * matches a prefix", async () => {
    const agent: AgentProfile = { name: "careful", description: "d", mode: "primary", prompt: "", deny: ["wri*", "task"] }
    const { engine, requests } = engineWith({ agents: { primary: () => agent, subagents: () => [] }, steps: [stop("ok")] })
    await engine.runTurn(turn({ text: "go" }).input)
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["echo", "plan_submit", "plan_review", "plan_exit"])
    // An empty prompt adds nothing to the system prompt.
    expect(requests[0]!.system).toBe("sys")
  })

  test("a tool the agent may not use is unknown to it even when the model calls it anyway", async () => {
    const log: string[] = []
    const { engine, requests } = engineWith({ agents: { primary: () => reviewer, subagents: () => [] }, log, steps: [callTool("write", { path: "a.ts" }), stop("ok")] })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(log).toEqual([])
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: "unknown tool: write", isError: true })
  })

  test("the agent's permission caps the session's mode, never raises it", async () => {
    const log: string[] = []
    const capped = engineWith({ agents: { primary: () => ({ name: "capped", description: "d", mode: "primary", prompt: "", permission: "ask" }), subagents: () => [] }, log, steps: [callTool("write", { path: "a.ts" }), stop("ok")] })
    const asked = turn({ text: "go", mode: () => "full", answers: [{ kind: "deny", reason: "cap" }] })
    await capped.engine.runTurn(asked.input)
    // Session mode is full, but the agent is capped at ask: the write asks.
    expect(asked.asked).toHaveLength(1)
    expect(log).toEqual([])

    const logFree: string[] = []
    const open = engineWith({ agents: { primary: () => ({ name: "open", description: "d", mode: "primary", prompt: "", permission: "full" }), subagents: () => [] }, log: logFree, steps: [callTool("write", { path: "b.ts" }), stop("ok")] })
    const strict = turn({ text: "go", mode: () => "ask", answers: [{ kind: "approve", scope: "once" }] })
    await open.engine.runTurn(strict.input)
    // An agent allowed `full` does not lift a session in ask mode.
    expect(strict.asked).toHaveLength(1)
    expect(capPermission("edits", "plan")).toBe("plan")
    expect(capPermission("ask", "full")).toBe("ask")
    expect(capPermission("full", undefined)).toBe("full")
  })

  test("a read-only agent uses the plan model role and cannot write", async () => {
    const log: string[] = []
    const roles: string[] = []
    const { engine, requests } = engineWith({
      agents: { primary: () => ({ name: "readonly", description: "d", mode: "primary", prompt: "", permission: "plan" }), subagents: () => [] },
      log,
      steps: [callTool("write", { path: "a.ts" }), stop("ok")],
      extra: { modelFor: (_session, role) => (roles.push(role), undefined) },
    })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(log).toEqual([])
    expect(roles).toEqual(["plan", "plan"])
    expect(requests[1]!.messages.at(-1)).toMatchObject({ isError: true, output: expect.stringContaining("plan mode is read-only") })
  })

  test("the agent's model reaches usage, goes through agentModel, and keeps the session's model when the agent names only an effort", async () => {
    const { engine, requests } = engineWith({
      agents: { primary: (sessionId) => (sessionId === effortOnly ? { name: "deep", description: "d", mode: "primary", prompt: "", effort: "xhigh" } : reviewer), subagents: () => [] },
      steps: [[{ type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, ...stop("a")], stop("b")],
      extra: {
        modelFor: () => ({ model: "session-model", effort: "low" }),
        // The daemon drops an effort the model does not support; here `gpt-6-sol` takes none.
        agentModel: (choice) => (choice.model === "gpt-6-sol" ? { model: choice.model } : choice),
      },
    })
    const effortOnly = ids("session")
    const named = turn({ text: "go" })
    await engine.runTurn(named.input)
    await engine.runTurn(turn({ text: "go", sessionId: effortOnly }).input)
    expect([requests[0]!.model, requests[0]!.effort]).toEqual(["gpt-6-sol", undefined])
    expect(named.events.find((e) => e.type === "usage")).toMatchObject({ model: "gpt-6-sol" })
    expect([requests[1]!.model, requests[1]!.effort]).toEqual(["session-model", "xhigh"])
  })

  test("task runs a named sub-agent with its own prompt, tools and model, and lists the sub-agents in its description", async () => {
    const { engine, requests } = engineWith({
      agents: { primary: () => undefined, subagents: () => [scout] },
      steps: [callTool("task", { description: "find it", prompt: "Where is main?", agent: "scout" }), callTool("echo", { text: "x" }), stop("src/main.ts"), stop("found it")],
    })
    await engine.runTurn(turn({ text: "find main" }).input)
    const taskSpec = requests[0]!.tools.find((t) => t.name === "task")!
    expect(taskSpec.description).toContain("- scout: Finds things fast")
    expect(requests[0]!.system).toBe("sys")
    // The sub-agent's call: its own prompt and tools (echo only), its own model, a fresh context.
    expect(requests[1]!.system).toBe("sys\n\n# Agent: scout\n\nYou are a scout. Answer in one line.")
    expect(requests[1]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect([requests[1]!.model, requests[1]!.effort]).toEqual(["gpt-6-luna", "low"])
    expect(requests[1]!.messages).toEqual([{ role: "user", content: "Where is main?" }])
    expect(requests[3]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task", output: "src/main.ts" })
  })

  test("an unknown sub-agent name is an error that lists the ones that exist; without a name the sub-agent is the general one", async () => {
    const { engine, requests } = engineWith({
      agents: { primary: () => undefined, subagents: () => [scout] },
      steps: [callTool("task", { description: "x", prompt: "p", agent: "ghost" }), callTool("task", { description: "y", prompt: "q" }), stop("general answer"), stop("done")],
    })
    await engine.runTurn(turn({ text: "go" }).input)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", isError: true, output: 'unknown agent "ghost"; available: scout' })
    // The general sub-agent has no agent section and the full sub-agent tool set.
    expect(requests[2]!.system).toBe("sys")
    expect(requests[2]!.tools.map((t) => t.name)).toEqual(["echo", "write"])
  })

  test("a sub-agent never has more permission than the agent that called it", async () => {
    const log: string[] = []
    const writer: AgentProfile = { name: "writer", description: "writes", mode: "subagent", prompt: "", permission: "full" }
    const { engine } = engineWith({
      agents: { primary: () => ({ name: "lead", description: "d", mode: "primary", prompt: "", permission: "ask" }), subagents: () => [writer] },
      log,
      steps: [callTool("task", { description: "w", prompt: "write a.ts", agent: "writer" }), callTool("write", { path: "a.ts" }), stop("tried"), stop("done")],
    })
    const run = turn({ text: "go", mode: () => "full", answers: [{ kind: "deny", reason: "lead is capped at ask" }] })
    await engine.runTurn(run.input)
    expect(run.asked).toHaveLength(1)
    expect(log).toEqual([])
  })

  test("a primary agent without the task tool offers no sub-agents", async () => {
    const { engine, requests } = engineWith({ agents: { primary: () => ({ name: "solo", description: "d", mode: "primary", prompt: "", deny: ["task"] }), subagents: () => [scout] }, steps: [stop("ok")] })
    await engine.runTurn(turn({ text: "go" }).input)
    expect(requests[0]!.tools.map((t) => t.name)).not.toContain("task")
  })

  test("a failing agent source never blocks the turn", async () => {
    const { engine, requests } = engineWith({
      agents: {
        primary: () => {
          throw new Error("disk gone")
        },
        subagents: () => {
          throw new Error("disk gone")
        },
      },
      steps: [stop("still works")],
    })
    expect(await engine.runTurn(turn({ text: "go" }).input)).toEqual({ status: "ok" })
    expect(requests[0]!.system).toBe("sys")
  })

  test("/context lists the agent's prompt as a system section", async () => {
    const sessionId = ids("session")
    const { engine } = engineWith({ agents: { primary: () => reviewer, subagents: () => [] }, steps: [stop("ok")] })
    await engine.runTurn(turn({ text: "go", sessionId }).input)
    const report = await engine.contextReport!(sessionId)
    expect(report.sections.map((s) => s.id)).toContain("system:agent")
    expect(report.sections.find((s) => s.id === "system:agent")?.label).toBe("system · agent reviewer")
  })
})

describe("sub-agent names a model writes", () => {
  test("other tools' names for the general agent, and other case, mean the agent; anything else is left to be refused", async () => {
    const { subagentName } = await import("../src")
    const known = new Map([["general", {}], ["Reviewer", {}]])
    for (const alias of ["general-purpose", "General-Purpose", "general_purpose", "default", "generalist"]) expect(subagentName(alias, known)).toBe("general")
    expect(subagentName("reviewer", known)).toBe("Reviewer")
    expect(subagentName("Reviewer", known)).toBe("Reviewer")
    expect(subagentName("Explore", known)).toBe("Explore")
    expect(subagentName(undefined, known)).toBeUndefined()
    // No custom `general`: the alias is the same as omitting `agent`.
    expect(subagentName("general-purpose", new Map())).toBeUndefined()
    expect(subagentName("general-purpose", undefined)).toBeUndefined()
  })
})
