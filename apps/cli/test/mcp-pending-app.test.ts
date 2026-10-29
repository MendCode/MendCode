import { expect, test } from "bun:test"
import type { McpServerStatus } from "@mendcode/protocol"
import { appHarness } from "./extensions-harness"
import { createMcpsPageState, mcpsPageKey, renderMcpsPage } from "../src/view/mcps-page"

const pending: McpServerStatus = { name: "integration", command: "pending approval", enabled: false, state: "stopped", tools: 0, stderr: [], pending: { revision: "revision-1", scope: "project", expiresAt: 100_000_000, details: ['command: "fixture"', 'args: ["--safe","two words"]', "env names: API_KEY"] } }

test("/mcp reviews pending command/args/env names and sends revision-bound local approval or rejection", async () => {
  for (const key of ["a", "x"]) {
    let shown = true
    const h = await appHarness({ reply: (command) => {
      if (command.type === "mcp.status") return { ok: true, result: { servers: shown ? [pending] : [], issues: [] } }
      if (command.type === "mcp.decide") { shown = false; return { ok: true, result: {} } }
    } })
    await h.start({ onboarded: true })
    await h.type("/mcp")
    await h.key("\r")
    expect(h.text()).toContain("pending approval")
    expect(h.text()).toContain('command: "fixture"')
    expect(h.text()).toContain("API_KEY")
    expect(h.text()).toContain("a approve")
    expect(h.text()).toContain("x reject")
    await h.key(key)
    expect(h.sent.find((command) => command.type === "mcp.decide")).toMatchObject({ server: "integration", scope: "project", revision: "revision-1", approve: key === "a" })
    expect(h.sent.some((command) => command.type === "mcp.restart" || command.type === "mcp.auth" || command.type === "mcp.catalog")).toBe(false)
  }
})

test("pending details wrap and scroll at narrow and wide terminal widths; restart remains unavailable", () => {
  const server = { ...pending, pending: { ...pending.pending!, details: Array.from({ length: 30 }, (_, n) => `arg ${n}: ${"long-value ".repeat(8)}`) } }
  for (const width of [50, 100]) {
    let state = createMcpsPageState()
    const render = () => renderMcpsPage({ report: { servers: [server], issues: [] }, state, width, height: 24 }).map((line) => line.map((span) => span.text).join(""))
    expect(render().join("\n")).toContain("arg 0:")
    for (let n = 0; n < 100; n++) state = mcpsPageKey(state, "\x1b[6~", [server]).state
    expect(render().join("\n")).toContain("expires:")
    expect(mcpsPageKey(state, "r", [server]).action.type).toBe("none")
    expect(mcpsPageKey(state, "x", [server]).action.type).toBe("reject")
  }
})

test("a stale approval remains visible and the next key reviews the refreshed revision", async () => {
  let server = pending
  const h = await appHarness({ reply: (command) => {
    if (command.type === "mcp.status") return { ok: true, result: { servers: [server], issues: [] } }
    if (command.type === "mcp.decide") {
      server = { ...pending, pending: { ...pending.pending!, revision: "revision-2", details: ['command: "changed"'] } }
      return { ok: false, error: { message: "MCP request expired or changed; refresh before approving" } }
    }
  } })
  await h.start({ onboarded: true })
  await h.type("/mcp")
  await h.key("\r")
  await h.key("a")
  expect(h.text()).toContain("expired or changed")
  expect(h.text()).toContain('command: "changed"')
  await h.key("a")
  expect(h.sent.filter((command) => command.type === "mcp.decide").map((command) => command.revision)).toEqual(["revision-1", "revision-2"])
})
