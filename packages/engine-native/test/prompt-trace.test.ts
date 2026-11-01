import { describe, expect, test } from "bun:test"
import { createPromptTrace, describeChange } from "../src/prompt-trace"
import { CONVERSATION, recordLineage } from "./prefix-harness"

const body = (input: unknown[], extra: Record<string, unknown> = {}) => ({ instructions: "sys", tools: [{ name: "read" }], input, prompt_cache_key: "mc:1", ...extra })

describe("prompt prefix diagnostic", () => {
  test("names the first thing that differs from the session's previous request, with hashes only", () => {
    const lines: string[] = []
    const trace = createPromptTrace((line) => lines.push(line))
    const request = (input: unknown[], extra?: Record<string, unknown>, session = "ses_1") => trace({ sessionId: session, role: "main", route: "mc:1", body: body(input, extra) })
    request(["a", "b"])
    request(["a", "b", "c"])
    request(["a", "B", "c"])
    request(["a", "B", "c"], { instructions: "other" })
    request(["a"], { tools: [] })
    request(["x"], undefined, "ses_2")
    expect(lines.map((line) => /change=(\S+)/.exec(line)![1])).toEqual(["first", "append", "item[1]", "instructions", "tools+instructions+shrunk@1", "first"])
    expect(lines[0]).toMatch(/^\[PROMPT-PREFIX\]: session=ses_1 role=main call=1 instructions=[0-9a-f]{8} tools=[0-9a-f]{8} route=[0-9a-f]{8} items=2 change=first hashes=[0-9a-f]{8},[0-9a-f]{8}$/)
    expect(lines.join("\n")).not.toContain("sys")
  })

  test("describeChange reports an identical request as same", () => {
    const shape = { instructions: "i", tools: "t", route: "r", items: ["1", "2"] }
    expect(describeChange(shape, { ...shape })).toBe("same")
  })

  test("the engine writes one line per request when asked, without any prompt text", async () => {
    const lines: string[] = []
    await recordLineage({ adapter: "responses", turns: CONVERSATION, engineOptions: { promptPrefixTrace: (line) => lines.push(line) } })
    expect(lines).toHaveLength(5)
    expect(lines.map((line) => /change=(\S+)/.exec(line)![1])).toEqual(["first", "append", "append", "append", "append"])
    expect(lines.join("\n")).not.toMatch(/pagination|coding agent/)
  })
})
