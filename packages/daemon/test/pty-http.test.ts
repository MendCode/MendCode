import { afterEach, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createClient } from "@mendcode/client"
import { createIdFactory, type PtyInfo } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { httpOpenApi, type HttpSocketData } from "../src/http"
import { remoteTokens } from "../src/remote"
import { fakePtyDriver } from "./pty-fake"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const ids = createIdFactory()
async function boot(enabled = true, hook = false) {
  const dir = tempDir(), project = realpathSync(tempDir()), fake = fakePtyDriver(), tokens = remoteTokens(dir)
  const full = tokens.create({ name: "owner" }).token, other = tokens.create({ name: "other" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  if (hook) {
    mkdirSync(path.join(dir, "extensions"))
    writeFileSync(path.join(dir, "extensions/pty-env.ts"), 'export default { name: "pty-env", daemon(api) { api.on("shell.env", ({ sessionId, cwd }) => ({ SOURCE: "extension", PTY_ID: sessionId, PTY_CWD: cwd, TERM: "ignored" })) } }\n')
  }
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true, pty: enabled, cors: ["https://allowed.example"] }, httpListen: false, pty: { driver: fake.driver }, extensionsEnabled: hook, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const adapter = daemon.httpAdapter!, clientId = ids("client")
  let addresses = 0
  const request = async (route: string, options: { method?: string; value?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const response = await adapter.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: options.token === "" ? "" : `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }) }), { requestIP: () => ({ address: `fake-${++addresses}` }), upgrade: () => false } as unknown as Parameters<typeof adapter.fetch>[1])
    if (!response) throw new Error("Unexpected upgrade")
    return response
  }
  const command = (value: Record<string, unknown>, options: Parameters<typeof request>[1] = {}) => request("/command", { ...options, value: { id: ids("command"), clientId, ...value } })
  const create = async () => { const response = await request("/pty", { value: { title: "Build" } }); expect(response.status).toBe(200); return await response.json() as PtyInfo }
  const ticket = async (id: string) => { const response = await request(`/pty/${id}/connect-token`, { method: "POST", headers: { "X-Mendcode-Ticket": "1" } }); expect(response.status).toBe(200); return (await response.json()).ticket as string }
  return { ...fake, daemon, adapter, dir, project, tokens, full, other, observer, request, command, create, ticket, clientId }
}

test("PTY REST is opt-in and OpenAPI describes all eight v1 operation ids", async () => {
  const h = await boot(false)
  for (const [route, method, value] of [["/pty/shells", "GET", undefined], ["/pty", "GET", undefined], ["/pty", "POST", {}]] as const) expect((await h.request(route, { method, ...(value ? { value } : {}) })).status).toBe(501)
  expect(h.processes).toHaveLength(0)
  const api = httpOpenApi()
  for (const [route, method, id] of [["/pty/shells", "get", "pty.shells"], ["/pty", "get", "pty.list"], ["/pty", "post", "pty.create"], ["/pty/{ptyID}", "get", "pty.get"], ["/pty/{ptyID}", "put", "pty.update"], ["/pty/{ptyID}", "delete", "pty.remove"], ["/pty/{ptyID}/connect-token", "post", "pty.connectToken"], ["/pty/{ptyID}/connect", "get", "pty.connect"]]) expect((api.paths as Record<string, Record<string, { operationId: string }>>)[route!]![method!]!.operationId).toBe(id!)
})

test("real REST and PTY listeners stay off by default, bind loopback and never log token, ticket or environment secrets", async () => {
  const dir = tempDir(), project = realpathSync(tempDir()), fake = fakePtyDriver(), logs: string[] = []
  const tokens = remoteTokens(dir), token = tokens.create({ name: "live-owner" }).token
  const observer = tokens.create({ name: "live-observer", readOnly: true }).token
  const secret = "opaqueLivePtyEnvironmentSecret"
  const options: Parameters<typeof startDaemon>[0] = { dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, pty: { driver: fake.driver }, log: (_level, text) => { logs.push(text) }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) }
  let daemon = await startDaemon(options)
  cleanup.push(() => daemon.stop())
  expect(daemon.httpAdapter).toBeUndefined()
  expect(daemon.httpUrl).toBeUndefined()
  expect(daemon.remotePort).toBeUndefined()
  await daemon.stop()
  daemon = await startDaemon({ ...options, http: { enabled: true, hostname: "localhost", port: 0 } })
  expect(new URL(daemon.httpUrl!).hostname).toBe("127.0.0.1")
  const request = (route: string, credential = token, value?: unknown) => fetch(`${daemon.httpUrl}${route}`, { method: value === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
  expect((await request("/pty", token, {})).status).toBe(501)
  const missing = await request("/pty", "", { env: { PRIVATE: secret } })
  expect(missing.status).toBe(401)
  expect(await missing.text()).not.toContain(secret)
  expect(fake.processes).toHaveLength(0)
  await daemon.stop()
  daemon = await startDaemon({ ...options, http: { enabled: true, hostname: "127.0.0.1", port: 0, pty: true } })
  expect((await request("/pty", observer, { env: { PRIVATE: secret } })).status).toBe(403)
  expect(fake.processes).toHaveLength(0)
  const created = await request("/pty", token, { env: { PRIVATE: secret } })
  expect(created.status).toBe(200)
  const pty = await created.json() as PtyInfo
  const connected = await fetch(`${daemon.httpUrl}/pty/${pty.id}/connect-token`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-mendcode-ticket": "1" } })
  expect(connected.status).toBe(200)
  const { ticket } = await connected.json()
  for (const value of [token, observer, secret, ticket]) expect(logs.join("\n")).not.toContain(value)
  tokens.revoke("live-owner")
  expect((await request(`/pty/${pty.id}`)).status).toBe(401)
})

test("PTY REST creates, lists, gets, renames, resizes, deletes and auto-removes exited processes", async () => {
  const h = await boot(), pty = await h.create()
  expect(await (await h.request("/pty/shells")).json()).toEqual(h.driver.shells())
  expect(await (await h.request("/pty")).json()).toEqual([pty])
  expect(await (await h.request(`/pty/${pty.id}`)).json()).toEqual(pty)
  const update = await h.request(`/pty/${pty.id}`, { method: "PUT", value: { title: "Tests", size: { cols: 100, rows: 30 } } })
  expect(update.status).toBe(200)
  expect(await update.json()).toMatchObject({ title: "Tests" })
  expect(h.processes[0]!.sizes).toEqual([[100, 30]])
  expect(await (await h.request(`/pty/${pty.id}`, { method: "DELETE" })).json()).toBe(true)
  expect((await h.request(`/pty/${pty.id}`)).status).toBe(404)
  expect((await h.request(`/pty/${pty.id}`, { method: "DELETE" })).status).toBe(404)
  await h.create()
  h.processes[1]!.exit(0)
  expect(await (await h.request("/pty")).json()).toEqual([])
  expect(h.processes.every((process) => process.kills === 1)).toBe(true)
})

test("PTY daemon invokes the existing trusted extension shell.env hook before spawn", async () => {
  const h = await boot(true, true)
  const response = await h.request("/pty", { value: { env: { SOURCE: "input" } } })
  expect(response.status).toBe(200)
  const pty = await response.json()
  expect(h.processes[0]!.env).toMatchObject({ SOURCE: "extension", PTY_ID: pty.id, PTY_CWD: h.project, TERM: "xterm-256color" })
})

test("PTY HTTP auth, owner, read-only, Origin and workspace checks deny before mutation or replay", async () => {
  const h = await boot(), pty = await h.create()
  expect((await h.request("/pty", { token: "" })).status).toBe(401)
  for (const route of ["/pty/shells", "/pty", `/pty/${pty.id}`, `/pty/${pty.id}/connect`]) expect((await h.request(route, { token: h.observer })).status).toBe(403)
  expect(await (await h.request("/pty", { token: h.other })).json()).toEqual([])
  for (const method of ["GET", "PUT", "DELETE"]) expect((await h.request(`/pty/${pty.id}`, { method, token: h.other, ...(method === "PUT" ? { value: { title: "stolen" } } : {}) })).status).toBe(404)
  expect((await h.request("/pty", { value: {}, headers: { Origin: "https://evil.example" } })).status).toBe(403)
  expect((await h.request("/pty", { headers: { "X-Opencode-Directory": realpathSync(tempDir()) } })).status).toBe(403)
  const directory = realpathSync(tempDir())
  expect((await h.request("/experimental/workspace", { value: { name: "second", directory } })).status).toBe(200)
  expect(await (await h.request("/pty", { headers: { "X-Opencode-Directory": directory } })).json()).toEqual([])
  expect((await h.request(`/pty/${pty.id}`, { headers: { "X-Opencode-Directory": directory } })).status).toBe(404)
  const value = { type: "pty.create", directory: h.project, input: {}, id: ids("command") }
  expect((await h.command(value)).status).toBe(200)
  expect((await h.command(value)).status).toBe(200)
  expect((await h.command(value, { token: h.observer })).status).toBe(403)
  expect(h.processes).toHaveLength(2)
})

test("PTY REST invalid size/body/cwd/env fails atomically; CORS allows PUT and both ticket headers", async () => {
  const h = await boot(), pty = await h.create()
  const update = await h.request(`/pty/${pty.id}`, { method: "PUT", value: { title: "bad", size: { cols: 0, rows: 30 } } })
  expect(update.status).toBe(400)
  expect((await (await h.request(`/pty/${pty.id}`)).json()).title).toBe("Build")
  expect(h.processes[0]!.sizes).toEqual([])
  for (const value of [{ cwd: realpathSync(tempDir()) }, { env: { "A=B": "private-secret" } }, { command: "sh\0" }]) {
    const response = await h.request("/pty", { value })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("private-secret")
  }
  expect(h.processes).toHaveLength(1)
  const preflight = await h.request("/pty", { method: "OPTIONS", token: "", headers: { Origin: "https://allowed.example" } })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT")
  expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Mendcode-Ticket")
})

test("PTY ticket WS binds owner/workspace, replays cursor, writes binary input and rejects reuse", async () => {
  const h = await boot(), pty = await h.create()
  expect((await h.request(`/pty/${pty.id}/connect-token`, { method: "POST" })).status).toBe(403)
  const legacy = await h.request(`/pty/${pty.id}/connect-token`, { method: "POST", headers: { "X-Opencode-Ticket": "1" } })
  expect(legacy.status).toBe(200)
  const ticket = (await legacy.json()).ticket
  const output: Array<string | Uint8Array> = [], closes: number[] = []
  let data: HttpSocketData | undefined
  const server = { requestIP: () => ({ address: "socket-test" }), upgrade: (_request: Request, value: { data: HttpSocketData }) => { data = value.data; return true } } as unknown as Parameters<typeof h.adapter.fetch>[1]
  h.processes[0]!.data("hello🌿")
  const route = `/pty/${pty.id}/connect?ticket=${ticket}&cursor=5`
  const response = await h.adapter.fetch(new Request(`http://127.0.0.1:4096${route}`, { headers: { Upgrade: "websocket" } }), server)
  expect(response).toBeUndefined()
  const ws = { data: data!, send: (value: string | Uint8Array) => { output.push(value); return 1 }, close: (code: number) => { closes.push(code); h.adapter.websocket.close(ws) } } as unknown as Bun.ServerWebSocket<HttpSocketData>
  h.adapter.websocket.open(ws)
  expect(output[0]).toBe("🌿")
  expect(JSON.parse(new TextDecoder().decode((output[1] as Uint8Array).subarray(1)))).toEqual({ cursor: 7 })
  h.adapter.websocket.message(ws, Buffer.from("echo next\n"))
  expect(h.processes[0]!.writes).toEqual(["echo next\n"])
  expect((await h.request(route, { token: "", headers: { Upgrade: "websocket" } })).status).toBe(403)
  h.tokens.revoke("owner")
  h.adapter.sweep()
  expect(closes).toEqual([1008])
  expect((await h.request(`/pty/${pty.id}/connect`, { token: h.other })).status).toBe(404)
})

test("PTY tickets reject stale targets, bad cursor and Origin; direct token WS still requires upgrade", async () => {
  const h = await boot(), pty = await h.create(), ticket = await h.ticket(pty.id)
  for (const cursor of ["bad", "-2", "1.5", ""]) expect((await h.request(`/pty/${pty.id}/connect?ticket=${ticket}&cursor=${cursor}`, { token: "", headers: { Upgrade: "websocket" } })).status).toBe(400)
  expect((await h.request(`/pty/${pty.id}/connect?ticket=${ticket}`, { token: "", headers: { Upgrade: "websocket", Origin: "https://evil.example" } })).status).toBe(403)
  expect((await h.request(`/pty/${pty.id}/connect`)).status).toBe(426)
  expect((await h.request(`/pty/${pty.id}/connect?ticket=${ticket}`, { token: "" })).status).toBe(426)
  await h.request(`/pty/${pty.id}`, { method: "DELETE" })
  expect((await h.request(`/pty/${pty.id}/connect?ticket=${ticket}`, { token: "", headers: { Upgrade: "websocket" } })).status).toBe(403)
})

test("native client helpers use the daemon protocol; local owner differs from HTTP tokens and disposal kills PTYs", async () => {
  const h = await boot(), client = createClient({ socketPath: h.daemon.socketPath, name: "B89", timeoutMs: 1000 })
  cleanup.push(() => client.close())
  await client.connect()
  expect((await client.ptyShells(h.project)).ok).toBe(true)
  const created = await client.ptyCreate(h.project, { title: "local" })
  if (!created.ok) throw new Error("PTY create failed")
  expect((await client.ptyList(h.project)).ok).toBe(true)
  expect((await client.ptyGet(h.project, created.pty.id)).ok).toBe(true)
  expect((await client.ptyUpdate(h.project, created.pty.id, { size: { cols: 180, rows: 50 } })).ok).toBe(true)
  expect((await client.ptyConnectToken(h.project, created.pty.id)).ok).toBe(false)
  expect((await h.request(`/pty/${created.pty.id}`)).status).toBe(404)
  expect((await client.ptyRemove(h.project, created.pty.id)).ok).toBe(true)
  const remote = await h.create()
  expect((await client.disposeInstances(h.project)).ok).toBe(true)
  expect((await h.request(`/pty/${remote.id}`)).status).toBe(404)
  expect(h.processes.every((process) => process.kills === 1)).toBe(true)
})
