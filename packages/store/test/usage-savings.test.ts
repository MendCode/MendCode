import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ids = createIdFactory()
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
const range = { from: "2026-09-20", to: "2026-09-20" }

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-savings-"))
  dirs.push(dir)
  const store = openStore({ dir, now: () => Date.UTC(2026, 8, 20, 12), dayOf })
  const toolCall = (directory: string, meta?: Record<string, string | number | boolean>) => {
    const sessionId = ids("session"), turnId = ids("turn"), queueId = ids("queue"), itemId = ids("item")
    store.createSession({ id: sessionId, directory, title: "savings" })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId, text: "run the tests", attachments: [] })
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: "shell: bun test" } })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", ...(meta ? { meta } : {}) })
    return sessionId
  }
  return { store, toolCall }
}

test("tokens saved by output filters are tallied per filter, scoped to the selected directories", () => {
  const h = fixture()
  try {
    h.toolCall("/repo/src", { savedTokens: 2300, filter: "tests", outputPath: "/data/tool-output/a.txt" })
    h.toolCall("/repo/src", { savedTokens: 700, filter: "tests" })
    h.toolCall("/repo/src", { savedTokens: 120, filter: "git" })
    h.toolCall("/repo/src")
    h.toolCall("/other", { savedTokens: 5000, filter: "search" })
    const s = h.store.usageScopes
    expect(s.savings({ ...range, directories: ["/repo/src"] })).toEqual([{ source: "tests", calls: 2, tokens: 3000 }, { source: "git", calls: 1, tokens: 120 }])
    expect(s.savings({ ...range, directories: ["/repo/src", "/other"] }).map((entry) => entry.source)).toEqual(["search", "tests", "git"])
    expect(s.savings({ ...range, directories: [] })).toEqual([])
    expect(s.savings({ from: "2026-09-21", to: "2026-09-22", directories: ["/repo/src"] })).toEqual([])
  } finally { h.store.close() }
})
