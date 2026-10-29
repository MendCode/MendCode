import { expect, test } from "bun:test"
import { commandTimeout } from "../src"

test("B19 extraction and synchronous Dream deadlines cannot expire at the ordinary RPC timeout", () => {
  expect(commandTimeout({ type: "memory.control", directory: "/repo", input: { operation: "propose", fromFile: "notes.md" } }, 15_000)).toBe(50_000)
  expect(commandTimeout({ type: "memory.control", directory: "/repo", input: { operation: "import-codex", apply: true } }, 15_000)).toBe(50_000)
  expect(commandTimeout({ type: "dream.control", directory: "/repo", input: { operation: "run" } }, 15_000)).toBe(3_600_000)
  expect(commandTimeout({ type: "dream.control", directory: "/repo", input: { operation: "consolidate" } }, 15_000)).toBe(3_600_000)
})

test("B19 quick reads and explicit larger client deadlines keep their configured budget", () => {
  expect(commandTimeout({ type: "memory.control", directory: "/repo", input: { operation: "import-codex" } }, 15_000)).toBe(15_000)
  expect(commandTimeout({ type: "memory.control", directory: "/repo", input: { operation: "status" } }, 1_000)).toBe(1_000)
  expect(commandTimeout({ type: "dream.control", directory: "/repo", input: { operation: "status" } }, 1_000)).toBe(1_000)
  expect(commandTimeout({ type: "daemon.info" }, 1_000)).toBe(1_000)
  expect(commandTimeout({ type: "memory.control", directory: "/repo", input: { operation: "import-codex", apply: true } }, 60_000)).toBe(60_000)
})
