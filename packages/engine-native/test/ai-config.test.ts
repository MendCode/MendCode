import { expect, test } from "bun:test"
import { createIdFactory, type AIConfigReport, type PermissionMode } from "@mendcode/protocol"
import type { EngineEvent, EngineRequest, TurnInput } from "@mendcode/kernel"
import { aiConfigTool, runTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelProvider } from "../src"

const ids = createIdFactory()
const inspect: AIConfigReport = { action: "inspect", version: 1, models: [], roles: {}, configSources: [], effective: { compactAtTokens: null }, missingInformation: [], advisor: "off" }
const patch = { description: "Local recipe", roles: { main: { model: "local" } } }
const applying = { action: "apply", scope: "project", patch, target: "/tmp/project/.mendcode/recipes/repair.json", expectedHash: "a".repeat(64) }

async function run(args: unknown, mode: PermissionMode, approve = false) {
  const asked: EngineRequest[] = []
  const events: EngineEvent[] = []
  const actions: string[] = []
  let steps = 0
  const provider: ModelProvider = { id: "local-fake", model: "local", async *stream() {
    if (steps++ === 0) { yield { type: "tool_call", call: { callId: ids("item"), name: "ai_config", args } }; yield { type: "finish", reason: "tool_calls" } }
    else { yield { type: "text", delta: "done" }; yield { type: "finish", reason: "stop" } }
  } }
  const engine = createNativeEngine({ provider, tools: [aiConfigTool], history: memoryHistory(), cwdFor: () => "/tmp/project", system: () => "Local fake", compactionPrompt: "Summarize", aiConfig: () => ({ run(input) { actions.push(input.action); return input.action === "validate" ? { action: "validate", valid: true, issues: [], warnings: [], target: { scope: "project", path: applying.target, exists: false, writable: true, digest: applying.expectedHash }, patch, diff: ["+ roles.main: local"] } : inspect } }) })
  const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "Review local AI configuration", attachments: [], signal: new AbortController().signal, permissionMode: () => mode, setPermissionMode() {}, newItemId: () => ids("item"), emit: (event) => { events.push(event) }, ask: async (request) => { asked.push(request); return approve ? { kind: "approve", scope: "once" } : { kind: "deny" } } }
  await engine.runTurn(input)
  return { asked, events, actions }
}

test("B70 inspect is a real read tool in plan mode without asking or mutating", async () => {
  const h = await run({ action: "inspect" }, "plan")
  expect(h.asked).toEqual([])
  expect(h.actions).toEqual(["inspect"])
  expect(h.events.some((event) => event.type === "item.completed" && event.status === "ok")).toBe(true)
})

test("B70 plan mode refuses apply; denied apply cannot reach the daemon port", async () => {
  const planned = await run(applying, "plan")
  expect(planned.actions).toEqual([])
  expect(planned.asked).toEqual([])
  const denied = await run(applying, "ask")
  expect(denied.actions).toEqual(["validate"])
  expect(denied.asked).toMatchObject([{ kind: "approval", tool: "ai_config", permission: "write" }])
  expect((denied.asked[0] as { detail: string }).detail).toContain("+ roles.main: local")
})

test("B70 approved apply receives the causal port; global save still asks in edits mode", async () => {
  expect((await run(applying, "ask", true)).actions).toEqual(["validate", "apply"])
  const global = await run({ ...applying, scope: "global" }, "edits")
  expect(global.actions).toEqual(["validate"])
  expect(global.asked).toMatchObject([{ tool: "ai_config", permission: "execute" }])
})

test("B70 unavailable/cancelled tools and invalid arguments settle without a host call", async () => {
  expect(await runTool(aiConfigTool, { action: "inspect" }, { cwd: "/tmp", signal: new AbortController().signal })).toMatchObject({ isError: true, output: "AI configuration is unavailable here" })
  const abort = new AbortController()
  abort.abort()
  expect(await runTool(aiConfigTool, { action: "inspect" }, { cwd: "/tmp", signal: abort.signal, aiConfig: { run() { throw new Error("must not run") } } })).toMatchObject({ isError: true, output: "AI configuration cancelled" })
  expect(await runTool(aiConfigTool, { ...applying, expectedHash: "stale" }, { cwd: "/tmp", signal: abort.signal })).toMatchObject({ isError: true })
})
