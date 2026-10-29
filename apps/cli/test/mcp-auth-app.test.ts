import { expect, test } from "bun:test"
import { appHarness } from "./extensions-harness"

const url = "http://127.0.0.1:9876/authorize?state=test"

test("MCP auth key and slash send the command, show and copy the URL; status events refresh", async () => {
  let auth = "needs_auth"
  const h = await appHarness({ reply: (c) => {
    if (c.type === "mcp.status") return { ok: true, result: { servers: [{ name: "remote", command: "http://127.0.0.1/mcp", enabled: true, state: auth === "authorized" ? "running" : "failed", auth, transport: "remote", tools: 0, stderr: [] }], issues: [] } }
    if (c.type === "mcp.auth") return { ok: true, result: { url } }
  } })
  await h.start({ onboarded: true })
  await h.type("/mcps")
  await h.key("\r")
  expect(h.text()).toContain("a auth")
  await h.key("a")
  expect(h.sent.filter((c) => c.type === "mcp.auth")).toEqual([{ type: "mcp.auth", directory: "/work/app", server: "remote" }])
  expect(h.text()).toContain(url)
  expect(h.text()).toContain("auth URL copied")
  expect(h.written.join("")).toContain(Buffer.from(url).toString("base64"))
  await h.key("c")
  expect(h.written.filter((s) => s.includes("52;")).length).toBe(2)
  auth = "authorized"
  h.app.onGlobal({ type: "mcp.changed", directory: "/work/app", server: "remote", gseq: 1, at: 1 })
  await Bun.sleep(5)
  expect(h.text()).toContain("authorized")
  expect(h.text()).not.toContain("a auth")
  expect(h.text()).not.toContain(url)
  expect(h.text()).not.toContain("auth URL copied")
  await h.key("\x1b")
  auth = "needs_auth"
  await h.type("/mcp auth remote")
  await h.key("\r")
  expect(h.sent.filter((c) => c.type === "mcp.auth")).toHaveLength(2)
  expect(h.text()).toContain(url)
})

test("MCP auth failure stays visible without copying", async () => {
  const h = await appHarness({ reply: (c) => c.type === "mcp.auth" ? { ok: false, error: { message: "unknown MCP server" } } : c.type === "mcp.status" ? { ok: true, result: { servers: [], issues: [] } } : undefined })
  await h.start({ onboarded: true })
  await h.type("/mcp auth missing")
  await h.key("\r")
  expect(h.text()).toContain("unknown MCP server")
  expect(h.written).toEqual([])
})
