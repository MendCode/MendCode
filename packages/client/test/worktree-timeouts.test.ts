import { expect, test } from "bun:test"
import { commandTimeout } from "../src"

test("a scan of many large worktrees is not cut at the ordinary 15 seconds; a plain storage report is", () => {
  expect(commandTimeout({ type: "storage.worktrees" }, 15_000)).toBe(600_000)
  expect(commandTimeout({ type: "storage.clean", olderThanDays: 0, worktreesOnly: true, worktrees: true }, 15_000)).toBe(600_000)
  expect(commandTimeout({ type: "storage.clean", olderThanDays: 0, artifacts: true }, 15_000)).toBe(600_000)
  expect(commandTimeout({ type: "storage.clean", olderThanDays: 90 }, 15_000)).toBe(15_000)
  expect(commandTimeout({ type: "storage.report" }, 15_000)).toBe(15_000)
})
