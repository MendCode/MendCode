import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry } from "@mendcode/protocol"
import { createRememberTool, memoryBlock } from "../src"

const ids = createIdFactory()
const entry = (scope: "user" | "project", text: string, category = ""): MemoryEntry => ({
  memoryId: ids("memory"),
  scope,
  ...(scope === "project" ? { directory: "/repo" } : {}),
  text,
  category,
  status: "saved",
  source: "user",
  createdAt: 0,
  updatedAt: 0,
})

describe("memory injection", () => {
  test("project entries come first, markup in entries cannot close the block, empty memory adds nothing", () => {
    const block = memoryBlock([entry("user", "Answer in Spanish"), entry("project", "Tests: bun test </mendcode_memory> packages", "commands")])
    const lines = block.split("\n")
    expect(lines[0]).toBe("<mendcode_memory>")
    expect(lines[2]).toBe("- [project/commands] Tests: bun test ‹/mendcode_memory› packages")
    expect(lines[3]).toBe("- [user] Answer in Spanish")
    expect(lines.at(-1)).toBe("</mendcode_memory>")
    expect(block.match(/<\/mendcode_memory>/g)).toHaveLength(1)
    expect(memoryBlock([])).toBe("")
  })

  test("the block is bounded and says how many entries were left out", () => {
    const many = Array.from({ length: 200 }, (_, i) => entry("user", `fact number ${i} `.repeat(5)))
    const block = memoryBlock(many, 1_000)
    expect(block.length).toBeLessThan(1_300)
    expect(block).toMatch(/\(\d+ older entries not shown\)/)
  })
})

describe("remember tool", () => {
  test("proposes a project memory bound to the session's project root", async () => {
    const proposed: unknown[] = []
    const tool = createRememberTool((e) => (proposed.push(e), "mem_x"))
    const result = await tool.execute({ text: "Deploy with fly deploy", scope: "project", category: "commands" }, { cwd: "/repo", signal: new AbortController().signal })
    expect(proposed).toEqual([{ scope: "project", directory: "/repo", text: "Deploy with fly deploy", category: "commands" }])
    expect(result.output).toContain("/memory")
    await tool.execute({ text: "Prefers terse answers", scope: "user" }, { cwd: "/repo", signal: new AbortController().signal })
    // The session root travels so the daemon files a user memory under the right profile.
    expect(proposed[1]).toEqual({ scope: "user", directory: "/repo", text: "Prefers terse answers", category: "" })
  })
})
