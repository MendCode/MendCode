import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelMessage } from "../src"
import { runSnip, SNIPPED_PREFIX } from "../src/snip"
import { callTool, ids, scriptedProvider, stop, turn } from "./harness"

const big = defineTool({
  name: "big",
  description: "a tool with a long output",
  permission: "read",
  args: z.object({ name: z.string() }),
  execute: async ({ name }) => ({ output: `${name}:${"x".repeat(4_000)}`, truncated: false, title: "big", isError: false }),
})

const on: Settings = { experimental: { snip: true } }
const toolMessages = (messages: readonly ModelMessage[]) => messages.filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool")

test("snip is offered only while experimental.snip is on", async () => {
  let settings: Settings = {}
  const script = scriptedProvider([stop("Off"), stop("On")])
  const engine = createNativeEngine({ provider: script.provider, tools: [big], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", permissionPolicy: () => settings })
  const input = turn({ text: "Hello" }).input
  await engine.runTurn(input)
  settings = on
  await engine.runTurn({ ...input, turnId: ids("turn") })
  expect(script.requests[0]!.tools.map((tool) => tool.name)).not.toContain("snip")
  expect(script.requests[1]!.tools.map((tool) => tool.name)).toContain("snip")
})

test("the model lists its tool results, snips one and the next request shows the note instead of the output", async () => {
  const call = (id: string) => id as ReturnType<typeof ids<"item">>
  const script = scriptedProvider([callTool("big", { name: "first" }, call("call_1")), callTool("big", { name: "second" }, call("call_2")), callTool("snip", {}, call("call_3")), callTool("snip", { ids: ["call_1"], reason: "file already edited" }, call("call_4")), stop("Done")])
  const history = memoryHistory()
  const engine = createNativeEngine({ provider: script.provider, tools: [big], history, cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", permissionPolicy: () => on })
  const current = turn({ text: "Work" })
  expect(await engine.runTurn(current.input)).toMatchObject({ status: "ok" })
  const listing = toolMessages(script.requests[3]!.messages).find((message) => message.callId === "call_3")!
  expect(listing.output).toContain("2 tool results in context")
  expect(listing.output).toContain("call_1 | big | ~1002 tokens | big: first")
  expect(listing.output).toContain("call_2 | big | ~1002 tokens")
  const last = toolMessages(script.requests[4]!.messages)
  expect(last.find((message) => message.callId === "call_1")!.output).toBe(`${SNIPPED_PREFIX}: file already edited; rerun the tool if it is needed again.]`)
  expect(last.find((message) => message.callId === "call_2")!.output).toContain("second:xxxx")
  expect(last.find((message) => message.callId === "call_4")!.output).toContain("Snipped 1 tool result")
  // The saved history keeps the note too, so the next turn does not bring the output back.
  const saved = toolMessages((await history.load(current.input.sessionId)) ?? [])
  expect(saved.find((message) => message.callId === "call_1")!.output).toStartWith(SNIPPED_PREFIX)
  // The transcript the person sees still shows the real output.
  const completed = current.events.filter((event) => event.type === "item.completed")
  expect(completed.some((event) => "text" in event && event.text.startsWith("first:xxxx"))).toBe(true)
})

test("runSnip reports unknown, protected and repeated ids without changing anything it should not", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ callId: "a", name: "read", args: { path: "src/a.ts" } }, { callId: "s", name: "skill", args: {} }, { callId: "t", name: "tool_search", args: {} }] },
    { role: "tool", callId: "a", name: "read", output: "file ".repeat(400), isError: false, loadedInstructions: ["AGENTS.md"] },
    { role: "tool", callId: "s", name: "skill", output: "skill body", isError: false },
    { role: "tool", callId: "t", name: "tool_search", output: "found", isError: false, discoveredTools: ["lsp"] },
  ]
  const describe = (call: { name: string; args: unknown }) => `${call.name} ${JSON.stringify(call.args)}`
  const first = runSnip({ messages, args: { ids: ["a", "s", "t", "nope"] }, describe })
  expect(first.isError).toBe(false)
  expect(first.output).toContain("Snipped 1 tool result")
  expect(first.output).toContain("s: skill results are kept")
  expect(first.output).toContain("t: tool_search results are kept")
  expect(first.output).toContain("nope: no such tool result in context")
  const snipped = messages[1] as Extract<ModelMessage, { role: "tool" }>
  expect(snipped.output).toStartWith(SNIPPED_PREFIX)
  expect("loadedInstructions" in snipped).toBe(false)
  expect((messages[2] as Extract<ModelMessage, { role: "tool" }>).output).toBe("skill body")
  const again = runSnip({ messages, args: { ids: ["a"] }, describe })
  expect(again).toMatchObject({ isError: true })
  expect(again.output).toContain("a: already dropped")
  expect(runSnip({ messages, args: {}, describe }).output).toBe("no tool results in context that can be snipped")
})

test("the listing caps at the 40 largest results and says so", () => {
  const messages: ModelMessage[] = Array.from({ length: 45 }, (_, index): ModelMessage => ({ role: "tool", callId: `c${index}`, name: "read", output: "y".repeat(100 + index), isError: false }))
  const listing = runSnip({ messages, args: {}, describe: () => "read" })
  expect(listing.output.split("\n")).toHaveLength(41)
  expect(listing.output).toContain("(the 40 largest shown)")
  expect(listing.output).not.toContain("c0 |")
})
