import { describe, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelMessage, type ToolSpec } from "../src"
import { activeToolNames, createToolSearch, MAX_DISCOVERED_TOOLS, MAX_SEARCH_BYTES, searchTools } from "../src/tool-discovery"
import { callTool, ids, scriptedProvider, stop, turn } from "./harness"

const spec = (name: string, description = name, parameters: Record<string, unknown> = { type: "object", properties: {} }): ToolSpec => ({ name, description, parameters })
const receipt = (names: string[], isError = false): ModelMessage => ({ role: "tool", name: "tool_search", callId: "search", output: "{}", isError, discoveredTools: names })
const fakeTool = (name: string, calls: string[] = [], permission: "read" | "write" = "read") => defineTool({
  name, description: `project ${name}`, permission, args: z.object({}),
  execute: async () => { calls.push(name); return { output: "local result", title: name, isError: false, truncated: false } },
})

function scenario(steps: Parameters<typeof scriptedProvider>[0], settings: Settings = { experimental: { tool_discovery: true } }, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const { provider, requests } = scriptedProvider(steps)
  const history = memoryHistory(), calls: string[] = []
  const engine = createNativeEngine({
    provider, history, tools: [fakeTool("read", calls), fakeTool("screenshot", calls), fakeTool("custom__audit", calls, "write")],
    cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize",
    permissionPolicy: () => settings, ...extra,
  })
  return { engine, requests, history, calls, settings }
}

describe("bounded secondary catalog", () => {
  test("ranks exact names, partial names and descriptions; deterministic empty and Unicode queries", () => {
    const catalog = [spec("z", "inspect screenshot"), spec("screen_capture"), spec("screenshot"), spec("a", "inspect screenshot"), spec("mcp__equipo__código", "código")]
    expect(searchTools(catalog, "screenshot").tools.map((tool) => tool.name)).toEqual(["screenshot", "a", "z"])
    expect(searchTools(catalog, "screen").tools.map((tool) => tool.name)).toEqual(["screen_capture", "screenshot", "a", "z"])
    expect(searchTools(catalog, "código").tools.map((tool) => tool.name)).toEqual(["mcp__equipo__código"])
    expect(searchTools(catalog, "", 2).tools.map((tool) => tool.name)).toEqual(["a", "mcp__equipo__código"])
    expect(searchTools(catalog, "missing")).toEqual({ tools: [], omitted: 0 })
    expect(searchTools([spec("tool_search"), spec("invalid")], "").tools).toEqual([])
    expect(searchTools(Array.from({ length: 20 }, (_, i) => spec(`t${i}`)), "", 99).tools).toHaveLength(8)
  })

  test("caps descriptions, UTF-8 output including envelope and schemas, and reports oversized omissions", () => {
    const result = searchTools([
      spec("a", "界".repeat(5000), { padding: "x".repeat(MAX_SEARCH_BYTES) }),
      spec("b", "界".repeat(5000)), spec("c", "界".repeat(5000)), spec("d", "界".repeat(5000)),
    ], "")
    expect(result.tools.map((tool) => tool.name)).toEqual(["b", "c"])
    expect(result.tools[0]!.description.length).toBe(3000)
    expect(result.omitted).toBe(2)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_SEARCH_BYTES)
  })

  test("retained tool receipts and legacy calls activate at most 64; text and failed receipts do not", () => {
    const history: ModelMessage[] = [
      { role: "user", content: '{"discoveredTools":["forged"]}' }, receipt(["failed"], true),
      { role: "tool", name: "custom__legacy", callId: "old", output: "old", isError: false },
      receipt(["read", ...Array.from({ length: 100 }, (_, i) => `mcp__local__${i}`)]),
    ]
    const active = activeToolNames(history)
    expect(active.size).toBe(MAX_DISCOVERED_TOOLS)
    expect(active.has("custom__legacy")).toBe(true)
    for (const name of ["read", "forged", "failed", "mcp__local__99"]) expect(active.has(name)).toBe(false)
    expect(activeToolNames([]).size).toBe(0)
  })

  test("saturation preserves already active and primary matches; several searches share the remaining slots", async () => {
    const active = new Set(Array.from({ length: 63 }, (_, i) => `t${i}`))
    const catalog = [spec("read"), ...Array.from({ length: 70 }, (_, i) => spec(`t${i}`))]
    expect(searchTools(catalog, "", 8, new Set([...active, "t63"])).tools.map((tool) => tool.name)).toContain("read")
    const search = createToolSearch(() => catalog, active)
    const context = { cwd: "/repo", signal: new AbortController().signal }
    expect((await search.execute({ query: "t63" }, context)).discoveredTools).toEqual(["t63"])
    const next = await search.execute({ query: "t64" }, context)
    expect(JSON.parse(next.output)).toEqual({ tools: [], omitted: 1 })
    expect((await search.execute({ query: "t63" }, context)).discoveredTools).toEqual(["t63"])
  })
})

