import { describe, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { BUILTIN_TOOLS, defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src"
import { AUX_TOOLS, FIND_TOOLS, impliedTools, isPrimaryIn, LEGACY_CATALOG, activeToolNames, type CatalogMode } from "../src/tool-discovery"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const BALANCED: CatalogMode = { lean: true, planTools: false, aux: false, find: true, ui: true }
const MINIMALIST: CatalogMode = { lean: true, planTools: false, aux: false, find: false, ui: false }

const fakeTool = (name: string, permission: "read" | "write" = "read") => defineTool({
  name, description: `tool ${name}`, permission, args: z.object({}),
  execute: async () => ({ output: `${name} ran`, title: name, isError: false, truncated: false }),
})
const NAMES = ["read", "shell", "edit", "todo", "update_goal", "workflow_start", "loop", "worktree", "memory", "notebook_edit", "ai_config"]

function scenario(steps: Parameters<typeof scriptedProvider>[0], settings: Settings) {
  const { provider, requests } = scriptedProvider(steps)
  const history = memoryHistory()
  const engine = createNativeEngine({ provider, history, tools: NAMES.map((name) => fakeTool(name)), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings })
  return { engine, requests, history }
}
const namesOf = (request: { tools: ReadonlyArray<{ name: string }> }) => request.tools.map((tool) => tool.name)

describe("lean tool catalogue (features lean_tools and plan_tools)", () => {
  test("no tier: the whole catalogue, as before; any tier: the coding core, tool_search and nothing heavy", async () => {
    const legacy = scenario([stop("a")], {})
    await legacy.engine.runTurn(turn({ text: "go" }).input)
    expect(namesOf(legacy.requests[0]!)).toEqual(expect.arrayContaining(["workflow_start", "loop", "todo", "ai_config"]))
    expect(namesOf(legacy.requests[0]!)).not.toContain("tool_search")
    for (const tier of ["minimalist", "balanced"] as const) {
      const lean = scenario([stop("a")], { tier })
      await lean.engine.runTurn(turn({ text: "go" }).input)
      const names = namesOf(lean.requests[0]!)
      expect(names).toEqual(expect.arrayContaining(["read", "shell", "edit", "tool_search"]))
      for (const deferred of ["workflow_start", "loop", "worktree", "memory", "notebook_edit", "ai_config", "todo", "update_goal"]) expect(names).not.toContain(deferred)
    }
  })

  test("customize_ui is listed in balanced and full (a model asked to hide a bar found it there first try) and found by search in minimalist", async () => {
    const run = async (settings: Settings) => {
      const { provider, requests } = scriptedProvider([stop("a")])
      const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [...NAMES, "customize_ui"].map((name) => fakeTool(name)), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings })
      await engine.runTurn(turn({ text: "go" }).input)
      return namesOf(requests[0]!)
    }
    expect(await run({ tier: "balanced" })).toContain("customize_ui")
    expect(await run({ tier: "full" })).toContain("customize_ui")
    expect(await run({ tier: "minimalist" })).not.toContain("customize_ui")
    expect(await run({ tier: "balanced", features: { ui_tool: false } })).not.toContain("customize_ui")
    expect(await run({ tier: "minimalist", features: { ui_tool: true } })).toContain("customize_ui")
  })

  test("plan_tools: no tier lists todo and the goal tools; every tier defers them until the user turns the feature on", async () => {
    for (const tier of ["minimalist", "balanced", "full"] as const) {
      const lean = scenario([stop("a")], { tier })
      await lean.engine.runTurn(turn({ text: "go" }).input)
      expect(namesOf(lean.requests[0]!)).not.toContain("todo")
      expect(namesOf(lean.requests[0]!)).not.toContain("update_goal")
    }
    const fullWithPlan = scenario([stop("a")], { tier: "full", features: { plan_tools: true } })
    await fullWithPlan.engine.runTurn(turn({ text: "go" }).input)
    expect(namesOf(fullWithPlan.requests[0]!)).toEqual(expect.arrayContaining(["todo", "update_goal"]))
    expect(namesOf(fullWithPlan.requests[0]!)).not.toContain("workflow_start")
  })

  test("first request per tier, with the real built-in tools: every tier lists the seven coding tools and tool_search, and nothing auxiliary", async () => {
    const first = async (settings: Settings) => {
      const { provider, requests } = scriptedProvider([stop("a")])
      const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [...BUILTIN_TOOLS], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings })
      await engine.runTurn(turn({ text: "go" }).input)
      return namesOf(requests[0]!)
    }
    expect((await first({ tier: "minimalist" })).sort()).toEqual(["apply_patch", "edit", "glob", "grep", "read", "shell", "tool_search", "write"].sort())
    for (const tier of ["balanced", "full"] as const) {
      const names = await first({ tier })
      expect(names).toEqual(expect.arrayContaining(["read", "write", "edit", "apply_patch", "shell", "glob", "grep", "tool_search"]))
      for (const deferred of ["ls", ...AUX_TOOLS, "todo"]) expect(names).not.toContain(deferred)
    }
    expect(await first({ tier: "balanced", features: { aux_tools: true } })).toEqual(expect.arrayContaining(["shell_output", "shell_kill", "webfetch"]))
    const withoutFind = await first({ tier: "minimalist", features: { find_tools: false } })
    expect(withoutFind).not.toContain("glob")
    expect(withoutFind).not.toContain("grep")
  })

  test("no capability is lost: every tool a tier defers is found by tool_search and joins the request with the schema it had when always listed", async () => {
    const specOf = (request: { tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }> }, name: string) => request.tools.find((tool) => tool.name === name)
    const legacy = scriptedProvider([stop("a")])
    await createNativeEngine({ provider: legacy.provider, history: memoryHistory(), tools: [...BUILTIN_TOOLS], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({}) }).runTurn(turn({ text: "go" }).input)
    const deferred = ["ls", "glob", "grep", "webfetch", "shell_output", "shell_kill"]
    for (const tier of ["minimalist", "balanced", "full"] as const) {
      const s = scriptedProvider([...deferred.map((name) => callTool("tool_search", { query: name, limit: 1 })), stop("done")])
      await createNativeEngine({ provider: s.provider, history: memoryHistory(), tools: [...BUILTIN_TOOLS], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ tier }) }).runTurn(turn({ text: "go" }).input)
      const last = s.requests.at(-1)!
      for (const name of deferred) expect({ tier, name, spec: specOf(last, name) }).toEqual({ tier, name, spec: specOf(legacy.requests[0]!, name) })
    }
  })

  test("each arm reverts by itself: features.lean_tools false, features.plan_tools true, experimental.tool_discovery false", async () => {
    const noLean = scenario([stop("a")], { tier: "balanced", features: { lean_tools: false } })
    await noLean.engine.runTurn(turn({ text: "go" }).input)
    // The plan tools are still deferred (they have their own switch); the heavy tools are back in the primary set of the legacy discovery.
    expect(namesOf(noLean.requests[0]!)).toEqual(expect.arrayContaining(["workflow_start", "loop", "memory"]))
    expect(namesOf(noLean.requests[0]!)).not.toContain("todo")
    const whole = scenario([stop("a")], { tier: "balanced", experimental: { tool_discovery: false } })
    await whole.engine.runTurn(turn({ text: "go" }).input)
    expect(namesOf(whole.requests[0]!)).toEqual(expect.arrayContaining(["workflow_start", "todo", "ai_config"]))
    expect(namesOf(whole.requests[0]!)).not.toContain("tool_search")
  })

  test("a discovered tool is appended at the end: the request before it stays a prefix of the request after it", async () => {
    const s = scenario([callTool("tool_search", { query: "notebook" }), callTool("tool_search", { query: "loop" }), stop("done")], { tier: "balanced" })
    await s.engine.runTurn(turn({ text: "go" }).input)
    const [first, second, third] = s.requests.map(namesOf)
    expect(second).toEqual([...first!, "notebook_edit"])
    expect(third).toEqual([...second!, "loop"])
    expect(first!.at(-1)).toBe("tool_search")
  })

  test("a deferred tool the model calls directly is refused once as unknown, and is listed from the next request on", async () => {
    const s = scenario([callTool("todo", {}), stop("done")], { tier: "balanced" })
    await s.engine.runTurn(turn({ text: "go" }).input)
    expect(namesOf(s.requests[0]!)).not.toContain("todo")
    expect(s.requests[1]!.messages.some((message) => message.role === "tool" && message.output === "unknown tool: todo")).toBe(true)
    expect(namesOf(s.requests[1]!)).toContain("todo")
  })

  test("a folder the code graph indexes lists its lookups first-hand; a skipped folder leaves them out and keeps sub-agents", async () => {
    const graphTools = ["graph_find", "graph_callers", "graph_file_api", "task"].map((name) => fakeTool(name))
    const run = async (hidden: readonly string[]) => {
      const { provider, requests } = scriptedProvider([stop("a")])
      const directories: string[] = []
      const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [...NAMES.map((name) => fakeTool(name)), ...graphTools], cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ tier: "full" }), subagents: true, hiddenTools: (directory) => (directories.push(directory), hidden) })
      await engine.runTurn(turn({ text: "go" }).input)
      return { names: namesOf(requests[0]!), directories }
    }
    const indexed = await run([])
    for (const name of ["graph_find", "graph_callers", "graph_file_api"]) expect(indexed.names).toContain(name)
    const skipped = await run(["graph_*", "code_search"])
    for (const name of ["graph_find", "graph_callers", "graph_file_api"]) expect(skipped.names).not.toContain(name)
    expect(skipped.names).toContain("task")
    expect(skipped.directories).toContain("/repo")
  })

  test("the harness's own orientation and impact notes never list a schema", () => {
    const note = (name: string, callId: string) => ({ role: "tool" as const, callId, name, output: "x", isError: false })
    const primary = (name: string) => isPrimaryIn(name, BALANCED)
    expect([...activeToolNames([note("graph_map", "graph_orientation_abc"), note("graph_impact", "graph_impact_def")], primary)]).toEqual([])
    expect([...activeToolNames([note("graph_map", "model_call")], primary)]).toEqual(["graph_map"])
  })

  test("the code graph's lookups are always listed, in every cut; its map, impact note and text search are found with a search", () => {
    for (const mode of [BALANCED, MINIMALIST, { ...BALANCED, aux: true }, LEGACY_CATALOG]) {
      for (const name of ["graph_find", "graph_callers", "graph_file_api"]) expect(isPrimaryIn(name, mode)).toBe(true)
      for (const name of ["graph_map", "graph_impact", "code_search"]) expect(isPrimaryIn(name, mode)).toBe(false)
    }
  })

  test("primary sets: legacy keeps its 38, lean keeps the core, plan tools follow their switch", () => {
    expect(isPrimaryIn("workflow_start", LEGACY_CATALOG)).toBe(true)
    expect(isPrimaryIn("ls", LEGACY_CATALOG)).toBe(true)
    expect(isPrimaryIn("workflow_start", { ...BALANCED, planTools: true, aux: true })).toBe(false)
    expect(isPrimaryIn("todo", { ...LEGACY_CATALOG, planTools: false })).toBe(false)
    expect(isPrimaryIn("todo", { ...BALANCED, planTools: true })).toBe(true)
    expect(isPrimaryIn("apply_patch", MINIMALIST)).toBe(true)
    expect(isPrimaryIn("plan_submit", { ...BALANCED, aux: true })).toBe(true)
    expect(isPrimaryIn("plan_submit", BALANCED)).toBe(false)
  })

  test("minimalist lists what every coding turn uses and nothing else; read covers ls in every lean cut", () => {
    for (const name of ["shell", "read", "edit", "write", "apply_patch", "skill", "tool_search"]) expect(isPrimaryIn(name, MINIMALIST)).toBe(true)
    for (const name of [...AUX_TOOLS, ...FIND_TOOLS, "ls", "customize_ui"]) expect(isPrimaryIn(name, MINIMALIST)).toBe(false)
    for (const name of FIND_TOOLS) expect(isPrimaryIn(name, BALANCED)).toBe(true)
    expect(isPrimaryIn("ls", { ...BALANCED, aux: true, planTools: true })).toBe(false)
    // Off the lean catalogue the switches change nothing.
    expect(isPrimaryIn("question", { ...LEGACY_CATALOG, aux: false, find: false })).toBe(true)
    expect(isPrimaryIn("grep", { ...LEGACY_CATALOG, aux: false, find: false })).toBe(true)
  })

  test("an auxiliary tool is listed as soon as the conversation calls for it: plan mode, a background command, a sub-agent", () => {
    const calls = (name: string, args: unknown) => ({ role: "assistant" as const, content: "", toolCalls: [{ callId: "c", name, args }] })
    expect(impliedTools([], false)).toEqual([])
    expect(impliedTools([], true)).toEqual(["plan_submit", "plan_review", "plan_exit"])
    expect(impliedTools([calls("shell", { command: "ls" })], false)).toEqual([])
    expect(impliedTools([calls("shell", { command: "bun dev", background: true })], false)).toEqual(["shell_output", "shell_kill"])
    expect(impliedTools([calls("task", { description: "x", prompt: "y" })], false)).toEqual(["task_status"])
  })
})
