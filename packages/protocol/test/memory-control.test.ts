import { describe, expect, test } from "bun:test"
import { Command, createIdFactory, DreamReport, MemoryConfigPatch, MemoryControlInput } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), directory: "/repo" }

describe("B19 memory and Dream contracts", () => {
  test("additive control commands validate required ids, text and exclusive inputs", () => {
    expect(Command.safeParse({ ...base, type: "memory.control", input: { operation: "status" } }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "dream.control", input: { operation: "consolidate", policy: "preview" } }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "dream.run" }).success).toBe(true)
    for (const operation of ["edit", "delete", "apply", "reject"] as const) expect(MemoryControlInput.safeParse({ operation }).success).toBe(false)
    expect(MemoryControlInput.safeParse({ operation: "propose", text: "fact", fromFile: "notes.txt" }).success).toBe(false)
    expect(MemoryControlInput.safeParse({ operation: "preview", mode: "manual", provider: "local", model: "test" }).success).toBe(true)
    expect(MemoryControlInput.safeParse({ operation: "import-codex", maxProposals: 51 }).success).toBe(false)
  })
  test("config rejects invalid caps and policies; mixed commands never become remote reads", () => {
    expect(MemoryConfigPatch.safeParse({ memoryProjectMaxEntries: 0 }).success).toBe(false)
    expect(MemoryConfigPatch.safeParse({ dreamConsolidationPolicy: "auto" }).success).toBe(false)
    expect(isReadOnlyCommand("memory.control")).toBe(false)
    expect(isReadOnlyCommand("dream.control")).toBe(false)
  })
  test("old Dream reports remain valid and consolidation has a bounded decision ledger", () => {
    const report = { read: { sessions: [], memories: 0, promptChars: 0 }, proposed: [], refused: [], redactions: { evidence: 0, proposals: 0 }, model: { calls: 0, inputTokens: 0, outputTokens: 0, estimated: false }, budget: { limit: 1_000, used: 0, stopped: false }, failures: [] }
    expect(DreamReport.safeParse(report).success).toBe(true)
    expect(DreamReport.safeParse({ ...report, consolidation: { policy: "preview", pendingBefore: 1, pendingAfter: 1, applied: 0, archived: 0, decisions: [{ memoryId: ids("memory"), outcome: "preview", reason: "Eligible" }] } }).success).toBe(true)
  })
})
