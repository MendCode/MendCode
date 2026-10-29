import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderAuthorization, ProviderAuthStatus } from "@mendcode/protocol"
import type { Fetch } from "./provider-http"

export const CHATGPT_AUTH_FILE = "chatgpt-auth.json"
type Credential = { access: string; refresh: string; account: string; expiresAt: number }
type Tokens = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown }
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

/** Own credentials only. Codex's auth file is never copied, refreshed or written here. */
export function createChatgptAuth(options: {
  dir: string
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
  const now = options.now ?? Date.now
  const request = options.fetch ?? fetch
  const issuer = (options.issuer ?? "https://auth.openai.com").replace(/\/+$/, "")
  const parsedIssuer = new URL(issuer)
  if (parsedIssuer.username || parsedIssuer.password || parsedIssuer.search || parsedIssuer.hash || (parsedIssuer.protocol !== "https:" && !(parsedIssuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedIssuer.hostname)))) throw new Error("OAuth issuer must use HTTPS or loopback HTTP")
  let pending: Pending | undefined
  let generation = 0
  let state: ProviderAuthStatus["state"] | undefined
  let error: string | undefined
  let refreshing: Promise<void> | undefined

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
      return value as Credential
    } catch { throw new Error("[AUTH]: invalid v2 credential store; log in again") }
  }
  function save(credential: Credential | undefined) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
    writeFileSync(temp, `${JSON.stringify(credential ?? {})}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
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
    if (!options.clientId || !tokenText(options.clientId)) throw new Error("[AUTH]: set MENDCODE_OPENAI_OAUTH_CLIENT_ID to enable ChatGPT login")
    return options.clientId
  }
  function credentialOf(tokens: Tokens, previous?: Credential): Credential {
    const account = accountOf(tokens) ?? previous?.account
    const refresh = tokens.refresh_token ?? previous?.refresh
    if (!tokenText(tokens.access_token) || !tokenText(refresh) || !account) throw new Error("[AUTH]: OAuth response has no usable ChatGPT credentials")
    const expiry = tokens.expires_in ?? 3600
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000) throw new Error("[AUTH]: invalid OAuth token expiry")
    return { access: tokens.access_token, refresh, account, expiresAt: now() + expiry * 1000 }
  }
  async function post(endpoint: string, body: URLSearchParams | Record<string, string>, signal: AbortSignal) {
    const form = body instanceof URLSearchParams
    let response: Response
    try {
      response = await request(`${issuer}${endpoint}`, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? body.toString() : JSON.stringify(body) })
    } catch { throw new Error("[AUTH]: OAuth request failed or cancelled") }
    return response
  }
  async function exchange(body: Record<string, string>, signal: AbortSignal): Promise<Tokens> {
    const response = await post("/oauth/token", new URLSearchParams({ client_id: clientId(), ...body }), signal)
    if (!response.ok) throw new Error(`[AUTH]: OAuth token exchange failed (${response.status})`)
    try { return await response.json() as Tokens } catch { throw new Error("[AUTH]: invalid OAuth token response") }
  }
  function completed(tokens: Tokens, serial: number) {
    if (serial !== generation || !pending || pending.abort.signal.aborted) return
    save(credentialOf(tokens))
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

  async function authorize(method: string): Promise<ProviderAuthorization> {
    clientId()
    if (!["browser", "headless"].includes(method)) throw new Error("[AUTH]: choose browser or headless")
    if (pending) throw new Error("[AUTH]: a ChatGPT login is already pending; cancel it first")
    const serial = ++generation
    const abort = new AbortController()
    const expiresAt = now() + (options.timeoutMs ?? 300_000)
    pending = { generation: serial, abort, expiresAt, timer: setTimeout(() => failed(serial, "OAuth authorization timed out"), options.timeoutMs ?? 300_000) }
    state = "pending"; error = undefined
    try {
      if (method === "browser") {
        const verifier = randomBytes(32).toString("base64url")
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        const stateToken = randomBytes(32).toString("base64url")
        let exchanging = false
        let redirectUri = ""
        const callback: Callback = async (incoming) => {
          const url = new URL(incoming.url)
          const response = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } })
          if (incoming.method !== "GET" || url.pathname !== "/auth/callback") return response("Not found", 404)
          if (serial !== generation || !pending || exchanging) return response("No pending login", 409)
          if (url.searchParams.get("state") !== stateToken) return response("Invalid OAuth state", 400)
          if (url.searchParams.has("error")) { failed(serial, "Authorization denied; retry login"); return response("Authorization denied", 400) }
          const code = url.searchParams.get("code")
          if (!code || code.length > 4096) return response("Missing or invalid authorization code", 400)
          exchanging = true
          try {
            completed(await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, abort.signal), serial)
            return response(serial === generation && state === "authorized" ? "MendCode connected. Return to the terminal." : "Login cancelled")
          } catch { failed(serial); return response("Authorization failed. Return to MendCode and retry.", 400) }
        }
        const listener = options.startCallback ? options.startCallback(callback) : (() => {
          const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 1455, fetch: callback })
          return { redirectUri: `http://localhost:${server.port}/auth/callback`, close: () => server.stop() }
        })()
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
            completed(await exchange({ grant_type: "authorization_code", code: code.authorization_code, code_verifier: code.code_verifier, redirect_uri: `${issuer}/deviceauth/callback` }, abort.signal), serial)
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
  async function refresh() {
    if (refreshing) return refreshing
    const serial = generation
    const credential = read()
    if (!credential) throw new Error("[AUTH]: no v2 ChatGPT login; use /connect chatgpt")
    refreshing = (async () => {
      try {
        const tokens = await exchange({ grant_type: "refresh_token", refresh_token: credential.refresh }, new AbortController().signal)
        if (serial !== generation) throw new Error("[AUTH]: login changed during refresh")
        save(credentialOf(tokens, credential)); state = "authorized"; error = undefined
      } catch { throw new Error("[AUTH]: ChatGPT refresh failed; log in again") }
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
    available: () => tokenText(options.clientId),
    logout() { cancel(); save(undefined); state = undefined },
    stop: cancel,
    async headers(): Promise<Record<string, string>> {
      let credential = read()
      if (!credential) throw new Error("[AUTH]: no v2 ChatGPT login; use /connect chatgpt")
      if (credential.expiresAt <= now() + 60_000) { await refresh(); credential = read() }
      if (!credential) throw new Error("[AUTH]: ChatGPT login removed")
      return { authorization: `Bearer ${credential.access}`, "chatgpt-account-id": credential.account, originator: "mendcode" }
    },
  }
}
export type ChatgptAuth = ReturnType<typeof createChatgptAuth>
