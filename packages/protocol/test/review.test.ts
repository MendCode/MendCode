import { expect, test } from "bun:test"
import { Command, GlobalEvent, createIdFactory, isReadOnlyCommand, ReviewSnapshot } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
test("review commands are typed but unredacted workspace content requires full-access peers", () => {
  expect(Command.parse({ ...base, type: "review.query", query: {} })).toMatchObject({ query: { action: "current" } })
  expect(Command.parse({ ...base, type: "review.update", change: { action: "navigate", blockIndex: 0 } }).type).toBe("review.update")
  expect(isReadOnlyCommand("review.query")).toBe(false)
  expect(isReadOnlyCommand("review.update")).toBe(false)
  for (const change of [{ action: "navigate", blockIndex: -1 }, { action: "comment_add", body: " " }, { action: "comment_clear", staleOnly: "yes" }, { action: "sync", selection: { row: -1 } }]) expect(Command.safeParse({ ...base, type: "review.update", change }).success).toBe(false)
})
test("review events carry bounded selection/comments without diffs", () => {
  const review = { revision: 2, selection: { filePath: "a.ts", blockIndex: 0, row: 3 }, comments: [] }
  expect(ReviewSnapshot.parse(review)).toEqual(review)
  expect(GlobalEvent.parse({ type: "review.changed", gseq: 0, at: 123, sessionId: base.sessionId, review })).toMatchObject({ review })
  expect(GlobalEvent.safeParse({ type: "review.changed", gseq: 0, at: 123, sessionId: base.sessionId, review, diff: "secret snapshot" }).success).toBe(false)
})
