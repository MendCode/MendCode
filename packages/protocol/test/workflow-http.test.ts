import { expect, test } from "bun:test"
import { Command, RestWorkflowPermission, RestWorkflowStart, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("B86 additive native controls validate and remain unavailable to read-only tokens", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client"), workflowId: ids("workflow") }
  expect(Command.safeParse({ ...base, type: "workflow.permissions", mode: "report-only", sessionPermission: null }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "workflow.retry-phase", phaseId: "review" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "workflow.permissions", mode: "full" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "workflow.retry-phase" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "workflow.retry-phase", phaseId: "../escape" }).success).toBe(false)
  for (const type of ["workflow.permissions", "workflow.retry-phase", "workflow.events", "workflow.artifacts"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
test("B86 HTTP source selection is exclusive and permission aliases are explicit", () => {
  expect(RestWorkflowStart.safeParse({ revisionID: "wfr_local" }).success).toBe(true)
  expect(RestWorkflowStart.safeParse({ definitionID: "wfd_local" }).success).toBe(true)
  for (const value of [{}, { revisionID: "wfr_a", definitionID: "wfd_b" }, { revisionID: "wfr_a", force: true }]) expect(RestWorkflowStart.safeParse(value).success).toBe(false)
  for (const sessionMode of ["approval", "smart", "full_access", "global_default", null]) expect(RestWorkflowPermission.safeParse({ sessionMode }).success).toBe(true)
  expect(RestWorkflowPermission.safeParse({ sessionMode: "full" }).success).toBe(false)
})
