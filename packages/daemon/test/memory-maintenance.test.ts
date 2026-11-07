import { expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry } from "@mendcode/protocol"
import { memoryMaintenance } from "../src/memory-maintenance"
const ids = createIdFactory()
const entry = (patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", text: "Use pnpm", category: "commands", status: "saved", source: "agent", createdAt: 1, updatedAt: 1, ...patch })

test("preview identifies only generated unpinned duplicates in the same scope; disabled does nothing", () => {
  const user = entry({ source: "user" })
  const duplicate = entry({ text: "use   PNPM" })
  const others = [entry({ pinned: true }), entry({ scope: "user", profile: "company" }), entry({ directory: "/other" }), entry({ text: "Use bun" }), entry({ kind: "update" }), entry({ source: "user" })]
  expect(memoryMaintenance([duplicate, user, ...others], "preview").duplicates).toEqual([{ memoryId: duplicate.memoryId, canonicalId: user.memoryId }])
  expect(memoryMaintenance([user, duplicate], "disabled").duplicates).toEqual([])
  expect(duplicate.status).toBe("saved")
})

test("an agent proposal pending past the limit expires: new ones are archived, revisions dropped; user, fresh and draft entries stay", async () => {
  const { expiredPending } = await import("../src/memory-maintenance")
  const day = 86_400_000
  const old = entry({ status: "pending", createdAt: 1 })
  const revision = entry({ status: "pending", createdAt: 1, kind: "update", targetId: old.memoryId })
  const kept = [entry({ status: "pending", createdAt: 1, source: "user" }), entry({ status: "pending", createdAt: 20 * day }), entry({ status: "saved", createdAt: 1 }), entry({ status: "pending", createdAt: 1, details: { action: { kind: "edit-memory", targetID: old.memoryId } as never } })]
  const now = 20 * day + 5
  expect(expiredPending([old, revision, ...kept], { now, days: undefined })).toEqual([{ memoryId: old.memoryId, action: "archive" }, { memoryId: revision.memoryId, action: "delete" }])
  expect(expiredPending([old], { now, days: 0 })).toEqual([])
  expect(expiredPending([old], { now, days: 30 })).toEqual([])
})
