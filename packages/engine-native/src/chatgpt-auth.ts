import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKeyInput } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderAuthorization, ProviderAuthStatus } from "@mendcode/protocol"
import type { Fetch } from "./provider-http"

export const CHATGPT_AUTH_FILE = "chatgpt-auth.json"
/** This installation's agent host id and the client OpenAI issued it at the first sign-in; neither is a credential. */
export const CHATGPT_HOST_FILE = "chatgpt-host.json"
/**
 * Sign in with ChatGPT for open-source clients (developers.openai.com/siwc/token-sharing-open-source): the first sign-in registers
 * a client of the user's own (`dynamic_agent_client` is only the entry point) and its token is spent on `https://api.openai.com/v1`
 * against the user's ChatGPT plan. No client id is shipped or configured.
 */
export const CHATGPT_PLAN_BASE_URL = "https://api.openai.com/v1"
const REGISTRATION_CLIENT = "dynamic_agent_client"
const AGENT_NAME = "MendCode"
const PLAN_SCOPE = "chatgpt.tokens.use.direct"
const PLAN_SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
/** How long a login stays open: Codex's device code lifetime; a first sign-in also picks an account and workspace and gives consent. */
const LOGIN_WINDOW_MS = 900_000
const PLAN_DECLINED ="ChatGPT plan use was not allowed; sign in again and allow it, or connect OpenAI with an API key"
/** Refresh codes that mean the token set is dead (siwc errors-and-recovery#refresh-errors); anything else keeps it for a later try. */
const DEAD_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])
/** `plan`: Sign in with ChatGPT, requests go to api.openai.com. `codex`: a configured Codex-style client, requests go to the subscription backend. */
export type ChatgptRoute = "plan" | "codex"
type Credential = { access: string; refresh: string; account: string; expiresAt: number; route?: "plan"; clientId?: string; idToken?: string; scopes?: string[] }
type Host = { hostId: string; clientId?: string }
/** One entry of the issuer's published key set (`/.well-known/jwks.json`). */
export type JsonWebKey = { kty?: string; kid?: string; n?: string; e?: string; [field: string]: unknown }
type Tokens = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown }
type Callback = (request: Request) => Promise<Response>
type Pending = { generation: number; abort: AbortController; expiresAt: number; close?(): void; complete?(code: string): Promise<void>; timer: ReturnType<typeof setTimeout> }

function claims(token: unknown): Record<string, unknown> {
  try { return typeof token === "string" ? JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) : {} } catch { return {} }
}
function accountOf(tokens: Tokens) {
  for (const token of [tokens.id_token, tokens.access_token]) {
    const value = claims(token)
    const auth = value["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined
    const organizations = value.organizations as { id?: unknown }[] | undefined
    const account = value.chatgpt_account_id ?? auth?.chatgpt_account_id ?? organizations?.[0]?.id
    if (typeof account === "string" && /^[\x21-\x7e]{1,200}$/.test(account)) return account
  }
  return undefined
}
const tokenText = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value)
const scopesOf = (value: unknown) => typeof value === "string" ? value.split(/\s+/).filter(Boolean) : undefined
const reason = (cause: unknown, fallback: string) => cause instanceof Error && cause.message.startsWith("[AUTH]: ") ? cause.message.slice(8) : fallback

/**
 * Checks an OpenID ID token against the issuer's published keys (RS256): issuer, audience (the issued client), expiry and the nonce of
 * this attempt. Returns its subject, the account identity.
 */
export async function verifyChatgptIdToken(input: { token: unknown; issuer: string; audience: string; nonce: string; keys(): Promise<JsonWebKey[]>; now: number }) {
  const invalid = () => new Error("[AUTH]: ChatGPT sign-in returned an invalid ID token; sign in again")
  if (typeof input.token !== "string") throw invalid()
  const [head, body, signature] = input.token.split(".")
  if (!head || !body || !signature) throw invalid()
  let header: { alg?: unknown; kid?: unknown }, payload: Record<string, unknown>
  try { header = JSON.parse(Buffer.from(head, "base64url").toString()); payload = JSON.parse(Buffer.from(body, "base64url").toString()) } catch { throw invalid() }
  if (header.alg !== "RS256") throw invalid()
  const keys = (await input.keys()).filter((key) => key.kty === "RSA" && (header.kid === undefined || key.kid === header.kid))
  const signed = Buffer.from(`${head}.${body}`)
  const valid = keys.some((key) => { try { return verify("RSA-SHA256", signed, createPublicKey({ key: key as JsonWebKeyInput["key"], format: "jwk" }), Buffer.from(signature, "base64url")) } catch { return false } })
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!valid || payload.iss !== input.issuer || !audience.includes(input.audience) || typeof payload.exp !== "number" || payload.exp * 1000 <= input.now || payload.nonce !== input.nonce) throw invalid()
  if (!tokenText(payload.sub)) throw invalid()
  return { subject: payload.sub }
}

