import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, ConsoleState, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { createConsole, savePrivate } from "../src/console"
import { startDaemon } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { httpConfig, httpOpenApi } from "../src/http"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const origin = "http://127.0.0.1:8788", ids = createIdFactory()
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b74-1-")), tokenFile = path.join(dir, "bootstrap")
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(tokenFile, "private-bootstrap", { mode: 0o600 })
  savePrivate(path.join(dir, "console.json"), { enabled: true, url: origin, tokenFile, activeID: "one", accounts: ["one", "two"].map((id) => ({ id, email: `${id}@local.test`, url: origin, access: `private-access-${id}`, refresh: `private-refresh-${id}`, expiresAt: Date.now() + 3_600_000, orgID: "engineering" })) })
  const calls: string[] = []
  let failAccount = "", configStatus = 200
  const request = (async (url: URL | Request | string, init?: RequestInit) => {
    const parsed = new URL(String(url)), headers = new Headers(init?.headers)
    calls.push(parsed.pathname)
    expect(parsed.origin).toBe(origin)
    expect(init?.redirect).toBe("error")
    expect(headers.get("authorization")).toMatch(/^Bearer private-/)
    if (parsed.pathname === "/api/orgs") {
      if (failAccount && headers.get("authorization") === `Bearer private-access-${failAccount}`) return new Response("private-server-error", { status: 503 })
      return Response.json([{ id: "engineering", name: "Engineering" }, { id: "research", name: "Research" }])
    }
    if (parsed.pathname === "/api/config") {
      if (configStatus !== 200) return new Response("private-server-error", { status: configStatus })
      return Response.json({ config: { provider: { "local-models": { apiKey: "private-provider-key" } } }, quota: { used: 42, limit: 100 }, billingUrl: "/billing" })
    }
    throw new Error("Unexpected fake Console request")
  }) as unknown as typeof fetch
  return { dir, tokenFile, calls, request, failAccount(value: string) { failAccount = value }, configStatus(value: number) { configStatus = value } }
}

test("B74.1 isolates failed accounts, keeps org switching available without metadata, and treats config 404 as absent", async () => {
  const h = fixture(), service = createConsole({ dir: h.dir, settings: () => ({}), request: h.request })
  h.failAccount("two")
  expect(await service.listOrgs()).toMatchObject({ orgs: [expect.objectContaining({ accountID: "one" }), expect.objectContaining({ accountID: "one" })], unavailableAccountIDs: ["two"] })
  h.configStatus(503)
  const switched = await service.switchOrg("one", "research")
  expect(switched).toMatchObject({ activeOrgName: "Research", switchableOrgCount: 2, metadataError: "Console metadata unavailable" })
  expect(switched.quota).toBeUndefined()
  expect(JSON.stringify(switched)).not.toContain("private-")
  const saved = JSON.parse(readFileSync(path.join(h.dir, "console.json"), "utf8"))
  expect(saved.accounts[0].orgID).toBe("research")
  await expect(service.switchOrg("two", "research")).rejects.toThrow("unavailable")
  h.configStatus(404)
  expect(await service.get()).toMatchObject({ activeOrgName: "Research", consoleManagedProviders: [] })
  expect((await service.get()).metadataError).toBeUndefined()
  const count = h.calls.length
  expect((await service.logout("one")).accounts.map((a) => a.accountID)).toEqual(["two"])
  expect(h.calls).toHaveLength(count)
  expect(statSync(path.join(h.dir, "console.json")).mode & 0o777).toBe(0o600)
})

test("B74.1 enterprise URL is opt-in configuration, snapshot/logout work with Console off and use no transport", async () => {
  const h = fixture(), service = createConsole({ dir: h.dir, settings: () => ({ enterprise: { url: origin } }), request: h.request })
  await service.configure({ enabled: false })
  expect(await service.snapshot()).toMatchObject({ enabled: false, accounts: [expect.objectContaining({ accountID: "one" }), expect.objectContaining({ accountID: "two" })] })
  await service.logout("one")
  expect(h.calls).toEqual([])
  const blank = mkdtempSync(path.join(tmpdir(), "mend-b74-1-enterprise-"))
  cleanup.push(() => rmSync(blank, { recursive: true, force: true }))
  const configured = createConsole({ dir: blank, settings: () => ({ enterprise: { url: origin } }), request: h.request })
  expect(await configured.snapshot()).toMatchObject({ enabled: false, url: origin })
  await configured.configure({ enabled: true, tokenFile: h.tokenFile })
  expect(await configured.snapshot()).toMatchObject({ enabled: true, url: origin })
  expect(h.calls).toEqual([])
})

