import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { EngineRequest, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type WorkflowTaskExecution } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "../src"
import { workflowToolDenied } from "../src/workflow-policy"

const ids = createIdFactory()
const execution = (extra: Partial<WorkflowTaskExecution> = {}): WorkflowTaskExecution => ({ directory: "/tmp", workspace: { mode: "in-place" }, permission: "ask", readOnly: false, ...extra })

function harness(policy: WorkflowTaskExecution, steps: ModelEvent[][], exhausted?: () => string | undefined, children?: { reserveChild: () => boolean; subagents: boolean }, projectTools: Tool[] = []) {
  const requests: ModelRequest[] = []
  const asked: EngineRequest[] = []
  const wrote: string[] = []
  const write = defineTool({ name: "write", description: "Write", permission: "write", args: z.object({ path: z.string() }), execute: async ({ path }) => { wrote.push(path); return { output: "wrote", title: "write", truncated: false, isError: false } } })
  const engine = createNativeEngine({ ...(children?.subagents ? { subagents: true, tasks: { nests: () => true, isChild: () => true } as unknown as NonNullable<Parameters<typeof createNativeEngine>[0]["tasks"]> } : {}), provider: { id: "fake", model: "base", async *stream(request) { requests.push(request); yield* steps.shift() ?? [] } }, history: memoryHistory(), tools: [write], projectTools: async () => projectTools, hostedTools: () => ["web_search"], cwdFor: () => "/tmp", system: () => "test", compactionPrompt: "summarize", permissionPolicy: () => ({ permission: "allow" }), modelFor: () => ({ model: "main", variant: "fast" }) })
  const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "Do the task", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, permissionMode: () => "full", setPermissionMode: () => {}, ask: async (request) => { asked.push(request); return { kind: "deny" } }, workflow: { execution: policy, beforeCall: exhausted ?? (() => undefined), reserveChild: children?.reserveChild ?? (() => false) } }
  return { engine, input, requests, asked, wrote }
}
const done: ModelEvent[] = [{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }]
const write: ModelEvent[] = [{ type: "tool_call", call: { callId: "write-1", name: "write", args: { path: "/tmp/a" } } }, { type: "finish", reason: "tool_calls" }]

