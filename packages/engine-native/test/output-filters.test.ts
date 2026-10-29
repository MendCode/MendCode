import { estimateTokens } from "@mendcode/protocol/wire"
import { expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type AgentProfile } from "../src"
import { filterToolOutput } from "../src/output-filters"
import { redactedToolStream, withReportedSavings } from "../src/tool-output"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const shell = (command: string, output: string, isError = false) => filterToolOutput({ tool: "shell", command, isError, output })
const tokens = (text: string) => estimateTokens(text.length)

/** A recorded `bun test` run: 240 passing tests, one failure with its detail, and the summary. */
const recordedTestRun = () => [
  "bun test v1.3.0",
  ...Array.from({ length: 240 }, (_, i) => `(pass) suite > case number ${i} [${(i % 7) + 0.31}ms]`),
  "error: expect(received).toBe(expected)",
  "Expected: 4",
  "Received: 5",
  "      at <anonymous> (/repo/src/math.test.ts:12:20)",
  "(fail) math > adds [0.52ms]",
  " 240 pass",
  " 1 fail",
  "Ran 241 tests across 12 files. [1.9s]",
].join("\n")

test("passing test lines fold to a count while the failure and the summary stay verbatim", () => {
  const raw = recordedTestRun()
  const filtered = shell("bun test", raw, true)!
  expect(filtered.filter).toBe("tests")
  expect(filtered.output).toContain("· 240 passing test lines omitted")
  for (const line of ["error: expect(received).toBe(expected)", "Expected: 4", "Received: 5", "(fail) math > adds [0.52ms]", " 1 fail", "Ran 241 tests across 12 files. [1.9s]"]) expect(filtered.output).toContain(line)
  expect(filtered.output).not.toContain("(pass)")
  // The measured number the budget is about: a long passing run costs a few dozen tokens, not thousands.
  expect(tokens(raw)).toBeGreaterThan(2_000)
  expect(tokens(filtered.output)).toBeLessThan(150)
  expect(filtered.savedTokens).toBeGreaterThan(1_800)
})

test("colour codes and progress redraws go, and a repeated line folds without touching a failure line", () => {
  const raw = ["\x1b[32mcompiling\x1b[0m", "50%\r75%\r100%", ...Array.from({ length: 80 }, () => "waiting for lock"), ...Array.from({ length: 5 }, () => "error: lock timeout"), "done", "x".repeat(300)].join("\n")
  const filtered = shell("make build", raw)!
  expect(filtered.output).not.toContain("\x1b")
  expect(filtered.output).toContain("compiling")
  expect(filtered.output).toContain("100%")
  expect(filtered.output).not.toContain("50%")
  expect(filtered.output).toContain("waiting for lock  [x80]")
  expect(filtered.output.split("\n").filter((line) => line === "error: lock timeout")).toHaveLength(5)
})

