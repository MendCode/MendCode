import { expect, test } from "bun:test"
import { Command, ServerRequest, createIdFactory, isPlanningOnlyPacket } from "../src"
const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session"), requestId: ids("request") }
test("review decisions accept long Markdown additively and reject malformed replies", () => {
  expect(Command.safeParse({ ...base, type: "request.resolve", decision: { kind: "plan_review", action: "edit", markdown: "x".repeat(30_000) } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "request.resolve", decision: { kind: "plan_review", action: "apply", markdown: "x".repeat(30_001) } }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "request.resolve", decision: { kind: "approve", scope: "once" } }).success).toBe(true)
  expect(ServerRequest.safeParse({ sessionId: base.sessionId, seq: 1, at: 1, requestId: base.requestId, turnId: ids("turn"), type: "server.request", kind: "approval", title: "Review plan", detail: "", planReview: { markdown: "Plan", phase: "plan", destination: "build" } }).success).toBe(true)
})
test("packet markers constrain execution without treating ordinary plan steps as planning-only", () => {
  for (const source of ['{"mode":"planner"}', 'phase: plan', 'implementation: false', 'Planning-only packet']) expect(isPlanningOnlyPacket(source)).toBe(true)
  expect(isPlanningOnlyPacket("# Plan\n\nImplement reconnect and test it")).toBe(false)
})
