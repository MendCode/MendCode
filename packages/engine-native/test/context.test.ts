import { estimateTokens } from "@mendcode/protocol/wire"
import { describe, expect, test } from "bun:test"
import type { TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, joinSystemParts, memoryHistory, type ModelEvent, type ModelProvider } from "../src"

const ids = createIdFactory()

function scripted(steps: ModelEvent[][]): ModelProvider {
  return {
    id: "scripted",
    model: "script-1",
    async *stream() {
      yield* steps.shift() ?? []
    },
  }
}

const echoTool = defineTool({
  name: "echo",
  description: "echo text",
  permission: "read",
  args: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ output: `echoed ${text}`, truncated: false, title: "echo", isError: false }),
})

const usage = (input: number, output: number): ModelEvent => ({ type: "usage", usage: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, usage(1_000, 50), { type: "finish", reason: "stop" }]
const call = (args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: "c1", name: "echo", args } }, usage(900, 20), { type: "finish", reason: "tool_calls" }]

function turnInput(sessionId: ReturnType<typeof ids<"session">>, text: string, attachments: TurnInput["attachments"] = []): TurnInput {
  return {
    permissionMode: () => "ask",
    setPermissionMode: () => {},
    sessionId,
    turnId: ids("turn"),
    text,
    attachments,
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: () => {},
    ask: async () => ({ kind: "deny" }),
  }
}

const parts = [
  { id: "base", label: "base prompt", text: "B".repeat(400) },
  { id: "instructions", label: "project instructions", text: "I".repeat(80) },
  { id: "skills", label: "skills", text: "" },
  { id: "memory", label: "memory", text: "M".repeat(40) },
]

function makeEngine(steps: ModelEvent[][], compactAtTokens?: number) {
  return createNativeEngine({
    provider: scripted(steps),
    tools: [echoTool],
    history: memoryHistory(),
    cwdFor: () => "/repo",
    system: () => joinSystemParts(parts),
    systemParts: () => parts,
    compactionPrompt: "summarize",
    ...(compactAtTokens ? { compactAtTokens } : {}),
  })
}

describe("native engine contextReport", () => {
  test("joinSystemParts keeps the original composition and drops empty parts", () => {
    expect(joinSystemParts(parts)).toBe(`${"B".repeat(400)}\n\n${"I".repeat(80)}\n\n${"M".repeat(40)}`)
  })

  test("an empty session reports system parts and tools with an empty history", async () => {
    const engine = makeEngine([])
    const report = await engine.contextReport!(ids("session"))
    expect(report.model).toBe("script-1")
    expect(report.sections.map((s) => s.id)).toEqual(["system:base", "system:instructions", "system:skills", "system:memory", "tools", "history:user", "history:assistant", "history:tool"])
    expect(report.sections.find((s) => s.id === "system:base")).toMatchObject({ chars: 400, tokens: 100, label: "system · base prompt" })
    expect(report.sections.find((s) => s.id === "system:skills")).toMatchObject({ chars: 0, tokens: 0 })
    expect(report.sections.find((s) => s.id === "history:user")).toMatchObject({ chars: 0, count: 0 })
    expect(report.largest).toEqual([])
    expect(report.images).toBe(0)
    expect(report.measuredTokens).toBeUndefined()
    expect(report.compactAtTokens).toBe(160_000)
  })

  test("history is sized by role, sections sum to the estimate and tools are counted", async () => {
    const engine = makeEngine([call({ text: "abc" }), stop("done answer")])
    const sessionId = ids("session")
    await engine.runTurn(turnInput(sessionId, "please echo abc"))
    const report = await engine.contextReport!(sessionId)
    const byId = Object.fromEntries(report.sections.map((s) => [s.id, s]))
    expect(byId["history:user"]).toMatchObject({ count: 1, chars: "please echo abc".length })
    expect(byId["history:assistant"]).toMatchObject({ count: 2 })
    expect(byId["history:assistant"]!.chars).toBe("done answer".length + "echo".length + JSON.stringify({ text: "abc" }).length)
    expect(byId["history:tool"]).toMatchObject({ count: 1, chars: "echo".length + "echoed abc".length })
    expect(byId.tools!.count).toBe(4)
    expect(byId.tools!.chars).toBeGreaterThan(200)
    expect(report.estimatedTokens).toBe(report.sections.reduce((sum, s) => sum + s.tokens, 0))
    expect(byId["history:user"]!.tokens).toBe(estimateTokens("please echo abc".length))
    expect(report.sections.every((section) => section.tokens === estimateTokens(section.chars))).toBe(true)
  })

  test("largest messages are ranked by size with role and a 60 char preview", async () => {
    const long = "word ".repeat(200)
    const engine = makeEngine([stop("short"), stop("ok")])
    const sessionId = ids("session")
    await engine.runTurn(turnInput(sessionId, long))
    await engine.runTurn(turnInput(sessionId, "tiny"))
    const report = await engine.contextReport!(sessionId)
    expect(report.largest.length).toBe(4)
    expect(report.largest[0]).toMatchObject({ role: "user", chars: long.length })
    expect(report.largest[0]!.preview.length).toBeLessThanOrEqual(60)
    expect(report.largest[0]!.preview.endsWith("…")).toBe(true)
    expect(report.largest.map((m) => m.chars)).toEqual([...report.largest.map((m) => m.chars)].sort((a, b) => b - a))
  })

  test("more than five messages report only the five largest", async () => {
    const engine = makeEngine(Array.from({ length: 4 }, () => stop("a")))
    const sessionId = ids("session")
    for (let i = 0; i < 4; i++) await engine.runTurn(turnInput(sessionId, `q${i}`))
    expect((await engine.contextReport!(sessionId)).largest.length).toBe(5)
  })

  test("attached images are counted separately from text", async () => {
    const engine = makeEngine([stop("ok")])
    const sessionId = ids("session")
    const ref = { sha256: "a".repeat(64), bytes: 10, mime: "image/png" } as TurnInput["attachments"][number]
    await engine.runTurn(turnInput(sessionId, "look", [ref, ref]))
    const report = await engine.contextReport!(sessionId)
    expect(report.images).toBe(2)
    expect(report.sections.find((s) => s.id === "history:user")!.chars).toBe("look".length)
  })

  test("measured tokens come from the last model call and the threshold from options", async () => {
    const engine = makeEngine([stop("ok")], 5_000)
    const sessionId = ids("session")
    await engine.runTurn(turnInput(sessionId, "hi"))
    const report = await engine.contextReport!(sessionId)
    expect(report.measuredTokens).toBe(1_050)
    expect(report.compactAtTokens).toBe(5_000)
  })

  test("without systemParts the whole prompt is one section", async () => {
    const engine = createNativeEngine({ provider: scripted([]), tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "x".repeat(8), compactionPrompt: "s" })
    const report = await engine.contextReport!(ids("session"))
    expect(report.sections[0]).toMatchObject({ id: "system:system", chars: 8, tokens: 2 })
  })
})

