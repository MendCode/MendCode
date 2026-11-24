import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { digest, normalizeCode, readableCode, sameSecret, secret } from "./bytes"
import type { GatewayConfig } from "./config"
import { auditLog, type AuditEntry } from "./audit"
import { deviceSignedText, validDevicePublicKey, verifyDeviceSignature } from "./device-key"
import { ephemeral } from "./ephemeral"
import { lockout, rateLimiter } from "./limits"
import { GATEWAY_PAGE, GATEWAY_PAGE_CSP } from "./page"
import { ACCOUNT_ID, gatewayState, type Account, type Device, type Scope } from "./state"
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration, type RelyingParty } from "./webauthn"

/** Same bound as the daemon's protocol frames (`MAX_FRAME_BYTES`); the gateway's own JSON bodies are far smaller. */
export const MAX_BODY_BYTES = 256 * 1024
const MAX_GATEWAY_JSON = 16 * 1024
export const SESSION_COOKIE = "__Host-mcgw"
export const ACCESS_TOKEN_PREFIX = "mgw_"
export const TTL = { ceremony: 5 * 60_000, sessionIdle: 2 * 3600_000, sessionMax: 12 * 3600_000, deviceCode: 10 * 60_000, devicePoll: 2_000, challenge: 60_000, accessToken: 10 * 60_000 } as const
const DEVICE_ID = /^d[0-9a-z]{10}$/
const DEVICE_NAME = /^[\w .@+-]{1,64}$/

type Ceremony =
  | { kind: "register"; accountId: string; inviteHash: string; challenge: Buffer; expiresAt: number }
  | { kind: "login"; challenge: Buffer; expiresAt: number }
  | { kind: "approve"; accountId: string; sessionKey: string; deviceKey: string; challenge: Buffer; expiresAt: number }
type Session = { accountId: string; csrf: string; createdAt: number; lastSeen: number; expiresAt: number }
type AccessToken = { accountId: string; deviceId: string; scope: Scope; expiresAt: number }
/** `key` is the SHA-256 of the device code, the flow's key in its map; the code itself is never kept. */
type DeviceFlow = { key: string; userCode: string; name: string; publicKey: string; ip: string; createdAt: number; expiresAt: number; lastPoll: number; status: "pending" | "approved" | "denied"; deviceId?: string; scope?: Scope }
type Identity = { kind: "session"; key: string; accountId: string; scope: Scope } | { kind: "device"; key: string; accountId: string; deviceId: string; scope: Scope }
export type Backend = { socket: string; token: string }
type SocketData = { target: string; token: string; identity: Identity; upstream?: WebSocket; queue: (string | Uint8Array<ArrayBuffer>)[]; queued: number }

export type GatewayOptions = {
  config: GatewayConfig
  stateDir: string
  now?: () => number
  /** Where one account's daemon listens and the token it accepts for a scope; the default reads `<state>/backends/<account>/`. */
  backend?: (accountId: string, scope: Scope) => Backend | undefined
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
}
/** Request headers a client may pass to its daemon; everything else (cookies, credentials, forwarding headers) stays here. */
const FORWARD_REQUEST = ["accept", "content-type", "if-match", "if-none-match", "last-event-id", "x-opencode-directory", "x-mendcode-workspace", "x-mendcode-ticket", "x-opencode-ticket"]
const FORWARD_RESPONSE = ["content-type", "etag", "content-disposition", "x-accel-buffering", "location"]

/** Reads one account's daemon tokens once per change of their files; they never leave this process. */
function fileBackends(stateDir: string, runtimeRoot: string) {
  const cache = new Map<string, { key: string; token: string }>()
  return (accountId: string, scope: Scope): Backend | undefined => {
    if (!ACCOUNT_ID.test(accountId)) return undefined
    const file = path.join(stateDir, "backends", accountId, scope === "full" ? "full.token" : "read.token")
    try {
      const stat = statSync(file)
      const key = `${stat.mtimeMs}:${stat.size}`
      let entry = cache.get(file)
      if (entry?.key !== key) {
        entry = { key, token: readFileSync(file, "utf8").trim() }
        cache.set(file, entry)
      }
      if (!entry.token || entry.token.length > 4096) return undefined
      return { socket: path.join(runtimeRoot, accountId, "http.sock"), token: entry.token }
    } catch { return undefined }
  }
}

