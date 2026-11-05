import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactSecrets, type SessionId } from "@mendcode/protocol"
import { ADVISOR_EVIDENCE_LIMITS, COMPLETION_MIN_CHANGE, advisorLimits, advisorRequestIndex,changedLines, editedPaths,advisorOutput, advisorSessionContext, buildAdvisorBrief, createAdvisor, createAdvisorTracker, parseAdvisorVerdict, renderAdvisorFile, renderAdvisorFiles, selectAdvisorImages, type ModelMessage } from "../src"

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

  test("keeps an optional code or ASCII example, trimmed and clamped, and omits a blank one", () => {
    const sketch = "\n+------+\n| head |\n+------+\n  "
    expect(parseAdvisorVerdict(JSON.stringify({ verdict: "revise", summary: "s", example: sketch })).example).toBe("+------+\n| head |\n+------+")
    expect(parseAdvisorVerdict(JSON.stringify({ verdict: "revise", summary: "s", example: "x".repeat(9_000) })).example).toHaveLength(4_000)
    expect("example" in parseAdvisorVerdict(JSON.stringify({ verdict: "proceed", summary: "s", example: "  " }))).toBe(false)
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
    { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "shell", args: { command: "bun test" } }] },
    { role: "tool", callId: "c1", name: "shell", output: `1 failed\nANTHROPIC_API_KEY=sk-ant-api03-${"a".repeat(90)}`, isError: true },
  ]

  test("carries the trigger, the latest request, plan, diff and the current turn, with secrets redacted", () => {
    const brief = buildAdvisorBrief({ messages, question: "Is this fix right?", trigger: "completion", plan: "1. guard empty input", diff: "+ if (!text) return []", maxTokens: 24_000, mask })
    expect(brief).toContain("# Advisor brief (completion)")
    expect(brief).toContain("Fix the parser so empty input returns []")
    expect(brief).toContain("1. guard empty input")
    expect(brief).toContain("+ if (!text) return []")
    expect(brief).toContain("### tool shell (error)")
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
    const twoFiles = { paths: ["a.ts", "b.ts"], lines: 4 }
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.noteEdit(twoFiles)
    expect(tracker.admit("completion", limits)).toBe(true)
    tracker.consulted("completion")
    tracker.noteEdit(twoFiles)
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.resetTurn()
    tracker.noteEdit(twoFiles)
    expect(tracker.admit("completion", limits)).toBe(true)
  })

  test("completion skips a trivial turn: one file and few changed lines, summed over the turn", () => {
    const tracker = createAdvisorTracker()
    tracker.noteEdit({ paths: ["config.toml"], lines: 2 })
    tracker.noteEdit({ paths: ["config.toml"], lines: COMPLETION_MIN_CHANGE.lines - 3 })
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.noteEdit({ paths: ["config.toml"], lines: 1 })
    expect(tracker.admit("completion", limits)).toBe(true)
    tracker.resetTurn()
    tracker.noteEdit({ paths: ["config.toml"], lines: 1 })
    expect(tracker.admit("completion", limits)).toBe(false)
    tracker.noteEdit({ paths: ["theme.json"], lines: 1 })
    expect(tracker.admit("completion", limits)).toBe(true)
  })

  test("changedLines counts each edit tool's own shape", () => {
    expect(changedLines({ name: "edit", args: { path: "a.ts", oldString: "a\nb", newString: "c" } })).toBe(2)
    expect(changedLines({ name: "edit", args: { path: "a.ts", edits: [{ oldString: "a", newString: "b\nc\nd" }, { oldString: "x", newString: "y" }] } })).toBe(4)
    expect(changedLines({ name: "write", args: { path: "a.ts", content: "1\n2\n3" } })).toBe(3)
    expect(changedLines({ name: "apply_patch", args: { patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n keep\n*** Add File: b.ts\n+one\n*** End Patch" } })).toBe(3)
    expect(editedPaths({ args: { patch: "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n+one\n*** End Patch" } })).toEqual(["a.ts", "b.ts"])
    expect(changedLines({ name: "read", args: { path: "a.ts" } })).toBe(0)
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

describe("advisor evidence", () => {
  const image = { sha256: "ab".repeat(32), mime: "image/png", bytes: 10, name: "shot.png" }

  test("a line range is sliced and numbered; a range past the end says so", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
    const ranged = renderAdvisorFile({ path: "a.ts", text, startLine: 10, endLine: 12 })
    expect(ranged).toContain("### a.ts (lines 10-12 of 50)")
    expect(ranged).toContain("10: line 10\n11: line 11\n12: line 12")
    expect(ranged).not.toContain("line 13")
    expect(renderAdvisorFile({ path: "a.ts", text, startLine: 90 })).toContain("the file has 50 lines")
  })

  test("a file without a range stops at the line cap and says how many lines were cut and how to ask for them", () => {
    const text = Array.from({ length: 1_000 }, (_, i) => `l${i + 1}`).join("\n")
    const out = renderAdvisorFile({ path: "big.ts", text })
    const cap = ADVISOR_EVIDENCE_LIMITS.fileMaxLines
    expect(out).toContain(`${cap}: l${cap}\n`)
    expect(out).not.toContain(`${cap + 1}: l${cap + 1}`)
    expect(out).toContain(`[${1_000 - cap} lines cut`)
    expect(out).toContain("pass startLine/endLine")
    expect(renderAdvisorFile({ path: "big.ts", text, startLine: 1, endLine: 1_000 })).toContain("lines cut")
  })

  test("several files share one total cap; files outside the project or past the count are not sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-evidence-"))
    try {
      const wide = Array.from({ length: 200 }, () => "x".repeat(100)).join("\n")
      for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(dir, name), wide)
      const out = await renderAdvisorFiles({ files: ["a.txt", "b.txt", "c.txt", "d.txt", "../outside.txt"].map((path) => ({ path })), cwd: dir })
      expect(out.length).toBeLessThanOrEqual(ADVISOR_EVIDENCE_LIMITS.filesTotalChars + 2_000)
      expect(out).toContain("### a.txt")
      expect(out).toContain("lines cut")
      expect(out).toContain("the files together are capped")
      expect(out).toContain("### ../outside.txt\n[not sent: ")
      const many = await renderAdvisorFiles({ files: Array.from({ length: 9 }, () => ({ path: "a.txt", startLine: 1, endLine: 1 })), cwd: dir })
      expect(many).toContain("3 more files not sent")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("images are chosen from the session's attachments by name or hash prefix, capped in count", () => {
    const other = { ...image, sha256: "cd".repeat(32), name: "other.png" }
    const messages: ModelMessage[] = [{ role: "user", content: "see", attachments: [image, other] }]
    expect(selectAdvisorImages({ wanted: ["shot.png", "cdcdcd", "nope.png"], messages })).toEqual({ refs: [image, other], missing: ["nope.png"] })
    expect(selectAdvisorImages({ wanted: Array(10).fill("shot.png"), messages }).refs).toHaveLength(1)
  })

  test("images reach the advisor model only when it accepts them", async () => {
    const seen: unknown[] = []
    const make = (accepts: boolean) => createAdvisor({ complete: async (input) => { seen.push(input.images); return { text: '{"verdict":"proceed"}' } }, modelFor: () => ({ model: "m" }), acceptsImages: () => accepts, limitsFor: () => limits })
    const request = { sessionId: session, trigger: "tool" as const, brief: "b", images: [{ mime: "image/png", base64: "AAAA" }], signal: new AbortController().signal }
    expect(make(true).acceptsImages?.(session)).toBe(true)
    expect(make(false).acceptsImages?.(session)).toBe(false)
    await make(true).consult(request)
    await make(false).consult(request)
    expect(seen).toEqual([[{ mime: "image/png", base64: "AAAA" }], undefined])
  })
})

describe("advisor session context", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "first request" },
    { role: "assistant", content: "", toolCalls: [{ callId: "e1", name: "edit", args: { path: "apps/api/old.ts" } }] },
    { role: "tool", callId: "e1", name: "edit", output: "ok", isError: false },
    { role: "user", content: "now fix the web page" },
    { role: "assistant", content: "", toolCalls: [{ callId: "e2", name: "write", args: { path: "apps/web/new.html" } }, { callId: "b1", name: "shell", args: { command: "bun run typecheck" } }] },
    { role: "tool", callId: "e2", name: "write", output: "ok", isError: false },
    { role: "tool", callId: "b1", name: "shell", output: "typecheck passed: 0 errors", isError: false },
  ]

  test("the brief separates earlier edits from this turn's and carries this turn's verification, within its cap", () => {
    const brief = buildAdvisorBrief({ messages, question: "Is it done?", trigger: "completion", diff: "+x", maxTokens: 24_000, mask })
    const section = brief.slice(brief.indexOf("## Session context"), brief.indexOf("## Current diff"))
    expect(section).toContain("Earlier requests in this session: 1")
    expect(section).toContain("earlier turns: apps/api/old.ts")
    expect(section).toContain("in this turn: apps/web/new.html")
    expect(section).toContain("typecheck passed: 0 errors")
    expect(section.length).toBeLessThanOrEqual(ADVISOR_EVIDENCE_LIMITS.contextMaxChars + 200)
  })

  test("a huge verification output cannot push the block past its cap", () => {
    const loud: ModelMessage[] = [...messages.slice(0, 6), { role: "tool", callId: "b1", name: "shell", output: "z".repeat(200_000), isError: false }]
    expect(advisorSessionContext({ messages: loud, requestIndex: 3 }).length).toBeLessThanOrEqual(ADVISOR_EVIDENCE_LIMITS.contextMaxChars)
  })

  test("a screenshot read after the edits does not start the turn: the request, edits and checks stay this turn's", () => {
    const image = { sha256: "a".repeat(64), mime: "image/png", bytes: 10, name: "after.png" }
    const withShot: ModelMessage[] = [
      ...messages,
      { role: "assistant", content: "", toolCalls: [{ callId: "r1", name: "read", args: { path: "after.png" } }] },
      { role: "tool", callId: "r1", name: "read", output: "image", isError: false },
      { role: "user", content: "[image from read call]", attachments: [image] },
      { role: "assistant", content: "", toolCalls: [{ callId: "t1", name: "todo", args: {} }] },
      { role: "tool", callId: "t1", name: "todo", output: "3/3", isError: false },
    ]
    expect(advisorRequestIndex(withShot)).toBe(3)
    const brief = buildAdvisorBrief({ messages: withShot, question: "Is it done?", trigger: "completion", diff: "+x", maxTokens: 24_000, mask })
    expect(brief.slice(brief.indexOf("## Latest user request"), brief.indexOf("## Session context"))).toContain("now fix the web page")
    const section = brief.slice(brief.indexOf("## Session context"), brief.indexOf("## Current diff"))
    expect(section).toContain("in this turn: apps/web/new.html")
    expect(section).toContain("typecheck passed: 0 errors")
    expect(section).not.toContain("none recorded")
  })

  test("the evidence from the executor is part of the brief", () => {
    const brief = buildAdvisorBrief({ messages, question: "q", trigger: "tool", evidence: "### a.ts (lines 1-2 of 2)\n1: x", maxTokens: 24_000, mask })
    expect(brief).toContain("## Evidence from the executor")
    expect(brief).toContain("1: x")
  })
})
