import { describe, expect, test } from "bun:test"
import type { EngineEvent } from "@mendcode/kernel"
import type { ItemId } from "@mendcode/protocol"
import { createUpdateMapper } from "../src/updates"

function mapped(updates: unknown[]) {
  const events: EngineEvent[] = []
  let n = 0
  const mapper = createUpdateMapper({ newItemId: () => `itm_${++n}` as ItemId, emit: (event) => void events.push(event) })
  for (const update of updates) mapper.accept(update)
  mapper.finish("ok")
  return {
    titles: events.flatMap((event) => (event.type === "item.started" ? [event.meta?.tool] : [])),
    texts: events.flatMap((event) => (event.type === "item.completed" ? [event.text] : [])),
  }
}

// What OpenCode 1.19.3 sent for an edit, a shell command and a new file (captured 2026-10-18 over `opencode acp`, paths shortened).
const EDIT = [
  { sessionUpdate: "tool_call", toolCallId: "e", title: "edit", kind: "edit", status: "pending", rawInput: {}, locations: [] },
  { sessionUpdate: "tool_call_update", toolCallId: "e", title: "edit", kind: "edit", status: "in_progress", rawInput: { filePath: "/p/notes.txt", oldString: "line four", newString: "line 4 (changed)" }, locations: [{ path: "/p/notes.txt" }] },
  {
    sessionUpdate: "tool_call_update", toolCallId: "e", title: "p/notes.txt", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Edit applied successfully." } }, { type: "diff", path: "/p/notes.txt", oldText: "line four", newText: "line 4 (changed)" }],
    rawOutput: { output: "Edit applied successfully.", metadata: { diagnostics: {}, diff: "Index: /p/notes.txt\n===================================================================\n--- /p/notes.txt\n+++ /p/notes.txt\n@@ -2,5 +2,5 @@\n line two\n line three\n-line four\n+line 4 (changed)\n line five\n line six\n" } },
  },
]
const SHELL = [
  { sessionUpdate: "tool_call", toolCallId: "s", title: "bash", kind: "execute", status: "pending", rawInput: { cwd: "/p" }, locations: [{ path: "/p" }] },
  { sessionUpdate: "tool_call_update", toolCallId: "s", title: "wc -l notes.txt", kind: "execute", status: "in_progress", rawInput: { command: "wc -l notes.txt", workdir: "/p" } },
  { sessionUpdate: "tool_call_update", toolCallId: "s", title: "wc -l notes.txt", status: "completed", content: [{ type: "content", content: { type: "text", text: "       6 notes.txt\n" } }], rawOutput: { output: "       6 notes.txt\n", metadata: { exit: 0 } } },
]
const WRITE = [
  { sessionUpdate: "tool_call", toolCallId: "w", title: "write", kind: "edit", status: "pending", rawInput: {}, locations: [] },
  { sessionUpdate: "tool_call_update", toolCallId: "w", title: "write", kind: "edit", status: "in_progress", rawInput: { filePath: "/p/hello.txt", content: "hi" } },
  { sessionUpdate: "tool_call_update", toolCallId: "w", title: "p/hello.txt", status: "completed", content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }], rawOutput: { metadata: { exists: false } } },
]

describe("ACP tool calls as MendCode's own cards", () => {
  test("OpenCode's edit, shell and write open once their input is known, under MendCode's names, with an edit's real unified diff", () => {
    const { titles, texts } = mapped([...EDIT, ...SHELL, ...WRITE])
    expect(titles).toEqual(["edit: /p/notes.txt", "shell: wc -l notes.txt", "write: /p/hello.txt"])
    expect(texts).toEqual(["@@ -2,5 +2,5 @@\n line two\n line three\n-line four\n+line 4 (changed)\n line five\n line six", "       6 notes.txt\n", "Created /p/hello.txt (2 bytes)"])
  })

  test("an agent's diff block of whole files becomes a hunk with three lines of context and the real line numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n")
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n")
    const { titles, texts } = mapped([{ sessionUpdate: "tool_call", toolCallId: "d", title: "Edit x.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: "x.ts", oldText: before, newText: after }] }])
    expect(titles).toEqual(["edit: x.ts"])
    expect(texts).toEqual(["@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h"])
  })

  test("a call with no input keeps the agent's title and text, and a failed edit keeps the agent's reason", () => {
    const { titles, texts } = mapped([
      { sessionUpdate: "tool_call", toolCallId: "t", title: "Thinking about it", kind: "think", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] },
      ...EDIT.slice(0, 2),
      { sessionUpdate: "tool_call_update", toolCallId: "e", status: "failed", content: [{ type: "content", content: { type: "text", text: "oldString not found" } }] },
    ])
    expect(titles).toEqual(["Thinking about it", "edit: /p/notes.txt"])
    expect(texts).toEqual(["done", "oldString not found"])
  })
})
