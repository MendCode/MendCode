import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import type { TurnInput } from "@mendcode/kernel"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()
const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const echo = defineTool({ name: "echo", description: "echo", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: text, truncated: false, title: "echo", isError: false }) })

function setup(steps: ModelEvent[][], maxSteps = 20) {
  const cwd = mkdtempSync(path.join(tmpdir(), "mend-queue-native-"))
  temps.push(cwd)
  const requests: ModelRequest[] = []
  const provider: ModelProvider = { id: "local", model: "test", async *stream(request) {
    requests.push({ ...request, messages: structuredClone(request.messages) })
    const events = steps.shift()
    if (!events) throw new Error("unexpected model call")
    yield* events
  } }
  const history = memoryHistory()
  const engine = createNativeEngine({ provider, tools: [echo], history, cwdFor: () => cwd, system: () => "test", compactionPrompt: "summarize", maxSteps })
  const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "First", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit() {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode() {} }
  return { cwd, engine, input, history, requests }
}
const call: ModelEvent[] = [{ type: "tool_call", call: { callId: "echo-1", name: "echo", args: { text: "result" } } }, { type: "finish", reason: "tool_calls" }]
const stop: ModelEvent[] = [{ type: "text", delta: "Done" }, { type: "finish", reason: "stop" }]

test("joined prompts expand mentions after persisted tool results and preserve signed reasoning for the same turn", async () => {
  const reasoning = { provider: "local", model: "test", blocks: [{ signature: "local-fixture", text: "thinking" }] }
  const h = setup([[{ type: "reasoning_state", state: reasoning }, ...call], stop])
  writeFileSync(path.join(h.cwd, "note.txt"), "Keep the queue held after user cancellation.")
  let boundaries = 0
  h.input.takeQueued = async () => {
    const saved = await h.history.load(h.input.sessionId)
    expect(saved?.filter((message) => message.role === "tool")).toHaveLength(1)
    return boundaries++ === 0 ? { text: "Also read @note.txt", attachments: [], authority: { sourceId: "queued-user", text: "Also read @note.txt" } } : undefined
  }
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
  expect(h.requests[1]!.messages[1]).toMatchObject({ reasoning })
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Keep the queue held after user cancellation.") })
  expect((await h.history.load(h.input.sessionId))?.filter((message) => message.role === "user")).toHaveLength(2)
})

test("a joined notice with no authority is appended as it is, after the tool result, and the loop goes on in the same turn", async () => {
  const reasoning = { provider: "local", model: "test", blocks: [{ signature: "local-fixture", text: "thinking" }] }
  const h = setup([[{ type: "reasoning_state", state: reasoning }, ...call], stop])
  writeFileSync(path.join(h.cwd, "note.txt"), "A file the notice only names.")
  const notice = "[background task bg_1 exited 0 after 2s: bun run build]\nlast output:\nwrote @note.txt"
  let boundaries = 0
  h.input.takeQueued = async () => (boundaries++ === 0 ? { text: notice, attachments: [] } : undefined)
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  // After the tool result, and once more after the answer without tools (where only a message of the user's may join).
  expect(boundaries).toBe(3)
  expect(h.requests).toHaveLength(2)
  // The first call's messages are an unchanged prefix of the second: the notice is only added at the end.
  expect(h.requests[1]!.messages.slice(0, 1)).toEqual(h.requests[0]!.messages)
  expect(h.requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
  expect(h.requests[1]!.messages[1]).toMatchObject({ reasoning })
  expect(h.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: notice })
  expect((await h.history.load(h.input.sessionId))?.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["First", notice])
})

test("an exhausted model-step budget leaves queued prompts unconsumed for their own turn", async () => {
  const h = setup([call], 1)
  let boundaries = 0
  h.input.takeQueued = async () => { boundaries++; return { text: "next", attachments: [] } }
  expect(await h.engine.runTurn(h.input)).toMatchObject({ status: "error", code: "max_steps" })
  expect(boundaries).toBe(0)
  // The last step is the wrap-up: a tool it still asks for is refused, not run.
  expect((await h.history.load(h.input.sessionId))?.at(-1)).toMatchObject({ role: "tool", output: "agent step limit reached; tools are disabled", isError: true })
})

test("a response without tools completes when nothing joins the turn", async () => {
  const h = setup([stop])
  let boundaries = 0
  h.input.takeQueued = async () => { boundaries++; return undefined }
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  expect(boundaries).toBe(1)
  expect(h.requests).toHaveLength(1)
})

test("a prompt that joins while the final answer streams gets one more model call in the same turn", async () => {
  const h = setup([stop, [{ type: "text", delta: "Both done" }, { type: "finish", reason: "stop" }]])
  const queued = [{ text: "Second", attachments: [], authority: { sourceId: "queued-user", text: "Second" } }]
  h.input.takeQueued = async () => queued.shift()
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Second") })
  expect((await h.history.load(h.input.sessionId))?.at(-1)).toMatchObject({ role: "assistant", content: "Both done" })
})

test("a tool-free answer on the last model step never consumes a prompt it could not answer", async () => {
  const h = setup([stop], 1)
  let boundaries = 0
  h.input.takeQueued = async () => { boundaries++; return { text: "next", attachments: [] } }
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  expect(boundaries).toBe(0)
})

test("the engine's step limit ends in a summary, not a bare error: the last step is asked for text only and its answer closes the turn", async () => {
  const h = setup([call, call, stop], 3)
  expect(await h.engine.runTurn(h.input)).toEqual({ status: "ok" })
  expect(h.requests).toHaveLength(3)
  // Only the last call carries the wrap-up request; the tools ran normally before it.
  const asked = (request: ModelRequest) => request.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("step limit is reached"))
  expect(h.requests.map(asked)).toEqual([false, false, true])
  expect((await h.history.load(h.input.sessionId))?.filter((message) => message.role === "tool").map((message) => message.output)).toEqual(["result", "result"])
})
