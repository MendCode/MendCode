import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { digest } from "../src/bytes"
import { deviceSignedText } from "../src/device-key"
import { createGateway, MAX_BODY_BYTES, TTL } from "../src/server"
import { gatewayState } from "../src/state"
import { fakeAuthenticator } from "./fake-authenticator"
import { MAX_FRAME_BYTES } from "../../protocol/src/constants"

/**
 * The gateway end to end on loopback with two fake per-account daemons on Unix sockets in a temp folder: passkey sign-up
 * and sign-in, device pairing with a passkey approval, short tokens, CSRF and Origin checks, lockouts, revocation and
 * cross-account isolation. No real host, user, service, certificate or browser is involved.
 */
const ORIGIN = "https://code.example.test"
const config = { version: 1 as const, origin: ORIGIN, rpId: "code.example.test", name: "MendCode", listen: { port: 1 }, clientIpHeader: "x-real-ip" as const, runtimeRoot: "/run/unused" }
const ACCOUNTS = { alice: "aaaaaaaaaa", bob: "bbbbbbbbbb" } as const
const INVITES = { alice: "invite-code-for-alice-0123456789-abcdef", bob: "invite-code-for-bob-0123456789-abcdefgh" }

let root: string
let stateDir: string
let clock = Date.now()
let gatewayServer: ReturnType<typeof Bun.serve>
let base: string
const backends: ReturnType<typeof Bun.serve>[] = []
const seen: { account: string; path: string; authorization: string | null; cookie: string | null; origin: string | null; extra: string | null }[] = []

beforeAll(() => {
  // Unix socket paths are short (104 bytes on macOS): a folder directly in /tmp.
  root = mkdtempSync("/tmp/mcgw-")
  stateDir = path.join(root, "state")
  const store = gatewayState(stateDir)
  store.update((state) => {
    for (const [name, id] of Object.entries(ACCOUNTS)) {
      state.accounts.push({ id, name, role: name === "alice" ? "admin" : "user", status: "invited", createdAt: clock, passkeys: [], devices: [] })
      state.invites.push({ hash: digest(INVITES[name as keyof typeof INVITES]), accountId: id, createdAt: clock, expiresAt: clock + 3600_000 })
    }
  })
  for (const [name, id] of Object.entries(ACCOUNTS)) {
    backends.push(Bun.serve<{ account: string }, never>({
      unix: path.join(root, `${id}.sock`),
      fetch(request, server) {
        const url = new URL(request.url)
        seen.push({ account: name, path: url.pathname, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), origin: request.headers.get("origin"), extra: request.headers.get("x-mendcode-account") })
        if (server.upgrade(request, { data: { account: name } })) return undefined
        if (url.pathname === "/event") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: hello\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
        if (url.pathname === "/") return new Response("<!doctype html><title>MendCode</title>", { headers: { "content-type": "text/html; charset=utf-8" } })
        return Response.json({ account: name, path: url.pathname, auth: request.headers.get("authorization") }, { headers: { "www-authenticate": 'Basic realm="x"', "set-cookie": "leak=1" } })
      },
      websocket: { message(ws, message) { ws.send(`${ws.data.account}:${message}`) } },
    }))
  }
  const gateway = createGateway({
    config, stateDir, now: () => clock,
    backend: (accountId, scope) => ({ socket: path.join(root, `${accountId}.sock`), token: `backend-${accountId}-${scope}` }),
  })
  gatewayServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: gateway.fetch, websocket: gateway.websocket, maxRequestBodySize: MAX_BODY_BYTES })
  base = `http://127.0.0.1:${gatewayServer.port}`
})
afterAll(() => {
  gatewayServer.stop(true)
  for (const server of backends) server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

let ipCounter = 0
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`
type Call = { method?: string; body?: unknown; cookie?: string; csrf?: string; origin?: string | null; ip?: string; auth?: string; headers?: Record<string, string> }
async function call(route: string, options: Call = {}) {
  const headers: Record<string, string> = { "x-real-ip": options.ip ?? "10.9.9.9", ...(options.headers ?? {}) }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  if (options.cookie) headers.cookie = options.cookie
  if (options.csrf) headers["x-mendcode-csrf"] = options.csrf
  if (options.auth) headers.authorization = options.auth
  const origin = options.origin === undefined ? (options.auth ? null : ORIGIN) : options.origin
  if (origin) headers.origin = origin
  const response = await fetch(`${base}${route}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, redirect: "manual", ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const text = await response.text()
  let json: Record<string, any> = {}
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, json, text, headers: response.headers }
}
const cookieOf = (response: { headers: Headers }) => response.headers.get("set-cookie")!.split(";")[0]!

