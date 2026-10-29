import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { EngineRequest, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type WorkflowTaskExecution } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "../src"
import { workflowToolDenied } from "../src/workflow-policy"

const ids = createIdFactory()
const execution = (extra: Partial<WorkflowTaskExecution> = {}): WorkflowTaskExecution => ({ directory: "/tmp", workspace: { mode: "in-place" }, permission: "ask", readOnly: false, ...extra })

function harness(policy: WorkflowTaskExecution, steps: ModelEvent[][], exhausted?: () => string | undefined) {
  const requests: ModelRequest[] = []
  const asked: EngineRequest[] = []
  const wrote: string[] = []
  const write = defineTool({ name: "write", description: "Write", permission: "write", args: z.object({ path: z.string() }), execute: async ({ path }) => { wrote.push(path); return { output: "wrote", title: "write", truncated: false, isError: false } } })
  const engine = createNativeEngine({ provider: { id: "fake", model: "base", async *stream(request) { requests.push(request); yield* steps.shift() ?? [] } }, history: memoryHistory(), tools: [write], hostedTools: () => ["web_search"], cwdFor: () => "/tmp", system: () => "test", compactionPrompt: "summarize", permissionPolicy: () => ({ permission: "allow" }), modelFor: () => ({ model: "main", variant: "fast" }) })
  const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "Do the task", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, permissionMode: () => "full", setPermissionMode: () => {}, ask: async (request) => { asked.push(request); return { kind: "deny" } }, workflow: { execution: policy, beforeCall: exhausted ?? (() => undefined), reserveChild: () => false } }
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

  test("read-only blocks plan exit, child creation, shell, external sends and arbitrary custom writes", () => {
    for (const name of ["plan_exit", "plan_submit", "task", "loop", "shell", "mcp__mail__send", "tell", "custom__write"]) expect(workflowToolDenied(execution({ readOnly: true }), name)).toBeDefined()
    expect(workflowToolDenied(execution({ readOnly: true }), "custom", "write")).toBeDefined()
    expect(workflowToolDenied(execution({ permissions: { mode: "normal", allowExternalSend: false } }), "mcp__read")).toBeDefined()
    expect(workflowToolDenied(execution({ budget: { maxDepth: 1 } }), "task")).toBeDefined()
  })
})
