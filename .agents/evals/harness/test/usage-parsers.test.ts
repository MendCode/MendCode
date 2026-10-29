import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { mergeSessionFacts, parseCodexEvents, parseCodexSession } from "../adapters/codex-usage"
import { parseMendcodeEvents } from "../adapters/mendcode-usage"

const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8").split("\n")

describe("mendcode event stream", () => {
  test("a stream recorded from the real daemon (faux engine): usage, tools, turn time", () => {
    const parsed = parseMendcodeEvents(fixture("mendcode-faux-activity.jsonl"))
    expect(parsed.turnStatus).toBe("completed")
    expect(parsed.usage).toEqual({
      // 12000 uncached + 9000 cache read + 0 cache write
      inputTokens: 21_000,
      cachedReadTokens: 9_000,
      cacheWriteTokens: 0,
      outputTokens: 900,
      reasoningTokens: 200,
      modelCalls: 1,
      toolCalls: 4,
      failedToolCalls: 0,
      compactions: 0,
      turnMs: parsed.usage.turnMs,
    })
    expect(parsed.usage.turnMs).toBeGreaterThan(0)
  })

  test("native-shaped stream: several calls, a failed tool, a retry, a compaction, non-JSON noise", () => {
    const parsed = parseMendcodeEvents(fixture("mendcode-native-shape.jsonl"))
    expect(parsed.skippedLines).toBe(1)
    expect(parsed.retries).toBe(1)
    expect(parsed.usage.modelCalls).toBe(2)
    // (1200 + 8000 + 0) + (900 + 10000 + 50)
    expect(parsed.usage.inputTokens).toBe(20_150)
    expect(parsed.usage.cachedReadTokens).toBe(18_000)
    expect(parsed.usage.cacheWriteTokens).toBe(50)
    expect(parsed.usage.outputTokens).toBe(750)
    expect(parsed.usage.reasoningTokens).toBe(320)
    expect(parsed.usage.toolCalls).toBe(3)
    expect(parsed.usage.failedToolCalls).toBe(1)
    // only the `packed` milestone counts, not `writing`
    expect(parsed.usage.compactions).toBe(1)
    expect(parsed.usage.turnMs).toBe(7_500)
  })

  test("a failed turn keeps tokens unavailable and carries the error", () => {
    const parsed = parseMendcodeEvents(fixture("mendcode-failed-turn.jsonl"))
    expect(parsed.turnStatus).toBe("failed")
    expect(parsed.error).toBe("You have hit your usage limit")
    expect(parsed.usage.inputTokens).toBeNull()
    expect(parsed.usage.outputTokens).toBeNull()
    expect(parsed.usage.cachedReadTokens).toBeNull()
    expect(parsed.usage.turnMs).toBe(500)
  })

  test("an empty or truncated stream reports nothing instead of zeros", () => {
    const empty = parseMendcodeEvents([])
    expect(empty.turnStatus).toBe("none")
    expect(empty.usage.toolCalls).toBeNull()
    expect(empty.usage.compactions).toBeNull()
    expect(empty.usage.inputTokens).toBeNull()
    const truncated = parseMendcodeEvents(fixture("mendcode-native-shape.jsonl").slice(0, 6))
    expect(truncated.turnStatus).toBe("none")
    expect(truncated.usage.inputTokens).toBe(9_200)
    expect(truncated.usage.turnMs).toBeNull()
  })
})

describe("codex exec stream", () => {
  test("input includes cached, output includes reasoning; commands that exit non-zero are failed tool calls", () => {
    const parsed = parseCodexEvents(fixture("codex-exec-events.jsonl"))
    expect(parsed.status).toBe("completed")
    expect(parsed.threadId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53")
    expect(parsed.usage.inputTokens).toBe(24_763)
    expect(parsed.usage.cachedReadTokens).toBe(24_448)
    expect(parsed.usage.outputTokens).toBe(122)
    expect(parsed.usage.reasoningTokens).toBe(64)
    // 3 commands + 1 file change; reasoning and the message are not tools
    expect(parsed.usage.toolCalls).toBe(4)
    expect(parsed.usage.failedToolCalls).toBe(1)
  })

  test("what the exec stream cannot say stays null", () => {
    const parsed = parseCodexEvents(fixture("codex-exec-no-reasoning-field.jsonl"))
    expect(parsed.usage.reasoningTokens).toBeNull()
    expect(parsed.usage.cacheWriteTokens).toBeNull()
    expect(parsed.usage.compactions).toBeNull()
    expect(parsed.usage.modelCalls).toBeNull()
    expect(parsed.usage.turnMs).toBeNull()
    expect(parsed.usage.toolCalls).toBe(0)
  })

  test("a failed run reports the error and no tokens", () => {
    const parsed = parseCodexEvents(fixture("codex-exec-failed.jsonl"))
    expect(parsed.status).toBe("failed")
    expect(parsed.error).toBe("You've hit your usage limit.")
    expect(parsed.usage.inputTokens).toBeNull()
  })

  test("garbage lines are counted and skipped", () => {
    const parsed = parseCodexEvents(["not json", "[1,2]", '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}'])
    expect(parsed.skippedLines).toBe(2)
    expect(parsed.usage.inputTokens).toBe(5)
  })

  test("several turns add up", () => {
    const turn = '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":4}}'
    const parsed = parseCodexEvents([turn, turn])
    expect(parsed.usage.inputTokens).toBe(200)
    expect(parsed.usage.cachedReadTokens).toBe(80)
    expect(parsed.usage.reasoningTokens).toBe(8)
  })
})

describe("codex session file", () => {
  test("reads the last cumulative totals and counts compactions", () => {
    const facts = parseCodexSession(fixture("codex-session.jsonl"))
    expect(facts.compactions).toBe(1)
    expect(facts.totals).toEqual({ input: 24_763, cached: 24_448, output: 122, reasoning: 64 })
  })

  test("merging fills compactions (even zero) and missing reasoning without overriding stream values", () => {
    const stream = parseCodexEvents(fixture("codex-exec-no-reasoning-field.jsonl")).usage
    const merged = mergeSessionFacts(stream, { totals: { input: 999, cached: 1, output: 9, reasoning: 5 }, compactions: 0 })
    expect(merged.compactions).toBe(0)
    expect(merged.reasoningTokens).toBe(5)
    expect(merged.inputTokens).toBe(1000)
    expect(mergeSessionFacts(stream, null).compactions).toBeNull()
  })

  test("session totals stand in when the stream had no usage", () => {
    const failed = parseCodexEvents(fixture("codex-exec-failed.jsonl")).usage
    const merged = mergeSessionFacts(failed, parseCodexSession(fixture("codex-session.jsonl")))
    expect(merged.inputTokens).toBe(24_763)
    expect(merged.compactions).toBe(1)
  })
})
