import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { sessionToMarkdown } from "../src/export"

const ids = createIdFactory()

function log() {
  const sessionId = ids("session")
  const turnId = ids("turn")
  let seq = 0
  const events: SessionEvent[] = []
  const ev = (e: Record<string, unknown>) => void events.push({ sessionId, seq: ++seq, at: 0, ...e } as SessionEvent)
  ev({ type: "session.created", directory: "/repo", title: "" })
  const user = ids("item")
  ev({ type: "item.started", turnId, itemId: user, kind: "user_message" })
  ev({ type: "item.completed", itemId: user, status: "ok", text: "fix the add bug" })
  const thought = ids("item")
  ev({ type: "item.started", turnId, itemId: thought, kind: "reasoning" })
  ev({ type: "item.delta", itemId: thought, text: "look at math.ts" })
  ev({ type: "item.completed", itemId: thought, status: "ok" })
  const tool = ids("item")
  ev({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: "shell: bun check.ts" } })
  ev({ type: "item.delta", itemId: tool, text: "FAIL add ```x```\n" })
  ev({ type: "item.completed", itemId: tool, status: "error" })
  const answer = ids("item")
  ev({ type: "item.started", turnId, itemId: answer, kind: "agent_message" })
  ev({ type: "item.delta", itemId: answer, text: "Fixed " })
  ev({ type: "item.completed", itemId: answer, status: "ok", text: "Fixed `src/math.ts:2`." })
  ev({ type: "turn.failed", turnId, error: { code: "provider_error", message: "429" } })
  return events
}

describe("session export", () => {
  test("renders prompts, answers and tool output as Markdown without reasoning by default", () => {
    const md = sessionToMarkdown(log(), { title: "Fix add" })
    expect(md).toContain("# Fix add\n\n`/repo`")
    expect(md).toContain("## User\n\nfix the add bug")
    expect(md).toContain("**Tool:** `shell: bun check.ts` (error)")
    expect(md).toContain("````\nFAIL add ```x```\n````")
    expect(md).toContain("## Assistant\n\nFixed `src/math.ts:2`.")
    expect(md).toContain("> **Turn failed** (provider_error): 429")
    expect(md).not.toContain("look at math.ts")
  })

  test("reasoning can be included in a collapsed block", () => {
    expect(sessionToMarkdown(log(), { reasoning: true })).toContain("<details><summary>Reasoning</summary>\n\nlook at math.ts")
  })
})
