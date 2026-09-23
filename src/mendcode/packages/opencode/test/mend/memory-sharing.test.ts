import { expect, test } from "bun:test"
import { readFile, writeFile, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { appendMemoryEntry, readMemoryEntries, updateMemoryEntry } from "../../src/mend/memory/store"
import { applyMemoryProposal, listMemoryProposals } from "../../src/mend/memory/proposals"
import { runMemoryConsolidation } from "../../src/mend/memory/dream-consolidation"
import { configureMemorySharing, exportSharedMemories, importSharedMemories } from "../../src/mend/memory/sharing"

test("Markdown sharing requires explicit opt-in separately for each scope", async () => {
  await using tmp = await tmpdir()
  await expect(exportSharedMemories("project", tmp.path)).rejects.toThrow("disabled")
  await configureMemorySharing("project", true, tmp.path)
  expect((await exportSharedMemories("project", tmp.path)).exported).toEqual([])
  await expect(exportSharedMemories("global", tmp.path)).rejects.toThrow("disabled")
})

test("edited Markdown becomes a deduplicated manual proposal, not an automatic overwrite", async () => {
  await using tmp = await tmpdir()
  const entry = await appendMemoryEntry({ scope: "project", text: "Use focused checks." }, tmp.path)
  await configureMemorySharing("project", true, tmp.path)
  const exported = await exportSharedMemories("project", tmp.path)
  const file = path.join(exported.directory, `${entry.id}.md`)
  const edited = (await readFile(file, "utf8")).replace("Use focused checks.", "Use focused checks and typecheck.")
  await writeFile(file, edited)
  expect((await exportSharedMemories("project", tmp.path)).conflicts).toContain(entry.id)
  expect(await readFile(file, "utf8")).toBe(edited)
  const imported = await importSharedMemories("project", tmp.path)
  expect(imported.proposals).toHaveLength(1)
  expect((await importSharedMemories("project", tmp.path)).proposals).toEqual(imported.proposals)
  expect((await readMemoryEntries("project", tmp.path))[0]?.text).toBe("Use focused checks.")
  expect((await listMemoryProposals(tmp.path, "pending"))[0]?.policyDecision).toBe("manual-only")
  const dream = await runMemoryConsolidation({
    root: tmp.path, runID: "sharing-manual-review", policy: "auto-consolidate",
    model: async ({ proposals }) => proposals.map((proposal) => ({ proposalID: proposal.id, resolution: "archive" as const, reason: "Attempted automatic resolution" })),
  })
  expect(dream.status).toBe("failed")
  expect(dream.failureReason).toContain("manual review")
  expect(await listMemoryProposals(tmp.path, "pending")).toHaveLength(1)
  await applyMemoryProposal(imported.proposals[0]!, tmp.path)
  expect((await readMemoryEntries("project", tmp.path))[0]?.text).toBe("Use focused checks and typecheck.")
  expect((await exportSharedMemories("project", tmp.path)).conflicts).toEqual([])
  expect((await importSharedMemories("project", tmp.path)).proposals).toEqual([])
})

test("internal changes conflict both during import and at later approval", async () => {
  await using tmp = await tmpdir()
  const entry = await appendMemoryEntry({ scope: "project", text: "Original accepted rule." }, tmp.path)
  await configureMemorySharing("project", true, tmp.path)
  const exported = await exportSharedMemories("project", tmp.path)
  const file = path.join(exported.directory, `${entry.id}.md`)
  await writeFile(file, (await readFile(file, "utf8")).replace("Original accepted rule.", "Edited external rule."))
  const imported = await importSharedMemories("project", tmp.path)
  await updateMemoryEntry("project", entry.id, { text: "New internal rule." }, tmp.path)
  expect((await importSharedMemories("project", tmp.path)).conflicts).toContain(entry.id)
  await expect(applyMemoryProposal(imported.proposals[0]!, tmp.path)).rejects.toThrow("revision conflict")
  expect((await readMemoryEntries("project", tmp.path))[0]?.text).toBe("New internal rule.")
})

test("corrupted or scope-tampered metadata is reported as a conflict", async () => {
  await using tmp = await tmpdir()
  const entry = await appendMemoryEntry({ scope: "project", text: "Protected metadata." }, tmp.path)
  await configureMemorySharing("project", true, tmp.path)
  const exported = await exportSharedMemories("project", tmp.path)
  const file = path.join(exported.directory, `${entry.id}.md`)
  const original = await readFile(file, "utf8")
  for (const edited of [original.replace('"scope":"project"', '"scope":"global"'), "<!-- mendcode-memory invalid JSON -->\n\nChanged text."]) {
    await writeFile(file, edited)
    const result = await importSharedMemories("project", tmp.path)
    expect(result.conflicts).toEqual([entry.id])
    expect(result.proposals).toEqual([])
  }
})

test("sharing excludes sensitive entries and detected credentials", async () => {
  await using tmp = await tmpdir()
  const privateEntry = await appendMemoryEntry({ scope: "project", text: "Private preference", sensitivity: "medium" }, tmp.path)
  const secret = await appendMemoryEntry({ scope: "project", text: "OPENAI_API_KEY=SHARING_TEST_CREDENTIAL" }, tmp.path)
  await configureMemorySharing("project", true, tmp.path)
  const result = await exportSharedMemories("project", tmp.path)
  expect(result.exported).toEqual([])
  expect(result.skipped.sort()).toEqual([privateEntry.id, secret.id].sort())
})

test("deleting a shared file never deletes internal memory; symlinks are refused", async () => {
  await using tmp = await tmpdir()
  const entry = await appendMemoryEntry({ scope: "project", text: "Keep internal authority." }, tmp.path)
  await configureMemorySharing("project", true, tmp.path)
  const exported = await exportSharedMemories("project", tmp.path)
  const file = path.join(exported.directory, `${entry.id}.md`)
  await unlink(file)
  expect((await importSharedMemories("project", tmp.path)).proposals).toEqual([])
  expect(await readMemoryEntries("project", tmp.path)).toHaveLength(1)
  const outside = path.join(tmp.path, "outside.txt")
  await writeFile(outside, "Do not read or overwrite")
  await symlink(outside, file)
  await expect(importSharedMemories("project", tmp.path)).rejects.toThrow()
  await expect(exportSharedMemories("project", tmp.path)).rejects.toThrow()
  expect(await readFile(outside, "utf8")).toBe("Do not read or overwrite")
})
