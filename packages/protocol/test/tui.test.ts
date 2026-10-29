import { expect, test } from "bun:test"
import { Command, createIdFactory, isReadOnlyCommand, TuiControlInput } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("TUI queries are additive read commands; changes remain forbidden for read-only peers", () => {
  expect(Command.safeParse({ ...base, type: "tui.query", operation: "profile" }).success).toBe(true)
  expect(isReadOnlyCommand("tui.query")).toBe(true)
  expect(isReadOnlyCommand("tui.change")).toBe(false)
  expect(TuiControlInput.safeParse({ operation: "apply", profile: { username: "Nora", submitScroll: "clear" } }).success).toBe(true)
  for (const profile of [{ unknown: true }, { timestamps: "yes" }, { messageRenderer: "fake" }, { pasteSummaryMinChars: 0 }, { statusLeft: "fake" }, { statusColors: '{"model":"invalid"}' }, { logoFont: "weak" }]) expect(TuiControlInput.safeParse({ operation: "apply", profile }).success).toBe(false)
})
test("render evidence rejects path traversal, control sequences, and unbounded data", () => {
  for (const frame of [{ name: "../escape", lines: ["text"] }, { name: "valid", lines: ["\x1b[31mtext"] }, { name: "valid", lines: ["x".repeat(1001)] }]) expect(TuiControlInput.safeParse({ operation: "render", frames: [frame] }).success).toBe(false)
  expect(TuiControlInput.safeParse({ operation: "render", frames: [{ name: "home-100x30", lines: ["MendCode"] }] }).success).toBe(true)
})
test("clipboard opt-in text leaves the original image command compatible", () => {
  expect(Command.safeParse({ ...base, type: "attachment.clipboard" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "attachment.clipboard", text: true }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "attachment.clipboard", text: "yes" }).success).toBe(false)
})
