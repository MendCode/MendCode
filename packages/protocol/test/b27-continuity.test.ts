import { expect, test } from "bun:test"
import { Command, Settings, createIdFactory, SessionEvent } from "../src"
import { isReadOnlyCommand } from "../src/remote"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }

test("async flags are additive, independent and unset by default", () => {
  expect(Settings.parse({})).toEqual({})
  expect(Settings.parse({ experimental: { async_tools: true, async_questions: false } }).experimental).toEqual({ async_tools: true, async_questions: false })
  expect(Settings.safeParse({ experimental: { async_tools: "yes" } }).success).toBe(false)
})

test("continuity commands validate scope, result pages and the 12-job/60-second wait caps; content/control stay full-access", () => {
  for (const input of [
    { type: "continuity.list", kind: "job" },
    { type: "continuity.get", recordId: "job_1", offset: 0, limit: 16000 },
    { type: "continuity.cancel", recordId: "job_1" },
    { type: "continuity.wait", recordIds: ["job_1"], timeoutMs: 60000 },
  ] as const) {
    expect(Command.safeParse({ ...base, ...input }).success).toBe(true)
    expect(isReadOnlyCommand(input.type)).toBe(false)
    expect(Command.safeParse({ ...base, ...input, sessionId: undefined }).success).toBe(false)
  }
  expect(Command.safeParse({ ...base, type: "continuity.get", recordId: "job_1", limit: 16001 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "continuity.wait", recordIds: [], timeoutMs: 0 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "continuity.wait", recordIds: ["job_1"], timeoutMs: 60001 }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "continuity.wait", recordIds: Array(13).fill("job_1") }).success).toBe(false)
})

test("async questions reuse the existing request protocol and continuity events carry bounded summaries", () => {
  const sessionId = base.sessionId, turnId = ids("turn")
  expect(SessionEvent.safeParse({ type: "server.request", seq: 1, at: 1, sessionId, turnId, requestId: ids("request"), kind: "question", title: "Which store?", detail: "", async: true }).success).toBe(true)
  const event = { type: "continuity.updated", seq: 2, at: 2, sessionId, record: { id: "job_1", sessionId, turnId, kind: "job", generation: 0, tool: "read", status: "running", createdAt: 1, updatedAt: 2 } }
  expect(SessionEvent.safeParse(event).success).toBe(true)
  expect(SessionEvent.safeParse({ ...event, record: { ...event.record, output: "not a summary" } }).success).toBe(false)
})
