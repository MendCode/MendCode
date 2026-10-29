import { describe, expect, test } from "bun:test"
import type { SessionTranscriptItem, SessionTranscriptTurn } from "@mendcode/protocol"
import { rebuildHistory, turnMessages } from "../src/rebuilt-history"

let n = 0
const item = (kind: SessionTranscriptItem["kind"], text: string, extra: Partial<SessionTranscriptItem> = {}): SessionTranscriptItem => ({ itemId: `itm_${n++}`, kind, text, ...extra })
const turn = (...items: SessionTranscriptItem[]): SessionTranscriptTurn => ({ turnId: `trn_${n++}`, items, outcome: "completed" }) as SessionTranscriptTurn
const base = { skipped: 0, fromStart: true, from: "Claude Code", to: "gpt-6-astra", sessionId: "ses_1" }

describe("another engine's turns as native messages", () => {
  test("a turn keeps its order: the request, then the answer with what ran and its output; reasoning stays out", () => {
    const messages = turnMessages(turn(
      item("user_message", "fix the build"),
      item("reasoning", "let me think about the build"),
      item("tool_call", "3 pass\n0 fail", { tool: "Bash", input: '{"command":"bun test"}', status: "ok" }),
      item("tool_call", "no such file", { tool: "Read", input: '{"file_path":"x.ts"}', status: "error" }),
      item("agent_message", "Fixed: the tests pass."),
    ))
    expect(messages).toEqual([
      { role: "user", content: "fix the build" },
      { role: "assistant", content: '[ran Bash {"command":"bun test"} → ok]\n3 pass\n0 fail\n\n[ran Read {"file_path":"x.ts"} → error]\nno such file\n\nFixed: the tests pass.', toolCalls: [] },
    ])
    expect(JSON.stringify(messages)).not.toContain("think about")
  })

  test("a long output keeps its start and its end; a typed shell command and a notice say what they are", () => {
    const [, answer] = turnMessages(turn(item("user_message", "go"), item("tool_call", `${"a".repeat(5_000)}${"z".repeat(5_000)}`, { tool: "Bash" })))
    expect(answer!.content).toContain("characters cut")
    expect(answer!.content.startsWith("[ran Bash → ok]\naaa")).toBe(true)
    expect(answer!.content.endsWith("zzz")).toBe(true)
    expect(answer!.content.length).toBeLessThan(6_200)
    expect(turnMessages(turn(item("user_message", "ls", { source: "shell" }), item("user_message", "task done", { source: "notice" })))).toEqual([{ role: "user", content: "Typed in the terminal: $ ls\n\nSystem notice: task done" }])
  })

  test("the newest turns come whole within the budget; the original request and a count of what was left out head them", () => {
    const turns = [turn(item("user_message", "the original request"), item("agent_message", "x".repeat(4_000))), ...Array.from({ length: 5 }, (_, index) => turn(item("user_message", `step ${index}`), item("agent_message", "y".repeat(4_000))))]
    const rebuilt = rebuildHistory({ ...base, turns, budgetTokens: 2_100 })!
    expect(rebuilt.turns).toBe(2)
    expect(rebuilt.omitted).toBe(4)
    expect(rebuilt.messages[0]!.content).toContain("ran on Claude Code until now and continues on gpt-6-astra")
    expect(rebuilt.messages[0]!.content).toContain("Original request:\nthe original request")
    expect(rebuilt.messages[0]!.content).toContain("4 earlier turns are not included")
    expect(rebuilt.messages[0]!.content.endsWith("[End of handoff]\n\nstep 3")).toBe(true)
    expect(rebuilt.tokens).toBeGreaterThan(2_000)
  })

  test("the newest turn comes even past the budget, everything fits without a note, and nothing to rebuild is undefined", () => {
    expect(rebuildHistory({ ...base, turns: [turn(item("user_message", "big"), item("agent_message", "z".repeat(40_000)))], budgetTokens: 10 })!.turns).toBe(1)
    const whole = rebuildHistory({ ...base, turns: [turn(item("user_message", "one"), item("agent_message", "ok"))], budgetTokens: 1_000 })!
    expect(whole).toMatchObject({ turns: 1, omitted: 0 })
    expect(whole.messages[0]!.content).not.toContain("not included")
    expect(whole.messages[0]!.content).not.toContain("Original request")
    expect(rebuildHistory({ ...base, turns: [turn(item("reasoning", "only thoughts"))], budgetTokens: 1_000 })).toBeUndefined()
  })
})
