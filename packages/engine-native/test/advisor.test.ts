import { describe, expect, test } from "bun:test"
import { redactSecrets, type SessionId } from "@mendcode/protocol"
import { advisorLimits, advisorOutput, buildAdvisorBrief, createAdvisor, createAdvisorTracker, parseAdvisorVerdict, type ModelMessage } from "../src"

const session = "ses_advisor" as SessionId
const mask = (text: string) => redactSecrets(text).text
const limits = advisorLimits(undefined)

describe("parseAdvisorVerdict", () => {
  test("reads a fenced verdict with nested findings", () => {
    const verdict = parseAdvisorVerdict('Here you go:\n```json\n{"verdict":"revise","summary":"Missing null check","findings":[{"claim":"parse() crashes on empty input","evidence":"src/p.ts:12","severity":"high"}],"next":["add a test"]}\n```')
    expect(verdict).toEqual({ verdict: "revise", summary: "Missing null check", findings: [{ claim: "parse() crashes on empty input", evidence: "src/p.ts:12", severity: "high" }], next: ["add a test"] })
  })

  test("fills defaults and clamps oversized answers", () => {
    const verdict = parseAdvisorVerdict(JSON.stringify({ verdict: "proceed", summary: "x".repeat(2_000), findings: Array.from({ length: 20 }, (_, i) => ({ claim: `c${i}` })), next: Array(10).fill("step") }))
    expect(verdict.summary).toHaveLength(600)
    expect(verdict.findings).toHaveLength(8)
    expect(verdict.findings[0]).toEqual({ claim: "c0", evidence: "", severity: "medium" })
    expect(verdict.next).toHaveLength(6)
  })

  test("garbage or an unknown verdict is a neutral proceed marked unparsable", () => {
    expect(parseAdvisorVerdict("I think it looks fine")).toMatchObject({ verdict: "proceed", fallback: "unparsable", summary: "I think it looks fine" })
    expect(parseAdvisorVerdict('{"verdict":"approve"}')).toMatchObject({ verdict: "proceed", fallback: "unparsable" })
  })
})

describe("buildAdvisorBrief", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "old request" },
    { role: "assistant", content: "old answer", toolCalls: [] },
    { role: "user", content: "Fix the parser so empty input returns []" },
    { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "bash", args: { command: "bun test" } }] },
    { role: "tool", callId: "c1", name: "bash", output: `1 failed\nANTHROPIC_API_KEY=sk-ant-api03-${"a".repeat(90)}`, isError: true },
  ]

  test("carries the trigger, the latest request, plan, diff and the current turn, with secrets redacted", () => {
    const brief = buildAdvisorBrief({ messages, question: "Is this fix right?", trigger: "completion", plan: "1. guard empty input", diff: "+ if (!text) return []", maxTokens: 24_000, mask })
    expect(brief).toContain("# Advisor brief (completion)")
    expect(brief).toContain("Fix the parser so empty input returns []")
    expect(brief).toContain("1. guard empty input")
    expect(brief).toContain("+ if (!text) return []")
    expect(brief).toContain("### tool bash (error)")
    expect(brief).not.toContain("old request")
    expect(brief).not.toContain("sk-ant-api03-aaaa")
  })

  test("stays within the token budget and refuses a budget too small to be useful", () => {
    const long: ModelMessage[] = [{ role: "user", content: "do it" }, ...Array.from({ length: 200 }, (_, i): ModelMessage => ({ role: "assistant", content: `step ${i} ${"z".repeat(500)}`, toolCalls: [] }))]
    expect(buildAdvisorBrief({ messages: long, question: "q", trigger: "tool", maxTokens: 4_000, mask }).length).toBeLessThanOrEqual(16_000)
    expect(() => buildAdvisorBrief({ messages: long, question: "q", trigger: "tool", maxTokens: 500, mask })).toThrow(RangeError)
  })
})

describe("createAdvisorTracker", () => {
  test("repeat_error fires on the second identical failure only, once per failure", () => {
    const tracker = createAdvisorTracker()
    expect(tracker.noteFailure('["bash",{"command":"bun test"}]', "error: 2 tests failed")).toBe(false)
    expect(tracker.noteFailure('["bash",{"command":"bun test"}]', "error: 1 test failed")).toBe(false)
    expect(tracker.noteFailure('["bash",{"command":"bun test"}]', "error: 2 tests failed")).toBe(true)
    expect(tracker.noteFailure('["bash",{"command":"bun test"}]', "error: 2 tests failed")).toBe(false)
  })

  test("completion needs an unseen edit and runs once per turn", () => {
    const tracker = createAdvisorTracker()
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.noteEdit()
    expect(tracker.admit("completion", limits)).toBe(true)
    tracker.consulted("completion")
    tracker.noteEdit()
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.resetTurn()
    tracker.noteEdit()
    expect(tracker.admit("completion", limits)).toBe(true)
  })

  test("per-turn and per-session caps and disabled checkpoints refuse", () => {
    const tight = advisorLimits({ maxCallsPerTurn: 2, maxCallsPerSession: 3, checkpoints: ["plan"] })
    const tracker = createAdvisorTracker()
    expect(tracker.admit("repeat_error", tight)).toBe(false)
    tracker.consulted("tool")
    tracker.consulted("plan")
    expect(tracker.admit("tool", tight)).toBe(false)
    expect(tracker.refusal(tight)).toContain("in this turn")
    tracker.resetTurn()
    tracker.consulted("tool")
    expect(tracker.admit("plan", tight)).toBe(false)
    expect(tracker.refusal(tight)).toContain("in this session")
  })
})

describe("createAdvisor", () => {
  const brief = "# Advisor brief"
  test("answers with the parsed verdict, the model and its usage", async () => {
    const advisor = createAdvisor({ complete: async () => ({ text: '{"verdict":"stop","summary":"needs the user"}', usage: { provider: "openai", model: "gpt-6.1-sol", input: 900, output: 40 } }), modelFor: () => ({ model: "gpt-6.1-sol" }), limitsFor: () => limits })
    const answer = await advisor.consult({ sessionId: session, trigger: "tool", brief, signal: new AbortController().signal })
    expect(answer).toMatchObject({ verdict: { verdict: "stop", summary: "needs the user" }, model: "gpt-6.1-sol", usage: { input: 900, output: 40 } })
    expect(JSON.parse(advisorOutput("tool", answer))).toMatchObject({ trigger: "tool", verdict: "stop", usage: { input: 900, output: 40 } })
  })

  test("timeout, provider error and missing model are neutral verdicts, never throws", async () => {
    const slow = createAdvisor({ complete: () => new Promise(() => {}), modelFor: () => ({ model: "m" }), limitsFor: () => limits, timeoutMs: 20 })
    expect((await slow.consult({ sessionId: session, trigger: "tool", brief, signal: new AbortController().signal })).verdict).toMatchObject({ verdict: "proceed", fallback: "timeout" })
    const broken = createAdvisor({ complete: async () => { throw new Error("503 overloaded") }, modelFor: () => ({ model: "m" }), limitsFor: () => limits })
    expect((await broken.consult({ sessionId: session, trigger: "tool", brief, signal: new AbortController().signal })).verdict).toMatchObject({ fallback: "error", summary: "the advisor failed: 503 overloaded" })
    const none = createAdvisor({ complete: async () => ({ text: "" }), modelFor: () => undefined, limitsFor: () => limits })
    expect(none.enabled(session)).toBe(false)
    expect((await none.consult({ sessionId: session, trigger: "tool", brief, signal: new AbortController().signal })).verdict.fallback).toBe("error")
  })
})
