import { expect, test } from "bun:test"
import { Command, ContextReport, SessionSummary, createIdFactory, isReadOnlyCommand } from "../src"
import { SESSION_COLORS } from "../src/wire"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")

test("the agent-view metadata patch takes a color from the palette, or null to clear it", () => {
  const ok = (patch: Record<string, unknown>) => Command.safeParse({ ...base, type: "session.agent-view.metadata.patch", sessionId, patch }).success
  expect(ok({ tags: ["a", "b"], color: "red" })).toBe(true)
  expect(ok({ tags: [], color: null })).toBe(true)
  for (const color of SESSION_COLORS) expect(ok({ color })).toBe(true)
  expect(ok({ color: "magenta" })).toBe(false)
  expect(ok({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false)
})

test("session.search needs text of at most 200 characters and bounds its scope", () => {
  const ok = (extra: Record<string, unknown>) => Command.safeParse({ ...base, type: "session.search", ...extra }).success
  expect(ok({ text: "refund" })).toBe(true)
  expect(ok({ text: "a.*b", regex: true, sessionIds: [sessionId], directory: "/p", limit: 10 })).toBe(true)
  expect(ok({ text: "" })).toBe(false)
  expect(ok({ text: "x".repeat(201) })).toBe(false)
  expect(ok({ text: "x", limit: 101 })).toBe(false)
  expect(ok({ text: "x", sessionIds: Array.from({ length: 201 }, () => sessionId) })).toBe(false)
  expect(ok({ text: "x", unknown: true })).toBe(false)
})

test("session.context-window takes 1,000 to 10,000,000 tokens or null", () => {
  const ok = (tokens: unknown) => Command.safeParse({ ...base, type: "session.context-window", sessionId, tokens }).success
  expect(ok(200_000)).toBe(true)
  expect(ok(null)).toBe(true)
  expect(ok(999)).toBe(false)
  expect(ok(10_000_001)).toBe(false)
  expect(ok(1.5)).toBe(false)
  expect(Command.safeParse({ ...base, type: "session.context-window", sessionId }).success).toBe(false)
})

test("the new commands read or change local session data, so remote read-only clients never get them", () => {
  for (const type of ["session.search", "session.context-window"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  expect(isReadOnlyCommand("session.agent-view.metadata.patch")).toBe(false)
  expect(isReadOnlyCommand("context.query")).toBe(true)
})

test("summaries and context reports gain optional fields; older ones still parse", () => {
  const summary = { sessionId, title: "Session", directory: "/p", createdAt: 0, updatedAt: 0, lastSeq: 0, queued: 0, state: "idle" }
  expect(SessionSummary.safeParse(summary).success).toBe(true)
  expect(SessionSummary.safeParse({ ...summary, tags: ["a"], color: "blue", named: true }).success).toBe(true)
  expect(SessionSummary.safeParse({ ...summary, color: "magenta" }).success).toBe(false)
  const report = { model: "m", sections: [], largest: [], images: 0, estimatedTokens: 0, compactAtTokens: 1 }
  expect(ContextReport.safeParse(report).success).toBe(true)
  expect(ContextReport.safeParse({ ...report, contextWindowOverride: true, files: [{ path: "a.ts", reads: 1, edits: 0, tokens: 5 }] }).success).toBe(true)
  expect(ContextReport.safeParse({ ...report, files: [{ path: "a.ts", reads: -1, edits: 0, tokens: 5 }] }).success).toBe(false)
})