describe("UI-8 context attribution", () => {
  test("MCP and custom-agent slices move tokens out of tools, preserving the total", async () => {
    const mcp = defineTool({ ...echoTool, name: "mcp__local__echo" })
    const engine = createNativeEngine({ provider: scripted([]), tools: [echoTool], subagents: true, history: memoryHistory(), cwdFor: () => "/repo", system: () => "BASE", systemParts: () => [
      { id: "base", label: "base", text: "BASE" },
      { id: "skills", label: "skills", text: "S".repeat(40), count: 2 },
      { id: "memory", label: "memory", text: "M".repeat(20), count: 1 },
    ], compactionPrompt: "s", projectTools: async () => [mcp], agents: {
      primary: () => ({ name: "review", description: "Review", mode: "primary", prompt: "Review carefully" }),
      subagents: () => [{ name: "inspect", description: "Inspect local files", mode: "subagent", prompt: "Inspect" }],
    } })
    const report = await engine.contextReport!(ids("session"))
    expect(report.categories!.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(report.estimatedTokens)
    const category = (id: string) => report.categories!.find((entry) => entry.id === id)!
    expect(category("mcp").count).toBe(1)
    expect(category("mcp").tokens).toBeGreaterThan(0)
    expect(category("agents").count).toBe(2)
    expect(category("skills")).toMatchObject({ count: 2, tokens: 10 })
    expect(category("memory")).toMatchObject({ count: 1, tokens: 5 })
    expect(category("tools").tokens).toBeLessThan(report.sections.find((entry) => entry.id === "tools")!.tokens)
    expect(report.mcpTools![0]!.id).toBe("mcp__local__echo")
  })

  test("re-reads are based on completed successful read calls in retained history", async () => {
    const history = memoryHistory()
    const sessionId = ids("session")
    await history.save(sessionId, [
      { role: "assistant", content: "", toolCalls: [
        { callId: "a", name: "read", args: { path: "src/a.ts" } },
        { callId: "b", name: "read", args: { path: "src/a.ts" } },
        { callId: "c", name: "read", args: { path: "src/a.ts" } },
        { callId: "d", name: "read", args: { path: "src/b.ts" } },
      ] },
      { role: "tool", name: "read", callId: "a", output: "x".repeat(396), isError: false },
      { role: "tool", name: "read", callId: "b", output: "x".repeat(396), isError: false },
      { role: "tool", name: "read", callId: "c", output: "error", isError: true },
      { role: "tool", name: "read", callId: "d", output: "y", isError: false },
    ])
    const engine = createNativeEngine({ provider: scripted([]), tools: [], history, cwdFor: () => "/repo", system: () => "BASE", compactionPrompt: "s" })
    const report = await engine.contextReport!(sessionId)
    expect(report.repeatedReads).toEqual([{ path: "src/a.ts", count: 2, tokens: 200 }])
    expect(report.categories!.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(report.estimatedTokens)
  })

  test("context rent lists every offered tool schema with its owner and how often it was called", async () => {
    const mcpTool = defineTool({ name: "mcp__github__search", description: "search issues ".repeat(40), permission: "read", args: z.object({ query: z.string() }), execute: async () => ({ output: "none", truncated: false, title: "search", isError: false }) })
    const engine = createNativeEngine({ provider: scripted([call({ text: "abc" }), stop("done")]), tools: [echoTool, mcpTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const sessionId = ids("session")
    await engine.runTurn(turnInput(sessionId, "echo abc"))
    const report = await engine.contextReport!(sessionId)
    const rent = report.rent!
    expect(rent.find((entry) => entry.tool === "echo")).toMatchObject({ owner: "built-in", uses: 1 })
    expect(rent.find((entry) => entry.tool === "mcp__github__search")).toMatchObject({ owner: "mcp:github", uses: 0 })
    expect(rent[0]!.tool).toBe("mcp__github__search")
    expect(rent.map((entry) => entry.tokens)).toEqual([...rent.map((entry) => entry.tokens)].sort((a, b) => b - a))
    expect(rent.reduce((sum, entry) => sum + entry.tokens, 0)).toBeGreaterThan(0)
    // Tools a tier turned off are not offered, so they are not rented at all.
    expect(rent.length).toBe(report.sections.find((section) => section.id === "tools")!.count!)
  })
})
