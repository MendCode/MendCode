import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createMcpManager, loadMcpConfig, type McpClient } from "@mendcode/mcp"
import { createIdFactory, isReadOnlyCommand, type McpStatusReport } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { addMcpConfig, decideMcpConfig, pendingMcpServers, readMcpServers } from "../src/mcp-config"
import { remoteTokens } from "../src/remote"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-pending-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const ids = createIdFactory()

async function boot(dir = temp(), project = temp()) {
  const calls: string[] = []
  const full = remoteTokens(dir).create({ name: `integration-${crypto.randomUUID()}`, readOnly: false }).token
  const readOnly = remoteTokens(dir).create({ name: `observer-${crypto.randomUUID()}`, readOnly: true }).token
  const manager = createMcpManager({ configLoader: (directory) => loadMcpConfig({ directory, userDir: dir, env: {} }), clientFactory: ({ name }): McpClient => {
    let state: McpClient["state"] = "stopped"
    const start = async () => { calls.push(`start:${name}`); state = "running" }
    return { name, get state() { return state }, lastError: undefined, toolCount: 1, get alive() { return state === "running" }, pid: undefined,
      start, listTools: async () => { await start(); return [{ name: "fixture", inputSchema: {} }] }, callTool: async () => ({ text: "ok", isError: false }), stderr: () => "", close: async () => { calls.push(`close:${name}`); state = "stopped" } }
  } })
  cleanup.push(() => manager.stop())
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "daemon.sock"), http: { enabled: true }, httpListen: false, mcp: manager, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "local" })
  await client.connect()
  cleanup.push(() => client.close())
  const request = async (route: string, method = "GET", value?: unknown, token = full) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
    if (!response) throw new Error("missing response")
    return response
  }
  const peer = (value: Record<string, unknown>) => request("/command", "POST", { id: ids("command"), clientId: ids("client"), ...value })
  const status = async () => {
    const reply = await client.send({ type: "mcp.status", directory: project })
    if (!reply.ok) throw new Error("missing MCP status")
    return reply.result as McpStatusReport
  }
  return { dir, project, daemon, client, manager, calls, request, peer, status, readOnly }
}

test("REST pending servers survive restart, never start or expose tools, and only local approval enables them", async () => {
  let h = await boot()
  const config = { type: "local", command: ["fixture-command", "--safe", "two words", "--api-key", "opaque-private-value"], environment: { API_KEY: "private-env-value" } }
  const added = await h.request("/mcp", "POST", { name: "fixture", config })
  expect(added.status).toBe(202)
  expect(await added.json()).toMatchObject({ fixture: { status: "pending" } })
  expect(await h.manager.listTools(h.project)).toMatchObject({ tools: [] })
  expect(h.calls).toEqual([])
  expect(statSync(path.join(h.project, ".mendcode", "mcp.json")).mode & 0o777).toBe(0o600)
  const before = (await h.status()).servers[0]!.pending!
  expect(before.details.join("\n")).toContain('"two words"')
  expect(before.details.join("\n")).toContain("API_KEY")
  expect(JSON.stringify(before)).not.toContain("opaque-private-value")
  expect(JSON.stringify(before)).not.toContain("private-env-value")
  expect((await h.request("/mcp/fixture/connect", "POST")).status).toBe(400)
  expect((await h.request("/mcp", "POST", { name: "observer", config }, h.readOnly)).status).toBe(403)
  const peerStatus = await (await h.peer({ type: "mcp.status", directory: h.project })).json()
  expect(JSON.stringify(peerStatus)).not.toContain("fixture-command")
  expect(JSON.stringify(peerStatus)).not.toContain("API_KEY")
  expect(JSON.stringify(await (await h.request("/config")).json())).not.toContain("private-env-value")
  expect((await h.peer({ type: "mcp.decide", directory: h.project, scope: "project", server: "fixture", revision: before.revision, approve: true })).status).toBe(403)
  const { dir, project } = h
  h.client.close()
  await h.daemon.stop()
  await h.manager.stop()
  h = await boot(dir, project)
  expect((await h.status()).servers[0]!.pending!.revision).toBe(before.revision)
  expect(await h.manager.listTools(project)).toMatchObject({ tools: [] })
  expect(await h.client.send({ type: "mcp.decide", directory: project, scope: "project", server: "fixture", revision: before.revision, approve: true })).toMatchObject({ ok: true })
  expect((await h.manager.listTools(project)).tools).toHaveLength(1)
  expect(h.calls).toContain("start:fixture")
  expect(await (await h.request("/mcp")).json()).toMatchObject({ fixture: { status: "connected" } })
  // A remote edit suspends the approved server; stale approval cannot accept its new arguments.
  expect((await h.request("/mcp", "POST", { name: "fixture", config: { ...config, command: ["changed-command"] } })).status).toBe(202)
  expect(h.calls).toContain("close:fixture")
  expect((await h.manager.listTools(project)).tools).toEqual([])
  expect(await h.client.send({ type: "mcp.decide", directory: project, scope: "project", server: "fixture", revision: before.revision, approve: true })).toMatchObject({ ok: false })
  const edited = (await h.status()).servers[0]!.pending!
  expect(await h.client.send({ type: "mcp.decide", directory: project, scope: "project", server: "fixture", revision: edited.revision, approve: false })).toMatchObject({ ok: true })
  expect((await h.status()).servers[0]!.pending).toBeUndefined()
  expect((await h.manager.listTools(project)).tools).toEqual([])
  expect(readMcpServers(path.join(project, ".mendcode/mcp.json")).fixture).toEqual({ command: "(rejected)", enabled: false })
})

