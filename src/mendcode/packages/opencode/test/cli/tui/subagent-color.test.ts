import { describe, expect, test } from "bun:test"
import { subagentTaskColorIndex, type SubagentTaskColorEntry } from "@/cli/cmd/tui/util/subagent-color"

describe("subagentTaskColorIndex", () => {
  test("rotates repeated adjacent subagent types", () => {
    const entries: SubagentTaskColorEntry[] = [
      { callID: "task-1", subagentType: "code-reviewer" },
      { callID: "task-2", subagentType: "code-reviewer" },
      { callID: "task-3", subagentType: "frontend-developer" },
    ]

    const first = subagentTaskColorIndex(entries, "task-1", 7)
    const second = subagentTaskColorIndex(entries, "task-2", 7)
    const third = subagentTaskColorIndex(entries, "task-3", 7)

    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
  })

  test("keeps deterministic colors for the same visible task sequence", () => {
    const entries: SubagentTaskColorEntry[] = [
      { callID: "task-1", subagentType: "code-reviewer" },
      { callID: "task-2", subagentType: "frontend-developer" },
      { callID: "task-3", subagentType: "code-reviewer" },
    ]

    expect(subagentTaskColorIndex(entries, "task-3", 7)).toBe(subagentTaskColorIndex(entries, "task-3", 7))
  })
})