/** Own credentials only. Codex's auth file is never copied, refreshed or written here. */
export function createChatgptAuth(options: {
  dir: string
  /** A Codex-style OAuth client (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`): browser and device code against the subscription backend. Unset: Sign in with ChatGPT. */
  clientId?: string | undefined
  issuer?: string | undefined
  port?: number
  fetch?: Fetch
  now?: () => number
  timeoutMs?: number
  startCallback?(callback: Callback): { redirectUri: string; close(): void }
  wait?(ms: number, signal: AbortSignal): Promise<void>
}) {
  const file = path.join(options.dir, CHATGPT_AUTH_FILE)
  const hostFile = path.join(options.dir, CHATGPT_HOST_FILE)
  const now = options.now ?? Date.now
  const request = options.fetch ?? fetch
  const issuer = (options.issuer ?? "https://auth.openai.com").replace(/\/+$/, "")
  const parsedIssuer = new URL(issuer)
  if (parsedIssuer.username || parsedIssuer.password || parsedIssuer.search || parsedIssuer.hash || (parsedIssuer.protocol !== "https:" && !(parsedIssuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedIssuer.hostname)))) throw new Error("OAuth issuer must use HTTPS or loopback HTTP")
  const configured = tokenText(options.clientId) ? options.clientId : undefined
  let pending: Pending | undefined
  let generation = 0
  let state: ProviderAuthStatus["state"] | undefined
  let error: string | undefined
  let refreshing: Promise<void> | undefined
  let jwks: JsonWebKey[] | undefined

  function read(): Credential | undefined {
    let raw: string
    try { raw = readFileSync(file, "utf8") } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error("[AUTH]: v2 credential store unreadable")
    }
    try {
      const value = JSON.parse(raw) as Partial<Credential>
      if (!Object.keys(value).length) return undefined
      if (!tokenText(value.access) || !tokenText(value.refresh) || !tokenText(value.account) || !Number.isFinite(value.expiresAt)) throw new Error()
      if (value.route !== undefined && (value.route !== "plan" || !tokenText(value.clientId))) throw new Error()
      return value as Credential
    } catch { throw new Error("[AUTH]: invalid v2 credential store; log in again") }
  }
  function write(target: string, value: unknown) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, target)
  }
  const save = (credential: Credential | undefined) => write(file, credential ?? {})
  /** The host id is chosen once, before the first sign-in, and kept for the life of this data dir; a logout keeps it and the issued client. */
  function host(): Host {
    try {
      const value = JSON.parse(readFileSync(hostFile, "utf8")) as Partial<Host>
      if (typeof value.hostId === "string" && /^urn:uuid:[0-9a-f-]{36}$/.test(value.hostId)) return { hostId: value.hostId, ...(tokenText(value.clientId) ? { clientId: value.clientId } : {}) }
    } catch {}
    const created = { hostId: `urn:uuid:${randomUUID()}` }
    write(hostFile, created)
    return created
  }
  function stop() {
    if (!pending) return
    const old = pending
    pending = undefined
    clearTimeout(old.timer)
    old.abort.abort()
    old.close?.()
  }
  function cancel() { generation++; stop(); state = "cancelled"; error = undefined }
  function status(): ProviderAuthStatus {
    let credential: Credential | undefined
    let problem: string | undefined
    try { credential = read() } catch { problem = "v2 credential store unreadable or invalid" }
    return {
      provider: "chatgpt", source: credential ? "v2" : "none",
      state: pending ? "pending" : problem ? "failed" : state === "failed" || state === "cancelled" ? state : credential ? credential.expiresAt <= now() + 60_000 ? "expired" : "authorized" : "none",
      accessTokenPresent: Boolean(credential), refreshTokenPresent: Boolean(credential), accountIdPresent: Boolean(credential),
      ...(credential ? { expiresAt: credential.expiresAt } : {}),
      ...(problem ?? error ? { error: (problem ?? error)! } : {}),
    }
  }
  function clientId() {
    if (!configured) throw new Error("[AUTH]: set MENDCODE_OPENAI_OAUTH_CLIENT_ID to enable ChatGPT device code login")
    return configured
  }
  function expiryOf(tokens: Tokens) {
    const expiry = tokens.expires_in ?? 3600
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000) throw new Error("[AUTH]: invalid OAuth token expiry")
    return now() + expiry * 1000
  }
  function credentialOf(tokens: Tokens, previous?: Credential): Credential {
    const account = accountOf(tokens) ?? previous?.account
    const refresh = tokens.refresh_token ?? previous?.refresh
    if (!tokenText(tokens.access_token) || !tokenText(refresh) || !account) throw new Error("[AUTH]: OAuth response has no usable ChatGPT credentials")
    return { access: tokens.access_token, refresh, account, expiresAt: expiryOf(tokens) }
  }
  /** A plan credential: the account is the ID token's verified subject, kept with the client it was issued to. */
  function planCredentialOf(tokens: Tokens, plan: { clientId: string; subject: string; idToken?: string; scopes?: string[] }): Credential {
    const scopes = scopesOf(tokens.scope) ?? plan.scopes ?? []
    if (!tokenText(tokens.access_token) || !tokenText(tokens.refresh_token)) throw new Error("[AUTH]: OAuth response has no usable ChatGPT credentials")
    const idToken = tokenText(tokens.id_token) ? tokens.id_token : plan.idToken
    return { route: "plan", access: tokens.access_token, refresh: tokens.refresh_token, account: plan.subject, expiresAt: expiryOf(tokens), clientId: plan.clientId, ...(idToken ? { idToken } : {}), scopes }
  }
  async function post(endpoint: string, body: URLSearchParams | Record<string, string>, signal: AbortSignal) {
    const form = body instanceof URLSearchParams
    let response: Response
    try {
      response = await request(`${issuer}${endpoint}`, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" }, body: form ? body.toString() : JSON.stringify(body) })
    } catch { throw new Error("[AUTH]: OAuth request failed or cancelled") }
    return response
  }
  async function tokensOf(response: Response): Promise<Tokens> {
    if (!response.ok) throw new Error(`[AUTH]: OAuth token exchange failed (${response.status})`)
    try { return await response.json() as Tokens } catch { throw new Error("[AUTH]: invalid OAuth token response") }
  }
  const exchange = async (body: Record<string, string>, signal: AbortSignal) => tokensOf(await post("/oauth/token", new URLSearchParams({ client_id: clientId(), ...body }), signal))
  /** The token endpoint's error code, never its message: the body may echo credential material. */
  async function errorCode(response: Response) {
    try {
      const body = await response.json() as { error?: unknown; code?: unknown }
      const code = typeof body.error === "string" ? body.error : typeof body.error === "object" && body.error !== null ? (body.error as { code?: unknown }).code : body.code
      return typeof code === "string" ? code : undefined
    } catch { return undefined }
  }
  async function publishedKeys(signal: AbortSignal) {
    if (jwks) return jwks
    let response: Response
    try { response = await request(`${issuer}/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }) } catch { throw new Error("[AUTH]: could not read ChatGPT's signing keys; retry login") }
    const body = response.ok ? await response.json().catch(() => undefined) as { keys?: unknown } | undefined : undefined
    if (!Array.isArray(body?.keys)) throw new Error("[AUTH]: could not read ChatGPT's signing keys; retry login")
    return jwks = body.keys as JsonWebKey[]
  }
  function completed(credential: Credential, serial: number) {
    if (serial !== generation || !pending || pending.abort.signal.aborted) return
    save(credential)
    stop(); state = "authorized"; error = undefined
  }
  function failed(serial: number, message = "OAuth authorization failed; retry login") {
    if (serial !== generation) return
    stop(); state = "failed"; error = message
  }
  const wait = options.wait ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("cancelled")) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }))
  const reply = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } })
  /** The loopback listener: `host` 127.0.0.1 for Sign in with ChatGPT (`localhost` is not accepted there), any free port when the default is taken. */
  function listen(callback: Callback, hostname: "localhost" | "127.0.0.1") {
    if (options.startCallback) return options.startCallback(callback)
    const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch: callback })
    let server: ReturnType<typeof serve>
    try { server = serve(options.port ?? 1455) } catch { server = serve(0) }
    return { redirectUri: `http://${hostname}:${server.port}/auth/callback`, close: () => server.stop(true) }
  }

  /** Sign in with ChatGPT: browser, loopback callback, issued client, verified ID token, plan scope granted. */
  function authorizePlan(serial: number, abort: AbortController, expiresAt: number): ProviderAuthorization {
    const registration = host()
    const saved = registration.clientId
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const stateToken = randomBytes(32).toString("base64url")
    const nonce = randomBytes(32).toString("base64url")
    let exchanging = false
    let redirectUri = ""
    const callback: Callback = async (incoming) => {
      const url = new URL(incoming.url)
      if (incoming.method !== "GET" || url.pathname !== "/auth/callback") return reply("Not found", 404)
      if (serial !== generation || !pending || exchanging) return reply("No pending login", 409)
      if (url.searchParams.get("state") !== stateToken) return reply("Invalid OAuth state", 400)
      if (url.searchParams.has("error")) {
        const declined = url.searchParams.get("error") === "access_denied"
        failed(serial, declined ? PLAN_DECLINED : "Authorization denied; retry login")
        return reply(declined ? "ChatGPT plan use was not allowed. Return to MendCode." : "Authorization denied", 400)
      }
      const code = url.searchParams.get("code")
      if (!code || code.length > 4096) return reply("Missing or invalid authorization code", 400)
      // A new registration names its issued client; a returning sign-in may omit it, and a different one is never taken over the saved one.
      const returned = url.searchParams.get("client_id") ?? undefined
      if (saved && returned && returned !== saved) { failed(serial, "ChatGPT returned a different client than this installation's; sign in again"); return reply("Unexpected client. Return to MendCode and retry.", 400) }
      const issued = saved ?? returned
      if (!tokenText(issued) || issued === REGISTRATION_CLIENT) { failed(serial, "ChatGPT sign-in did not finish registering MendCode; sign in again"); return reply("Registration incomplete. Return to MendCode and retry.", 400) }
      exchanging = true
      try {
        const tokens = await tokensOf(await post("/api/accounts/oauth/token", new URLSearchParams({ grant_type: "authorization_code", client_id: issued, code, code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_PLAN_BASE_URL }), abort.signal))
        const { subject } = await verifyChatgptIdToken({ token: tokens.id_token, issuer, audience: issued, nonce, keys: () => publishedKeys(abort.signal), now: now() })
        if (serial !== generation || !pending) return reply("Login cancelled")
        if (!saved) write(hostFile, { ...registration, clientId: issued })
        const credential = planCredentialOf(tokens, { clientId: issued, subject })
        if (!credential.scopes?.includes(PLAN_SCOPE)) { failed(serial, PLAN_DECLINED); return reply("ChatGPT plan use was not allowed. Return to MendCode.", 400) }
        completed(credential, serial)
        return reply(state === "authorized" ? "MendCode connected. Return to the terminal." : "Login cancelled")
      } catch (cause) { failed(serial, reason(cause, "OAuth authorization failed; retry login")); return reply("Authorization failed. Return to MendCode and retry.", 400) }
    }
    const listener = listen(callback, "127.0.0.1")
    redirectUri = listener.redirectUri
    const redirect = new URL(redirectUri)
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") { listener.close(); throw new Error("[AUTH]: callback must be loopback") }
    pending!.close = listener.close
    const params = new URLSearchParams({
      client_id: saved ?? REGISTRATION_CLIENT,
      ...(saved ? {} : { agent_name_hint: AGENT_NAME }),
      ext_agent_host_id: registration.hostId,
      response_type: "code", redirect_uri: redirectUri, scope: PLAN_SCOPES, resource: CHATGPT_PLAN_BASE_URL,
      state: stateToken, nonce, code_challenge_method: "S256", code_challenge: challenge,
    })
    return { provider: "chatgpt", method: "browser", url: `${issuer}/api/accounts/authorize?${params}`, instructions: "Sign in with ChatGPT in your browser and allow MendCode to use your ChatGPT plan", expiresAt }
  }

  async function authorize(method: string): Promise<ProviderAuthorization> {
    if (!["browser", "headless"].includes(method)) throw new Error("[AUTH]: choose browser or headless")
    if (method === "headless" && !configured) throw new Error("[AUTH]: Sign in with ChatGPT has no device code; use the browser method (open the link on this machine)")
    if (pending) throw new Error("[AUTH]: a ChatGPT login is already pending; cancel it first")
    const serial = ++generation
    const abort = new AbortController()
    const expiresAt = now() + (options.timeoutMs ?? LOGIN_WINDOW_MS)
    pending = { generation: serial, abort, expiresAt, timer: setTimeout(() => failed(serial, "OAuth authorization timed out"), options.timeoutMs ?? LOGIN_WINDOW_MS) }
    state = "pending"; error = undefined
    try {
      if (!configured) return authorizePlan(serial, abort, expiresAt)
      if (method === "browser") {
        const verifier = randomBytes(32).toString("base64url")
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        const stateToken = randomBytes(32).toString("base64url")
        let exchanging = false
        let redirectUri = ""
        const callback: Callback = async (incoming) => {
          const url = new URL(incoming.url)
          if (incoming.method !== "GET" || url.pathname !== "/auth/callback") return reply("Not found", 404)
          if (serial !== generation || !pending || exchanging) return reply("No pending login", 409)
          if (url.searchParams.get("state") !== stateToken) return reply("Invalid OAuth state", 400)
          if (url.searchParams.has("error")) { failed(serial, "Authorization denied; retry login"); return reply("Authorization denied", 400) }
          const code = url.searchParams.get("code")
          if (!code || code.length > 4096) return reply("Missing or invalid authorization code", 400)
          exchanging = true
          try {
            completed(credentialOf(await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, abort.signal)), serial)
            return reply(serial === generation && state === "authorized" ? "MendCode connected. Return to the terminal." : "Login cancelled")
          } catch { failed(serial); return reply("Authorization failed. Return to MendCode and retry.", 400) }
        }
        const listener = listen(callback, "localhost")
        redirectUri = listener.redirectUri
        const redirect = new URL(redirectUri)
        if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) { listener.close(); throw new Error("[AUTH]: callback must be loopback") }
        pending!.close = listener.close
        pending!.complete = async (code) => {
          const url = new URL(redirectUri)
          url.searchParams.set("state", stateToken)
          url.searchParams.set("code", code)
          const response = await callback(new Request(url))
          if (!response.ok || status().state !== "authorized") throw new Error("[AUTH]: OAuth callback failed")
        }
        const params = new URLSearchParams({ response_type: "code", client_id: clientId(), redirect_uri: redirectUri, scope: "openid profile email offline_access", code_challenge: challenge, code_challenge_method: "S256", state: stateToken, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "mendcode" })
        return { provider: "chatgpt", method, url: `${issuer}/oauth/authorize?${params}`, instructions: "Complete authorization in your browser", expiresAt }
      }
      const response = await post("/api/accounts/deviceauth/usercode", { client_id: clientId() }, abort.signal)
      if (!response.ok) throw new Error(`[AUTH]: device authorization failed (${response.status})`)
      const device = await response.json() as { device_auth_id?: unknown; user_code?: unknown; interval?: unknown }
      if (!tokenText(device.device_auth_id) || typeof device.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(device.user_code)) throw new Error("[AUTH]: invalid device authorization response")
      const deviceId = device.device_auth_id, userCode = device.user_code
      const interval = Math.max(1000, Math.min(60_000, (Number(device.interval) || 5) * 1000)) + 3000
      void (async () => {
        while (serial === generation && !abort.signal.aborted && now() < expiresAt) {
          await wait(interval, abort.signal)
          const poll = await post("/api/accounts/deviceauth/token", { device_auth_id: deviceId, user_code: userCode }, abort.signal)
          if (poll.ok) {
            const code = await poll.json() as { authorization_code?: unknown; code_verifier?: unknown }
            if (!tokenText(code.authorization_code) || !tokenText(code.code_verifier)) throw new Error("invalid device code")
            completed(credentialOf(await exchange({ grant_type: "authorization_code", code: code.authorization_code, code_verifier: code.code_verifier, redirect_uri: `${issuer}/deviceauth/callback` }, abort.signal)), serial)
            return
          }
          if (![403, 404, 429].includes(poll.status)) throw new Error("device authorization refused")
        }
      })().catch(() => failed(serial))
      return { provider: "chatgpt", method, url: `${issuer}/codex/device`, instructions: `Enter code: ${userCode}`, expiresAt }
    } catch (cause) {
      failed(serial)
      throw new Error(cause instanceof Error && cause.message.startsWith("[AUTH]:") ? cause.message : "[AUTH]: OAuth authorization could not start")
    }
  }
  /** Plan credentials: a dead refresh token clears the set (sign in again); a network or server failure keeps it for the next try. */
  async function refreshPlan(credential: Credential) {
    const response = await post("/api/accounts/oauth/token", new URLSearchParams({ grant_type: "refresh_token", client_id: credential.clientId!, refresh_token: credential.refresh, resource: CHATGPT_PLAN_BASE_URL }), new AbortController().signal)
    if (!response.ok) {
      const code = await errorCode(response)
      if (response.status === 401 || (code && DEAD_REFRESH.has(code))) {
        save(undefined); state = "failed"; error = "ChatGPT sign-in expired; sign in again with /connect chatgpt"
        throw new Error("[AUTH]: ChatGPT sign-in expired; sign in again with /connect chatgpt")
      }
      throw new Error(`[AUTH]: ChatGPT refresh failed (${response.status}); retrying later`)
    }
    return planCredentialOf(await tokensOf(response), { clientId: credential.clientId!, subject: credential.account, ...(credential.idToken ? { idToken: credential.idToken } : {}), ...(credential.scopes ? { scopes: credential.scopes } : {}) })
  }
  async function refresh() {
    if (refreshing) return refreshing
    const serial = generation
    const credential = read()
    if (!credential) throw new Error("[AUTH]: no v2 ChatGPT login; use /connect chatgpt")
    refreshing = (async () => {
      try {
        const next = credential.route === "plan" ? await refreshPlan(credential) : credentialOf(await exchange({ grant_type: "refresh_token", refresh_token: credential.refresh }, new AbortController().signal), credential)
        if (serial !== generation) throw new Error("[AUTH]: login changed during refresh")
        save(next); state = "authorized"; error = undefined
      } catch (cause) { throw new Error(credential.route === "plan" ? `[AUTH]: ${reason(cause, "ChatGPT refresh failed; retrying later")}` : "[AUTH]: ChatGPT refresh failed; log in again") }
      finally { refreshing = undefined }
    })()
    return refreshing
  }
  return {
    status, authorize, refresh, cancel,
    async complete(code: string) {
      if (!pending?.complete) throw new Error("[AUTH]: no pending browser authorization")
      await pending.complete(code)
    },
    setCredential(input: { access: string; refresh: string; expires: number; accountId?: string | undefined }) {
      const account = input.accountId ?? accountOf({ access_token: input.access })
      if (!tokenText(input.access) || !tokenText(input.refresh) || !tokenText(account) || !Number.isFinite(input.expires) || input.expires < 0) throw new Error("[AUTH]: invalid ChatGPT credential")
      cancel()
      save({ access: input.access, refresh: input.refresh, account, expiresAt: input.expires })
      state = "authorized"; error = undefined
    },
    /** Browser sign-in needs nothing configured; device code only exists for a configured Codex-style client. */
    available: (method = "browser") => method === "browser" || Boolean(configured),
    /** Where the saved login's requests go, without reading a token; undefined without one. */
    route(): ChatgptRoute | undefined {
      try { const credential = read(); return credential ? credential.route ?? "codex" : undefined } catch { return undefined }
    },
    /** The verified account of a Sign in with ChatGPT login (an opaque subject, not a token); undefined for any other. */
    planAccount(): string | undefined {
      try { const credential = read(); return credential?.route === "plan" ? credential.account : undefined } catch { return undefined }
    },
    logout() { cancel(); save(undefined); state = undefined },
    stop: cancel,
    async headers(): Promise<Record<string, string>> {
      let credential = read()
      if (!credential) throw new Error("[AUTH]: no v2 ChatGPT login; use /connect chatgpt")
      if (credential.expiresAt <= now() + 60_000) { await refresh(); credential = read() }
      if (!credential) throw new Error("[AUTH]: ChatGPT login removed")
      if (credential.route === "plan") return { authorization: `Bearer ${credential.access}` }
      return { authorization: `Bearer ${credential.access}`, "chatgpt-account-id": credential.account, originator: "mendcode" }
    },
  }
}
export type ChatgptAuth = ReturnType<typeof createChatgptAuth>
