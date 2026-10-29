import { describe, expect, test } from "bun:test"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest, type RunLimits } from "../src"

const ids = createIdFactory()

function scripted(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  return { provider, requests }
}

const named = (name: string, output = name) => defineTool({ name, description: name, permission: "read", args: z.object({}), execute: async () => ({ output, truncated: false, title: name, isError: false }) })
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const call = (name: string): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args: {} } }, { type: "finish", reason: "tool_calls" }]

function input(sessionId = ids("session")) {
  const events: EngineEvent[] = []
  const turn: TurnInput = {
    permissionMode: () => "ask", setPermissionMode: () => {}, sessionId, turnId: ids("turn"), text: "go", attachments: [],
    signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }),
  }
  return { turn, events }
}

function engineWith(limits: RunLimits | undefined, provider: ModelProvider, tools = [named("read"), named("shell"), named("webfetch"), named("grep")]) {
  return createNativeEngine({ provider, tools, history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", runLimits: () => limits })
}

const offered = (request: ModelRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name).filter((name) => !name.startsWith("plan_"))

describe("scripted-run limits", () => {
  test("--tools keeps only the listed tools; --no-tools offers none", async () => {
    const allowed = scripted([stop("ok")])
    await engineWith({ tools: ["read", "grep"] }, allowed.provider).runTurn(input().turn)
    expect(offered(allowed.requests[0])).toEqual(["read", "grep"])
    const none = scripted([stop("ok")])
    await engineWith({ tools: [] }, none.provider).runTurn(input().turn)
    expect(offered(none.requests[0])).toEqual([])
  })

  test("a tool outside the allow-list is unavailable even if the model calls it", async () => {
    const { provider } = scripted([call("shell"), stop("done")])
    const run = input()
    await engineWith({ tools: ["read"] }, provider).runTurn(run.turn)
    const failed = run.events.find((event) => event.type === "item.completed" && event.text?.includes("unknown tool"))
    expect(failed).toBeDefined()
  })

  test("--exclude-tools and --offline remove tools; globs work; nothing is ever added", async () => {
    const excluded = scripted([stop("ok")])
    await engineWith({ excludeTools: ["shell"] }, excluded.provider).runTurn(input().turn)
    expect(offered(excluded.requests[0])).toEqual(["read", "webfetch", "grep"])
    const offline = scripted([stop("ok")])
    await engineWith({ offline: true }, offline.provider).runTurn(input().turn)
    expect(offered(offline.requests[0])).toEqual(["read", "shell", "grep"])
    const globbed = scripted([stop("ok")])
    await engineWith({ tools: ["*"], excludeTools: ["web*"] }, globbed.provider).runTurn(input().turn)
    expect(offered(globbed.requests[0])).toEqual(["read", "shell", "grep"])
    const unknown = scripted([stop("ok")])
    await engineWith({ tools: ["read", "not_a_tool"] }, unknown.provider).runTurn(input().turn)
    expect(offered(unknown.requests[0])).toEqual(["read"])
  })

  test("--max-turns stops a model that keeps calling tools with code max_steps", async () => {
    const { provider, requests } = scripted([call("read"), call("read"), call("read"), call("read"), stop("never")])
    const outcome = await engineWith({ maxSteps: 2 }, provider).runTurn(input().turn)
    expect(outcome).toMatchObject({ status: "error", code: "max_steps" })
    expect(requests).toHaveLength(2)
  })

  test("without limits nothing changes", async () => {
    const { provider, requests } = scripted([stop("ok")])
    await engineWith(undefined, provider).runTurn(input().turn)
    expect(offered(requests[0])).toEqual(["read", "shell", "webfetch", "grep"])
  })

  test("shell calls see their session, model and project in the environment", async () => {
    const sessionId = ids("session")
    const shell = defineTool({ name: "shell", description: "shell", permission: "read", args: z.object({}), execute: async (_args, context) => ({ output: [context.environment?.MENDCODE_SESSION_ID, context.environment?.MENDCODE_MODEL, context.environment?.MENDCODE_PROJECT_DIR].join("|"), truncated: false, title: "shell", isError: false }) })
    const { provider, requests } = scripted([call("shell"), stop("done")])
    await engineWith(undefined, provider, [shell]).runTurn(input(sessionId).turn)
    const result = requests[1]!.messages.find((message) => message.role === "tool")
    expect(result && "output" in result ? result.output : "").toContain(`${sessionId}|script-1|/repo`)
  })
})
