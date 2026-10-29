import { expect, test } from "bun:test"
import { Command, HttpServerConfig, createIdFactory } from "../src/index"
import { READ_ONLY_COMMANDS } from "../src/wire"

test("HTTP server schema defaults off and restricts hosts and config shape", () => {
  expect(HttpServerConfig.parse({})).toMatchObject({ enabled: false, port: 0, hostname: "127.0.0.1", mdns: false, cors: [] })
  for (const value of [{ hostname: "0.0.0.0" }, { port: 65536 }, { password: "secret" }, { token: "secret" }, { mdnsDomain: "example.com" }]) expect(HttpServerConfig.safeParse(value).success).toBe(false)
})
test("workspace commands are additive, strict and local only", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
  expect(Command.parse({ ...base, type: "workspace.query" })).toMatchObject({ type: "workspace.query", operation: "list" })
  expect(Command.parse({ ...base, type: "workspace.create", name: "review", directory: "/work/review" })).toMatchObject({ adapter: "local" })
  expect(Command.safeParse({ ...base, type: "workspace.create", name: "review", directory: "/work/review", adapter: "cloud" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "workspace.remove", workspaceId: "../../file" }).success).toBe(false)
})
test("workspace catalog and mutations do not expand the remote read-only whitelist", () => {
  for (const type of ["workspace.query", "workspace.create", "workspace.remove"]) expect(READ_ONLY_COMMANDS as readonly string[]).not.toContain(type)
})
