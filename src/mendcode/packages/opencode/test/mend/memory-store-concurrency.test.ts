import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { appendMemoryEntry, readMemoryEntries, updateMemoryEntry, archiveMemoryEntries } from "../../src/mend/memory/store"

test("concurrent memory read-modify-write operations preserve unrelated entries", async () => {
  await using tmp = await tmpdir()
  const first = await appendMemoryEntry({ text: "first", scope: "project" }, tmp.path)
  const second = await appendMemoryEntry({ text: "second", scope: "project" }, tmp.path)
  await Promise.all([
    updateMemoryEntry("project", first.id, { text: "updated first" }, tmp.path),
    updateMemoryEntry("project", second.id, { text: "updated second" }, tmp.path),
    appendMemoryEntry({ text: "third", scope: "project" }, tmp.path),
  ])
  expect((await readMemoryEntries("project", tmp.path)).map((entry) => entry.text).sort()).toEqual([
    "third", "updated first", "updated second",
  ])
  await Promise.all([
    archiveMemoryEntries("project", [{ id: first.id, reason: "obsolete" }], tmp.path),
    appendMemoryEntry({ text: "fourth", scope: "project" }, tmp.path),
  ])
  expect((await readMemoryEntries("project", tmp.path)).map((entry) => entry.text).sort()).toEqual([
    "fourth", "third", "updated second",
  ])
})
