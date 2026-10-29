import { describe, expect, test } from "bun:test"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, createProviderRouter, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest, type ReasoningState } from "../src"

const ids = createIdFactory()

function scripted(id: string, steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id,
    model: `${id}-default`,
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      yield* steps.shift() ?? []
    },
  }
  return { provider, requests }
}

const echo = defineTool({ name: "echo", description: "echo", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: `echoed ${text}`, truncated: false, title: "echo", isError: false }) })

function turn(text: string, sessionId = ids("session")) {
  const events: EngineEvent[] = []
  const input: TurnInput = {
    permissionMode: () => "ask",
    setPermissionMode: () => {},
    sessionId,
    turnId: ids("turn"),
    text,
    attachments: [],
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async () => ({ kind: "deny" }),
  }
  return { input, events }
}

const state: ReasoningState = { provider: "anthropic", model: "claude-x", blocks: [{ type: "thinking", thinking: "t", signature: "s" }] }

describe("native engine with several providers", () => {
  test("reasoning state stays on the assistant step for the tool loop, and a new user turn drops it", async () => {
    const { provider, requests } = scripted("anthropic", [
      [{ type: "reasoning_state", state }, { type: "tool_call", call: { callId: "c1", name: "echo", args: { text: "x" } } }, { type: "finish", reason: "tool_calls" }],
      [{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }],
      [{ type: "text", delta: "again" }, { type: "finish", reason: "stop" }],
    ])
    const history = memoryHistory()
    const engine = createNativeEngine({ provider, tools: [echo], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    const first = turn("hi")
    await engine.runTurn(first.input)
    const step = requests[1]!.messages.find((m) => m.role === "assistant")
    expect(step).toMatchObject({ role: "assistant", toolCalls: [{ callId: "c1" }], reasoning: state })
    await engine.runTurn(turn("more", first.input.sessionId).input)
    expect(requests[2]!.messages.some((m) => m.role === "assistant" && m.reasoning)).toBe(false)
  })

  test("usage and model come from the provider that served the call, through a router", async () => {
    const chatgpt = scripted("chatgpt", [[{ type: "text", delta: "a" }, { type: "usage", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "stop" }]])
    const anthropic = scripted("anthropic", [[{ type: "text", delta: "b" }, { type: "usage", usage: { input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "stop" }]])
    const router = createProviderRouter({ fallback: chatgpt.provider, providers: { anthropic: anthropic.provider } })
    let model: string | undefined
    const engine = createNativeEngine({ provider: router, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", modelFor: () => (model ? { model } : undefined) })
    const plain = turn("hi")
    await engine.runTurn(plain.input)
    model = "anthropic:claude-sonnet-5-5"
    const routed = turn("hi")
    await engine.runTurn(routed.input)
    const usage = (events: EngineEvent[]) => events.find((e) => e.type === "usage")
    expect(usage(plain.events)).toMatchObject({ provider: "chatgpt", model: "chatgpt-default" })
    expect(usage(routed.events)).toMatchObject({ provider: "anthropic", model: "anthropic:claude-sonnet-5-5" })
    expect(anthropic.requests[0]!.model).toBe("claude-sonnet-5-5")
  })
})
