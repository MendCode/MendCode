import { expect, test } from "bun:test"
import { Command, Settings, createIdFactory, isReadOnlyCommand } from "../src"
const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }

test("support commands are additive, validated and classified without exposing files to read-only peers", () => {
  expect(Command.safeParse({ ...base, type: "context.recent", sessionId: ids("session"), limit: 100 }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "context.recent", sessionId: ids("session"), limit: 101 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "system.query", directory: "/tmp/project", operation: "doctor" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "files.query", directory: "/tmp/project", operation: "files", glob: ["*.ts"], limit: 0 }).success).toBe(false)
  expect(isReadOnlyCommand("context.recent")).toBe(true)
  expect(isReadOnlyCommand("system.query")).toBe(false)
  expect(isReadOnlyCommand("files.query")).toBe(false)
  expect(isReadOnlyCommand("diagnostics.snapshot")).toBe(false)
})

test("logLevel accepts v1 level names without changing old settings", () => {
  expect(Settings.parse({})).toEqual({})
  for (const logLevel of ["DEBUG", "INFO", "WARN", "ERROR"] as const) expect(Settings.parse({ logLevel })).toEqual({ logLevel })
  expect(Settings.safeParse({ logLevel: "verbose" }).success).toBe(false)
})
