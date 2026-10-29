import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Command, ConsoleReport, ConsoleUrl, SessionShare, createIdFactory, isReadOnlyCommand, type Settings, type SessionId } from "@mendcode/protocol"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createConsole } from "../src/console"
import { startDaemon } from "../src/daemon"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b74-")), tokenFile = path.join(dir, "bootstrap")
  writeFileSync(tokenFile, "b74-bootstrap-private-token", { mode: 0o600 })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, tokenFile }
}
function transport() {
  const calls: Array<{ url: URL; headers: Headers; body: any; method: string }> = []
  let mode = "success", failSync = false, failDelete = false, account = "one", shares = 0
  const request = (async (url: URL | Request | string, init?: RequestInit) => {
    const parsed = new URL(String(url)), method = init?.method ?? "GET", headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url: parsed, method, headers, body })
    expect(parsed.hostname).toBe("127.0.0.1")
    expect(init?.redirect).toBe("error")
    expect(headers.get("authorization")).toMatch(/^Bearer /)
    let response: unknown = {}
    if (parsed.pathname === "/auth/device/code") response = { device_code: "b74-device-secret", user_code: "ABCD-EFGH", verification_uri_complete: "/device", expires_in: 60, interval: 1 }
    else if (parsed.pathname === "/auth/device/token") response = mode === "success" || body.grant_type === "refresh_token" ? { access_token: `b74-access-private-${account}`, refresh_token: "b74-refresh-private-token", token_type: "Bearer", expires_in: 600 } : { error: mode }
    else if (parsed.pathname === "/api/user") response = { id: account, email: `${account}@local.test` }
    else if (parsed.pathname === "/api/orgs") response = [{ id: "engineering", name: "Engineering" }, { id: "research", name: "Research" }]
    else if (parsed.pathname === "/api/config") response = { config: { provider: { "console-models": { apiKey: "b74-hidden-provider-key" } } }, quota: { used: 42, limit: 100, resetAt: 999999 }, billingUrl: "/billing" }
    else if (/^\/api\/shares?$/.test(parsed.pathname)) { shares++; response = { id: `link-${shares}`, secret: "b74-share-private-secret", url: `${parsed.origin}/share/link-${shares}` } }
    else if (parsed.pathname.endsWith("/sync") && failSync || method === "DELETE" && failDelete) return new Response("b74-private-server-error", { status: 503 })
    return Response.json(response)
  }) as unknown as typeof fetch
  return { request, calls, mode(value: string) { mode = value }, account(value: string) { account = value }, failSync(value: boolean) { failSync = value }, failDelete(value: boolean) { failDelete = value } }
}
async function service() {
  const f = fixture(), fake = transport(), settings: Settings = {}
  let now = 1000
  const opened: string[] = []
  const console = createConsole({ dir: f.dir, settings: () => settings, request: fake.request, now: () => now, openUrl: async (url) => { opened.push(url) } })
  const configure = () => console.configure({ enabled: true, url: "http://127.0.0.1:8788", tokenFile: f.tokenFile })
  const login = async () => { const login = await console.login(); now += 1000; expect(await console.poll(login.loginID)).toMatchObject({ status: "success" }); return login }
  return { ...f, fake, settings, console, opened, configure, login, advance(ms: number) { now += ms } }
}

