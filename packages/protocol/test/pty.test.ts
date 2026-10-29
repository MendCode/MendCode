import { expect, test } from "bun:test"
import { Command, HttpServerConfig, isReadOnlyCommand, createIdFactory, PtyCreateInput, PtyUpdateInput } from "../src/index"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), directory: "/work/project" }
const ptyId = `pty_${"a".repeat(32)}`
test("PTY schemas are additive, strict and all commands stay out of read-only", () => {
  for (const command of [{ type: "pty.shells" }, { type: "pty.list" }, { type: "pty.create", input: {} }, { type: "pty.get", ptyId }, { type: "pty.update", ptyId, input: { size: { cols: 180, rows: 50 } } }, { type: "pty.remove", ptyId }, { type: "pty.connect-token", ptyId }]) {
    const parsed = Command.parse({ ...base, ...command })
    expect(isReadOnlyCommand(parsed.type)).toBe(false)
    expect(Command.safeParse({ ...base, ...command, owner: "forged" }).success).toBe(false)
  }
  expect(HttpServerConfig.parse({}).pty).toBe(false)
  expect(HttpServerConfig.parse({ pty: true }).pty).toBe(true)
})

test("PTY payload rejects invalid resize, NUL, unknown fields, env keys and excess argv before side effects", () => {
  for (const size of [{ cols: 0, rows: 30 }, { cols: 100, rows: -1 }, { cols: 1001, rows: 30 }, { cols: 10.5, rows: 30 }]) expect(PtyUpdateInput.safeParse({ size }).success).toBe(false)
  for (const value of [{ command: "sh\0oops" }, { cwd: "\0" }, { env: { "A=B": "bad" } }, { env: { A: "\0" } }, { env: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`A${index}`, "x"])) }, { args: Array.from({ length: 65 }, () => "x") }, { owner: "forged" }]) expect(PtyCreateInput.safeParse(value).success).toBe(false)
  expect(PtyCreateInput.parse({ args: ["--noprofile"], env: { APP: "local" } })).toEqual({ args: ["--noprofile"], env: { APP: "local" } })
})
