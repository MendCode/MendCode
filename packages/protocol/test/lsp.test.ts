import { expect, test } from "bun:test"
import { Command, LspInput, LspReport, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("LSP command validates operations and 1-based editor coordinates", () => {
  const ids = createIdFactory()
  const command = { type: "lsp.query", id: ids("command"), clientId: ids("client"), directory: "/project", filePath: "src/app.ts", line: 1, character: 1, operation: "hover" }
  expect(Command.safeParse(command).success).toBe(true)
  for (const change of [{ operation: "executeCommand" }, { line: 0 }, { character: -1 }, { line: 1.5 }, { filePath: "" }, { unexpected: true }]) expect(Command.safeParse({ ...command, ...change }).success).toBe(false)
  expect(LspInput.safeParse({ operation: "workspaceSymbol", filePath: "app.ts", line: 1, character: 1, query: "" }).success).toBe(true)
})

test("LSP response preserves server shapes and does not grant read-only peers process/config access", () => {
  expect(LspReport.parse({ result: [{ contents: { kind: "markdown", value: "type Result" } }, { children: [{ name: "run" }] }], issues: [{ server: "fake", message: "unsupported" }] }).result).toHaveLength(2)
  expect(isReadOnlyCommand("lsp.query")).toBe(false)
})