test("B74 additive schemas, disabled defaults, private reads and loopback-only configuration", async () => {
  const h = await service()
  expect(await h.console.snapshot()).toMatchObject({ enabled: false, accounts: [], tokenConfigured: false })
  await expect(h.console.login()).rejects.toThrow("off")
  expect(h.fake.calls).toHaveLength(0)
  for (const value of ["http://localhost:8788", "http://example.com", "http://127.0.0.1/a", "http://user:password@127.0.0.1", "http://127.0.0.1?token=secret", "file:///tmp"]) expect(ConsoleUrl.safeParse(value).success).toBe(false)
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
  for (const type of ["console.get", "console.listOrgs", "console.login", "console.open"]) expect(Command.safeParse({ ...base, type }).success).toBe(true)
  for (const type of ["session.share.get", "session.share", "session.share.sync", "session.unshare", "console.get", "console.poll", "console.open", "console.configure"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  chmodSync(h.tokenFile, 0o644)
  await expect(h.configure()).rejects.toThrow()
  chmodSync(h.tokenFile, 0o600)
  const link = path.join(h.dir, "token-link")
  symlinkSync(h.tokenFile, link)
  await expect(h.console.configure({ enabled: true, url: "http://127.0.0.1:8788", tokenFile: link })).rejects.toThrow()
})

test("device login polls with pending/slow deadlines, expires, denies and cancels without returning credentials", async () => {
  const h = await service(); await h.configure()
  const started = await h.console.login()
  expect(JSON.stringify(started)).not.toContain("b74-device-secret")
  expect(await h.console.poll(started.loginID)).toMatchObject({ status: "pending" })
  expect(h.fake.calls.filter((c) => c.url.pathname.endsWith("/token"))).toHaveLength(0)
  h.advance(1000); h.fake.mode("authorization_pending")
  expect(await h.console.poll(started.loginID)).toMatchObject({ status: "pending", intervalMs: 1000 })
  h.advance(1000); h.fake.mode("slow_down")
  expect(await h.console.poll(started.loginID)).toMatchObject({ status: "slow", intervalMs: 6000 })
  h.advance(6000); h.fake.mode("success")
  expect(await h.console.poll(started.loginID)).toMatchObject({ status: "success", accountEmail: "one@local.test" })
  expect(await h.console.poll(started.loginID)).toMatchObject({ status: "expired" })
  const denied = await h.console.login(); h.advance(1000); h.fake.mode("access_denied")
  expect(await h.console.poll(denied.loginID)).toMatchObject({ status: "denied" })
  const expired = await h.console.login(); h.advance(61000)
  expect(await h.console.poll(expired.loginID)).toMatchObject({ status: "expired" })
  const cancelled = await h.console.login(); await h.console.cancel(cancelled.loginID)
  expect(await h.console.poll(cancelled.loginID)).toMatchObject({ status: "expired" })
})

test("accounts/orgs persist, quota/billing/provider metadata exclude keys, refresh and pinned share identity survive switches", async () => {
  const h = await service(); await h.configure(); await h.login()
  h.fake.account("two"); await h.login()
  const report = await h.console.get()
  expect(ConsoleReport.safeParse(report).success).toBe(true)
  expect(report).toMatchObject({ switchableOrgCount: 4, activeOrgName: "Engineering", quota: { used: 42, limit: 100 }, billingUrl: "http://127.0.0.1:8788/billing", consoleManagedProviders: ["console-models"] })
  expect(JSON.stringify(report)).not.toMatch(/b74-(?:access|refresh|hidden|bootstrap)/)
  expect(statSync(path.join(h.dir, "console.json")).mode & 0o777).toBe(0o600)
  await h.console.switchOrg("one", "research")
  expect((await h.console.get()).activeOrgName).toBe("Research")
  await expect(h.console.switchOrg("one", "missing")).rejects.toThrow("unavailable")
  const restored = createConsole({ dir: h.dir, settings: () => ({}), request: h.fake.request })
  expect((await restored.snapshot()).accounts.find((a) => a.active)).toMatchObject({ accountID: "one", activeOrgID: "research" })
  const access = await h.console.access({ url: "http://127.0.0.1:8788", accountID: "two", orgID: "engineering" })
  expect(access.headers["x-org-id"]).toBe("engineering")
  await h.console.open("billing"); expect(h.opened).toEqual(["http://127.0.0.1:8788/billing"])
  h.advance(310000); await h.console.get()
  expect(h.fake.calls.some((c) => c.body?.grant_type === "refresh_token")).toBe(true)
  await h.console.logout("one"); await h.console.logout("two")
  expect((await h.console.snapshot()).accounts).toEqual([])
  await expect(h.console.access({ url: "http://127.0.0.1:8788", accountID: "two" })).rejects.toThrow("logged out")
  expect(readFileSync(path.join(h.dir, "console.json"), "utf8")).not.toContain("b74-access")
})

test("failed/malformed backend responses do not echo credentials, redirect links or mutate successful state", async () => {
  const h = await service(); await h.configure()
  const invalid = createConsole({ dir: h.dir, settings: () => ({}), request: (async () => Response.json({ device_code: "secret", user_code: "code", verification_uri_complete: "https://example.com", expires_in: 60, interval: 1 })) as unknown as typeof fetch })
  await expect(invalid.login()).rejects.toThrow("non-local")
  const throwing = createConsole({ dir: h.dir, settings: () => ({}), request: (async () => { throw new Error("b74-bootstrap-private-token") }) as unknown as typeof fetch })
  await expect(throwing.login()).rejects.toThrow("Console request failed")
  const oversized = createConsole({ dir: h.dir, settings: () => ({}), request: (async () => new Response("x".repeat(2_000_001))) as unknown as typeof fetch })
  await expect(oversized.login()).rejects.toThrow("too large")
  await h.console.configure({ enabled: false })
  await expect(h.console.access()).rejects.toThrow("off")
})

async function daemon() {
  const f = fixture(), fake = transport()
  const daemon = await startDaemon({ dir: f.dir, socketPath: path.join(f.dir, "mendd.sock"), log: () => {}, console: { request: fake.request, debounceMs: 1, openUrl: async () => {} }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(daemon.stop)
  const client = createClient({ socketPath: daemon.socketPath, name: "b74-local-test" }); await client.connect(); cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: f.dir })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  return { ...f, fake, daemon, client, sessionId }
}
async function eventually(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true) }

test("protocol/client share create-sync-unshare is sanitized, idempotent, durable and retryable", async () => {
  const h = await daemon()
  expect(await h.client.sessionShare(h.sessionId)).toMatchObject({ ok: true, share: { policy: "disabled" } })
  expect(await h.client.sessionShare(h.sessionId, "create")).toMatchObject({ ok: false })
  expect(h.fake.calls).toHaveLength(0)
  expect((await h.client.send({ type: "console.configure", enabled: true, url: "http://127.0.0.1:8788", tokenFile: h.tokenFile })).ok).toBe(true)
  await h.client.send({ type: "settings.set", patch: { share: "manual" } })
  const created = await h.client.sessionShare(h.sessionId, "create")
  expect(created).toMatchObject({ ok: true, share: { pending: false, url: "http://127.0.0.1:8788/share/link-1" } })
  if (created.ok) expect(SessionShare.safeParse(created.share).success).toBe(true)
  await h.client.sessionShare(h.sessionId, "create")
  expect(h.fake.calls.filter((c) => /^\/api\/shares?$/.test(c.url.pathname))).toHaveLength(1)
  const synced = h.fake.calls.find((c) => c.url.pathname.endsWith("/sync"))!
  expect(synced.body).toMatchObject({ replace: true, format: "mendcode-share@1", data: { format: "mendcode-session@1" } })
  expect(JSON.stringify(synced.body.data)).not.toContain(h.dir)
  expect(JSON.stringify(created)).not.toContain("b74-share-private-secret")
  expect(statSync(path.join(h.dir, "session-shares.json")).mode & 0o777).toBe(0o600)
  h.fake.failSync(true)
  const failed = await h.client.sessionShare(h.sessionId, "sync")
  expect(failed).toMatchObject({ ok: false })
  expect(JSON.stringify(failed)).not.toContain("b74-private-server-error")
  expect(await h.client.sessionShare(h.sessionId)).toMatchObject({ ok: true, share: { url: created.ok ? created.share.url : "", error: "Console returned HTTP 503" } })
  h.fake.failSync(false); expect((await h.client.sessionShare(h.sessionId, "sync")).ok).toBe(true)
  await h.client.send({ type: "settings.set", patch: { share: "disabled" } })
  h.fake.failDelete(true)
  expect(await h.client.send({ type: "session.delete", sessionId: h.sessionId })).toMatchObject({ ok: false })
  expect(h.daemon.store.hasSession(h.sessionId)).toBe(true)
  h.fake.failDelete(false)
  expect((await h.client.sessionShare(h.sessionId, "remove")).ok).toBe(true)
  expect((await h.client.sessionShare(h.sessionId, "remove")).ok).toBe(true)
  expect(h.fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(2)
  const removed = await h.client.sessionShare(h.sessionId)
  expect(removed.ok && removed.share.url).toBeUndefined()
})

test("automatic sharing creates only new sessions, coalesces content changes, pauses while disabled and retention preserves links", async () => {
  const h = await daemon()
  await h.client.send({ type: "console.configure", enabled: true, url: "http://127.0.0.1:8788", tokenFile: h.tokenFile })
  await h.client.send({ type: "settings.set", patch: { share: "auto" } })
  expect(h.fake.calls).toHaveLength(0)
  const next = await h.client.send({ type: "session.create", directory: h.dir })
  if (!next.ok) throw new Error(next.error.message)
  const nextId = next.result!.sessionId as SessionId
  await eventually(() => h.fake.calls.some((c) => c.url.pathname.endsWith("/sync")))
  await h.client.send({ type: "user.submit", sessionId: nextId, text: "local fake answer sk-proj-" + "a".repeat(40), attachments: [] })
  await eventually(() => h.fake.calls.filter((c) => c.url.pathname.endsWith("/sync")).length >= 2)
  const latest = h.fake.calls.filter((c) => c.url.pathname.endsWith("/sync")).at(-1)!
  expect(JSON.stringify(latest.body.data)).toContain("local fake answer")
  expect(JSON.stringify(latest.body.data)).not.toContain("sk-proj-" + "a".repeat(40))
  await h.client.send({ type: "settings.set", patch: { share: "disabled" } })
  const count = h.fake.calls.length
  await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "off", attachments: [] }); await Bun.sleep(30)
  expect(h.fake.calls).toHaveLength(count)
  expect((await h.client.send({ type: "storage.clean", olderThanDays: 0 })).ok).toBe(true)
  expect(h.daemon.store.hasSession(nextId)).toBe(true)
  expect((await h.client.send({ type: "session.delete", sessionId: nextId })).ok).toBe(true)
  expect(h.daemon.store.hasSession(nextId)).toBe(false)
})
