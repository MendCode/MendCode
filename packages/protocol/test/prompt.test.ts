import { expect, test } from "bun:test"
import { Command, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"
const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
test("prompt commands are additive and reject unknown modes, families and arguments", () => {
  for (const type of ["prompt.status", "prompt.sources", "prompt.build", "prompt.cycle"]) expect(Command.safeParse({ ...base, type }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "prompt.set", mode: "full", focusID: "gemini" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "prompt.set", focusID: "auto" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "prompt.status", modelID: "claude-sonnet-5-5" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "prompt.sources", modelID: "claude-sonnet-5-5" }).success).toBe(true)
  for (const input of [{ type: "prompt.set" }, { type: "prompt.set", mode: "foo" }, { type: "prompt.build", focusID: "foo" }, { type: "prompt.build", extra: true }]) expect(Command.safeParse({ ...base, ...input }).success).toBe(false)
})
test("prompt metadata can contain unredacted project names and requires full-access peers", () => {
  expect(isReadOnlyCommand("prompt.status")).toBe(false)
  expect(isReadOnlyCommand("prompt.sources")).toBe(false)
  for (const type of ["prompt.build", "prompt.set", "prompt.cycle"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
