import { expect, test } from "bun:test"
import { Command, createIdFactory, isReadOnlyCommand, SharingStatusReport } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
test("B08 commands are additive and memory sharing/workspaces remain local only", () => {
  for (const type of ["memory.sharing.status", "memory.sharing.configure", "memory.sharing.export", "memory.sharing.import"] as const) {
    const input = { ...base, type, scope: "project", directory: "/repo", ...(type === "memory.sharing.configure" ? { enabled: true, confirmation: "ENABLE PROJECT" } : {}) }
    expect(Command.safeParse(input).success).toBe(true)
    expect(isReadOnlyCommand(type)).toBe(false)
    expect(Command.safeParse({ ...input, scope: "session" }).success).toBe(false)
    expect(Command.safeParse({ ...input, file: "/outside" }).success).toBe(false)
  }
  for (const view of ["project", "user", "all"]) expect(Command.safeParse({ ...base, type: "memory.browse", directory: "/repo", view }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "memory.browse", view: "global" }).success).toBe(false)
  expect(isReadOnlyCommand("memory.browse")).toBe(false)
  expect(isReadOnlyCommand("memory.workspaces")).toBe(false)
  expect(SharingStatusReport.safeParse({ scope: "user", directory: "/tmp/sharing", enabled: false, format: "mendcode-v2", entries: 0 }).success).toBe(true)
})
