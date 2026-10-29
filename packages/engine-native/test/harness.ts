import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import type { ModelEvent, ModelProvider, ModelRequest } from "../src"

export const ids = createIdFactory()

/** Replays one scripted response per model call and records every request it received. */
export function scriptedProvider(steps: Array<ModelEvent[] | Error | ((request: ModelRequest) => AsyncIterable<ModelEvent>)>) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      if (step instanceof Error) throw step
      if (typeof step === "function") return yield* step(request)
      yield* step
    },
  }
  return { provider, requests }
}

export const echoTool = defineTool({
  name: "echo",
  description: "echo text",
  permission: "read",
  args: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ output: `echoed ${text}`, truncated: false, title: "echo", isError: false }),
})

export function writeTool(log: string[]): Tool {
  return defineTool({
    name: "write",
    description: "write a file",
    permission: "write",
    args: z.object({ path: z.string() }),
    execute: async ({ path }) => (log.push(path), { output: `wrote ${path}`, truncated: false, title: `Write ${path}`, isError: false }),
  })
}

export function turn(options: { text: string; answers?: EngineResolution[]; signal?: AbortSignal; sessionId?: ReturnType<typeof ids<"session">>; mode?: () => PermissionMode; onModeChange?: (mode: PermissionMode) => void }) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const answers = [...(options.answers ?? [])]
  const input: TurnInput = {
    permissionMode: options.mode ?? (() => "ask"),
    setPermissionMode: (mode) => options.onModeChange?.(mode),
    sessionId: options.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: options.text,
    attachments: [],
    signal: options.signal ?? new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny" }),
  }
  return { input, events, asked }
}

export const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
export const callTool = (name: string, args: unknown, callId = ids("item")): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]
