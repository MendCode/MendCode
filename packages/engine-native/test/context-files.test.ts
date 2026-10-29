import { expect, test } from "bun:test"
import { contextFiles } from "../src/context-files"
import type { ModelMessage } from "../src/provider"

const call = (callId: string, name: string, args: unknown): ModelMessage => ({ role: "assistant", content: "", toolCalls: [{ callId, name, args }] })
const result = (callId: string, output: string, isError = false): ModelMessage => ({ role: "tool", callId, name: "x", output, isError })
const tokensOf = (message: ModelMessage) => (message.role === "tool" ? message.output.length : 0)

test("reads and edits are counted per path with the weight of their results, biggest first", () => {
  const messages: ModelMessage[] = [
    call("1", "read", { path: "src/a.ts" }), result("1", "x".repeat(100)),
    call("2", "read", { path: "src/a.ts" }), result("2", "x".repeat(100)),
    call("3", "edit", { path: "src/a.ts", oldString: "a", newString: "b" }), result("3", "ok"),
    call("4", "read", { path: "docs/b.md" }), result("4", "x".repeat(50)),
    call("5", "write", { path: "new.txt", content: "hi" }), result("5", "wrote"),
    call("6", "notebook_edit", { path: "n.ipynb" }), result("6", "ok"),
  ]
  expect(contextFiles({ messages, tokensOf })).toEqual([
    { path: "src/a.ts", reads: 2, edits: 1, tokens: 202 },
    { path: "docs/b.md", reads: 1, edits: 0, tokens: 50 },
    { path: "new.txt", reads: 0, edits: 1, tokens: 5 },
    { path: "n.ipynb", reads: 0, edits: 1, tokens: 2 },
  ])
})

test("failed calls and calls without a result are not files in context", () => {
  const messages: ModelMessage[] = [
    call("1", "read", { path: "missing.ts" }), result("1", "ENOENT", true),
    call("2", "read", { path: "pending.ts" }),
    call("3", "grep", { path: "src", pattern: "x" }), result("3", "hits"),
    call("4", "read", {}), result("4", "no path"),
  ]
  expect(contextFiles({ messages, tokensOf })).toEqual([])
})

test("apply_patch names every file in its headers and splits the result between them", () => {
  const patch = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: src/y.ts\n+new\n*** Delete File: old.ts\n*** End Patch"
  const messages: ModelMessage[] = [call("1", "apply_patch", { patch }), result("1", "x".repeat(30))]
  expect(contextFiles({ messages, tokensOf }).map((file) => [file.path, file.edits, file.tokens]).sort()).toEqual([["old.ts", 1, 10], ["src/x.ts", 1, 10], ["src/y.ts", 1, 10]])
})

test("at most 100 files are listed", () => {
  const messages: ModelMessage[] = Array.from({ length: 120 }, (_, i) => [call(`c${i}`, "read", { path: `f${i}.ts` }), result(`c${i}`, "x".repeat(i + 1))]).flat()
  const files = contextFiles({ messages, tokensOf })
  expect(files).toHaveLength(100)
  expect(files[0]!.path).toBe("f119.ts")
})
