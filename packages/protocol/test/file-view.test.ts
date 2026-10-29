import { expect, test } from "bun:test"
import { Command, FILE_VIEW_MAX_ROWS, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = () => ({ type: "file.view", id: ids("command"), clientId: ids("client"), directory: "/project", path: "src/app.rs" })

test("file.view takes a path and an optional window, search and version, and nothing else", () => {
  for (const extra of [{}, { from: 11_000, count: 40 }, { search: "todo" }, { known: "120:1790000000000" }, { count: FILE_VIEW_MAX_ROWS }, { lang: "ts", from: 3_000 }]) expect(Command.safeParse({ ...base(), ...extra }).success).toBe(true)
  for (const extra of [{ lang: "" }, { lang: "x".repeat(33) }, { path: "" },{ from: 0 }, { count: FILE_VIEW_MAX_ROWS + 1 }, { count: 0 }, { search: "" }, { extra: true }, { from: 1.5 }]) expect(Command.safeParse({ ...base(), ...extra }).success).toBe(false)
})

test("file.view is never a read-only peer's command: file contents can hold credentials", () => {
  expect(isReadOnlyCommand("file.view")).toBe(false)
})