async function registerPasskey(account: keyof typeof ACCOUNTS, ip = freshIp()) {
  const authenticator = fakeAuthenticator({ userId: Buffer.from(ACCOUNTS[account]), rpId: config.rpId, origin: ORIGIN })
  const options = await call("/_gw/register/options", { body: { code: INVITES[account] }, ip })
  expect(options.status).toBe(200)
  const done = await call("/_gw/register", { body: { flowId: options.json.flowId, credential: authenticator.create(options.json.publicKey) }, ip })
  expect(done.status).toBe(200)
  return { authenticator, cookie: cookieOf(done), setCookie: done.headers.get("set-cookie")! }
}
async function signIn(authenticator: ReturnType<typeof fakeAuthenticator>, bend = {}, ip = freshIp()) {
  const options = await call("/_gw/login/options", { body: {}, ip })
  return call("/_gw/login", { body: { flowId: options.json.flowId, credential: authenticator.get(options.json.publicKey, bend) }, ip })
}
async function csrfOf(cookie: string) { return (await call("/_gw/me", { cookie })).json.csrf as string }

let alice: Awaited<ReturnType<typeof registerPasskey>>
let bob: Awaited<ReturnType<typeof registerPasskey>>

describe("sign-up and sign-in with passkeys", () => {
  test("an invite registers a passkey once and starts a __Host- cookie session (Secure, HttpOnly, SameSite=Strict)", async () => {
    alice = await registerPasskey("alice")
    bob = await registerPasskey("bob")
    expect(alice.setCookie).toMatch(/^__Host-mcgw=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
    const me = await call("/_gw/me", { cookie: alice.cookie })
    expect(me.json).toMatchObject({ id: ACCOUNTS.alice, name: "alice", role: "admin" })
    // Single use: the same invite does not work twice.
    expect((await call("/_gw/register/options", { body: { code: INVITES.alice }, ip: freshIp() })).status).toBe(400)
  })
  test("sign-in works, and a replayed assertion is refused (the ceremony is consumed whatever the outcome)", async () => {
    const ip = freshIp()
    const options = await call("/_gw/login/options", { body: {}, ip })
    const credential = alice.authenticator.get(options.json.publicKey)
    expect((await call("/_gw/login", { body: { flowId: options.json.flowId, credential }, ip })).status).toBe(200)
    expect((await call("/_gw/login", { body: { flowId: options.json.flowId, credential }, ip })).status).toBe(400)
    const again = await call("/_gw/login/options", { body: {}, ip })
    expect((await call("/_gw/login", { body: { flowId: again.json.flowId, credential }, ip })).status).toBe(401)
  })
  test("a ceremony expires after five minutes", async () => {
    const ip = freshIp()
    const options = await call("/_gw/login/options", { body: {}, ip })
    clock += TTL.ceremony + 1
    expect((await call("/_gw/login", { body: { flowId: options.json.flowId, credential: alice.authenticator.get(options.json.publicKey) }, ip })).status).toBe(400)
  })
  test("an assertion from a phishing origin, for another rpId or with a counter that went back is refused", async () => {
    expect((await signIn(alice.authenticator, { origin: "https://code-example.test" })).status).toBe(401)
    expect((await signIn(alice.authenticator, { rpId: "example.test" })).status).toBe(401)
    expect((await signIn(alice.authenticator, { counter: 1 })).status).toBe(401)
    const audit = readFileSync(path.join(stateDir, "audit", `${ACCOUNTS.alice}.jsonl`), "utf8")
    for (const reason of ["origin", "rp_id", "counter"]) expect(audit).toContain(`"reason":"${reason}"`)
  })
  test("an unknown or wrong invite code is refused and repeated guesses are rate limited", async () => {
    const ip = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await call("/_gw/register/options", { body: { code: `guess-${i}-0123456789abcdefghij` }, ip })).status)
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })
  test("repeated failed sign-ins lock the account, even for a then-correct passkey", async () => {
    const victim = fakeAuthenticator({ userId: Buffer.from(ACCOUNTS.bob), rpId: config.rpId, origin: ORIGIN })
    void victim
    for (let i = 0; i < 6; i++) expect((await signIn(bob.authenticator, { tamper: true })).status).toBe(401)
    expect((await signIn(bob.authenticator)).status).toBe(429)
    // The sixth failure locks for a minute; the lock passes, the failures stay remembered.
    clock += 61_000
    expect((await signIn(bob.authenticator)).status).toBe(200)
  })
})

