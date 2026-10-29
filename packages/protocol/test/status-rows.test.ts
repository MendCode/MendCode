import { expect, test } from "bun:test"
import { StatusLineChanged } from "../src/events"

const legacy = { type: "status.line" as const, gseq: 0, at: 0, directory: "/tmp/project", left: [{ text: "main" }], right: [], problems: [] }

test("status.line accepts old clients' single row and bounded optional rows", () => {
  expect(StatusLineChanged.parse(legacy)).toEqual(legacy)
  const rows = Array.from({ length: 4 }, () => Array.from({ length: 32 }, () => ({ text: "x".repeat(240), fg: "#70ffaf", bold: true, prepend: true })))
  expect(StatusLineChanged.safeParse({ ...legacy, leftRows: rows, rightRows: rows }).success).toBe(true)
})

test("status.line refuses unbounded rows, text, colors and unknown segment fields", () => {
  for (const rows of [Array(5).fill([]), [Array(33).fill({ text: "x" })], [[{ text: "x".repeat(241) }]], [[{ text: "x", fg: "red" }]], [[{ text: "x", breakBefore: true }]]]) {
    expect(StatusLineChanged.safeParse({ ...legacy, leftRows: rows }).success).toBe(false)
    expect(StatusLineChanged.safeParse({ ...legacy, rightRows: rows }).success).toBe(false)
  }
})
