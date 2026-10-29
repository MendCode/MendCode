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
