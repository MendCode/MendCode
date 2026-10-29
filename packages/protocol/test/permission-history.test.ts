import { expect, test } from "bun:test"
import { Command, createIdFactory, PermissionsHistoryReport, PermissionProvenance } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("permission history is bounded but raw grant patterns require full-access peers", () => {
  const ids = createIdFactory()
  const command = { type: "permissions.history", id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
  expect(Command.safeParse(command).success).toBe(true)
  for (const limit of [0, 101, 1.5]) expect(Command.safeParse({ ...command, limit }).success).toBe(false)
  expect(isReadOnlyCommand("permissions.history")).toBe(false)
  expect(isReadOnlyCommand("permissions.revoke")).toBe(false)
})

test("execution provenance accepts digests but rejects raw environments and unknown fields", () => {
  const ids = createIdFactory()
  const provenance = { turnId: ids("turn"), authority: { sourceUserIds: ["user"], objectiveEpoch: "user", contextRevision: 0, fingerprint: "a".repeat(64), complete: true, unknownReasons: [] }, action: { fingerprint: "b".repeat(64), environmentDigest: "c".repeat(64), cwd: "/work", executableIdentities: ["/bin/sh:1:2"], complete: true, unknownReasons: [] } }
  expect(PermissionProvenance.safeParse(provenance).success).toBe(true)
  expect(PermissionProvenance.safeParse({ ...provenance, action: { ...provenance.action, environment: { KEY: "secret" } } }).success).toBe(false)
  expect(PermissionProvenance.safeParse({ ...provenance, authority: { ...provenance.authority, userText: "private text" } }).success).toBe(false)
  expect(PermissionsHistoryReport.safeParse({ grants: [], reviews: [] }).success).toBe(true)
})
