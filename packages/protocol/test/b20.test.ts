import { expect, test } from "bun:test"
import { Command, createIdFactory, isReadOnlyCommand } from "../src"
import { commandTimeout } from "@mendcode/client"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("B20 additive commands validate identity, bounds and dry-run defaults", () => {
  expect(Command.parse({ ...base, type: "loop.tick", directory: "/repo" })).toMatchObject({ limit: 1, execute: false, reportOnly: false })
  expect(Command.safeParse({ ...base, type: "loop.draft", directory: "/repo", template: "pr-watch" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "loop.draft", directory: "/repo" }).success).toBe(false)
  const loopId = ids("loop")
  for (const type of ["loop.snapshot", "loop.events", "loop.activate"] as const) {
    expect(Command.safeParse({ ...base, type, loopId }).success).toBe(true)
    expect(Command.safeParse({ ...base, type }).success).toBe(false)
  }
  for (const limit of [0, 201, 1.5]) expect(Command.safeParse({ ...base, type: "loop.events", loopId, limit }).success).toBe(false)
  for (const limit of [0, 101]) expect(Command.safeParse({ ...base, type: "loop.tick", directory: "/repo", limit }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "loop.draft", directory: "/repo", name: "n", objective: "o", trigger: { kind: "daily", at: "25:00" } }).success).toBe(false)
})
test("B20 user-text reports and mutating controls stay outside READ_ONLY_COMMANDS", () => {
  for (const type of ["loop.draft", "loop.snapshot", "loop.events", "loop.activate", "loop.tick"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  expect(commandTimeout({ type: "loop.tick", directory: "/repo", limit: 1, reportOnly: false, execute: false }, 15_000)).toBe(15_000)
  expect(commandTimeout({ type: "loop.tick", directory: "/repo", limit: 1, reportOnly: false, execute: true }, 15_000)).toBe(16 * 60_000)
})