describe("CSRF and Origin checks for cookie sessions", () => {
  test("a change without the CSRF header, with a wrong one, or from another origin is refused", async () => {
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/command", { body: { type: "session.list" }, cookie: alice.cookie })).status).toBe(403)
    expect((await call("/command", { body: { type: "session.list" }, cookie: alice.cookie, csrf: "x".repeat(43) })).status).toBe(403)
    expect((await call("/command", { body: { type: "session.list" }, cookie: alice.cookie, csrf, origin: "https://evil.example.test" })).status).toBe(403)
    expect((await call("/command", { body: { type: "session.list" }, cookie: alice.cookie, csrf, origin: null })).status).toBe(403)
    expect((await call("/_gw/logout", { body: {}, cookie: alice.cookie })).status).toBe(403)
    expect((await call("/_gw/me", { cookie: alice.cookie, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
    const ok = await call("/command", { body: { type: "session.list" }, cookie: alice.cookie, csrf })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ account: "alice", auth: `Bearer backend-${ACCOUNTS.alice}-full` })
  })
  test("a WebSocket handshake needs our Origin (no cross-site WebSocket hijacking)", async () => {
    expect((await call("/wire", { cookie: alice.cookie, origin: "https://evil.example.test", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(403)
    expect((await call("/wire", { cookie: alice.cookie, origin: null, headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(403)
  })
  test("the web page served through the gateway carries the session's CSRF token, and never the daemon's credentials", async () => {
    const page = await call("/", { cookie: alice.cookie, headers: { accept: "text/html" } })
    expect(page.text).toContain(`<meta name="mendcode-gateway-csrf" content="${await csrfOf(alice.cookie)}">`)
    expect(page.text).not.toContain("backend-")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  })
})

describe("nothing for anonymous callers, nothing across accounts", () => {
  test("an unauthenticated request learns nothing and never reaches a daemon", async () => {
    const before = seen.length
    const anonymous = await call("/global/health", { origin: null })
    expect(anonymous.status).toBe(401)
    expect(anonymous.json).toEqual({ error: { code: "unauthorized", message: "sign in required" } })
    expect(anonymous.headers.get("www-authenticate")).toBeNull()
    expect((await call("/", { origin: null, headers: { accept: "text/html" } })).headers.get("location")).toBe("/_gw/")
    // A daemon token presented directly is not a gateway credential.
    expect((await call("/global/health", { auth: `Bearer backend-${ACCOUNTS.bob}-full` })).status).toBe(401)
    expect((await call("/global/health", { cookie: "__Host-mcgw=" + "A".repeat(43), origin: null })).status).toBe(401)
    expect(seen.length).toBe(before)
  })
  test("alice's session reaches only alice's daemon, whatever headers or paths she sends; cookies and credentials stay at the gateway", async () => {
    const csrf = await csrfOf(alice.cookie)
    seen.length = 0
    for (const route of ["/session/x", "/../bbbbbbbbbb/http.sock", "/%2e%2e/bob", "//bob"]) await call(route, { cookie: alice.cookie, headers: { "x-mendcode-account": ACCOUNTS.bob, authorization: "" } })
    await call("/command", { body: {}, cookie: alice.cookie, csrf, headers: { "x-mendcode-account": ACCOUNTS.bob } })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((entry) => entry.account === "alice" && entry.authorization === `Bearer backend-${ACCOUNTS.alice}-full` && entry.cookie === null && entry.origin === null && entry.extra === null)).toBe(true)
    const response = await call("/session/x", { cookie: alice.cookie })
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("www-authenticate")).toBeNull()
  })
  test("a cookie and a bearer together are refused as ambiguous", async () => {
    expect((await call("/session/x", { cookie: alice.cookie, auth: "Bearer mgw_x" })).status).toBe(400)
  })
})

describe("device pairing: code, passkey approval, short tokens", () => {
  const device = generateKeyPairSync("ed25519")
  const publicKey = (device.publicKey.export({ format: "jwk" }) as { x: string }).x
  let deviceId = ""
  async function token(id = deviceId, key = device.privateKey, ip = freshIp()) {
    const challenge = await call("/_gw/token/challenge", { body: { deviceId: id }, origin: null, ip })
    const signature = sign(null, Buffer.from(deviceSignedText({ origin: ORIGIN, deviceId: id, challenge: challenge.json.challenge })), key).toString("base64url")
    return { response: await call("/_gw/token", { body: { deviceId: id, challenge: challenge.json.challenge, signature }, origin: null, ip }), challenge: challenge.json.challenge as string, signature }
  }
  async function start(name = "laptop") {
    const started = await call("/_gw/device/start", { body: { name, publicKey }, origin: null, ip: freshIp() })
    expect(started.status).toBe(200)
    return started.json as { deviceCode: string; userCode: string }
  }
  async function approve(userCode: string, scope = "full", who = alice) {
    const csrf = await csrfOf(who.cookie)
    const options = await call("/_gw/device/approve/options", { body: { userCode }, cookie: who.cookie, csrf })
    expect(options.status).toBe(200)
    return call("/_gw/device/approve", { body: { flowId: options.json.flowId, scope, credential: who.authenticator.get(options.json.publicKey) }, cookie: who.cookie, csrf })
  }

  test("a device is approved only with a fresh passkey check, then trades signed challenges for 10-minute tokens", async () => {
    const started = await start()
    expect(started.userCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect((await call("/_gw/device/poll", { body: { deviceCode: started.deviceCode }, origin: null })).json.status).toBe("pending")
    // A tampered passkey assertion does not approve.
    const csrf = await csrfOf(alice.cookie)
    const options = await call("/_gw/device/approve/options", { body: { userCode: started.userCode.toLowerCase() }, cookie: alice.cookie, csrf })
    expect(options.json.device.name).toBe("laptop")
    expect((await call("/_gw/device/approve", { body: { flowId: options.json.flowId, credential: alice.authenticator.get(options.json.publicKey, { tamper: true }) }, cookie: alice.cookie, csrf })).status).toBe(401)
    expect((await approve(started.userCode)).status).toBe(200)
    clock += TTL.devicePoll
    const polled = await call("/_gw/device/poll", { body: { deviceCode: started.deviceCode }, origin: null })
    expect(polled.json.status).toBe("approved")
    deviceId = polled.json.deviceId
    // The device code is spent.
    clock += TTL.devicePoll
    expect((await call("/_gw/device/poll", { body: { deviceCode: started.deviceCode }, origin: null })).status).toBe(400)
    const issued = await token()
    expect(issued.response.status).toBe(200)
    expect(issued.response.json).toMatchObject({ tokenType: "Bearer", expiresIn: 600, scope: "full" })
    const used = await call("/session/x", { auth: `Bearer ${issued.response.json.accessToken}` })
    expect(used.json).toMatchObject({ account: "alice", auth: `Bearer backend-${ACCOUNTS.alice}-full` })
  })
  test("a replayed challenge, a signature by another key or for another origin, and an expired token are refused", async () => {
    const issued = await token()
    expect((await call("/_gw/token", { body: { deviceId, challenge: issued.challenge, signature: issued.signature }, origin: null, ip: freshIp() })).status).toBe(401)
    expect((await token(deviceId, generateKeyPairSync("ed25519").privateKey)).response.status).toBe(401)
    const challenge = await call("/_gw/token/challenge", { body: { deviceId }, origin: null })
    const elsewhere = sign(null, Buffer.from(deviceSignedText({ origin: "https://other.example.test", deviceId, challenge: challenge.json.challenge })), device.privateKey).toString("base64url")
    expect((await call("/_gw/token", { body: { deviceId, challenge: challenge.json.challenge, signature: elsewhere }, origin: null, ip: freshIp() })).status).toBe(401)
    const expiring = await call("/_gw/token/challenge", { body: { deviceId }, origin: null })
    clock += TTL.challenge + 1
    const late = sign(null, Buffer.from(deviceSignedText({ origin: ORIGIN, deviceId, challenge: expiring.json.challenge })), device.privateKey).toString("base64url")
    expect((await call("/_gw/token", { body: { deviceId, challenge: expiring.json.challenge, signature: late }, origin: null, ip: freshIp() })).status).toBe(401)
    const fresh = await token()
    expect(fresh.response.status).toBe(200)
    const accessToken = fresh.response.json.accessToken
    expect((await call("/session/x", { auth: `Bearer ${accessToken}` })).status).toBe(200)
    clock += TTL.accessToken + 1
    expect((await call("/session/x", { auth: `Bearer ${accessToken}` })).status).toBe(401)
  })
  test("a device token is not accepted from a browser page (Origin present)", async () => {
    const issued = await token()
    expect((await call("/session/x", { auth: `Bearer ${issued.response.json.accessToken}`, origin: ORIGIN })).status).toBe(403)
  })
  test("guessing device codes locks the signed-in session after five misses", async () => {
    const csrf = await csrfOf(bob.cookie)
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await call("/_gw/device/approve/options", { body: { userCode: `ZZZZ-ZZ${i}Z` }, cookie: bob.cookie, csrf, ip: freshIp() })).status)
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404])
    expect(statuses.slice(5)).toEqual([404, 429])
  })
  test("a device code expires after ten minutes, and a denied one never pairs", async () => {
    const expired = await start("old")
    clock += TTL.deviceCode + 1
    expect((await call("/_gw/device/poll", { body: { deviceCode: expired.deviceCode }, origin: null })).status).toBe(400)
    const denied = await start("unknown")
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/_gw/device/deny", { body: { userCode: denied.userCode }, cookie: alice.cookie, csrf })).status).toBe(200)
    expect((await call("/_gw/device/poll", { body: { deviceCode: denied.deviceCode }, origin: null })).status).toBe(403)
  })
  test("a read-only device reaches the daemon with its read-only token only", async () => {
    const started = await start("phone")
    expect((await approve(started.userCode, "read-only")).status).toBe(200)
    clock += TTL.devicePoll
    const id = (await call("/_gw/device/poll", { body: { deviceCode: started.deviceCode }, origin: null })).json.deviceId
    const issued = await token(id)
    expect(issued.response.json.scope).toBe("read-only")
    expect((await call("/session/x", { auth: `Bearer ${issued.response.json.accessToken}` })).json.auth).toBe(`Bearer backend-${ACCOUNTS.alice}-read-only`)
  })
  test("an open WebSocket of a device ends when the access token it was opened with expires", async () => {
    const issued = await token()
    const socket = new (WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket })(`${base.replace("http", "ws")}/wire`, { headers: { authorization: `Bearer ${issued.response.json.accessToken}`, "x-real-ip": "10.8.8.7" } })
    const echoed = new Promise<string>((resolve) => { socket.onmessage = (event) => resolve(String(event.data)) })
    const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code) })
    await new Promise((resolve) => { socket.onopen = resolve })
    socket.send("ping")
    expect(await echoed).toBe("alice:ping")
    clock += TTL.accessToken + 1
    expect(await closed).toBe(1008)
  })
  test("revoking a device ends its open event stream, not only its WebSockets", async () => {
    const started = await start("stream")
    expect((await approve(started.userCode)).status).toBe(200)
    clock += TTL.devicePoll
    const id = (await call("/_gw/device/poll", { body: { deviceCode: started.deviceCode }, origin: null })).json.deviceId
    const issued = await token(id)
    const response = await fetch(`${base}/event`, { headers: { authorization: `Bearer ${issued.response.json.accessToken}`, "x-real-ip": "10.8.8.6" } })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n")
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/_gw/devices/revoke", { body: { deviceId: id }, cookie: alice.cookie, csrf })).status).toBe(200)
    const ended = await Promise.race([reader.read().then((chunk) => (chunk.done ? "done" : "data"), () => "error"), Bun.sleep(2000).then(() => "open")])
    expect(ended === "done" || ended === "error").toBe(true)
  })
  test("revoking a device ends its tokens and closes its open WebSocket within a second", async () => {
    const issued = await token()
    const accessToken = issued.response.json.accessToken
    const socket = new (WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket })(`${base.replace("http", "ws")}/wire`, { headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "10.8.8.8" } })
    const echoed = new Promise<string>((resolve) => { socket.onmessage = (event) => resolve(String(event.data)) })
    const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code) })
    await new Promise((resolve) => { socket.onopen = resolve })
    socket.send("ping")
    expect(await echoed).toBe("alice:ping")
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/_gw/devices/revoke", { body: { deviceId }, cookie: alice.cookie, csrf })).status).toBe(200)
    const started = Date.now()
    expect(await closed).toBe(1008)
    expect(Date.now() - started).toBeLessThan(1500)
    expect((await call("/session/x", { auth: `Bearer ${accessToken}` })).status).toBe(401)
    expect((await token()).response.status).toBe(401)
  })
})

