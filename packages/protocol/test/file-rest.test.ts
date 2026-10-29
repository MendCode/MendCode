import { expect, test } from "bun:test"
import { Command, FileContent, FileNode, FileRestInput, FileSearchMatch, FileStatus, FindFileQuery, HttpServerConfig, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
test("file.edit is strict, needs a hash to write and never becomes read-only", () => {
  const base = { type: "file.edit", id: ids("command"), clientId: ids("client"), directory: "/project" }
  const hash = "a".repeat(64)
  for (const input of [{ operation: "read", path: "a.ts" }, { operation: "write", path: "a.ts", content: "x", expected: null }, { operation: "write", path: "a.ts", content: "", expected: hash }]) expect(Command.safeParse({ ...base, input }).success).toBe(true)
  for (const input of [{ operation: "read", path: "" }, { operation: "write", path: "a.ts", content: "x" }, { operation: "write", path: "a.ts", content: "x", expected: "short" }, { operation: "write", path: "a.ts", content: "x".repeat(120_001), expected: null }, { operation: "read", path: "a.ts", extra: 1 }]) expect(Command.safeParse({ ...base, input }).success).toBe(false)
  expect(isReadOnlyCommand("file.edit")).toBe(false)
  expect(HttpServerConfig.parse({}).edit).toBe(false)
})

test("B35 file REST reads are additive, strict and require full authority", () => {
  for (const input of [
    { operation: "find.text", pattern: "execute" }, { operation: "find.files", query: "", dirs: false, limit: 200 },
    { operation: "find.symbols", query: "execute" }, { operation: "file.list", path: "" },
    { operation: "file.read", path: "src/app.ts" }, { operation: "file.status" },
  ]) expect(Command.safeParse({ type: "file.rest.read", id: ids("command"), clientId: ids("client"), directory: "/project", input }).success).toBe(true)
  expect(isReadOnlyCommand("file.rest.read")).toBe(false)
  for (const input of [{ operation: "file.read" }, { operation: "file.status", path: "outside" }, { operation: "find.files", query: "", limit: 201 }, { operation: "find.files", query: "", dirs: "false" }]) expect(FileRestInput.safeParse(input).success).toBe(false)
})

test("B35 HTTP query coercion and payload schemas keep donor names and units", () => {
  expect(FindFileQuery.parse({ query: "src", dirs: "false", type: "file", limit: "10" })).toEqual({ query: "src", dirs: "false", type: "file", limit: 10 })
  for (const limit of ["0", "201", "1.5", "NaN", ""]) expect(FindFileQuery.safeParse({ query: "", limit }).success).toBe(false)
  expect(FileSearchMatch.safeParse({ path: { text: "a.ts" }, lines: { text: "é execute\n" }, line_number: 1, absolute_offset: 0, submatches: [{ match: { text: "execute" }, start: 3, end: 10 }] }).success).toBe(true)
  expect(FileContent.parse({ type: "text", content: "iVBORw==", encoding: "base64", mimeType: "image/png" }).encoding).toBe("base64")
  expect(FileNode.safeParse({ name: "src", path: "src", absolute: "/project/src", type: "directory", ignored: false }).success).toBe(true)
  expect(FileStatus.safeParse({ path: "a.ts", added: 2, removed: 1, status: "modified" }).success).toBe(true)
})
