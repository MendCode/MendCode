import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { Command, createIdFactory, isReadOnlyCommand, type MflowReport } from "@mendcode/protocol"
import { createMflow } from "../src/mflow"
import { createMflowCoordinator } from "../src/mflow-coordinator"
import { createMflowHttp, mflowListenerAddress } from "../src/mflow-http"
import { createMflowHooks, mflowTargets } from "../src/mflow-hooks"
import { remoteTokens } from "../src/remote"
import { boot } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b73-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  return { dir, project }
}
function service(options: Parameters<typeof createMflow>[0]) {
  const result = createMflow(options)
  cleanups.push(result.stop)
  return result
}
const authToken = "b73-local-fake-private-token"
const activate = { operation: "activate", input: { room: "team/source" } } as const

describe("B73 configuration and room transactions", () => {
  test("default off, explicit start, durable config/plan, deactivate keeps config and remove moves it to Trash", async () => {
    const { dir, project } = fixture(), mflow = service({ dir })
    expect((await mflow.query(project, { operation: "status" })).mode).toBe("disabled")
    expect(existsSync(path.join(dir, "mflow"))).toBe(false)
    await expect(mflow.change(project, { operation: "start" })).rejects.toThrow("activate")
    expect((await mflow.change(project, activate)).mode).toBe("enabled-stopped")
    const plan = await mflow.change(project, { operation: "plan" })
    expect(plan.plan).toMatchObject({ dryRun: true, syncsFiles: false, startsDaemon: false })
    expect(JSON.parse(readFileSync(plan.planPath!, "utf8")).neverSync).toContain(".env*")
    expect((await mflow.change(project, { operation: "start" })).mode).toBe("running")
    const other = service({ dir })
    expect((await other.query(project, { operation: "status" })).mode).toBe("enabled-stopped")
    await mflow.change(project, { operation: "stop" })
    expect((await mflow.change(project, { operation: "deactivate" })).config.room).toBe("team/source")
    const file = (await mflow.query(project, { operation: "status" })).statePath
    expect(existsSync(file)).toBe(true)
    expect((statSync(file).mode & 0o777)).toBe(0o600)
    expect((await mflow.change(project, { operation: "remove" })).mode).toBe("disabled")
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.join(dir, "trash"))).toBe(true)
    expect(existsSync(path.join(project, ".mendcode"))).toBe(false)
    expect(existsSync(path.join(project, ".mflow"))).toBe(false)
    await mflow.change(project, { operation: "remove" })
  })
  test("locks are atomic, shared reads coexist, writes conflict, owners cannot steal and TTLs survive restart", () => {
    const { dir } = fixture()
    let now = 1000
    const coordinator = createMflowCoordinator({ dir, now: () => now })
    const a = coordinator.run("room", "a", { action: "acquire", files: ["src/a", "src/b"], mode: "write", ttlMs: 1000 })
    expect(a.ok).toBe(true)
    expect(coordinator.run("room", "b", { action: "acquire", files: ["src/b", "src/c"], mode: "write" }).ok).toBe(false)
    expect(coordinator.snapshot("room").locks.flatMap((lock) => lock.files)).not.toContain("src/c")
    expect(coordinator.run("room", "b", { action: "release", leaseId: a.lease!.leaseId }).ok).toBe(false)
    expect(coordinator.run("room", "b", { action: "renew", leaseId: a.lease!.leaseId }).ok).toBe(false)
    expect(createMflowCoordinator({ dir, now: () => now }).snapshot("room").locks).toHaveLength(1)
    now = 2001
    expect(coordinator.snapshot("room").locks).toHaveLength(0)
    expect(coordinator.run("room", "a", { action: "renew", leaseId: a.lease!.leaseId }).ok).toBe(false)
    for (const owner of ["a", "b"]) expect(coordinator.run("room", owner, { action: "acquire", files: ["src/c"], mode: "read" }).ok).toBe(true)
    expect(coordinator.run("room", "c", { action: "acquire", files: ["src/c"], mode: "write" }).ok).toBe(false)
    expect(coordinator.run("other-room", "c", { action: "acquire", files: ["src/c"], mode: "write" }).ok).toBe(true)
    expect(coordinator.run("room", "a", { action: "leave" }).ok).toBe(true)
    expect(coordinator.snapshot("room").locks).toHaveLength(1)
    for (const file of ["../escape", "/absolute", "C:/escape", "x/../../escape", "x\nsecret"]) expect(() => coordinator.run("room", "x", { action: "acquire", files: [file], mode: "write" })).toThrow()
  })
  test("peers expire and diagnostics/legacy never claim live sync or an external relay", async () => {
    const { dir, project } = fixture()
    let now = 1000
    const mflow = service({ dir, now: () => now, listener: () => "http://127.0.0.1:8787" })
    mflow.coordinator.run("other", "one", { action: "join", ttlMs: 1000 })
    expect((await mflow.query(project, { operation: "scan" })).relays?.[0]).toMatchObject({ roomCount: 1, peerCount: 1 })
    now = 2001
    expect(mflow.coordinator.stats()).toEqual({ roomCount: 0, peerCount: 0 })
    expect((await mflow.query(project, { operation: "legacy-status" })).legacy).toMatchObject({ enabled: false, liveSync: false })
    expect((await mflow.query(project, { operation: "doctor" })).warnings).toContain("No local plan; run mflow plan")
    expect((await mflow.query(project, { operation: "relay-guide" })).guide?.commands.join("\n")).toContain("--mflow-listen")
  })
})

