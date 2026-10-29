import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src/engine"
import { activeToolNames } from "../src/tool-discovery"
import { callTool, scriptedProvider, stop, turn, writeTool } from "./harness"

function scenario(code: string, settings: Settings = { experimental: { code_mode: true } }, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const calls: string[] = [], history = memoryHistory()
  const { provider, requests } = scriptedProvider([callTool("code", { code }), stop("done")])
  const read = defineTool({ name: "read", description: "read", permission: "read", args: z.strictObject({ path: z.string() }), execute: async ({ path }) => {
    calls.push(`read:${path}`)
    return { output: JSON.stringify({ selected: 7, intermediate: "large intermediate tool result" }), title: path, isError: false, truncated: false, loadedInstructions: ["/work/AGENTS.md"] }
  } })
  const engine = createNativeEngine({ provider, history, tools: [read, writeTool(calls)], cwdFor: () => tmpdir(), system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings, ...extra })
  return { engine, calls, history, requests, settings }
}
const resultOf = (s: ReturnType<typeof scenario>) => {
  const message = s.requests.at(-1)!.messages.findLast((message) => message.role === "tool" && message.name === "code")!
  if (message.role !== "tool") throw new Error("missing code result")
  return message
}

describe("native permission-preserving Code Mode", () => {
  test("off/unset offer no interpreter, on is independent from secondary discovery", async () => {
    for (const enabled of [undefined, false, true]) {
      const s = scenario('return 7', enabled === undefined ? {} : { experimental: { code_mode: enabled } })
      await s.engine.runTurn(turn({ text: "go" }).input)
      expect(s.requests[0]!.tools.some((tool) => tool.name === "code")).toBe(enabled === true)
      expect(resultOf(s).isError).toBe(enabled !== true)
      if (enabled) expect(JSON.parse(resultOf(s).output)).toMatchObject({ ok: true, value: 7 })
    }
  })

  test("nested calls have durable parent-linked items, but only selected final data enters model history", async () => {
    const s = scenario('const value = await tools.read({path: "a.ts"}); console.log("selected"); return JSON.parse(value.output).selected')
    const t = turn({ text: "read" })
    expect(await s.engine.runTurn(t.input)).toMatchObject({ status: "ok" })
    expect(s.calls).toEqual(["read:a.ts"])
    expect(JSON.parse(resultOf(s).output)).toMatchObject({ ok: true, value: 7, logs: ["selected"] })
    expect(JSON.stringify(s.requests[1]!.messages)).not.toContain("large intermediate")
    expect(resultOf(s).loadedInstructions).toEqual(["/work/AGENTS.md"])
    const starts = t.events.filter((event) => event.type === "item.started" && event.kind === "tool_call")
    expect(starts).toHaveLength(2)
    expect(starts[1]!.type === "item.started" && starts[1]!.meta?.parentItemId).toBe(starts[0]!.type === "item.started" && starts[0]!.itemId)
    const nested = t.events.find((event) => event.type === "item.completed" && event.itemId === (starts[1]!.type === "item.started" && starts[1]!.itemId))
    expect(nested?.type === "item.completed" && nested.meta?.parentItemId).toBe(starts[0]!.type === "item.started" && starts[0]!.itemId)
  })

  test("write approval and plan caps apply to nested tools, never to a blanket orchestration grant", async () => {
    const code = 'await tools.write({path: "a.ts"}); return 1'
    const approved = scenario(code)
    const yes = turn({ text: "write", answers: [{ kind: "approve", scope: "once" }] })
    await approved.engine.runTurn(yes.input)
    expect(yes.asked.map((request) => request.tool)).toEqual(["write"])
    expect(approved.calls).toEqual(["a.ts"])
    const denied = scenario(code)
    const no = turn({ text: "write", answers: [{ kind: "deny", reason: "no writes" }] })
    await denied.engine.runTurn(no.input)
    expect(denied.calls).toEqual([])
    expect(no.asked.map((request) => request.tool)).toEqual(["write"])
    expect(denied.requests).toHaveLength(1)
    const planned = scenario(code)
    const plan = turn({ text: "investigate", mode: () => "plan" })
    await planned.engine.runTurn(plan.input)
    expect(planned.calls).toEqual([])
    expect(plan.asked).toEqual([])
    expect(resultOf(planned).output).toContain("plan mode is read-only")
  })

  test("global, path, agent and live policy denials cannot be bypassed through tools", async () => {
    for (const settings of [{ tools: { read: false } }, { permission: { read: { "*": "deny" } } }] satisfies Settings[]) {
      const s = scenario('return await tools.read({path: "private.ts"})', { ...settings, experimental: { code_mode: true } })
      await s.engine.runTurn(turn({ text: "read", mode: () => "full" }).input)
      expect(s.calls).toEqual([])
      expect(resultOf(s).isError).toBe(true)
    }
    const agent = scenario('return await tools.read({path: "a.ts"})', { experimental: { code_mode: true } }, { agents: { primary: () => ({ name: "limited", description: "limited", prompt: "", mode: "primary", tools: ["code"] }), subagents: () => [] } })
    await agent.engine.runTurn(turn({ text: "read" }).input)
    expect(agent.calls).toEqual([])
    const live: Settings = { experimental: { code_mode: true } }
    const s = scenario('await tools.read({path: "a.ts"}); return await tools.read({path: "b.ts"})', live, {
      hooks: { has: (hook) => hook === "tool.after", toolAfter: async () => { live.tools = { read: false } } },
    })
    await s.engine.runTurn(turn({ text: "read" }).input)
    expect(s.calls).toEqual(["read:a.ts"])
    expect(resultOf(s).output).toContain("unknown tool: read")
  })

  test("validates nested inputs, rechecks extension rewrites and records thrown host failures", async () => {
    const invalid = scenario('return await tools.read({path: 1})')
    await invalid.engine.runTurn(turn({ text: "read" }).input)
    expect(invalid.calls).toEqual([])
    expect(JSON.parse(resultOf(invalid).output)).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" } })
    const rewritten = scenario('return await tools.write({path: "a.ts"})', { experimental: { code_mode: true }, permission: { edit: { "*": "allow", "*private.ts": "deny" } } }, {
      hooks: { has: (hook) => hook === "tool.before", toolBefore: async () => ({ args: { path: "private.ts" } }) },
    })
    await rewritten.engine.runTurn(turn({ text: "write", mode: () => "full" }).input)
    expect(rewritten.calls).toEqual([])
    expect(resultOf(rewritten).output).toContain("rewritten call denied")
    const failed = scenario('return await tools.crash({})', { experimental: { code_mode: true } }, { tools: [defineTool({ name: "crash", description: "crash", permission: "read", args: z.object({}), execute: async () => { throw new Error("local failure") } })] })
    const t = turn({ text: "fail" })
    await failed.engine.runTurn(t.input)
    expect(resultOf(failed).output).toContain("local failure")
    expect(t.events.filter((event) => event.type === "item.completed" && event.status === "error")).toHaveLength(2)
  })

  test("local search sees filtered secondary schemas and persists discovery receipts, never raw nested output", async () => {
    const secondary = defineTool({ name: "mcp__local__symbols", description: "symbols", permission: "read", args: z.object({}), execute: async () => ({ output: "symbols: a, b", title: "symbols", isError: false, truncated: false }) })
    const s = scenario('const found = search({query: "symbols"}); const result = await tools[found.tools[0].name]({}); return result.output', { experimental: { code_mode: true, tool_discovery: true } }, { projectTools: async () => [secondary] })
    const t = turn({ text: "symbols" })
    await s.engine.runTurn(t.input)
    expect(s.requests[0]!.tools.map((tool) => tool.name)).not.toContain(secondary.name)
    expect(JSON.parse(resultOf(s).output)).toMatchObject({ ok: true, value: "symbols: a, b" })
    expect(s.requests[1]!.tools.map((tool) => tool.name)).toContain(secondary.name)
    expect(activeToolNames((await s.history.load(t.input.sessionId))!)).toEqual(new Set([secondary.name]))
  })

  test("nested repeated actions still ask doom_loop and user denial halts later calls", async () => {
    const s = scenario('for (let i = 0; i < 4; i++) { await tools.read({path: "a.ts"}) } return 1')
    const t = turn({ text: "read", answers: [{ kind: "deny", reason: "stop repeating" }] })
    await s.engine.runTurn(t.input)
    expect(s.calls).toEqual(["read:a.ts", "read:a.ts"])
    expect(t.asked[0]?.title).toBe("repeated tool action")
    expect(s.requests).toHaveLength(1)
  })

  test("code flag and agent/main-only restrictions also apply to inline children", async () => {
    const { provider, requests } = scriptedProvider([
      callTool("task", { description: "inspect", prompt: "run code" }),
      callTool("code", { code: 'return await tools.write({path: "a.ts"})' }), stop("child done"), stop("parent done"),
    ])
    const calls: string[] = []
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [writeTool(calls)], cwdFor: () => tmpdir(), system: () => "sys", compactionPrompt: "summarize", subagents: true,
      permissionPolicy: () => ({ experimental: { code_mode: true, primary_tools: ["write"] } }),
    })
    await engine.runTurn(turn({ text: "inspect", mode: () => "full" }).input)
    expect(requests[1]!.tools.map((tool) => tool.name)).toContain("code")
    expect(calls).toEqual([])
    const receipt = requests[2]!.messages.find((message) => message.role === "tool" && message.name === "code")
    expect(receipt?.role === "tool" && JSON.parse(receipt.output).ok).toBe(false)
  })

  test("built-in secret substitution stays host-side; code receives and returns masked output", async () => {
    const secret = "local-secret-value"
    let seen = ""
    const s = scenario('const result = await tools.write({content: "‹secret:1›"}); console.log(result.output); return result.output', { experimental: { code_mode: true } }, {
      tools: [defineTool({ name: "write", description: "write", permission: "write", args: z.object({ content: z.string() }), execute: async ({ content }) => { seen = content; return { output: content, title: "write", isError: false, truncated: false } } })],
      secrets: { list: () => [], resolve: (_, text) => text.replaceAll("‹secret:1›", secret), mask: (_, text) => text.replaceAll(secret, "‹secret:1›"), stream: () => undefined },
    })
    const t = turn({ text: "write", mode: () => "full" })
    await s.engine.runTurn(t.input)
    expect(seen).toBe(secret)
    expect(JSON.stringify(t.events)).not.toContain(secret)
    expect(JSON.stringify(s.requests)).not.toContain(secret)
    expect(resultOf(s).output).toContain("‹secret:1›")
  })
})
