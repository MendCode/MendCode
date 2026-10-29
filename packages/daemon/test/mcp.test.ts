import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { McpServerStatus } from "@mendcode/protocol"
import { startDaemon, type McpControl } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(mcp?: McpControl, onGlobal?: Parameters<typeof createClient>[0]["onGlobal"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-mcp-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...(mcp ? { mcp } : {}) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "mcp", ...(onGlobal ? { onGlobal } : {}) })
  await client.connect()
  cleanups.push(() => client.close())
  return client
}

const server = (patch: Partial<McpServerStatus> = {}): McpServerStatus => ({ name: "demo", command: "npx -y pkg", enabled: true, state: "running", pid: 42, tools: 3, stderr: [], ...patch })

describe("mcp handlers", () => {
  test("mcp.status returns the manager's report for the directory", async () => {
    const calls: string[] = []
    const client = await boot({
      status: async (directory) => (calls.push(directory), { servers: [server()], issues: [{ source: "mcp.json", message: "bad" }] }),
      restart: async () => server(),
    })
    const reply = await client.send({ type: "mcp.status", directory: "/repo" })
    expect(reply).toMatchObject({ ok: true, result: { servers: [{ name: "demo", state: "running", pid: 42, tools: 3 }], issues: [{ source: "mcp.json", message: "bad" }] } })
    expect(calls).toEqual(["/repo"])
  })
  test("mcp.restart passes directory and server and returns the new status; errors become target_mismatch", async () => {
    const seen: unknown[] = []
    const client = await boot({
      status: async () => ({ servers: [], issues: [] }),
      restart: async (input) => {
        seen.push(input)
        if (input.server === "gone") throw new Error("unknown MCP server: gone")
        return server({ pid: 99, state: "failed", lastError: "boom" })
      },
    })
    expect(await client.send({ type: "mcp.restart", directory: "/repo", server: "demo" })).toMatchObject({ ok: true, result: { server: { name: "demo", pid: 99, state: "failed", lastError: "boom" } } })
    expect(seen).toEqual([{ directory: "/repo", server: "demo" }])
    expect(await client.send({ type: "mcp.restart", directory: "/repo", server: "gone" })).toMatchObject({ ok: false, error: { code: "target_mismatch", message: expect.stringContaining("unknown MCP server") } })
  })
  test("without an mcp option status is empty and restart is refused", async () => {
    const client = await boot()
    expect(await client.send({ type: "mcp.status", directory: "/repo" })).toMatchObject({ ok: true, result: { servers: [], issues: [] } })
    expect(await client.send({ type: "mcp.restart", directory: "/repo", server: "x" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})

// Exercise the real OAuth manager through the daemon, with loopback-only metadata, token and MCP endpoints.
test("mcp.auth returns immediately, completes by status push, cancels/forgets and rejects non-OAuth targets", async () => {
  const { createMcpAuth, createMcpManager } = await import("@mendcode/mcp")
  const { startFakeRemote, approveInBrowser } = await import("../../mcp/test/fixtures/fake-remote")
  const fake = await startFakeRemote()
  cleanups.push(() => fake.stop())
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-auth-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const manager = createMcpManager({ auth: createMcpAuth({ dir }), configLoader: () => ({ servers: { remote: { url: fake.url }, local: { command: "unused" }, off: { url: fake.url, oauth: false } }, errors: [] }) })
  cleanups.push(() => manager.stop())
  const events: string[] = []
  const client = await boot(manager, (event) => { if (event.type === "mcp.changed") events.push(event.server) })
  for (const server of ["missing", "local", "off"]) {
    expect(await client.send({ type: "mcp.auth", directory: dir, server })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  }
  const reply = await client.send({ type: "mcp.auth", directory: dir, server: "remote" })
  expect(reply.ok).toBe(true)
  const url = reply.ok ? reply.result?.url as string : ""
  expect(new URL(url).pathname).toBe("/authorize")
  expect(new URL(url).searchParams.get("state")).toBeTruthy()
  expect(await client.send({ type: "mcp.status", directory: dir })).toMatchObject({ ok: true, result: { servers: expect.arrayContaining([expect.objectContaining({ name: "remote", auth: "pending" })]) } })
  await approveInBrowser(url)
  for (let tries = 0; tries < 100; tries++) {
    const status = await manager.status(dir)
    if (status.servers.some((s) => s.name === "remote" && s.state === "running")) break
    await Bun.sleep(5)
  }
  expect(await client.send({ type: "mcp.status", directory: dir })).toMatchObject({ ok: true, result: { servers: expect.arrayContaining([expect.objectContaining({ name: "remote", auth: "authorized", state: "running" })]) } })
  expect(events.length).toBeGreaterThanOrEqual(2)
  expect(await client.send({ type: "mcp.auth", directory: dir, server: "remote", action: "forget" })).toMatchObject({ ok: true, result: { server: { auth: "none" } } })
  expect(await client.send({ type: "mcp.auth", directory: dir, server: "remote" })).toMatchObject({ ok: true, result: { url: expect.any(String) } })
  expect(await client.send({ type: "mcp.auth", directory: dir, server: "remote", action: "cancel" })).toMatchObject({ ok: true })
})
