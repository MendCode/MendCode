import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry } from "@mendcode/protocol"
import { findDuplicate, normalizeMemoryText } from "../src/memory-duplicates"

const ids = createIdFactory()
const entry = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "agent", createdAt: 1, updatedAt: 1, ...patch })

describe("duplicate proposals", () => {
  test("case, spacing, punctuation and accents do not make a different text", () => {
    expect(normalizeMemoryText("  Use PNPM — never npm!  ")).toBe(normalizeMemoryText("use pnpm, never   NPM"))
    expect(normalizeMemoryText("Usa café")).toBe(normalizeMemoryText("usa cafe."))
  })
  test("a repeat is found in any status including archived, and across user and project scope", () => {
    const archived = entry("Run bun test before pushing", { status: "archived" })
    const user = entry("Prefers terse answers", { scope: "user" })
    expect(findDuplicate([archived, user], "run bun TEST before pushing.")).toBe(archived)
    expect(findDuplicate([archived, user], "Prefers   terse answers")).toBe(user)
    expect(findDuplicate([archived, user], "Something else entirely")).toBeUndefined()
  })
  test("revisions and assistant drafts are not memories to repeat", () => {
    expect(findDuplicate([entry("Use bun", { kind: "update", status: "pending" }), entry("Use bun here", { details: { action: { kind: "edit-memory" } as never } })], "Use bun")).toBeUndefined()
  })
})
