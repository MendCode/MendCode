import { expect, test } from "bun:test"
import { Command, GlobalEvent, SessionSummary, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")

test("B64 archive commands and metadata are additive; mutations stay out of the read-only set", () => {
  for (const restore of [undefined, false, true]) expect(Command.safeParse({ ...base, type: "session.archive", sessionId, ...(restore === undefined ? {} : { restore }) }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.archive", sessionId, restore: "yes" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.archive" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.list" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "session.list", archived: true }).success).toBe(true)
  expect(isReadOnlyCommand("session.archive")).toBe(false)
  const summary = { sessionId, title: "Session", directory: "/project", createdAt: 0, updatedAt: 0, lastSeq: 0, queued: 0, state: "idle" }
  expect(SessionSummary.safeParse(summary).success).toBe(true)
  expect(SessionSummary.safeParse({ ...summary, archivedAt: 0 }).success).toBe(true)
  expect(SessionSummary.safeParse({ ...summary, archivedAt: -1 }).success).toBe(false)
  const activity = { type: "session.activity", gseq: 0, at: 0, sessionId, title: "Session", directory: "/project", updatedAt: 0, state: "idle" }
  for (const archivedAt of [undefined, 0, null]) expect(GlobalEvent.safeParse({ ...activity, ...(archivedAt === undefined ? {} : { archivedAt }) }).success).toBe(true)
})