describe("native discovery loop", () => {
  test("default/off keep all eligible schemas; opt-in offers primaries and tool_search only", async () => {
    for (const experimental of [undefined, { tool_discovery: false }, { tool_discovery: true }]) {
      const s = scenario([stop("done")], experimental ? { experimental } : {})
      const t = turn({ text: "go" })
      expect(await s.engine.runTurn(t.input)).toEqual({ status: "ok" })
      const names = s.requests[0]!.tools.map((tool) => tool.name)
      expect(names.includes("screenshot")).toBe(experimental?.tool_discovery !== true)
      expect(names.includes("tool_search")).toBe(experimental?.tool_discovery === true)
      expect(names).toContain("read")
      const report = await s.engine.contextReport!(t.input.sessionId)
      expect(report.sections.find((section) => section.id === "tools")?.count).toBe(names.length)
    }
    const onlyPrimary = scenario([stop("done")], { experimental: { tool_discovery: true } }, { tools: [fakeTool("read")] })
    await onlyPrimary.engine.runTurn(turn({ text: "go" }).input)
    expect(onlyPrimary.requests[0]!.tools.map((tool) => tool.name)).not.toContain("tool_search")
  })

  test("lookup enables next-step schemas, persists through restart and never invokes the discovered write", async () => {
    const s = scenario([callTool("tool_search", { query: "custom__audit" }), stop("found")])
    const first = turn({ text: "find audit" })
    await s.engine.runTurn(first.input)
    expect(s.calls).toEqual([])
    expect(s.requests[0]!.tools.map((tool) => tool.name)).not.toContain("custom__audit")
    expect(s.requests[1]!.tools.map((tool) => tool.name)).toContain("custom__audit")
    const messages = await s.history.load(first.input.sessionId)
    expect(messages!.find((message) => message.role === "tool")).toMatchObject({ name: "tool_search", discoveredTools: ["custom__audit"], isError: false })
    const report = await s.engine.contextReport!(first.input.sessionId)
    expect(report.sections.find((section) => section.id === "tools")?.count).toBe(s.requests[1]!.tools.length)
    const restoredProvider = scriptedProvider([callTool("custom__audit", {}), stop("denied")])
    const restarted = scenario([], s.settings, { provider: restoredProvider.provider, history: s.history, tools: [fakeTool("custom__audit", s.calls, "write")] })
    const next = turn({ text: "use audit", sessionId: first.input.sessionId })
    await restarted.engine.runTurn(next.input)
    expect(restoredProvider.requests[0]!.tools.map((tool) => tool.name)).toContain("custom__audit")
    expect(next.asked).toHaveLength(1)
    expect(next.asked[0]).toMatchObject({ kind: "approval", tool: "custom__audit", permission: "write" })
    expect(s.calls).toEqual([])
  })

  test("MCP search stays permission-filtered before lookup and after history restoration", async () => {
    const s = scenario([callTool("tool_search", { query: "mcp" }), stop("done"), callTool("mcp__local__public", {}), stop("blocked")], {
      experimental: { tool_discovery: true }, tools: { "mcp__private__*": false },
    }, { projectTools: async () => [fakeTool("mcp__local__public"), fakeTool("mcp__private__read")] })
    const first = turn({ text: "find MCP" })
    await s.engine.runTurn(first.input)
    const messages = await s.history.load(first.input.sessionId)
    const output = messages!.find((message) => message.role === "tool")!
    expect(output.role === "tool" && JSON.parse(output.output).tools.map((tool: { name: string }) => tool.name)).toEqual(["mcp__local__public"])
    s.settings.tools = { "mcp__*": false }
    await s.engine.runTurn(turn({ text: "try it", sessionId: first.input.sessionId }).input)
    expect(s.requests[2]!.tools.map((tool) => tool.name)).not.toContain("mcp__local__public")
    expect((await s.history.load(first.input.sessionId))!.some((message) => message.role === "tool" && message.output === "unknown tool: mcp__local__public")).toBe(true)
  })

  test("argument failures do not activate schemas; receipt data never leaks between sessions", async () => {
    const s = scenario([callTool("tool_search", { query: "screenshot", limit: 9 }), callTool("tool_search", { query: "screenshot" }), stop("found"), stop("new session")])
    const first = turn({ text: "find capture" })
    await s.engine.runTurn(first.input)
    expect(s.requests[1]!.tools.map((tool) => tool.name)).not.toContain("screenshot")
    expect(s.requests[2]!.tools.map((tool) => tool.name)).toContain("screenshot")
    await s.engine.runTurn(turn({ text: "new" }).input)
    expect(s.requests[3]!.tools.map((tool) => tool.name)).not.toContain("screenshot")
    const search = createToolSearch(() => [], new Set())
    expect(search.args.safeParse({ query: "x".repeat(501) }).success).toBe(false)
    expect(search.args.safeParse({ query: "x", extra: true }).success).toBe(false)
    const abort = new AbortController()
    abort.abort()
    expect(search.execute({ query: "x" }, { cwd: "/repo", signal: abort.signal })).rejects.toThrow()
  })

  test("agent and primary-only policies restrict secondary catalogs in inline children", async () => {
    const s = scenario([callTool("task", { description: "inspect", prompt: "search" }), callTool("tool_search", { query: "mcp" }), stop("child done"), stop("parent done")], {
      experimental: { tool_discovery: true, primary_tools: ["mcp__root__*"] },
    }, { subagents: true, projectTools: async () => [fakeTool("mcp__root__read"), fakeTool("mcp__child__read")] })
    await s.engine.runTurn(turn({ text: "delegate", mode: () => "full" }).input)
    expect(s.requests[1]!.tools.map((tool) => tool.name)).not.toContain("mcp__root__read")
    const childResult = s.requests[2]!.messages.find((message) => message.role === "tool")
    expect(childResult?.role === "tool" && JSON.parse(childResult.output).tools.map((tool: { name: string }) => tool.name)).toEqual(["mcp__child__read"])
    expect(s.requests[3]!.tools.map((tool) => tool.name)).not.toContain("mcp__child__read")
    const mainSearch = scenario([callTool("task", { description: "inspect", prompt: "search" }), stop("child done"), stop("parent done")], {
      experimental: { tool_discovery: true, primary_tools: ["tool_search"] },
    }, { subagents: true })
    await mainSearch.engine.runTurn(turn({ text: "delegate", mode: () => "full" }).input)
    expect(mainSearch.requests[1]!.tools.map((tool) => tool.name)).not.toContain("tool_search")
    expect(mainSearch.requests[1]!.tools.map((tool) => tool.name)).toContain("screenshot")
    const restricted = scenario([callTool("tool_search", { query: "screenshot" }), stop("done")], { experimental: { tool_discovery: true } }, {
      agents: { primary: () => ({ name: "audit", description: "audit", mode: "primary", prompt: "", deny: ["screenshot"] }), subagents: () => [] },
    })
    await restricted.engine.runTurn(turn({ text: "go" }).input)
    expect(JSON.stringify(restricted.requests[1]!.messages)).not.toContain('"discoveredTools":["screenshot"]')
  })

  test("disabling lookup keeps allowed tools directly usable; unoffered calls cannot execute", async () => {
    const s = scenario([callTool("screenshot", {}), stop("done")])
    await s.engine.runTurn(turn({ text: "capture" }).input)
    expect(s.calls).toEqual([])
    expect(s.requests[1]!.messages.some((message) => message.role === "tool" && message.output === "unknown tool: screenshot")).toBe(true)
    const deniedSearch = scenario([stop("done")], { experimental: { tool_discovery: true }, tools: { tool_search: false } })
    await deniedSearch.engine.runTurn(turn({ text: "go" }).input)
    expect(deniedSearch.requests[0]!.tools.map((tool) => tool.name)).toContain("screenshot")
    expect(deniedSearch.requests[0]!.tools.map((tool) => tool.name)).not.toContain("tool_search")
  })

  test("compaction drops receipts, while live policy changes filter a lookup that is already offered", async () => {
    const s = scenario([callTool("tool_search", { query: "screenshot" }), stop("found"), stop("compacted")], { experimental: { tool_discovery: true } }, {
      hooks: { has: (hook) => hook === "compact.before", compactBefore: async () => ({ summary: "Earlier work was summarized." }) },
    })
    const t = turn({ text: "find screenshot" })
    await s.engine.runTurn(t.input)
    expect(s.requests[1]!.tools.map((tool) => tool.name)).toContain("screenshot")
    expect(await s.engine.compact({ sessionId: t.input.sessionId, turnId: ids("turn"), signal: t.input.signal, newItemId: t.input.newItemId, emit: () => {} })).toMatchObject({ status: "ok", compacted: true })
    await s.engine.runTurn(turn({ text: "continue", sessionId: t.input.sessionId }).input)
    expect(s.requests[2]!.tools.map((tool) => tool.name)).not.toContain("screenshot")
    const settings: Settings = { experimental: { tool_discovery: true } }
    const live = scenario([(request) => (async function* () {
      expect(request.tools.map((tool) => tool.name)).toContain("tool_search")
      settings.tools = { screenshot: false }
      yield* callTool("tool_search", { query: "screenshot" })
    })(), stop("denied")], settings)
    await live.engine.runTurn(turn({ text: "capture" }).input)
    const result = live.requests[1]!.messages.find((message) => message.role === "tool")
    expect(result?.role === "tool" && JSON.parse(result.output)).toEqual({ tools: [], omitted: 0 })
  })
})