describe("the device limit", () => {
  test("a device can replace a revoked one at the limit of 32: the revoked record makes room instead of failing the approval", async () => {
    const device = generateKeyPairSync("ed25519")
    const publicKey = (device.publicKey.export({ format: "jwk" }) as { x: string }).x
    const pair = async (name: string) => {
      const started = (await call("/_gw/device/start", { body: { name, publicKey }, origin: null, ip: freshIp() })).json as { deviceCode: string; userCode: string }
      const csrf = await csrfOf(alice.cookie)
      const options = await call("/_gw/device/approve/options", { body: { userCode: started.userCode }, cookie: alice.cookie, csrf })
      const approved = await call("/_gw/device/approve", { body: { flowId: options.json.flowId, scope: "full", credential: alice.authenticator.get(options.json.publicKey) }, cookie: alice.cookie, csrf })
      return { status: approved.status, deviceId: approved.json.deviceId as string | undefined }
    }
    const live: string[] = []
    for (let i = 0; i < 40; i++) {
      const result = await pair(`fill-${i}`)
      if (result.status === 409) break
      expect(result.status).toBe(200)
      live.push(result.deviceId!)
    }
    const full = await pair("one too many")
    expect(full.status).toBe(409)
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/_gw/devices/revoke", { body: { deviceId: live[0] }, cookie: alice.cookie, csrf })).status).toBe(200)
    expect((await pair("replacement")).status).toBe(200)
  })
})

