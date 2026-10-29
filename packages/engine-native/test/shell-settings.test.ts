import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory } from "@mendcode/protocol"
import { defineTool, type ToolContext } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider } from "../src"

const ids = createIdFactory()
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const call = (name: string): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args: {} } }, { type: "finish", reason: "tool_calls" }]

function scripted(steps: ModelEvent[][]): ModelProvider {
  return { id: "scripted", model: "script-1", async *stream() { const step = steps.shift(); if (!step) throw new Error("script exhausted"); yield* step } }
}

function turn(): TurnInput {
  const events: EngineEvent[] = []
  return {
    permissionMode: () => "ask", setPermissionMode: () => {}, sessionId: ids("session"), turnId: ids("turn"), text: "go", attachments: [],
    signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }),
  }
}

const saved = { ...process.env }
beforeEach(() => { process.env.MC_TEST_OPENAI_API_KEY = "secret"; process.env.MC_TEST_PLAIN = "plain" })
afterEach(() => { for (const name of ["MC_TEST_OPENAI_API_KEY", "MC_TEST_PLAIN"]) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } })

describe("engine applies shell and web settings", () => {
  test("shell calls get the filtered environment, the prefix and login flag; other tools do not", async () => {
    const seen: ToolContext[] = []
    const probe = (name: string) => defineTool({ name, description: name, permission: "read", args: z.object({}), execute: async (_args, context) => { seen.push(context); return { output: "ok", truncated: false, title: name, isError: false } } })
    const engine = createNativeEngine({
      provider: scripted([call("shell"), call("read"), stop("done")]), tools: [probe("shell"), probe("read")], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "x",
      shellSettings: () => ({ environment: { inherit: "all", exclude: ["MC_TEST_PLAIN"], set: { CI: "1" } }, policy: { prefix: "set -e", login: true } }),
    })
    await engine.runTurn(turn())
    const [shell, read] = seen
    expect(shell?.environment?.MC_TEST_OPENAI_API_KEY).toBeUndefined()
    expect(shell?.environment?.MC_TEST_PLAIN).toBeUndefined()
    expect(shell?.environment?.CI).toBe("1")
    expect(shell?.environment?.PATH).toBe(process.env.PATH)
    expect(shell?.shellPolicy).toEqual({ prefix: "set -e", login: true })
    expect(read?.shellPolicy).toBeUndefined()
  })

  test("a shell command addresses the daemon's data directory, even under a policy that drops the inherited environment", async () => {
    const seen: Record<string, ToolContext> = {}
    const probe = (name: string) => defineTool({ name, description: name, permission: "read", args: z.object({}), execute: async (_args, context) => { seen[name] = context; return { output: "ok", truncated: false, title: name, isError: false } } })
    const engine = createNativeEngine({
      provider: scripted([call("shell"), call("read"), stop("done")]), tools: [probe("shell"), probe("read")], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "x",
      shellSettings: () => ({ environment: { inherit: "none" }, dataDir: "/srv/mend-data" }),
    })
    await engine.runTurn(turn())
    expect(seen.shell?.environment?.MENDCODE_V2_DIR).toBe("/srv/mend-data")
    expect(seen.read?.environment?.MENDCODE_V2_DIR).toBe(process.env.MENDCODE_V2_DIR)
  })

  test("without a policy the environment is untouched, and web rules reach only webfetch and websearch", async () => {
    const seen: Record<string, ToolContext> = {}
    const probe = (name: string) => defineTool({ name, description: name, permission: "read", args: z.object({}), execute: async (_args, context) => { seen[name] = context; return { output: "ok", truncated: false, title: name, isError: false } } })
    const engine = createNativeEngine({
      provider: scripted([call("shell"), call("webfetch"), call("read"), stop("done")]), tools: [probe("shell"), probe("webfetch"), probe("read")], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "x",
      shellSettings: () => ({ policy: {} }), web: () => ({ blockDomains: ["bad.com"] }),
    })
    await engine.runTurn(turn())
    expect(seen.shell?.environment?.MC_TEST_OPENAI_API_KEY).toBe("secret")
    expect(seen.shell?.shellPolicy).toBeUndefined()
    expect(seen.webfetch?.web).toEqual({ blockDomains: ["bad.com"] })
    expect(seen.read?.web).toBeUndefined()
  })
})
