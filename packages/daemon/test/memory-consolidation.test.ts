import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry } from "@mendcode/protocol"
import { consolidateMemory } from "../src/memory-consolidation"

const ids = createIdFactory()
const memory = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", category: "commands", source: "agent", status: "pending", createdAt: 0, updatedAt: 0, text, details: { confidence: .95, durability: .9, changeRisk: .1 }, ...patch })

function harness(initial: MemoryEntry[]) {
  let entries = initial
  const applied: string[] = []
  return { entries: () => entries, applied,
    change: (id: string, patch: Partial<MemoryEntry>) => { entries = entries.map((entry) => entry.memoryId === id ? { ...entry, ...patch } : entry) },
    archive: (memory: MemoryEntry) => { entries = entries.map((entry) => entry.memoryId === memory.memoryId ? { ...entry, status: "archived" } : entry) },
    apply: async (memory: MemoryEntry) => { applied.push(memory.text); entries = entries.map((entry) => entry.memoryId === memory.memoryId ? { ...entry, status: "saved" } : entry) },
  }
}

describe("B19 deterministic consolidation", () => {
  test("preview and disabled do not mutate any proposal; configured caps bound the pass", async () => {
    const h = harness([memory("Use pnpm to install packages"), memory("Run checks before deploying")])
    const preview = await consolidateMemory({ ...h, policy: "preview", limit: 1 })
    expect(preview).toMatchObject({ applied: 0, archived: 0, pendingAfter: 2, decisions: [{ outcome: "preview" }] })
    expect(preview.decisions).toHaveLength(1)
    expect((await consolidateMemory({ ...h, policy: "disabled", limit: 50 })).decisions).toEqual([])
    expect(h.applied).toEqual([])
  })
  test("high scores are insufficient for redacted text, sensitive categories and user/pinned targets", async () => {
    const target = memory("The original remembered fact", { status: "saved", source: "user", pinned: true })
    const h = harness([target, memory("Use secret sk-abcdEFGH1234ijklMNOP5678"), memory("Private account settings", { category: "preferences" }), memory("An updated remembered fact", { kind: "update", targetId: target.memoryId }), memory("Low durability proposal", { details: { confidence: 1, durability: .1, changeRisk: 0 } })])
    const result = await consolidateMemory({ ...h, policy: "auto-consolidate", limit: 50 })
    expect(result).toMatchObject({ applied: 0, archived: 4, pendingAfter: 0 })
    expect(h.entries()[0]).toMatchObject({ status: "saved", text: target.text, pinned: true })
  })
  test("near duplicates are grouped within a scope, and the highest scored proposal wins", async () => {
    const h = harness([memory("Release stable builds after running integration checks", { details: { confidence: .91, durability: .86, changeRisk: .2 } }), memory("Release stable builds only after running integration checks"), memory("Release stable builds only after running integration checks", { scope: "user" })])
    const result = await consolidateMemory({ ...h, policy: "auto-consolidate", limit: 50 })
    expect(result).toMatchObject({ applied: 2, archived: 1 })
    expect(h.applied).toEqual(["Release stable builds only after running integration checks", "Release stable builds only after running integration checks"])
  })
  test("a proposal edited during another resolution is not applied using stale scores", async () => {
    const first = memory("First command for this project")
    const second = memory("Second independent build procedure")
    const h = harness([first, second])
    const apply = async (entry: MemoryEntry) => { await h.apply(entry); h.change(second.memoryId, { text: "Changed while applying", details: { confidence: 0 } }) }
    const result = await consolidateMemory({ ...h, apply, policy: "auto-consolidate", limit: 50 })
    expect(result).toMatchObject({ applied: 1, pendingAfter: 1 })
    expect(result.decisions.at(-1)).toMatchObject({ outcome: "failed", reason: "Proposal changed during consolidation" })
  })
})
