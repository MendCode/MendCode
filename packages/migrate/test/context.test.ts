import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { ModelMessage } from "@mendcode/engine-native"
import { createContextBuilder, SUMMARY_PREFIX, type NativeMessage } from "../src"

/** Compile-time: what the importer writes is what the native engine reads. */
export const assignable = (messages: NativeMessage[]): ModelMessage[] => messages

const call = (n: number) => ({ callId: `c${n}`, name: "read", args: { n }, output: `out ${n}`, isError: false })

describe("context builder", () => {
  test("the summary prefix equals the native engine's", async () => {
    const engine = await Bun.file(path.join(import.meta.dir, "../../engine-native/src/engine.ts")).text()
    expect(engine).toContain(`const SUMMARY_PREFIX = ${JSON.stringify(SUMMARY_PREFIX)}`)
  })

  test("groups a step's text and tool calls, then pairs each call with its result", () => {
    const context = createContextBuilder()
    context.user("q", [])
    context.assistantText("thinking aloud")
    context.tool(call(1))
    context.tool(call(2))
    context.assistantText("done")
    expect(context.build()).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "thinking aloud", toolCalls: [{ callId: "c1", name: "read", args: { n: 1 } }, { callId: "c2", name: "read", args: { n: 2 } }] },
      { role: "tool", callId: "c1", name: "read", output: "out 1", isError: false },
      { role: "tool", callId: "c2", name: "read", output: "out 2", isError: false },
      { role: "assistant", content: "done", toolCalls: [] },
    ])
  })

  test("a compaction with a summary drops everything before it; one without a summary changes nothing", () => {
    const context = createContextBuilder()
    context.user("old", [])
    context.assistantText("old answer")
    context.compaction("")
    context.compaction("the summary")
    context.user("new", [])
    expect(context.build()).toEqual([
      { role: "user", content: `${SUMMARY_PREFIX}\n\nthe summary` },
      { role: "user", content: "new" },
    ])
    const untouched = createContextBuilder()
    untouched.user("kept", [])
    untouched.compaction("  ")
    expect(untouched.build()).toEqual([{ role: "user", content: "kept" }])
  })

  test("is capped at 200 messages, never starts with an orphan tool result and keeps the summary", () => {
    const context = createContextBuilder()
    context.compaction("S")
    for (let i = 0; i < 300; i++) {
      context.assistantText(`step ${i}`)
      context.tool(call(i))
    }
    const built = context.build()
    expect(built.length).toBeLessThanOrEqual(200)
    expect(built[0]).toMatchObject({ role: "user", content: `${SUMMARY_PREFIX}\n\nS` })
    expect(built[1]!.role).toBe("assistant")
    const ids = new Set(built.flatMap((message) => (message.role === "assistant" ? message.toolCalls.map((c) => c.callId) : [])))
    for (const message of built) if (message.role === "tool") expect(ids.has(message.callId)).toBe(true)
  })

  test("without a summary, a window that starts in the assistant gets an explanatory first message", () => {
    const context = createContextBuilder()
    for (let i = 0; i < 300; i++) context.assistantText(`answer ${i}`)
    const built = context.build()
    expect(built).toHaveLength(201)
    expect(built[0]!.role).toBe("user")
    expect(built[1]).toMatchObject({ role: "assistant", content: "answer 100" })
  })

  test("a huge tool result is shortened, attachments ride on the user message", () => {
    const context = createContextBuilder()
    context.user("look", [{ sha256: "a".repeat(64), bytes: 1, mime: "image/png", name: "x.png" }])
    context.tool({ ...call(1), output: "x".repeat(100_000) })
    const built = context.build()
    expect(built[0]).toMatchObject({ role: "user", attachments: [{ name: "x.png" }] })
    const result = built.find((message) => message.role === "tool") as Extract<NativeMessage, { role: "tool" }>
    expect(result.output.length).toBeLessThan(31_000)
    expect(result.output).toContain("shortened")
  })
})
