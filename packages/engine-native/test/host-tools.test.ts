import { describe, expect, test } from "bun:test"
import type { SessionId, Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src"
import { hostable } from "../src/host-tools"
import { scriptedProvider, turn } from "./harness"

const ran: string[] = []
const fakeTool = (name: string, permission: "read" | "write" = "read") => defineTool({
  name, description: `tool ${name}`, permission, args: z.object({ query: z.string().optional() }),
  execute: async (args) => { ran.push(name); return { output: `${name} ran ${args.query ?? ""}`.trim(), title: name, isError: false, truncated: false } },
})
const NAMES = ["read", "shell", "edit", "grep", "webfetch", "question", "todo", "graph_find", "computer_observe", "memory", "mcp__linear__list"]

function engineWith(settings: Settings) {
  const { provider, requests } = scriptedProvider([])
  const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [...NAMES.map((name) => fakeTool(name)), fakeTool("customize_ui", "write")], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings })
  return { engine, requests }
}

describe("native tools lent to another harness", () => {
  test("what that harness already has, and MendCode's own MCP servers, are not offered; the rest is", async () => {
    for (const own of ["read", "write", "edit", "apply_patch", "glob", "grep", "ls", "shell", "task", "question", "todo", "skill", "tool_search", "plan_exit", "mcp__linear__list", "mcp_resource_read"]) expect(hostable(own)).toBe(false)
    // MendCode's web tools are lent too: the other harness refuses some sites or has no search.
    for (const lent of ["graph_find", "graph_callers", "computer_session", "memory", "remember", "customize_ui", "loop", "worktree", "sessions", "webfetch", "websearch"]) expect(hostable(lent)).toBe(true)
    const { engine, requests } = engineWith({ tier: "full" })
    const tools = await engine.hostTools!({ directory: "/repo", sessionId: "ses_a" as SessionId })
    expect(tools.map((tool) => tool.name).sort()).toEqual(["computer_observe", "customize_ui", "graph_find", "memory", "webfetch"])
    expect((tools.find((tool) => tool.name === "graph_find")!.parameters as any).properties.query).toBeDefined()
    // Listing calls no model.
    expect(requests).toEqual([])
  })

  test("a call runs the tool as a call of the given turn: one card, the tool's output, no model call", async () => {
    ran.length = 0
    const { engine, requests } = engineWith({ tier: "full" })
    const { input, events } = turn({ text: "" })
    const result = await engine.hostCall!({ turn: input, name: "graph_find", args: { query: "router" } })
    expect(result).toEqual({ output: "graph_find ran router", isError: false })
    expect(ran).toEqual(["graph_find"])
    expect(events.filter((event) => event.type === "item.started").map((event) => (event as any).kind)).toEqual(["tool_call"])
    expect(events.some((event) => event.type === "item.completed" && event.status === "ok")).toBe(true)
    expect(requests).toEqual([])
  })

  test("a tool the harness has of its own, or an unknown one, is refused without running", async () => {
    ran.length = 0
    const { engine } = engineWith({ tier: "full" })
    const { input, events } = turn({ text: "" })
    for (const name of ["shell", "nope"]) expect(await engine.hostCall!({ turn: input, name, args: {} })).toEqual({ output: `Tool ${name} is not available in this session`, isError: true })
    expect(ran).toEqual([])
    expect(events).toEqual([])
  })

  test("a writing tool asks the user in ask mode and does not run when denied; plan mode refuses it", async () => {
    ran.length = 0
    const { engine } = engineWith({ tier: "full" })
    const denied = turn({ text: "", mode: () => "ask", answers: [{ kind: "deny" }] })
    const first = await engine.hostCall!({ turn: denied.input, name: "customize_ui", args: {} })
    expect(first.isError).toBe(true)
    expect(denied.asked).toHaveLength(1)
    const plan = turn({ text: "", mode: () => "plan" })
    expect((await engine.hostCall!({ turn: plan.input, name: "customize_ui", args: {} })).isError).toBe(true)
    expect(ran).toEqual([])
    const approved = turn({ text: "", mode: () => "ask", answers: [{ kind: "approve", scope: "once" }] })
    expect((await engine.hostCall!({ turn: approved.input, name: "customize_ui", args: {} })).isError).toBe(false)
    expect(ran).toEqual(["customize_ui"])
  })
})
