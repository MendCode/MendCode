import { expect, test } from "bun:test"
import { Command, InteractionReport, MemorySideChatPayload, RestPermissionReply, RestPlanReviewReply, SessionEvent, createIdFactory, isReadOnlyCommand, redactEventText } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }

test("B88 commands are additive, strictly validated and never available to observers", () => {
  for (const kind of ["permission", "question", "plan-review"]) expect(Command.safeParse({ ...base, type: "interaction.list", kind }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "memory.side-chat", payload: { message: "Explain saved rules" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "interaction.list", kind: "permission", admin: true }).success).toBe(false)
  for (const type of ["interaction.list", "memory.side-chat"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})

test("donor payloads preserve reply names, nullable selection and native ids", () => {
  expect(RestPermissionReply.parse({ reply: "always", message: "Keep it scoped" })).toEqual({ reply: "always", message: "Keep it scoped" })
  expect(RestPlanReviewReply.safeParse({ action: "accept" }).success).toBe(false)
  expect(MemorySideChatPayload.parse({ message: "Explain", context: { selectedWorkspaceID: null, selectedGroupID: null, selectedCategoryID: null, pageContext: null } }).context?.pageContext).toBeNull()
  expect(MemorySideChatPayload.safeParse({ message: " ", apply: true }).success).toBe(false)
  expect(InteractionReport.parse({ requests: [{ id: ids("request"), sessionID: ids("session"), markdown: "# Review" }] }).requests).toHaveLength(1)
})

test("permission patterns are redacted before durable events and transport", () => {
  const secret = "sk-proj-" + "Ab12".repeat(8)
  const event = SessionEvent.parse(redactEventText({ type: "server.request", sessionId: ids("session"), turnId: ids("turn"), requestId: ids("request"), seq: 1, at: 1, kind: "approval", title: "Read", detail: secret, permissionContext: { name: "read", patterns: [secret], always: [secret] } }))
  expect(JSON.stringify(event)).not.toContain(secret)
  expect(event.type === "server.request" && event.permissionContext?.name).toBe("read")
})
