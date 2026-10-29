import { expect, test } from "bun:test"
import { Command, ModelChoice, ProviderModel, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session"), type: "session.history" }
test("history cursors and detail requests are exclusive and bounded", () => {
  expect(Command.safeParse(base).success).toBe(true)
  expect(Command.safeParse({ ...base, before: 4, after: 0 }).success).toBe(false)
  expect(Command.safeParse({ ...base, turnId: ids("turn"), before: 4 }).success).toBe(false)
  for (const limit of [0, 51]) expect(Command.safeParse({ ...base, limit }).success).toBe(false)
  expect(isReadOnlyCommand("session.history")).toBe(true)
  expect(isReadOnlyCommand("skills.load")).toBe(true)
  expect(isReadOnlyCommand("skills.set")).toBe(false)
})
test("legacy choices still parse, named variants are optional, and generation parameters have explicit limits", () => {
  expect(ModelChoice.parse({ model: "test", effort: "high" })).toEqual({ model: "test", effort: "high" })
  expect(ModelChoice.parse({ model: "test", variant: "precise" }).variant).toBe("precise")
  expect(ProviderModel.safeParse({ id: "test", variants: { default: {} } }).success).toBe(false)
  expect(ModelChoice.safeParse({ model: "test", parameters: { temperature: "x".repeat(8_001) } }).success).toBe(false)
  expect(ModelChoice.safeParse({ model: "test", parameters: { messages: [] } }).success).toBe(false)
})
