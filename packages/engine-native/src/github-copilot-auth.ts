import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderAuthorization, ProviderAuthStatus } from "@mendcode/protocol"
import type { Fetch } from "./provider-http"

export const COPILOT_AUTH_FILE = "github-copilot-auth.json"
export const COPILOT_HEADERS = { "user-agent": "mendcode", "openai-intent": "conversation-edits" }
const tokenText = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value)
type Credential = { access: string; issuer: string; refresh?: string; expiresAt?: number }
type Tokens = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; interval?: unknown }

/** HTTPS services, or an explicitly configured loopback fake. Never follow credential-bearing redirects. */
export function copilotUrl(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("[AUTH]: Copilot endpoint must use HTTPS or loopback HTTP")
  return value.replace(/\/+$/, "")
}

/** Device login is opt-in and daemon-owned; neither codes nor credentials enter status reports. */
export function createCopilotAuth(options: {
  dir: string
  clientId?: string | undefined
  clientSecret?: string | undefined
  issuer?: string | undefined
  fetch?: Fetch
  now?: () => number
  wait?(ms: number, signal: AbortSignal): Promise<void>
  onAuthorized?(): void
}) {
  const issuer = copilotUrl(options.issuer ?? "https://github.com")
  const file = path.join(options.dir, COPILOT_AUTH_FILE)
  const now = options.now ?? Date.now
  const request = options.fetch ?? fetch
  let generation = 0
  let pending: { abort: AbortController; timer: ReturnType<typeof setTimeout> } | undefined
  let state: ProviderAuthStatus["state"] | undefined
  let error: string | undefined
  let refreshing: Promise<void> | undefined
  const listeners = new Set<() => void>()

  function read(): Credential | undefined {
    let raw: string
    try { raw = readFileSync(file, "utf8") } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error("[AUTH]: Copilot credential store unreadable")
    }
    try {
      const value = JSON.parse(raw) as Credential
      if (!Object.keys(value).length) return undefined
      if (!tokenText(value.access) || value.issuer !== issuer || (value.refresh !== undefined && !tokenText(value.refresh)) || (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))) throw new Error()
      return value
    } catch { throw new Error("[AUTH]: invalid Copilot credential store; log in again") }
  }
  function save(value?: Credential) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
    writeFileSync(temp, `${JSON.stringify(value ?? {})}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
  }
  function stop() { if (pending) { clearTimeout(pending.timer); pending.abort.abort(); pending = undefined } }
  function cancel() { generation++; stop(); state = "cancelled"; error = undefined }
  function fail(serial: number, message: string) { if (serial === generation) { stop(); state = "failed"; error = message } }
  function status(): ProviderAuthStatus {
    let value: Credential | undefined
    let problem: string | undefined
    try { value = read() } catch { problem = "Copilot credential store unreadable or invalid" }
    return { provider: "github-copilot", source: value ? "v2" : "none", state: pending ? "pending" : problem ? "failed" : state === "failed" || state === "cancelled" ? state : value ? value.expiresAt !== undefined && value.expiresAt <= now() + 60_000 ? "expired" : "authorized" : "none", accessTokenPresent: Boolean(value), refreshTokenPresent: Boolean(value?.refresh), accountIdPresent: false, ...(value?.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}), ...(problem ?? error ? { error: (problem ?? error)! } : {}) }
  }
  function clientId() {
    if (!tokenText(options.clientId)) throw new Error("[AUTH]: set MENDCODE_GITHUB_COPILOT_CLIENT_ID to enable device login")
    return options.clientId
  }
  function credential(tokens: Tokens, previous?: Credential): Credential {
    if (!tokenText(tokens.access_token) || (tokens.refresh_token !== undefined && !tokenText(tokens.refresh_token))) throw new Error("[AUTH]: invalid Copilot token response")
    const expiry = tokens.expires_in
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000)) throw new Error("[AUTH]: invalid Copilot token expiry")
    const refresh = tokens.refresh_token ?? previous?.refresh
    return { access: tokens.access_token, issuer, ...(tokenText(refresh) ? { refresh } : {}), ...(typeof expiry === "number" ? { expiresAt: now() + expiry * 1000 } : {}) }
  }
  async function post(endpoint: string, body: Record<string, string>, signal: AbortSignal) {
    let response: Response
    try { response = await request(`${issuer}${endpoint}`, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { ...COPILOT_HEADERS, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId(), ...body }) }) }
    catch { throw new Error("[AUTH]: GitHub device request failed or cancelled") }
    if (!response.ok) throw new Error(`[AUTH]: GitHub device request failed (${response.status})`)
    try { return await response.json() as Tokens & Record<string, unknown> } catch { throw new Error("[AUTH]: invalid GitHub device response") }
  }
  const wait = options.wait ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("cancelled")) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }))
  async function authorize(method = "device"): Promise<ProviderAuthorization> {
    clientId()
    if (method !== "device") throw new Error("[AUTH]: choose device")
    if (pending) throw new Error("[AUTH]: a Copilot login is pending; cancel it first")
    const serial = ++generation, abort = new AbortController()
    pending = { abort, timer: setTimeout(() => fail(serial, "GitHub device login timed out"), 300_000) }
    state = "pending"; error = undefined
    try {
      const device = await post("/login/device/code", { scope: "read:user" }, abort.signal)
      if (serial !== generation || abort.signal.aborted) throw new Error("[AUTH]: GitHub device login cancelled")
      const deviceCode = device.device_code
      if (!tokenText(deviceCode) || typeof device.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(device.user_code) || typeof device.verification_uri !== "string") throw new Error("[AUTH]: invalid GitHub device response")
      const url = copilotUrl(device.verification_uri)
      if (new URL(url).origin !== new URL(issuer).origin) throw new Error("[AUTH]: GitHub verification URL must match the issuer")
      const expiry = Number(device.expires_in ?? 900)
      if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("[AUTH]: invalid GitHub device expiry")
      const expiresAt = now() + Math.min(expiry * 1000, 900_000)
      clearTimeout(pending!.timer)
      pending!.timer = setTimeout(() => fail(serial, "GitHub device code expired"), expiresAt - now())
      let interval = Math.max(1, Math.min(60, Number(device.interval) || 5)) * 1000
      void (async () => {
        while (serial === generation && !abort.signal.aborted && now() < expiresAt) {
          await wait(interval + 3000, abort.signal)
          if (serial !== generation || abort.signal.aborted || now() >= expiresAt) return
          const tokens = await post("/login/oauth/access_token", { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, abort.signal)
          if (serial !== generation || abort.signal.aborted) return
          if (tokens.access_token !== undefined) {
            save(credential(tokens)); stop(); state = "authorized"; error = undefined
            options.onAuthorized?.()
            for (const listener of listeners) listener()
            return
          }
          if (tokens.error === "authorization_pending") continue
          if (tokens.error === "slow_down") { interval = Math.max(interval + 5000, Math.min(60_000, (Number(tokens.interval) || 0) * 1000)); continue }
          throw new Error("GitHub authorization denied or expired")
        }
      })().catch(() => fail(serial, "GitHub authorization denied, expired or failed; retry login"))
      return { provider: "github-copilot", method, url, instructions: `Enter code: ${device.user_code}`, expiresAt }
    } catch { fail(serial, "GitHub device login could not start"); throw new Error("[AUTH]: GitHub device login could not start; check configuration and retry") }
  }
  async function refresh() {
    if (refreshing) return refreshing
    const value = read(), serial = generation
    if (!value) throw new Error("[AUTH]: no v2 Copilot login; use /connect github-copilot")
    if (!value.refresh) {
      if (value.expiresAt !== undefined && value.expiresAt <= now() + 60_000) throw new Error("[AUTH]: Copilot token expired; log in again")
      state = "authorized"; error = undefined
      return
    }
    refreshing = (async () => {
      try {
        const tokens = await post("/login/oauth/access_token", { grant_type: "refresh_token", refresh_token: value.refresh!, ...(tokenText(options.clientSecret) ? { client_secret: options.clientSecret } : {}) }, new AbortController().signal)
        if (serial !== generation || tokens.error) throw new Error()
        save(credential(tokens, value)); state = "authorized"; error = undefined
      } catch { throw new Error("[AUTH]: Copilot refresh failed; log in again") }
      finally { refreshing = undefined }
    })()
    return refreshing
  }
  return {
    available: () => tokenText(options.clientId), status, authorize, cancel, refresh,
    onAuthorized(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    stop: cancel,
    /** Imports a token the caller already holds (REST credential import); `expires` is epoch milliseconds, 0 or absent for none. */
    setCredential(input: { access: string; refresh?: string | undefined; expires?: number | undefined }) {
      if (!tokenText(input.access) || (input.refresh !== undefined && !tokenText(input.refresh))) throw new Error("[AUTH]: invalid Copilot credential")
      const expiresAt = input.expires && input.expires > 0 ? input.expires : undefined
      if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new Error("[AUTH]: invalid Copilot credential expiry")
      cancel()
      save({ access: input.access, issuer, ...(input.refresh ? { refresh: input.refresh } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) })
      state = "authorized"; error = undefined
      options.onAuthorized?.()
      for (const listener of listeners) listener()
    },
    logout() { cancel(); save(); state = undefined },
    token() { try { return read()?.access } catch { return undefined } },
    async tokenForRequest() {
      let value = read()
      if (value?.expiresAt !== undefined && value.expiresAt <= now() + 60_000) { await refresh(); value = read() }
      return value?.access
    },
  }
}
export type CopilotAuth = ReturnType<typeof createCopilotAuth>