test("peer adds and PATCH /config also require approval, including env/url edits and enable-only edits", async () => {
  const h = await boot()
  expect((await h.peer({ type: "mcp.add", directory: h.project, scope: "project", name: "peer", config: { command: "unused" } })).status).toBe(200)
  expect((await h.status()).servers.find((entry) => entry.name === "peer")?.pending).toBeDefined()
  const original = (await h.status()).servers.find((entry) => entry.name === "peer")!.pending!
  expect(await h.client.send({ type: "mcp.decide", directory: h.project, scope: "project", server: "peer", revision: original.revision, approve: true })).toMatchObject({ ok: true })
  expect((await h.request("/config", "PATCH", { mcp: { peer: { type: "local", command: ["unused", "--new-arg"], environment: { CUSTOM_ENV: "private-new-value" } } } })).status).toBe(200)
  const edited = (await h.status()).servers.find((entry) => entry.name === "peer")!.pending!
  expect(edited.revision).not.toBe(original.revision)
  expect(edited.details.join("\n")).toContain("--new-arg")
  expect(edited.details.join("\n")).toContain("CUSTOM_ENV")
  expect(JSON.stringify(edited)).not.toContain("private-new-value")
  expect((await h.request("/config", "PATCH", { mcp: { web: { type: "remote", url: "https://example.invalid/mcp" } } })).status).toBe(200)
  let pending = (await h.status()).servers.find((entry) => entry.name === "web")!.pending!
  expect(pending.details).toEqual(["URL: https://example.invalid/mcp"])
  expect(await h.client.send({ type: "mcp.decide", directory: h.project, scope: "project", server: "web", revision: pending.revision, approve: true })).toMatchObject({ ok: true })
  expect((await h.request("/config", "PATCH", { mcp: { web: { type: "remote", url: "https://example.invalid/changed" } } })).status).toBe(200)
  pending = (await h.status()).servers.find((entry) => entry.name === "web")!.pending!
  expect((await h.request("/config", "PATCH", { mcp: { web: { enabled: true } } })).status).toBe(200)
  expect((await h.status()).servers.find((entry) => entry.name === "web")!.pending!.revision).not.toBe(pending.revision)
  expect((await h.manager.listTools(h.project)).tools).toEqual([])
  expect(h.calls).toEqual([])
})

test("pending quota is daemon-wide, survives reload, expires at 24h and never restores a lower layer", async () => {
  const dir = temp(), directory = temp(), other = temp(), now = 1000
  addMcpConfig({ dir, directory, scope: "user", name: "same", config: { command: "global-approved" } })
  for (let n = 0; n < 10; n++) addMcpConfig({ dir, directory: n % 2 ? directory : other, scope: "project", name: n === 1 ? "same" : `s${n}`, config: { command: "unused" }, pending: true, now })
  expect(() => addMcpConfig({ dir, directory, scope: "user", name: "overflow", config: { command: "unused" }, pending: true, now })).toThrow("limit (10)")
  const pending = pendingMcpServers({ dir, directory, now }).find((server) => server.name === "same")!.pending!
  const expires = now + 24 * 60 * 60 * 1000
  expect(pending.expiresAt).toBe(expires)
  expect(pendingMcpServers({ dir, directory, now: expires - 1 })).toHaveLength(5)
  expect(pendingMcpServers({ dir, directory, now: expires })).toEqual([])
  expect(() => decideMcpConfig({ dir, directory, scope: "project", server: "same", revision: pending.revision, approve: true, now: expires })).toThrow("expired or changed")
  const loaded = await loadMcpConfig({ directory, userDir: dir, env: {} })
  expect(loaded.servers.same!.enabled).toBe(false)
  addMcpConfig({ dir, directory, scope: "project", name: "next", config: { command: "unused" }, pending: true, now: expires })
  expect(pendingMcpServers({ dir, directory, now: expires })).toHaveLength(1)
  expect(isReadOnlyCommand("mcp.decide")).toBe(false)
})

test("suspension failures keep the request pending without reflecting client secrets", async () => {
  const h = await boot()
  h.manager.suspend = async () => { throw new Error("private-client-error-detail") }
  const response = await h.request("/mcp", "POST", { name: "fixture", config: { type: "local", command: ["unused"] } })
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain("private-client-error-detail")
  expect((await h.status()).servers[0]!.pending).toBeDefined()
  expect((await h.manager.listTools(h.project)).tools).toEqual([])
})