describe("B45 native workflow policies", () => {
  test("explicit workflow task model/variant beats global role and agent model", async () => {
    const h = harness(execution({ model: { model: "task", variant: "deep", effort: "high", parameters: { temperature: 0 } } }), [done])
    expect(await h.engine.runTurn(h.input)).toMatchObject({ status: "ok" })
    expect(h.requests[0]).toMatchObject({ model: "task", effort: "high", parameters: { temperature: 0 } })
  })

  test("read-only stays read-only even if the session is full and global rules allow everything", async () => {
    const h = harness(execution({ readOnly: true, workspace: { mode: "read-only" } }), [write, done])
    await h.engine.runTurn(h.input)
    expect(h.wrote).toEqual([])
    expect(h.requests[0]?.tools.some((tool) => tool.name === "write")).toBe(false)
    expect(h.asked).toHaveLength(0)
  })

  test("a read-only task is offered and may call the project's MCP tool that declares read-only, and no other", async () => {
    const calls: string[] = []
    const mcp = (name: string, readOnlyHint: boolean) => ({ ...defineTool({ name, description: name, permission: "execute", args: z.object({}), execute: async () => { calls.push(name); return { output: "ok", title: name, truncated: false, isError: false } } }), ...(readOnlyHint ? { readOnlyHint } : {}) }) as Tool
    const call = (name: string): ModelEvent[] => [{ type: "tool_call", call: { callId: `${name}-1`, name, args: {} } }, { type: "finish", reason: "tool_calls" }]
    const h = harness(execution({ readOnly: true, workspace: { mode: "read-only" }, permissions: { mode: "report-only", allowEdits: false, allowMutatingCommands: false, allowExternalSend: false } }), [call("mcp__dev__peek"), call("mcp__dev__poke"), done], undefined, undefined, [mcp("mcp__dev__peek", true), mcp("mcp__dev__poke", false)])
    await h.engine.runTurn(h.input)
    const offered = h.requests[0]?.tools.map((tool) => tool.name) ?? []
    expect(offered).toContain("mcp__dev__peek")
    expect(offered).not.toContain("mcp__dev__poke")
    expect(calls).toEqual(["mcp__dev__peek"])
  })

  test("approvalRequiredFor cannot be bypassed by full mode or a global allow rule", async () => {
    const h = harness(execution({ permissions: { mode: "normal", approvalRequiredFor: ["edit"] } }), [write])
    await h.engine.runTurn(h.input)
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]?.detail).toContain("Workflow policy requires approval")
    expect(h.wrote).toHaveLength(0)
  })

  test("a tool allowlist is enforced against hallucinated calls", async () => {
    const h = harness(execution({ permissions: { mode: "custom", allowedTools: [] } }), [write, done])
    await h.engine.runTurn(h.input)
    expect(h.requests[0]?.tools).toHaveLength(0)
    expect(h.wrote).toHaveLength(0)
  })

  test("hosted tools requiring approval are withheld from the provider", async () => {
    const h = harness(execution({ permissions: { mode: "normal", approvalRequiredFor: ["web_search"] } }), [done])
    await h.engine.runTurn(h.input)
    expect(h.requests[0]?.hostedTools ?? []).toEqual([])
  })

  test("exhausted budget makes no provider call", async () => {
    const h = harness(execution({ budget: { maxTurns: 0 } }), [done], () => "model-call budget exhausted")
    expect(await h.engine.runTurn(h.input)).toMatchObject({ status: "error", message: expect.stringContaining("budget exhausted") })
    expect(h.requests).toHaveLength(0)
  })

  test("a task call whose effort and variant differ is rejected before it takes a workflow child slot", async () => {
    let slots = 1
    const reserveChild = () => slots-- > 0
    const call = (callId: string, args: Record<string, unknown>): ModelEvent[] => [{ type: "tool_call", call: { callId, name: "task", args } }, { type: "finish", reason: "tool_calls" }]
    const h = harness(execution({ budget: { maxChildren: 1, maxDepth: 2 } }), [call("t-1", { description: "d", prompt: "p", effort: "high", variant: "low" }), call("t-2", { description: "d", prompt: "p", agent: "?" }), done], undefined, { reserveChild, subagents: true })
    await h.engine.runTurn(h.input)
    expect(slots).toBe(0)
    expect(JSON.stringify(h.requests[1]?.messages)).toContain("differ")
    expect(JSON.stringify(h.requests[2]?.messages)).not.toContain("budget exhausted")
  })

  test("a tool that declares itself read-only stays available to a read-only task and under the no-send, no-command policies", () => {
    const readOnly = execution({ readOnly: true, permissions: { mode: "report-only", allowEdits: false, allowMutatingCommands: false, allowExternalSend: false } })
    expect(workflowToolDenied(readOnly, "mcp__device__status", "execute")).toBeDefined()
    expect(workflowToolDenied(readOnly, "mcp__device__status", "execute", true)).toBeUndefined()
    expect(workflowToolDenied(readOnly, "mcp__device__status", undefined, true)).toBeUndefined()
    expect(workflowToolDenied(readOnly, "shell", "execute", true)).toBeDefined()
  })

  test("read-only blocks plan exit, child creation, shell, external sends and arbitrary custom writes", () => {
    for (const name of ["plan_exit", "plan_submit", "task", "loop", "shell", "mcp__mail__send", "tell", "custom__write"]) expect(workflowToolDenied(execution({ readOnly: true }), name)).toBeDefined()
    expect(workflowToolDenied(execution({ readOnly: true }), "custom", "write")).toBeDefined()
    expect(workflowToolDenied(execution({ permissions: { mode: "normal", allowExternalSend: false } }), "mcp__read")).toBeDefined()
    expect(workflowToolDenied(execution({ budget: { maxDepth: 1 } }), "task")).toBeDefined()
  })
})