describe("admin and account state", () => {
  test("only an admin lists accounts; disabling an account ends its sessions; admins see no session data", async () => {
    const bobCsrf = await csrfOf(bob.cookie)
    expect((await call("/_gw/admin/accounts", { cookie: bob.cookie })).status).toBe(403)
    expect((await call("/_gw/admin/account", { body: { accountId: ACCOUNTS.alice, status: "disabled" }, cookie: bob.cookie, csrf: bobCsrf })).status).toBe(403)
    const list = await call("/_gw/admin/accounts", { cookie: alice.cookie })
    expect(list.json.accounts.map((entry: { id: string }) => entry.id).sort()).toEqual(Object.values(ACCOUNTS).sort())
    expect(JSON.stringify(list.json)).not.toMatch(/passkeys":\[|publicKey|session/)
    const csrf = await csrfOf(alice.cookie)
    expect((await call("/_gw/admin/account", { body: { accountId: ACCOUNTS.bob, status: "disabled" }, cookie: alice.cookie, csrf })).status).toBe(200)
    expect((await call("/_gw/me", { cookie: bob.cookie })).status).toBe(401)
    expect((await signIn(bob.authenticator)).status).toBe(401)
  })
  test("the audit log names events and reasons but holds no code, token, cookie or challenge", () => {
    const text = readdirSync(path.join(stateDir, "audit")).map((file) => readFileSync(path.join(stateDir, "audit", file), "utf8")).join("")
    for (const event of ["passkey.register", "login", "device.start", "device.approve", "token.issue", "device.revoke", "admin.account"]) expect(text).toContain(`"event":"${event}"`)
    for (const secret of [INVITES.alice, INVITES.bob, alice.cookie.split("=")[1]!, bob.cookie.split("=")[1]!, "mgw_", "backend-"]) expect(text).not.toContain(secret)
  })
  test("the gateway's body limit is the daemon's frame limit", () => {
    expect(MAX_BODY_BYTES).toBe(MAX_FRAME_BYTES)
  })
})
