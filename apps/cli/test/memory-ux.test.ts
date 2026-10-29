import { expect, test } from "bun:test"
import { renderExtraction } from "../src/view/memory-extraction-tab"
import { createMemoryPageState, memoryPageKey } from "../src/view/memory-page"
import type { MemoryEntry } from "@mendcode/protocol"
import { createTranscript } from "../src/view/transcript"
import { ids, NOW } from "./session-ui-harness"
import type { SessionEvent } from "@mendcode/protocol"

test("extraction separates enablement, queue, last run, errors and maintenance", () => {
  const rows = renderExtraction({ configured: true, settings: { memoryEnabled: true, memoryGenerate: true }, jobs: [{ jobId: "extract_t", sessionId: "ses_t", turnId: "trn_t", directory: "/project", state: "failed", attempts: 3, proposed: 0, reason: "Extractor timed out", nextAttemptAt: 0, createdAt: 0, updatedAt: 1 }], maintenance: { policy: "disabled", duplicates: [] } }, { selected: 0 }, 100, 35)
  const text = rows.map((line) => line.map((span) => span.text).join("")).join("\n")
  expect(text).toContain("Extraction enabled")
  expect(text).toContain("Queue 0 · Last run failed")
  expect(text).toContain("Last error: Extractor timed out")
  expect(text).toContain("Maintenance: disabled · 0 duplicate memories")
})

test("empty extraction status remains visible at narrow width", () => {
  const rows = renderExtraction({ configured: true, settings: { memoryGenerate: true } }, { selected: 0 }, 60, 20)
  const text = rows.flatMap((line) => line.map((span) => span.text)).join("")
  expect(text).toContain("Extraction enabled")
  expect(text).toContain("Last run never")
  expect(text).toContain("Last error: none")
})

test("Saved offers edit, cancel delete and confirmed delete for the selected fact", () => {
  const entry = { memoryId: "mem_fact", scope: "user", text: "My name is Nora", category: "preferences", status: "saved", source: "user", createdAt: 0, updatedAt: 0 } as MemoryEntry
  const state = { ...createMemoryPageState(), tab: "saved" as const }
  expect(memoryPageKey(state, "e", [entry]).action).toEqual({ type: "edit", memoryId: entry.memoryId, text: entry.text })
  const confirming = memoryPageKey(state, "d", [entry]).state
  expect(confirming.confirmDelete).toBe(true)
  expect(memoryPageKey(confirming, "\x1b", [entry]).action.type).toBe("none")
  expect(memoryPageKey(confirming, "y", [entry]).action).toEqual({ type: "delete", memoryId: entry.memoryId })
})

test("saved notice stays visible and muted when later compact tools fold", () => {
  const transcript = createTranscript({ now: () => NOW })
  const sessionId = ids("session")
  const turnId = ids("turn")
  let seq = 0
  const emit = (event: Record<string, unknown>) => transcript.apply({ ...event, sessionId, seq: ++seq, at: NOW } as SessionEvent)
  const notice = "memory saved · My name is Nora · /memory to undo"
  for (let index = 0; index < 15; index++) {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: index === 0 ? "memory_graph" : "read" } })
    emit({ type: "item.completed", itemId, status: "ok", text: index === 0 ? notice : "read done", ...(index === 0 ? { meta: { memorySaved: true } } : {}) })
  }
  for (const mode of ["balanced", "minimal", "full"] as const) {
    transcript.setMode(mode)
    const lines = transcript.viewport(100, 100)
    const rows = lines.filter((line) => line.text.includes("memory saved"))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toContain(notice)
    expect(rows[0]?.spans.find((span) => span.text.includes("memory"))).toMatchObject({ fg: "muted", dim: true })
  }
})