async function boot() {
  const h = fixture(), tokens = remoteTokens(h.dir)
  const full = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir: h.dir, defaultDirectory: h.dir, socketPath: path.join(h.dir, "mendd.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: false, log: () => {}, console: { request: h.request, openUrl: async () => {} }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(daemon.stop)
  const client = createClient({ socketPath: daemon.socketPath, name: "B74.1", timeoutMs: 1000 })
  cleanup.push(() => client.close())
  await client.connect()
  async function request(route: string, options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${options.token ?? full}`, "content-type": "application/json", ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }))
    if (!response) throw new Error("Unexpected WebSocket response")
    return response
  }
  return { ...h, tokens, full, observer, daemon, client, transport: h.request, request }
}

test("B74.1 donor HTTP get/orgs/switch use daemon state and typed clients, persist selection and omit credentials", async () => {
  const h = await boot()
  expect(await h.client.consoleAccounts()).toMatchObject({ ok: true, report: { accounts: [expect.objectContaining({ accountID: "one" }), expect.objectContaining({ accountID: "two" })] } })
  expect(h.calls).toEqual([])
  const response = await h.request("/experimental/console")
  expect(response.status).toBe(200)
  const value = await response.json()
  expect(ConsoleState.parse(value)).toEqual({ activeOrgName: "Engineering", consoleManagedProviders: ["local-models"], switchableOrgCount: 4 })
  expect(Object.keys(value).sort()).toEqual(["activeOrgName", "consoleManagedProviders", "switchableOrgCount"])
  expect(await (await h.request("/experimental/console/orgs")).json()).toMatchObject({ orgs: [expect.objectContaining({ active: true }), expect.objectContaining({ active: false }), expect.objectContaining({ accountID: "two" }), expect.objectContaining({ accountID: "two" })] })
  const switched = await h.request("/experimental/console/switch", { body: { accountID: "two", orgID: "research" } })
  expect(switched.status).toBe(200)
  expect(await switched.json()).toBe(true)
  expect(await h.client.console()).toMatchObject({ ok: true, report: { activeOrgName: "Research", quota: { used: 42, limit: 100 }, billingUrl: `${origin}/billing` } })
  expect(await h.client.consoleOrgs()).toMatchObject({ ok: true, orgs: expect.arrayContaining([expect.objectContaining({ accountID: "two", orgID: "research", active: true })]) })
  const restored = createConsole({ dir: h.dir, settings: () => ({}), request: h.transport })
  expect((await restored.snapshot()).accounts.find((a) => a.active)?.accountID).toBe("two")
  expect(JSON.stringify(value)).not.toContain("private-")
  expect(response.headers.get("cache-control")).toBe("no-store")
  h.configStatus(503)
  expect(await (await h.request("/experimental/console/switch", { body: { accountID: "one", orgID: "research" } })).json()).toBe(true)
})

test("B74.1 Console HTTP rejects observers, browser requests, malformed switches and local-only credential commands", async () => {
  const h = await boot()
  for (const route of ["/experimental/console", "/experimental/console/orgs", "/experimental/console/switch"]) {
    expect((await h.request(route, { token: h.observer })).status).toBe(403)
    expect((await h.request(route, { headers: { origin: "http://127.0.0.1:4096" } })).status).toBe(403)
  }
  expect(h.calls).toEqual([])
  for (const body of [{ accountID: "one" }, { accountID: "one", orgID: "research", extra: "private-payload" }, []]) expect((await h.request("/experimental/console/switch", { body })).status).toBe(400)
  expect((await h.request("/experimental/console/switch", { body: { accountID: "one", orgID: "missing" } })).status).toBe(400)
  expect((await h.request("/experimental/console", { method: "POST", body: {} })).status).toBe(405)
  for (const type of ["console.accounts", "console.logout", "console.open", "console.login", "console.configure"] as const) {
    const body = { type, id: ids("command"), clientId: ids("client"), ...(type === "console.logout" ? { accountID: "one" } : {}), ...(type === "console.configure" ? { enabled: false } : {}) }
    expect(Command.safeParse(body).success).toBe(true)
    expect(isReadOnlyCommand(type)).toBe(false)
    expect((await h.request("/command", { body })).status).toBe(403)
  }
  expect(httpConfig(h.dir).enabled).toBe(false)
  expect(() => httpConfig(h.dir, { hostname: "0.0.0.0" as never })).toThrow()
  expect(httpOpenApi().paths["/experimental/console"].get.operationId).toBe("experimental.console.get")
  h.tokens.revoke("full")
  expect((await h.request("/experimental/console")).status).toBe(401)
})