describe("B73 authenticated HTTP and distributed local fakes", () => {
  test("every HTTP route rejects missing/read-only credentials before state access and hides private failures", async () => {
    const { dir, project } = fixture(), mflow = service({ dir })
    const http = createMflowHttp({ service: mflow, directory: project, authenticate: (token) => token === "observer" ? { name: "observer", readOnly: true } : token === authToken ? { name: "writer", readOnly: false } : undefined })
    for (const [route, method] of [["", "GET"], ["/status", "GET"], ["/scan", "GET"], ["/relay-guide", "GET"], ["/health", "GET"], ["/room?room=private", "GET"], ["/activate", "POST"], ["/deactivate", "POST"], ["/remove", "POST"], ["/lease", "POST"]] as const) {
      for (const authorization of [undefined, "Bearer invalid", "Bearer observer"]) {
        const response = await http(new Request(`http://127.0.0.1/mflow${route}`, { method, headers: { ...(authorization ? { Authorization: authorization } : {}), "X-Forwarded-For": "127.0.0.1" }, ...(method === "POST" ? { body: JSON.stringify(activate.input) } : {}) }))
        expect(response.status).toBe(authorization === "Bearer observer" ? 403 : 401)
        expect(await response.text()).not.toContain(authToken)
        expect(existsSync(path.join(dir, "mflow"))).toBe(false)
      }
    }
    const broken = createMflowHttp({ service: { ...mflow, query: async () => { throw new Error(authToken) } }, directory: project, authenticate: () => ({ name: "writer", readOnly: false }) })
    const failure = await broken(new Request("http://127.0.0.1/mflow/status", { headers: { Authorization: `Bearer ${authToken}` } }))
    expect(failure.status).toBe(400)
    expect(await failure.text()).not.toContain(authToken)
    expect(mflowListenerAddress("[::1]:0").hostname).toBe("::1")
  })
  test("six audit routes require full token auth, strict bounded requests and revocation", async () => {
    const { dir, project } = fixture(), mflow = service({ dir })
    const tokens = remoteTokens(dir)
    const full = tokens.create({ name: "writer" }).token, read = tokens.create({ name: "reader", readOnly: true }).token
    const http = createMflowHttp({ service: mflow, directory: project, authenticate: tokens.authenticate })
    const request = (route: string, method = "GET", body?: unknown, token = full) => http(new Request(`http://127.0.0.1:8787/mflow${route}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) }))
    for (const route of ["", "/scan", "/relay-guide"]) {
      expect((await request(route)).status).toBe(200)
      expect((await request(route, "GET", undefined, read)).status).toBe(403)
      expect((await request(route, "GET", undefined, "invalid")).status).toBe(401)
    }
    expect((await request("/activate", "POST", activate.input)).status).toBe(200)
    expect((await request("/deactivate", "POST")).status).toBe(200)
    expect((await request("/remove", "POST")).status).toBe(200)
    expect((await request("/activate", "POST", { secret: authToken })).status).toBe(400)
    expect((await request("/activate", "POST", { room: "x".repeat(33_000) })).status).toBe(413)
    expect((await request("/remove", "GET")).status).toBe(404)
    tokens.revoke("writer")
    expect((await request("")).status).toBe(401)
  })
  test("two independent daemon services coordinate through an authenticated Request adapter without network", async () => {
    const relayFixture = fixture(), relay = service({ dir: relayFixture.dir })
    const http = createMflowHttp({ service: relay, directory: relayFixture.project, authenticate: (token) => token === authToken ? { name: "room-access", readOnly: false } : undefined })
    const clients = [fixture(), fixture()].map((fixture) => {
      const tokenFile = path.join(fixture.dir, "token")
      writeFileSync(tokenFile, authToken, { mode: 0o600 })
      return { ...fixture, tokenFile, mflow: service({ dir: fixture.dir, fetch: async (request) => { expect(request.redirect).toBe("error"); return http(request) } }) }
    })
    for (const client of clients) {
      await client.mflow.change(client.project, { operation: "setup", input: { room: "shared", signaling: "ws://127.0.0.1:8787", tokenFile: client.tokenFile } })
      await client.mflow.change(client.project, { operation: "start" })
      expect((await client.mflow.query(client.project, { operation: "status" })).daemon.running).toBe(true)
    }
    const [a, b] = clients as [typeof clients[number], typeof clients[number]]
    const held = await a.mflow.lease(a.project, "a", { action: "acquire", mode: "write", files: ["src/common.ts"] })
    expect(held.ok).toBe(true)
    expect((await b.mflow.lease(b.project, "b", { action: "acquire", mode: "write", files: ["src/common.ts"] })).ok).toBe(false)
    expect((await b.mflow.lease(b.project, "b", { action: "release", leaseId: held.lease!.leaseId })).ok).toBe(false)
    expect((await b.mflow.query(b.project, { operation: "status" })).locks).toHaveLength(1)
    expect((await a.mflow.lease(a.project, "a", { action: "renew", leaseId: held.lease!.leaseId })).ok).toBe(true)
    await a.mflow.lease(a.project, "a", { action: "release", leaseId: held.lease!.leaseId })
    expect((await b.mflow.lease(b.project, "b", { action: "acquire", mode: "write", files: ["src/common.ts"] })).ok).toBe(true)
    const report = await a.mflow.query(a.project, { operation: "scan" })
    expect(report.relays?.[0]?.peerCount).toBe(2)
    expect(JSON.stringify(report)).not.toContain(authToken)
    expect(readFileSync(report.statePath, "utf8")).not.toContain(authToken)
  })
  test("public/hostname relays, unsafe token files, old relay protocols and failures remain off or unavailable", async () => {
    const { dir, project } = fixture(), tokenFile = path.join(dir, "token")
    writeFileSync(tokenFile, authToken, { mode: 0o600 })
    let available = true
    const mflow = service({ dir, fetch: async () => available ? Response.json({ protocol: "old-relay" }) : Promise.reject(new Error(authToken)) })
    for (const signaling of ["http://example.com:8787", "http://localhost:8787", "https://127.0.0.1:8787", "http://a:b@127.0.0.1:8787", "http://127.0.0.1:8787/path"]) await expect(mflow.change(project, { operation: "activate", input: { signaling, tokenFile } })).rejects.toThrow()
    chmodSync(tokenFile, 0o644)
    await expect(mflow.change(project, { operation: "activate", input: { signaling: "http://127.0.0.1:8787", tokenFile } })).rejects.toThrow("private")
    chmodSync(tokenFile, 0o600)
    await mflow.change(project, { operation: "activate", input: { signaling: "http://127.0.0.1:8787", tokenFile } })
    await expect(mflow.change(project, { operation: "start" })).rejects.toThrow("v2 Mflow")
    available = false
    await expect(mflow.change(project, { operation: "start" })).rejects.toThrow("unavailable or unauthorized")
    expect((await mflow.query(project, { operation: "status" })).mode).toBe("enabled-stopped")
    for (const address of ["0.0.0.0:8787", "localhost:8787", "192.168.0.2:8787"]) expect(() => mflowListenerAddress(address)).toThrow()
    expect(mflowListenerAddress("127.0.0.1:0").port).toBe(0)
    for (const type of ["mflow.query", "mflow.change", "mflow.lease"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })
})

describe("B73 native file hooks and wire integration", () => {
  test("patch moves, multi-file calls and aliases use canonical project paths; outside symlinks fail closed", () => {
    const { dir, project } = fixture()
    writeFileSync(path.join(project, "one"), "content")
    symlinkSync(path.join(project, "one"), path.join(project, "alias"))
    symlinkSync(dir, path.join(project, "outside"))
    expect(mflowTargets("read", { path: "alias" }, project)).toEqual(["one"])
    expect(mflowTargets("apply_patch", { patch: "*** Update File: one\n*** Move to: src/two\n*** Add File: three" }, project)).toEqual(["one", "src/two", "three"])
    expect(mflowTargets("write", { path: "new/one", paths: ["two"] }, project)).toEqual(["new/one", "two"])
    expect(() => mflowTargets("write", { path: "outside/escape" }, project)).toThrow("outside")
    expect(mflowTargets("shell", { command: "cat file" }, project)).toEqual([])
  })
  test("before/after hooks lock rewritten paths, await conflicts, cancel waits, and release on failure/end", async () => {
    const { dir, project } = fixture(), mflow = service({ dir })
    await mflow.change(project, activate)
    await mflow.change(project, { operation: "start" })
    let alive = true
    const wrapper = createMflowHooks({ service: mflow, waitMs: 100, pollMs: 5, alive: () => alive, inner: { has: () => true, toolBefore: async () => ({ args: { path: "rewritten" } }), toolAfter: async () => { throw new Error("extension failure") } } })
    cleanups.push(wrapper.stop)
    const event = { sessionId: "sess_b73" as never, turnId: "turn_b73" as never, cwd: project, tool: "write", callId: "one", args: { path: "original" } }
    await wrapper.hooks.toolBefore!(event)
    expect(mflow.coordinator.snapshot("team/source").locks[0]?.files).toEqual(["rewritten"])
    const waiting = wrapper.hooks.toolBefore!({ ...event, callId: "two" })
    await expect(wrapper.hooks.toolAfter!({ ...event, output: "", isError: false })).rejects.toThrow("extension failure")
    expect(await waiting).toMatchObject({ args: { path: "rewritten" } })
    expect(mflow.coordinator.snapshot("team/source").locks).toHaveLength(1)
    alive = false
    expect(await wrapper.hooks.toolBefore!({ ...event, callId: "three" })).toMatchObject({ block: "Mflow wait cancelled" })
    wrapper.observe({ type: "turn.cancelled", sessionId: event.sessionId } as never)
    await wrapper.stop()
    expect(mflow.coordinator.snapshot("team/source").locks).toHaveLength(0)
    await mflow.change(project, { operation: "stop" })
    alive = true
    expect(await wrapper.hooks.toolBefore!(event)).toMatchObject({ block: "Mflow lock unavailable; start coordination or check the relay" })
    await mflow.change(project, { operation: "deactivate" })
    expect(await wrapper.hooks.toolBefore!(event)).toMatchObject({ args: { path: "rewritten" } })
  })
  test("daemon dispatch and typed client helpers persist and share leases through the local socket", async () => {
    const harness = await boot()
    cleanups.push(harness.cleanup)
    expect(harness.daemon.mflowPort).toBeUndefined()
    expect((await harness.client.mflow(harness.project)).ok).toBe(true)
    expect((await harness.client.changeMflow(harness.project, activate)).ok).toBe(true)
    expect((await harness.client.changeMflow(harness.project, { operation: "start" })).ok).toBe(true)
    const other = createClient({ socketPath: harness.daemon.socketPath, name: "b73-peer" })
    cleanups.push(() => other.close())
    await other.connect()
    const held = await harness.client.mflowLease(harness.project, { action: "acquire", mode: "write", files: ["shared.ts"] })
    if (!held.ok) throw new Error("Lease request failed")
    const conflict = await other.mflowLease(harness.project, { action: "acquire", mode: "read", files: ["shared.ts"] })
    expect(conflict).toMatchObject({ ok: true, lease: { ok: false, message: "File locked" } })
    const report = await other.mflow(harness.project)
    expect(report).toMatchObject({ ok: true, report: { mode: "running", locks: [{ files: ["shared.ts"] }] } })
    expect((await harness.client.mflowLease(harness.project, { action: "release", leaseId: held.lease.lease!.leaseId })).ok).toBe(true)
    expect((await harness.client.changeMflow(harness.project, { operation: "deactivate" })).ok).toBe(true)
    const result = await harness.client.send({ type: "mflow.query", directory: harness.project, query: { operation: "legacy-status" } })
    expect(result.ok && (result.result as unknown as MflowReport).legacy?.liveSync).toBe(false)
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "mflow.change", directory: harness.project, change: { operation: "activate", input: { secret: authToken } } }).success).toBe(false)
  })
})
