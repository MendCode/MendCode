import { expect, test } from "bun:test"
import { createAppServer } from "../src/app-server"

test("app-server internal errors do not export exception text or credentials", async () => {
  const secret = "ghp_" + "a".repeat(36)
  const output: string[] = []
  const server = createAppServer({
    cwd: "/temp/project", version: "test", listen: () => {}, write: (line) => output.push(line),
    client: { send: async () => { throw new Error(`failed Authorization: Bearer ${secret}`) }, subscribe: async () => { throw new Error("unused") } },
  })
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } }))
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" }))
  expect(output.join("\n").includes(secret)).toBe(false)
  expect(JSON.parse(output[1]!).error.message).toBe("internal error")
})

test("app-server protocol errors redact credentials in rejected method names", async () => {
  const secret = "ghp_" + "a".repeat(36)
  const output: string[] = []
  const server = createAppServer({ cwd: "/temp/project", version: "test", listen: () => {}, write: (line) => output.push(line), client: {} as never })
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } }))
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: `unknown/${secret}` }))
  expect(output.join("\n").includes(secret)).toBe(false)
})