export function createGateway(options: GatewayOptions) {
  const { config } = options
  const now = options.now ?? Date.now
  const rp: RelyingParty = { id: config.rpId, origin: config.origin, name: config.name }
  const store = gatewayState(options.stateDir, now)
  const audit = auditLog(options.stateDir, now)
  const backend = options.backend ?? fileBackends(options.stateDir, config.runtimeRoot)
  const ceremonies = ephemeral<Ceremony>(10_000, now)
  const sessions = ephemeral<Session>(10_000, now)
  const tokens = ephemeral<AccessToken>(50_000, now)
  const deviceFlows = ephemeral<DeviceFlow>(1_000, now)
  const challenges = ephemeral<{ deviceId: string; expiresAt: number }>(10_000, now)
  const limits = rateLimiter(now)
  const ipLock = lockout({ free: 10, baseMs: 1_000, maxMs: 15 * 60_000, memoryMs: 3600_000 }, now)
  const accountLock = lockout({ free: 5, baseMs: 60_000, maxMs: 3600_000, memoryMs: 24 * 3600_000 }, now)
  const deviceLock = lockout({ free: 5, baseMs: 60_000, maxMs: 3600_000, memoryMs: 24 * 3600_000 }, now)
  const codeLock = lockout({ free: 5, baseMs: 60_000, maxMs: 3600_000, memoryMs: 3600_000 }, now)
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  const perAccountSockets = new Map<string, number>()
  /** Long HTTP responses (event streams) in progress: ended with their sockets when their access goes away. */
  const streams = new Set<{ identity: Identity; abort(): void }>()
  let sweeper: ReturnType<typeof setInterval> | undefined

  const record = (entry: AuditEntry) => audit.write(entry)
  function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } })
  }
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => respond({ error: { code, message } }, status, headers)
  const limited = () => fail(429, "rate_limited", "too many attempts; try again later")

  function clientIp(request: Request, server?: Bun.Server<SocketData>) {
    if (config.clientIpHeader) {
      const raw = request.headers.get(config.clientIpHeader)
      const value = (config.clientIpHeader === "x-forwarded-for" ? raw?.split(",")[0] : raw)?.trim()
      if (value && /^[0-9a-fA-F:.]{2,45}$/.test(value)) return value
    }
    return server?.requestIP(request)?.address ?? "local"
  }

  const account = (id: string) => store.read().accounts.find((entry) => entry.id === id)
  const activeAccount = (id: string) => { const found = account(id); return found?.status === "active" ? found : undefined }
  const liveDevice = (found: Account | undefined, deviceId: string) => found?.devices.find((device) => device.id === deviceId && device.revokedAt === undefined)

  function cookieValue(request: Request) {
    const header = request.headers.get("cookie")
    if (!header) return undefined
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name === SESSION_COOKIE) { const value = rest.join("="); return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "" }
    }
    return undefined
  }
  function session(request: Request) {
    const value = cookieValue(request)
    if (!value) return undefined
    const key = digest(value)
    const found = sessions.get(key)
    if (!found || !activeAccount(found.accountId)) return undefined
    const time = now()
    found.lastSeen = time
    found.expiresAt = Math.min(found.createdAt + TTL.sessionMax, time + TTL.sessionIdle)
    return { key, session: found }
  }
  function startSession(accountId: string) {
    const value = secret()
    const time = now()
    if (!sessions.put(digest(value), { accountId, csrf: secret(), createdAt: time, lastSeen: time, expiresAt: time + TTL.sessionIdle })) return undefined
    return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL.sessionMax / 1000}`
  }
  const clearCookie = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`

  /** A browser request from this origin: Origin (when sent, and always for changes) must be ours, Fetch Metadata must not say cross-site. */
  function sameOrigin(request: Request, change: boolean) {
    const origin = request.headers.get("origin")
    if (change && origin === null) return false
    if (origin !== null && origin !== config.origin) return false
    const site = request.headers.get("sec-fetch-site")
    return site === null || site === "same-origin" || site === "none"
  }
  const csrfValid = (request: Request, found: Session) => {
    const header = request.headers.get("x-mendcode-csrf")
    return header !== null && sameSecret(header, found.csrf)
  }

  async function json(request: Request): Promise<Record<string, unknown> | undefined> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined
    const text = await request.text()
    if (text.length > MAX_GATEWAY_JSON) return undefined
    try {
      const value = JSON.parse(text)
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
    } catch { return undefined }
  }

  function closeSockets(match: (identity: Identity) => boolean, reason: string) {
    for (const ws of sockets) if (match(ws.data.identity)) ws.close(1008, reason)
    for (const stream of streams) if (match(stream.identity)) stream.abort()
  }
  function identityValid(identity: Identity) {
    if (identity.kind === "session") return sessions.get(identity.key) !== undefined && activeAccount(identity.accountId) !== undefined
    // The access token is what the connection was opened with: when it expires the device signs for a new one and reconnects.
    return tokens.get(identity.key) !== undefined && liveDevice(activeAccount(identity.accountId), identity.deviceId) !== undefined
  }
  function watchAccess() {
    sweeper ??= setInterval(sweep, 1_000)
    sweeper.unref?.()
  }
  /** Revocation reaches open connections within a second; the timer runs only while a WebSocket or an event stream is open. */
  function sweep() {
    for (const ws of sockets) if (!identityValid(ws.data.identity)) ws.close(1008, "access revoked")
    for (const stream of streams) if (!identityValid(stream.identity)) stream.abort()
    if (!sockets.size && !streams.size && sweeper) { clearInterval(sweeper); sweeper = undefined }
  }

  // ---- WebAuthn: invite (or bootstrap) registration, sign-in -------------------------------------------------------

  function findInvite(code: string) {
    const hash = digest(code)
    const time = now()
    let found: { hash: string; accountId: string } | undefined
    // Every live invite is compared, in constant time each, so timing says nothing about which (or whether one) matched.
    for (const invite of store.read().invites) if (sameSecret(invite.hash, hash) && invite.expiresAt > time) found = invite
    return found
  }

  async function registerOptions(request: Request, ip: string) {
    if (!limits.hit(`register:${ip}`, 10, 15 * 60_000) || ipLock.locked(ip)) return limited()
    const body = await json(request)
    const code = typeof body?.code === "string" ? body.code : ""
    const invite = code.length >= 20 && code.length <= 100 ? findInvite(code) : undefined
    const target = invite ? account(invite.accountId) : undefined
    if (!invite || !target || target.status === "disabled") {
      ipLock.fail(ip)
      record({ event: "passkey.register.options", ok: false, ip, reason: "invite" })
      return fail(400, "invalid_invite", "this invite link is invalid or has expired")
    }
    const challenge = Buffer.from(secret(32), "base64url")
    const flowId = secret()
    if (!ceremonies.put(digest(flowId), { kind: "register", accountId: target.id, inviteHash: invite.hash, challenge, expiresAt: now() + TTL.ceremony })) return fail(503, "busy", "try again shortly")
    return respond({ flowId, publicKey: registrationOptions({ rp, userId: Buffer.from(target.id), userName: target.name, challenge, exclude: target.passkeys.map((key) => key.id) }) })
  }

  async function register(request: Request, ip: string) {
    if (ipLock.locked(ip)) return limited()
    const body = await json(request)
    const flow = typeof body?.flowId === "string" ? ceremonies.take(digest(body.flowId)) : undefined
    if (!flow || flow.kind !== "register") { ipLock.fail(ip); return fail(400, "expired", "this sign-up step expired; start again") }
    const verified = verifyRegistration({ rp, challenge: flow.challenge, response: body?.credential })
    if (!verified.ok) {
      ipLock.fail(ip)
      record({ event: "passkey.register", ok: false, account: flow.accountId, ip, reason: verified.reason })
      return fail(400, "passkey_rejected", "the passkey could not be verified")
    }
    const result = store.update((state) => {
      const index = state.invites.findIndex((invite) => invite.hash === flow.inviteHash && invite.expiresAt > now())
      const target = state.accounts.find((entry) => entry.id === flow.accountId)
      if (index < 0 || !target || target.status === "disabled") return "invite" as const
      if (state.accounts.some((entry) => entry.passkeys.some((key) => key.id === verified.credential.id))) return "duplicate" as const
      if (target.passkeys.length >= 16) return "limit" as const
      state.invites.splice(index, 1)
      target.passkeys.push({ ...verified.credential, createdAt: now() })
      target.status = "active"
      return "ok" as const
    })
    if (result !== "ok") {
      record({ event: "passkey.register", ok: false, account: flow.accountId, ip, reason: result })
      return fail(400, "passkey_rejected", result === "invite" ? "this invite link is invalid or has expired" : "this passkey cannot be added")
    }
    record({ event: "passkey.register", ok: true, account: flow.accountId, ip })
    const cookie = startSession(flow.accountId)
    return cookie ? respond({ ok: true }, 200, { "set-cookie": cookie }) : fail(503, "busy", "try again shortly")
  }

  function loginOptions(ip: string) {
    if (!limits.hit(`login-options:${ip}`, 30, 60_000)) return limited()
    const challenge = Buffer.from(secret(32), "base64url")
    const flowId = secret()
    if (!ceremonies.put(digest(flowId), { kind: "login", challenge, expiresAt: now() + TTL.ceremony })) return fail(503, "busy", "try again shortly")
    return respond({ flowId, publicKey: authenticationOptions({ rp, challenge }) })
  }

  /** Verifies a passkey assertion for an account and stores its new counter; the counter is re-checked under the state lock. */
  function checkPasskey(input: { target: Account; challenge: Buffer; response: unknown }) {
    const credentialId = (input.response as { id?: unknown } | null)?.id
    const key = input.target.passkeys.find((entry) => entry.id === credentialId)
    if (!key) return { ok: false as const, reason: "credential" }
    const verified = verifyAuthentication({ rp, challenge: input.challenge, response: input.response, credential: key, userId: Buffer.from(input.target.id) })
    if (!verified.ok) return verified
    const stored = store.update((state) => {
      const current = state.accounts.find((entry) => entry.id === input.target.id)?.passkeys.find((entry) => entry.id === key.id)
      if (!current || ((verified.counter > 0 || current.counter > 0) && verified.counter <= current.counter)) return false
      current.counter = verified.counter
      current.lastUsedAt = now()
      return true
    })
    return stored ? { ok: true as const } : { ok: false as const, reason: "counter" }
  }

  async function login(request: Request, ip: string) {
    if (ipLock.locked(ip)) return limited()
    const body = await json(request)
    const flow = typeof body?.flowId === "string" ? ceremonies.take(digest(body.flowId)) : undefined
    const refused = () => fail(401, "signin_failed", "sign-in failed")
    if (!flow || flow.kind !== "login") { ipLock.fail(ip); return fail(400, "expired", "this sign-in step expired; start again") }
    const credentialId = (body?.credential as { id?: unknown } | undefined)?.id
    const target = typeof credentialId === "string" ? store.read().accounts.find((entry) => entry.passkeys.some((key) => key.id === credentialId)) : undefined
    if (!target) { ipLock.fail(ip); record({ event: "login", ok: false, ip, reason: "credential" }); return refused() }
    if (accountLock.locked(target.id)) { record({ event: "login", ok: false, account: target.id, ip, reason: "locked" }); return limited() }
    if (target.status !== "active") { ipLock.fail(ip); record({ event: "login", ok: false, account: target.id, ip, reason: target.status }); return refused() }
    const checked = checkPasskey({ target, challenge: flow.challenge, response: body?.credential })
    if (!checked.ok) {
      ipLock.fail(ip)
      accountLock.fail(target.id)
      record({ event: "login", ok: false, account: target.id, ip, reason: checked.reason })
      return refused()
    }
    record({ event: "login", ok: true, account: target.id, ip })
    const cookie = startSession(target.id)
    return cookie ? respond({ ok: true }, 200, { "set-cookie": cookie }) : fail(503, "busy", "try again shortly")
  }

  // ---- Device pairing (device code + passkey approval) and short access tokens -----------------------------------

  async function deviceStart(request: Request, ip: string) {
    if (!limits.hit(`device-start:${ip}`, 10, 3600_000)) return limited()
    const body = await json(request)
    const name = typeof body?.name === "string" ? body.name : ""
    if (!DEVICE_NAME.test(name) || !validDevicePublicKey(body?.publicKey)) return fail(400, "invalid_request", "a device name and an Ed25519 public key are required")
    const pending = deviceFlows.values()
    let userCode = readableCode(8)
    while (pending.some((flow) => flow.userCode === userCode)) userCode = readableCode(8)
    const deviceCode = secret()
    const time = now()
    const key = digest(deviceCode)
    if (!deviceFlows.put(key, { key, userCode, name, publicKey: body!.publicKey as string, ip, createdAt: time, expiresAt: time + TTL.deviceCode, lastPoll: 0, status: "pending" })) return fail(503, "busy", "too many pairings in progress; try again shortly")
    record({ event: "device.start", ok: true, ip, detail: { name } })
    return respond({ deviceCode, userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`, verificationUri: `${config.origin}/_gw/`, expiresIn: TTL.deviceCode / 1000, interval: TTL.devicePoll / 1000 })
  }

  async function devicePoll(request: Request, ip: string) {
    if (!limits.hit(`device-poll:${ip}`, 120, 60_000)) return limited()
    const body = await json(request)
    const key = typeof body?.deviceCode === "string" ? digest(body.deviceCode) : ""
    const flow = key ? deviceFlows.get(key) : undefined
    if (!flow) return fail(400, "expired", "this pairing code expired; run the login again")
    if (now() - flow.lastPoll < TTL.devicePoll) return fail(429, "slow_down", "poll less often")
    flow.lastPoll = now()
    if (flow.status === "pending") return respond({ status: "pending" })
    deviceFlows.delete(key)
    if (flow.status === "denied") return fail(403, "denied", "the pairing was denied")
    return respond({ status: "approved", deviceId: flow.deviceId, scope: flow.scope })
  }

  /** Every pending flow is compared (constant time each), so the time taken says nothing about near misses. */
  function pendingByUserCode(code: string) {
    const typed = normalizeCode(code)
    if (!/^[0-9A-Z]{8}$/.test(typed)) return undefined
    let found: DeviceFlow | undefined
    for (const flow of deviceFlows.values()) if (sameSecret(flow.userCode, typed) && flow.status === "pending") found = flow
    return found
  }

  async function approveOptions(request: Request, ip: string, signedIn: { key: string; session: Session }) {
    if (codeLock.locked(signedIn.key) || ipLock.locked(ip)) return limited()
    const body = await json(request)
    const match = typeof body?.userCode === "string" ? pendingByUserCode(body.userCode) : undefined
    if (!match) {
      codeLock.fail(signedIn.key)
      ipLock.fail(ip)
      record({ event: "device.lookup", ok: false, account: signedIn.session.accountId, ip, reason: "code" })
      return fail(404, "unknown_code", "no pairing is waiting with this code")
    }
    const target = activeAccount(signedIn.session.accountId)!
    const challenge = Buffer.from(secret(32), "base64url")
    const flowId = secret()
    if (!ceremonies.put(digest(flowId), { kind: "approve", accountId: target.id, sessionKey: signedIn.key, deviceKey: match.key, challenge, expiresAt: now() + TTL.ceremony })) return fail(503, "busy", "try again shortly")
    return respond({ flowId, device: { name: match.name, from: match.ip, createdAt: match.createdAt }, publicKey: authenticationOptions({ rp, challenge, allow: target.passkeys.map((key) => key.id) }) })
  }

  async function approve(request: Request, ip: string, signedIn: { key: string; session: Session }) {
    const body = await json(request)
    const flow = typeof body?.flowId === "string" ? ceremonies.take(digest(body.flowId)) : undefined
    if (!flow || flow.kind !== "approve" || flow.sessionKey !== signedIn.key || flow.accountId !== signedIn.session.accountId) return fail(400, "expired", "this approval expired; look the code up again")
    const pending = deviceFlows.get(flow.deviceKey)
    if (!pending || pending.status !== "pending") return fail(400, "expired", "this pairing code expired")
    const target = activeAccount(flow.accountId)
    if (!target || accountLock.locked(target.id)) return limited()
    const checked = checkPasskey({ target, challenge: flow.challenge, response: body?.credential })
    if (!checked.ok) {
      accountLock.fail(target.id)
      record({ event: "device.approve", ok: false, account: target.id, ip, reason: checked.reason })
      return fail(401, "passkey_rejected", "the passkey check failed")
    }
    const scope: Scope = body?.scope === "read-only" ? "read-only" : "full"
    const deviceId = `d${readableCode(10).toLowerCase()}`
    const added = store.update((state) => {
      const current = state.accounts.find((entry) => entry.id === target.id)
      if (!current || current.status !== "active") return false
      const live = current.devices.filter((device) => device.revokedAt === undefined)
      if (live.length >= 32) return false
      // Revoked devices are kept (for the audit trail) only while there is room.
      const room = 31 - live.length
      const revoked = current.devices.filter((device) => device.revokedAt !== undefined)
      current.devices = [...current.devices.filter((device) => device.revokedAt === undefined), ...(room > 0 ? revoked.slice(-room) : [])]
      current.devices.push({ id: deviceId, name: pending.name, publicKey: pending.publicKey, scope, createdAt: now() } satisfies Device)
      return true
    })
    if (!added) return fail(409, "device_limit", "remove a device first")
    pending.status = "approved"
    pending.deviceId = deviceId
    pending.scope = scope
    record({ event: "device.approve", ok: true, account: target.id, device: deviceId, ip, detail: { name: pending.name, scope } })
    return respond({ ok: true, deviceId })
  }

  async function deny(request: Request, ip: string, signedIn: { key: string; session: Session }) {
    if (codeLock.locked(signedIn.key)) return limited()
    const body = await json(request)
    const match = typeof body?.userCode === "string" ? pendingByUserCode(body.userCode) : undefined
    if (!match) { codeLock.fail(signedIn.key); return fail(404, "unknown_code", "no pairing is waiting with this code") }
    match.status = "denied"
    record({ event: "device.deny", ok: true, account: signedIn.session.accountId, ip })
    return respond({ ok: true })
  }

  async function tokenChallenge(request: Request, ip: string) {
    if (!limits.hit(`token-challenge:${ip}`, 60, 60_000)) return limited()
    const body = await json(request)
    const deviceId = typeof body?.deviceId === "string" && DEVICE_ID.test(body.deviceId) ? body.deviceId : undefined
    if (!deviceId) return fail(400, "invalid_request", "deviceId required")
    // Issued for any well-formed id, so the answer never says whether a device exists.
    const challenge = secret()
    if (!challenges.put(digest(challenge), { deviceId, expiresAt: now() + TTL.challenge })) return fail(503, "busy", "try again shortly")
    return respond({ challenge, expiresIn: TTL.challenge / 1000 })
  }

  async function issueToken(request: Request, ip: string) {
    const body = await json(request)
    const deviceId = typeof body?.deviceId === "string" && DEVICE_ID.test(body.deviceId) ? body.deviceId : ""
    if (ipLock.locked(ip) || (deviceId && deviceLock.locked(deviceId))) return limited()
    const challenge = typeof body?.challenge === "string" ? body.challenge : ""
    const issued = challenge ? challenges.take(digest(challenge)) : undefined
    const refuse = (reason: string, target?: string) => {
      ipLock.fail(ip)
      if (deviceId) deviceLock.fail(deviceId)
      record({ event: "token.issue", ok: false, ...(target ? { account: target } : {}), ...(deviceId ? { device: deviceId } : {}), ip, reason })
      return fail(401, "token_refused", "token request refused")
    }
    if (!deviceId || !issued || issued.deviceId !== deviceId) return refuse("challenge")
    const owner = store.read().accounts.find((entry) => entry.devices.some((device) => device.id === deviceId))
    const device = liveDevice(owner, deviceId)
    if (!owner || !device) return refuse("device")
    if (owner.status !== "active") return refuse(owner.status, owner.id)
    if (!verifyDeviceSignature({ publicKey: device.publicKey, text: deviceSignedText({ origin: config.origin, deviceId, challenge }), signature: body?.signature })) return refuse("signature", owner.id)
    const scope: Scope = body?.scope === "read-only" || device.scope === "read-only" ? "read-only" : "full"
    const accessToken = `${ACCESS_TOKEN_PREFIX}${secret()}`
    if (!tokens.put(digest(accessToken), { accountId: owner.id, deviceId, scope, expiresAt: now() + TTL.accessToken })) return fail(503, "busy", "try again shortly")
    if (device.lastUsedAt === undefined || now() - device.lastUsedAt > 60_000) store.update((state) => {
      const current = state.accounts.find((entry) => entry.id === owner.id)?.devices.find((entry) => entry.id === deviceId)
      if (current) current.lastUsedAt = now()
    })
    record({ event: "token.issue", ok: true, account: owner.id, device: deviceId, ip, detail: { scope } })
    return respond({ accessToken, tokenType: "Bearer", expiresIn: TTL.accessToken / 1000, scope })
  }

  function revokeDevice(accountId: string, deviceId: string, ip: string, by: string) {
    const revoked = store.update((state) => {
      const device = state.accounts.find((entry) => entry.id === accountId)?.devices.find((entry) => entry.id === deviceId && entry.revokedAt === undefined)
      if (!device) return false
      device.revokedAt = now()
      return true
    })
    if (!revoked) return fail(404, "unknown_device", "no such device")
    tokens.deleteWhere((token) => token.deviceId === deviceId)
    closeSockets((identity) => identity.kind === "device" && identity.deviceId === deviceId, "device revoked")
    record({ event: "device.revoke", ok: true, account: accountId, device: deviceId, ip, detail: { by } })
    return respond({ ok: true })
  }

  // ---- The gateway's own routes ------------------------------------------------------------------------------------

  async function gatewayRoute(request: Request, url: URL, ip: string) {
    const route = url.pathname.slice("/_gw/".length)
    const method = request.method
    if (route === "" && method === "GET") {
      // The page is static and holds no secret, so a link from a mail or chat site opens it; framing is refused by CSP and X-Frame-Options.
      return new Response(GATEWAY_PAGE, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": GATEWAY_PAGE_CSP } })
    }
    if (!limits.hit(`gw:${ip}`, 300, 60_000)) return limited()
    const devicePaths = new Set(["device/start", "device/poll", "token/challenge", "token"])
    if (devicePaths.has(route)) {
      if (method !== "POST") return fail(405, "method", "POST required")
      // Called by a terminal, not a page: a browser Origin other than ours is refused.
      const origin = request.headers.get("origin")
      if (origin !== null && origin !== config.origin) return fail(403, "forbidden", "cross-site request")
      if (route === "device/start") return deviceStart(request, ip)
      if (route === "device/poll") return devicePoll(request, ip)
      if (route === "token/challenge") return tokenChallenge(request, ip)
      return issueToken(request, ip)
    }
    if (route === "devices/self/revoke" && method === "POST") {
      const identity = bearer(request)
      if (!identity || identity.kind !== "device" || request.headers.get("origin") !== null) return fail(401, "unauthorized", "sign in required")
      return revokeDevice(identity.accountId, identity.deviceId, ip, "device")
    }
    const change = method !== "GET" && method !== "HEAD"
    if (!sameOrigin(request, change)) return fail(403, "forbidden", "cross-site request")
    if (route === "register/options" && method === "POST") return registerOptions(request, ip)
    if (route === "register" && method === "POST") return register(request, ip)
    if (route === "login/options" && method === "POST") return loginOptions(ip)
    if (route === "login" && method === "POST") return login(request, ip)
    const signedIn = session(request)
    if (!signedIn) return fail(401, "unauthorized", "sign in required")
    const me = activeAccount(signedIn.session.accountId)!
    if (route === "me" && method === "GET") return respond({ id: me.id, name: me.name, role: me.role, csrf: signedIn.session.csrf, devices: me.devices.filter((device) => device.revokedAt === undefined).map((device) => ({ id: device.id, name: device.name, scope: device.scope, createdAt: device.createdAt, ...(device.lastUsedAt ? { lastUsedAt: device.lastUsedAt } : {}) })) })
    if (route === "admin/accounts" && method === "GET") {
      if (me.role !== "admin") return fail(403, "forbidden", "admins only")
      return respond({ accounts: store.read().accounts.map((entry) => ({ id: entry.id, name: entry.name, role: entry.role, status: entry.status, createdAt: entry.createdAt, passkeys: entry.passkeys.length, devices: entry.devices.filter((device) => device.revokedAt === undefined).length })) })
    }
    if (!change) return fail(404, "not_found", "unknown route")
    if (!csrfValid(request, signedIn.session)) return fail(403, "csrf", "missing or wrong CSRF token")
    if (route === "logout") {
      sessions.delete(signedIn.key)
      closeSockets((identity) => identity.kind === "session" && identity.key === signedIn.key, "signed out")
      record({ event: "logout", ok: true, account: me.id, ip })
      return respond({ ok: true }, 200, { "set-cookie": clearCookie })
    }
    if (route === "device/approve/options") return approveOptions(request, ip, signedIn)
    if (route === "device/approve") return approve(request, ip, signedIn)
    if (route === "device/deny") return deny(request, ip, signedIn)
    if (route === "devices/revoke") {
      const body = await json(request)
      const deviceId = typeof body?.deviceId === "string" && DEVICE_ID.test(body.deviceId) ? body.deviceId : ""
      return revokeDevice(me.id, deviceId, ip, "web")
    }
    if (route === "admin/account") {
      if (me.role !== "admin") { record({ event: "admin.account", ok: false, account: me.id, ip, reason: "role" }); return fail(403, "forbidden", "admins only") }
      const body = await json(request)
      const accountId = typeof body?.accountId === "string" && ACCOUNT_ID.test(body.accountId) ? body.accountId : ""
      const status = body?.status === "disabled" ? "disabled" : body?.status === "active" ? "active" : undefined
      if (!accountId || !status || accountId === me.id) return fail(400, "invalid_request", "an other account and a status are required")
      const changed = store.update((state) => {
        const target = state.accounts.find((entry) => entry.id === accountId)
        if (!target || target.status === "invited") return false
        target.status = status
        return true
      })
      if (!changed) return fail(404, "unknown_account", "no such account")
      if (status === "disabled") disableAccess(accountId)
      record({ event: "admin.account", ok: true, account: accountId, ip, detail: { status, by: me.id } })
      return respond({ ok: true })
    }
    return fail(404, "not_found", "unknown route")
  }

  function disableAccess(accountId: string) {
    sessions.deleteWhere((entry) => entry.accountId === accountId)
    tokens.deleteWhere((entry) => entry.accountId === accountId)
    closeSockets((identity) => identity.accountId === accountId, "account disabled")
  }

  // ---- Everything else: authenticated, then routed to the caller's own daemon only -----------------------------

  function bearer(request: Request): Identity | undefined {
    const header = request.headers.get("authorization")
    if (!header?.startsWith(`Bearer ${ACCESS_TOKEN_PREFIX}`)) return undefined
    const value = header.slice(7)
    if (value.length > 128) return undefined
    const key = digest(value)
    const token = tokens.get(key)
    if (!token || !liveDevice(activeAccount(token.accountId), token.deviceId)) return undefined
    return { kind: "device", key, accountId: token.accountId, deviceId: token.deviceId, scope: token.scope }
  }

  async function proxyRoute(request: Request, url: URL, ip: string, server?: Bun.Server<SocketData>) {
    const hasAuthorization = request.headers.has("authorization")
    const hasCookie = cookieValue(request) !== undefined
    if (hasAuthorization && hasCookie) return fail(400, "ambiguous", "send a token or a cookie, not both")
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    let identity: Identity | undefined
    let csrf: string | undefined
    if (hasAuthorization) {
      identity = bearer(request)
      if (identity && request.headers.has("origin")) return fail(403, "forbidden", "device tokens are not for browsers")
    } else if (hasCookie) {
      const signedIn = session(request)
      if (signedIn) {
        const change = !["GET", "HEAD"].includes(request.method)
        // A WebSocket handshake always carries Origin from a browser; requiring ours stops cross-site WebSocket hijacking.
        if (!sameOrigin(request, change || upgrade)) return fail(403, "forbidden", "cross-site request")
        if (change && !csrfValid(request, signedIn.session)) return fail(403, "csrf", "missing or wrong CSRF token")
        identity = { kind: "session", key: signedIn.key, accountId: signedIn.session.accountId, scope: "full" }
        csrf = signedIn.session.csrf
      }
    }
    if (!identity) {
      if (!limits.hit(`anon:${ip}`, 120, 60_000)) return limited()
      if (request.method === "GET" && url.pathname === "/" && !hasAuthorization && (request.headers.get("accept") ?? "").includes("text/html")) return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, location: "/_gw/" } })
      return fail(401, "unauthorized", "sign in required")
    }
    if (!limits.hit(`account:${identity.accountId}`, 1200, 60_000)) return limited()
    const target = backend(identity.accountId, identity.scope)
    if (!target) return fail(503, "unavailable", "your MendCode daemon is not running yet")
    if (upgrade) {
      const count = perAccountSockets.get(identity.accountId) ?? 0
      if (count >= 32) return fail(409, "busy", "too many open connections")
      const data: SocketData = { target: `ws+unix://${target.socket}:${url.pathname}${url.search}`, token: target.token, identity, queue: [], queued: 0 }
      if (server?.upgrade(request, { data })) return undefined
      return fail(426, "upgrade_required", "WebSocket required")
    }
    const headers = new Headers()
    for (const name of FORWARD_REQUEST) { const value = request.headers.get(name); if (value !== null) headers.set(name, value) }
    headers.set("authorization", `Bearer ${target.token}`)
    let upstream: Response
    const aborter = new AbortController()
    try {
      upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
        method: request.method, headers, redirect: "manual", signal: AbortSignal.any([request.signal, aborter.signal]),
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
        unix: target.socket,
      } as RequestInit)
    } catch { return fail(502, "unavailable", "your MendCode daemon did not answer") }
    const out: Record<string, string> = { ...SECURITY_HEADERS }
    for (const name of FORWARD_RESPONSE) { const value = upstream.headers.get(name); if (value !== null) out[name] = value }
    // The browser client served through the gateway signs in by cookie: it learns its CSRF token from this tag.
    if (csrf && request.method === "GET" && url.pathname === "/" && out["content-type"]?.startsWith("text/html")) {
      const page = (await upstream.text()).replace("<title>", `<meta name="mendcode-gateway-csrf" content="${csrf}"><title>`)
      out["content-security-policy"] = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${config.origin.replace(/^http/, "ws")}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      return new Response(page, { status: upstream.status, headers: out })
    }
    if (out["content-type"]?.startsWith("text/event-stream") && upstream.body) {
      // An event stream outlives the request that opened it: revoking the device, signing out or disabling the account must end it too.
      const entry = { identity, abort: () => aborter.abort() }
      const finish = () => { streams.delete(entry) }
      streams.add(entry)
      watchAccess()
      request.signal.addEventListener("abort", finish, { once: true })
      aborter.signal.addEventListener("abort", finish, { once: true })
      return new Response(upstream.body.pipeThrough(new TransformStream({ flush: finish })), { status: upstream.status, headers: out })
    }
    return new Response(upstream.body, { status: upstream.status, headers: out })
  }

  const websocket = {
    maxPayloadLength: MAX_BODY_BYTES,
    backpressureLimit: 4 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    open(ws: Bun.ServerWebSocket<SocketData>) {
      sockets.add(ws)
      const accountId = ws.data.identity.accountId
      perAccountSockets.set(accountId, (perAccountSockets.get(accountId) ?? 0) + 1)
      watchAccess()
      const Upstream = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket }
      const upstream = new Upstream(ws.data.target, { headers: { authorization: `Bearer ${ws.data.token}` } })
      upstream.binaryType = "arraybuffer"
      ws.data.upstream = upstream
      upstream.onopen = () => { for (const message of ws.data.queue) upstream.send(message); ws.data.queue = []; ws.data.queued = 0 }
      upstream.onmessage = (event) => { ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)) }
      upstream.onclose = (event) => ws.close(event.code >= 3000 && event.code < 5000 || event.code === 1000 || event.code === 1008 ? event.code : 1011, event.reason.slice(0, 120))
      upstream.onerror = () => ws.close(1011, "daemon unavailable")
    },
    message(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) {
      if (!identityValid(ws.data.identity)) return ws.close(1008, "access revoked")
      const upstream = ws.data.upstream
      const data = typeof message === "string" ? message : new Uint8Array(message)
      if (upstream?.readyState === WebSocket.OPEN) return upstream.send(data)
      ws.data.queued += typeof data === "string" ? data.length : data.byteLength
      if (ws.data.queued > 1024 * 1024) return ws.close(1013, "daemon not ready")
      ws.data.queue.push(data)
    },
    close(ws: Bun.ServerWebSocket<SocketData>) {
      sockets.delete(ws)
      const accountId = ws.data.identity.accountId
      const count = (perAccountSockets.get(accountId) ?? 1) - 1
      if (count > 0) perAccountSockets.set(accountId, count)
      else perAccountSockets.delete(accountId)
      try { ws.data.upstream?.close() } catch {}
    },
  }

  return {
    async fetch(request: Request, server?: Bun.Server<SocketData>) {
      const url = new URL(request.url)
      const ip = clientIp(request, server)
      try {
        if (url.pathname === "/_gw") return new Response(null, { status: 308, headers: { ...SECURITY_HEADERS, location: "/_gw/" } })
        if (url.pathname.startsWith("/_gw/")) return await gatewayRoute(request, url, ip)
        return await proxyRoute(request, url, ip, server)
      } catch {
        return fail(500, "internal", "gateway error")
      }
    },
    websocket,
    sweep,
    /** Ends every open WebSocket (shutdown). */
    close() { for (const ws of sockets) ws.close(1001, "gateway stopped"); for (const stream of streams) stream.abort(); if (sweeper) clearInterval(sweeper); sweeper = undefined },
  }
}
export type Gateway = ReturnType<typeof createGateway>
