import { expect, test } from "bun:test"
import { Command, SessionEvent, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session"), requestId: ids("request"), type: "request.resolve" }
const question = { question: "Which store?", header: "Store", options: [{ label: "SQLite" }], multiple: true }

test("question batches and answer arrays are additive to legacy request frames", () => {
  const event = { type: "server.request", seq: 1, at: 1, sessionId: base.sessionId, requestId: base.requestId, turnId: ids("turn"), kind: "question", title: "Store", detail: "" }
  expect(SessionEvent.safeParse(event).success).toBe(true)
  expect(SessionEvent.safeParse({ ...event, questions: [question] }).success).toBe(true)
  expect(Command.safeParse({ ...base, decision: { kind: "answer", text: "SQLite" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, decision: { kind: "answer", text: "SQLite", answers: [["SQLite"], []] } }).success).toBe(true)
  expect(isReadOnlyCommand("request.resolve")).toBe(false)
})

test("batch contracts bound question counts, option counts, labels and answer size", () => {
  const event = { type: "server.request", seq: 1, at: 1, sessionId: base.sessionId, requestId: base.requestId, turnId: ids("turn"), kind: "question", title: "Store", detail: "" }
  for (const questions of [[], Array(33).fill(question), [{ ...question, options: Array(10).fill({ label: "x" }) }], [{ ...question, header: "x".repeat(31) }]]) expect(SessionEvent.safeParse({ ...event, questions }).success).toBe(false)
  for (const answers of [[], [["x".repeat(4001)]], Array(33).fill([])]) expect(Command.safeParse({ ...base, decision: { kind: "answer", text: "", answers } }).success).toBe(false)
})
