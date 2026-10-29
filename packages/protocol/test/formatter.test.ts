import { expect, test } from "bun:test"
import { Command, FormatterConfig, FormatterFileReport, FormatterStatusReport, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
test("formatter commands are additive and never permitted to read-only peers", () => {
  const base = { id: ids("command"), clientId: ids("client"), directory: "/work/project" }
  expect(Command.safeParse({ ...base, type: "formatter.status" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "formatter.file", path: "app.ts" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "formatter.file", path: "" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "formatter.file", path: "app.ts", command: ["shell"] }).success).toBe(false)
  expect(isReadOnlyCommand("formatter.file")).toBe(false)
  expect(isReadOnlyCommand("formatter.status")).toBe(false)
})

test("formatter config and reply schemas validate overrides and safe structured outcomes", () => {
  for (const input of [true, false, { prettier: { disabled: true }, custom: { command: ["fmt", "$FILE"], extensions: [".x"], environment: { FLAG: "1" } } }]) expect(FormatterConfig.safeParse(input).success).toBe(true)
  for (const input of [{ custom: { command: [] } }, { custom: { extensions: ["x"] } }, { custom: { environment: { FLAG: 1 } } }]) expect(FormatterConfig.safeParse(input).success).toBe(false)
  expect(FormatterStatusReport.safeParse({ formatters: [{ name: "prettier", extensions: [".ts"], enabled: false, reason: "not installed" }], issues: [] }).success).toBe(true)
  expect(FormatterFileReport.safeParse({ file: "/work/app.ts", formatted: false, results: [{ name: "custom", ok: false, message: "exit 7" }], issues: [] }).success).toBe(true)
})
