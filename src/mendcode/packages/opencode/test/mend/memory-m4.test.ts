import { describe, expect, test } from "bun:test"
import { appendMemoryEntry, readArchivedMemoryEntries, readMemoryEntries, restoreArchivedMemoryEntries } from "../../src/mend/memory/store"
import { runMemoryDream } from "../../src/mend/memory/dream"
import { tmpdir } from "../fixture/fixture"

describe("Memory M4 Dream controls", () => {
  test("maintains accepted duplicates with no pending proposals and restores them reversibly", async () => {
    await using dir = await tmpdir()
    const canonical = await appendMemoryEntry({ scope: "project", text: "Keep Dream maintenance bounded and auditable.", tags: ["canonical"], evidence: "evidence:a" }, dir.path)
    const duplicate = await appendMemoryEntry({ scope: "project", text: "Keep Dream maintenance bounded and auditable.", tags: ["duplicate"], evidence: "evidence:b" }, dir.path)
    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidator: async () => [], consolidationPolicy: "auto-consolidate" })

    expect(run.status).toBe("completed")
    expect((await readMemoryEntries("project", dir.path)).map((entry) => entry.id)).toEqual([canonical.id])
    expect((await readArchivedMemoryEntries("project", dir.path)).map((entry) => entry.id)).toContain(duplicate.id)
    expect((await readMemoryEntries("project", dir.path))[0]?.evidence).toContain("evidence:b")

    expect((await restoreArchivedMemoryEntries("project", [duplicate.id], dir.path)).restored).toHaveLength(1)
    expect((await readMemoryEntries("project", dir.path)).map((entry) => entry.id)).toContain(duplicate.id)
  })

  test("preview records candidates without creating or applying memory", async () => {
    await using dir = await tmpdir()
    const run = await runMemoryDream({
      root: dir.path,
      consolidationPolicy: "preview",
      model: async () => [{ text: "Preview must not mutate the memory store.", categoryIDs: ["memory.policy"] }],
    })

    expect(run.status).toBe("completed")
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(0)
  })

  test("accepted-only maintenance reports consolidator errors without fake success", async () => {
    await using dir = await tmpdir()
    const entry = await appendMemoryEntry({ scope: "project", text: "Keep accepted memory after provider failure." }, dir.path)
    const run = await runMemoryDream({
      root: dir.path,
      consolidationPolicy: "preview",
      model: async () => [],
      consolidator: async () => { throw new Error("controlled consolidation failure") },
    })
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("controlled consolidation failure")
    expect((await readMemoryEntries("project", dir.path)).map((item) => item.id)).toEqual([entry.id])
  })

  test("reports an unavailable Dream model instead of using a deterministic fallback", async () => {
    await using dir = await tmpdir()
    const run = await runMemoryDream({ root: dir.path, consolidationPolicy: "preview" })

    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("no deterministic fallback")
  })
})