test("git hints, diff index lines and transfer progress are dropped, paths and hunks stay", () => {
  const status = ["On branch main", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...Array.from({ length: 30 }, (_, i) => `\tmodified:   src/file-${i}.ts`), ...Array.from({ length: 12 }, (_, i) => `remote: Counting objects: ${i}% (${i}/120)`), "no changes added to commit"].join("\n")
  const filtered = shell("git status", status)!
  expect(filtered.output).not.toContain("(use \"git")
  expect(filtered.output).not.toContain("Counting objects")
  expect(filtered.output).toContain("modified:   src/file-29.ts")
  expect(filtered.output).toContain("no changes added to commit")
  const diff = Array.from({ length: 12 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\nindex 83db48f${i}..bf2a3c4${i} 100644\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context line with some text to pad it out`).join("\n")
  const filteredDiff = shell("git diff", diff)!
  expect(filteredDiff.output).not.toContain("index 83db48f")
  expect(filteredDiff.output).toContain("@@ -1,2 +1,2 @@")
  expect(filteredDiff.output.match(/^diff --git/gm)).toHaveLength(12)
})

test("compiler diagnostics and search hits group under their file", () => {
  const diagnostics = Array.from({ length: 30 }, (_, i) => `packages/engine-native/src/components/page-${Math.floor(i / 10)}.ts(${i + 3},5): error TS2322: Type 'string' is not assignable to type 'number'.`).join("\n")
  const tsc = shell("bunx tsc --noEmit", diagnostics)
  expect(tsc?.output).toContain("packages/engine-native/src/components/page-0.ts:\n  3:5 TS2322 Type 'string' is not assignable to type 'number'.")
  expect(tsc?.output.match(/error|TS2322/g)?.length).toBe(30)
  const hits = Array.from({ length: 40 }, (_, i) => `packages/engine/src/file-${Math.floor(i / 10)}.ts:${i + 1}:  const value = compute(${i}) // matches the needle`).join("\n")
  const search = shell("rg needle packages", hits)
  expect(search?.output).toContain("packages/engine/src/file-0.ts:\n  1:   const value = compute(0) // matches the needle")
  expect(search!.output.length).toBeLessThan(hits.length)
})

test("nothing is filtered for other tools, small results or when the saving would not pay for the header", () => {
  const big = Array.from({ length: 300 }, (_, i) => `(pass) case ${i}`).join("\n")
  expect(filterToolOutput({ tool: "read", command: "bun test", isError: false, output: big })).toBeUndefined()
  expect(shell("bun test", "(pass) a\n(pass) b")).toBeUndefined()
  expect(shell("echo hello", "hello world ".repeat(60))).toBeUndefined()
})

const agent: AgentProfile = { name: "build", description: "Build", mode: "primary", prompt: "" }
test("full filtered and truncated outputs redact newly encountered credentials before saving", async () => {
  const secret = "ghp_" + "a".repeat(36)
  for (const filters of [true, false]) {
    const h = run({ output: `${secret}\n${recordedTestRun()}\n${"x".repeat(60_000)}`, command: "bun test", filters, save: true })
    await h.done
    expect(h.saved.length).toBeGreaterThan(0)
    expect(h.saved[0]!.text).not.toContain(secret)
    expect(h.saved[0]!.text).toContain("[redacted:")
  }
})

test("new credentials split across live output chunks never enter tool events", async () => {
  const secret = "ghp_" + "a".repeat(36)
  const pem = "-----BEGIN PRIVATE KEY-----\n" + "QUFB".repeat(20) + "\n-----END PRIVATE KEY-----"
  const raw = `prefix\n${secret}\n${pem}\nsuffix\n`
  const tool = defineTool({
    name: "shell", description: "stream", permission: "read", args: z.object({ command: z.string() }),
    execute: async (_, ctx) => {
      for (let i = 0; i < raw.length; i += 5) ctx.onOutput?.(raw.slice(i, i + 5))
      return { output: raw, title: "shell", truncated: false, isError: false }
    },
  })
  const { provider } = scriptedProvider([callTool("shell", { command: "test" }), stop("done")])
  const engine = createNativeEngine({ provider, tools: [tool], history: memoryHistory(), cwdFor: () => "/temp/repo", system: () => "sys", compactionPrompt: "summary" })
  const t = turn({ text: "stream" })
  await engine.runTurn(t.input)
  const deltas = t.events.flatMap((event) => event.type === "item.delta" ? [event.text] : []).join("")
  expect(deltas.includes(secret)).toBe(false)
  expect(deltas.includes("QUFB".repeat(20))).toBe(false)
  expect(deltas).toContain("prefix")
  expect(deltas).toContain("suffix")
})

test("live redaction bounds an unfinished line and suppresses an incomplete private key", () => {
  const capped = redactedToolStream(100)
  expect(capped.push("x".repeat(101))).toContain("Live output paused")
  expect(capped.push("discarded\n")).toBe("")
  expect(capped.flush()).toBe("")
  const key = redactedToolStream(1_000)
  expect(key.push("-----BEGIN PRIVATE KEY-----\nQUFBQUFB\n")).toBe("")
  expect(key.flush()).toBe("[redacted:private-key]")
})
function run(input: { output: string; command: string; filters?: boolean; save?: boolean }) {
  const saved: Array<{ text: string; complete: boolean }> = []
  const shellTool = defineTool({
    name: "shell", description: "run", permission: "read", args: z.object({ command: z.string() }),
    execute: async () => ({ output: input.output, truncated: false, title: "shell", isError: true, meta: { exitCode: 1 } }),
  })
  const { provider, requests } = scriptedProvider([callTool("shell", { command: input.command }), stop("done")])
  const engine = createNativeEngine({
    provider, tools: [shellTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summary", agents: { primary: () => agent, subagents: () => [] },
    toolOutput: () => ({ ...(input.filters === undefined ? {} : { filters: input.filters }) }),
    ...(input.save === false ? {} : { saveToolOutput: async (text: string, complete: boolean) => { saved.push({ text, complete }); return { path: "/data/tool-output/tool-1.txt", complete } } }),
  })
  const t = turn({ text: "go" })
  return { saved, requests, events: t.events, done: engine.runTurn(t.input) }
}

test("the engine saves the full output first, tells the model the path, and records the tokens saved", async () => {
  const raw = recordedTestRun()
  const h = run({ output: raw, command: "bun test", filters: true })
  await h.done
  expect(h.saved).toEqual([{ text: raw, complete: true }])
  const sent = h.requests[1]!.messages.at(-1) as { output: string }
  expect(sent.output.split("\n", 1)[0]).toMatch(/^\[filtered tests: 249 → \d+ lines, ~\d+ tokens saved\. Full output: \/data\/tool-output\/tool-1\.txt\]$/)
  expect(sent.output).toContain("(fail) math > adds [0.52ms]")
  expect(sent.output).not.toContain("(pass) suite")
  const completed = h.events.find((event) => event.type === "item.completed" && event.meta?.savedTokens !== undefined)
  expect(completed).toMatchObject({ meta: { filter: "tests", outputPath: "/data/tool-output/tool-1.txt", outputComplete: true, exitCode: 1 } })
  expect(Number((completed as unknown as { meta: { savedTokens: number } }).meta.savedTokens)).toBeGreaterThan(1_800)
})

test("with filters off, or no way to keep the full output, the result is exactly what the tool printed", async () => {
  const raw = recordedTestRun()
  for (const input of [{ filters: false }, {}, { filters: true, save: false }]) {
    const h = run({ output: raw, command: "bun test", ...input })
    await h.done
    expect((h.requests[1]!.messages.at(-1) as { output: string }).output).toContain("(pass) suite > case number 0")
    expect(h.saved).toEqual([])
  }
})

test("a filtered result still over the cap is cut with the unfiltered copy kept at the first path", async () => {
  const raw = [recordedTestRun(), ...Array.from({ length: 4_000 }, (_, i) => `distinct log line number ${i} with some padding text to take room`)].join("\n")
  const h = run({ output: raw, command: "bun test", filters: true })
  await h.done
  expect(h.saved).toHaveLength(1)
  expect(h.saved[0]!.text).toBe(raw)
  const sent = (h.requests[1]!.messages.at(-1) as { output: string }).output
  expect(sent).toContain("Full output: /data/tool-output/tool-1.txt")
  expect(sent).toContain("the full unfiltered output is at the path above")
})

test("a graft lookup's own saving joins the tally as source graft; other tools and missing lines add nothing", () => {
  const printed = "[graft] tokens saved ≈ 16,491 (98%) — this output ≈ 316 tok\n\nrenderToolCard · function"
  const base = { output: printed, truncated: false, title: "t", isError: false }
  expect(withReportedSavings({ result: base, tool: "mcp__graft__graft_trace_calls" }).meta).toEqual({ savedTokens: 16_491, filter: "graft" })
  expect(withReportedSavings({ result: { ...base, meta: { exitCode: 0 } }, tool: "graft_find_code" }).meta).toEqual({ exitCode: 0, savedTokens: 16_491, filter: "graft" })
  expect(withReportedSavings({ result: base, tool: "shell" }).meta).toBeUndefined()
  expect(withReportedSavings({ result: { ...base, output: "no savings line" }, tool: "graft_find_code" }).meta).toBeUndefined()
  const filtered = { ...base, meta: { savedTokens: 5, filter: "tests" } }
  expect(withReportedSavings({ result: filtered, tool: "graft_find_code" })).toBe(filtered)
})
