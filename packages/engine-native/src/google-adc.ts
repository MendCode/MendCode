import { createHash, createPrivateKey, sign } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { RetryableProviderError } from "./provider"
import { retryAfter } from "./openai-responses"
import type { Fetch } from "./provider-http"

export const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
export const GOOGLE_TOKEN_ENV = "GOOGLE_OAUTH_ACCESS_TOKEN"
type Env = Record<string, string | undefined>
type Credential = Record<string, unknown>
type Token = { token: string; expires: number }
const fail = (message: string) => new Error(`[AUTH]: Vertex ADC ${message}`)
const visible = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7E]{1,16384}$/.test(value)
const string = (value: unknown) => typeof value === "string" && value ? value : undefined

function fileText(file: string) {
  try {
    if (statSync(file).size > 1_048_576) throw new Error()
    return readFileSync(file, "utf8")
  } catch { throw fail("credential file is unreadable or oversized") }
}

function parse(text: string): Credential {
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error()
    return raw
  } catch { throw fail("credential file is invalid") }
}

/** Token endpoints can receive private keys or subject tokens: only Google and local test services. */
function authUrl(value: string, kind: "oauth" | "sts" | "iam") {
  try {
    const url = new URL(value)
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    const google = kind === "oauth" ? ["oauth2.googleapis.com", "accounts.google.com"].includes(url.hostname) : kind === "iam" ? url.hostname === "iamcredentials.googleapis.com" : /^sts(?:\.[a-z0-9-]+\.rep)?\.googleapis\.com$/.test(url.hostname)
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" && (local || google) || url.protocol === "http:" && local)) throw new Error()
    return url.toString()
  } catch { throw fail("token endpoint must be Google HTTPS or loopback") }
}

/** ADC is read-only. Presence checks never read a credential, run gcloud, or contact metadata. */
export function createGoogleAdcCredential(options: { env(): Env; fetch?: Fetch; now?(): number; tokenEnv?: string; allowMetadata?: boolean }) {
  const now = options.now ?? Date.now
  const tokenEnv = options.tokenEnv ?? GOOGLE_TOKEN_ENV
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  let quotaProject: string | undefined
  let cached: (Token & { signature: string }) | undefined
  let pending: { signature: string; promise: Promise<Token>; controller: AbortController; users: number } | undefined
  const file = () => {
    const env = options.env()
    return env.GOOGLE_APPLICATION_CREDENTIALS || (env.CLOUDSDK_CONFIG ? path.join(env.CLOUDSDK_CONFIG, "application_default_credentials.json") : env.HOME ? path.join(env.HOME, ".config", "gcloud", "application_default_credentials.json") : undefined)
  }
  const exists = () => { try { const target = file(); return Boolean(target && statSync(target).isFile()) } catch { return false } }

  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<Credential> {
    let response: Response
    try { response = await doFetch(url, { ...init, redirect: "error", signal }) }
    catch (error) {
      if (signal.aborted) throw signal.reason
      throw new RetryableProviderError("[AUTH]: Vertex ADC token request failed", undefined, "network")
    }
    if (!response.ok) {
      const message = `[AUTH]: Vertex ADC token endpoint returned HTTP ${response.status}`
      if (response.status === 408 || response.status === 429 || response.status >= 500) throw new RetryableProviderError(message, retryAfter(response))
      throw new Error(message)
    }
    // Never echo response bodies, even when their JSON is malformed.
    try {
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const decoder = new TextDecoder()
      let text = "", size = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 1_048_576) throw new Error()
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
        return parse(text)
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch { if (signal.aborted) throw signal.reason; throw fail("returned an invalid token response") }
  }

  const tokenFrom = (raw: Credential): Token => {
    if (!visible(raw.access_token) || typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || raw.token_type !== undefined && String(raw.token_type).toLowerCase() !== "bearer") throw fail("returned an invalid token response")
    return { token: raw.access_token, expires: now() + raw.expires_in * 1000 }
  }
  const post = (url: string, fields: Record<string, string>, signal: AbortSignal) => json(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields).toString() }, signal)
  async function impersonate(url: string, source: Token, signal: AbortSignal): Promise<Token> {
    const raw = await json(authUrl(url, "iam"), { method: "POST", headers: { authorization: `Bearer ${source.token}`, "content-type": "application/json" }, body: JSON.stringify({ scope: [GOOGLE_CLOUD_SCOPE], lifetime: "3600s" }) }, signal)
    const expires = typeof raw.expireTime === "string" ? Date.parse(raw.expireTime) : NaN
    if (!visible(raw.accessToken) || !Number.isFinite(expires) || expires <= now()) throw fail("returned an invalid impersonated token")
    return { token: raw.accessToken, expires }
  }
  async function exchange(raw: Credential | undefined, signal: AbortSignal, depth = 0): Promise<Token> {
    if (depth > 2) throw fail("impersonation nesting exceeded")
    if (!raw) {
      if (!options.allowMetadata) throw fail(`needs ${tokenEnv} or application default credentials; metadata is off`)
      return tokenFrom(await json("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", { method: "GET", headers: { "Metadata-Flavor": "Google" } }, signal))
    }
    if (raw.type === "authorized_user") {
      if (![raw.client_id, raw.client_secret, raw.refresh_token].every(visible)) throw fail("authorized_user credential is incomplete")
      return tokenFrom(await post(authUrl(string(raw.token_uri) ?? "https://oauth2.googleapis.com/token", "oauth"), { grant_type: "refresh_token", client_id: raw.client_id as string, client_secret: raw.client_secret as string, refresh_token: raw.refresh_token as string }, signal))
    }
    if (raw.type === "service_account") {
      const url = authUrl(string(raw.token_uri) ?? "https://oauth2.googleapis.com/token", "oauth")
      if (!visible(raw.client_email) || !string(raw.private_key)) throw fail("service_account credential is incomplete")
      let assertion: string
      try {
        const key = createPrivateKey(raw.private_key as string)
        if (key.asymmetricKeyType !== "rsa") throw new Error()
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
        const iat = Math.floor(now() / 1000)
        const payload = `${encode({ alg: "RS256", typ: "JWT", ...(string(raw.private_key_id) ? { kid: raw.private_key_id } : {}) })}.${encode({ iss: raw.client_email, scope: GOOGLE_CLOUD_SCOPE, aud: url, iat, exp: iat + 3600 })}`
        assertion = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`
      } catch { throw fail("service_account private key is invalid") }
      return tokenFrom(await post(url, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, signal))
    }
    if (raw.type === "external_account") {
      const source = raw.credential_source as Credential | undefined
      if (!source || !string(source.file) || source.executable || source.url || source.environment_id) throw fail("federation requires a local subject-token file; URL, executable and AWS sources are disabled")
      if (!visible(raw.audience) || !visible(raw.subject_token_type) || !string(raw.token_url)) throw fail("federated credential is incomplete")
      const format = source.format as Credential | undefined
      const content = fileText(source.file as string).trim()
      const subject = format?.type === "json" ? parse(content)[String(format.subject_token_field_name)] : !format || format.type === "text" ? content : undefined
      if (!visible(subject)) throw fail("subject token is invalid")
      const result = tokenFrom(await post(authUrl(raw.token_url as string, "sts"), { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", scope: GOOGLE_CLOUD_SCOPE, audience: raw.audience as string, subject_token_type: raw.subject_token_type as string, subject_token: subject }, signal))
      return string(raw.service_account_impersonation_url) ? impersonate(raw.service_account_impersonation_url as string, result, signal) : result
    }
    if (raw.type === "impersonated_service_account" && raw.source_credentials && typeof raw.source_credentials === "object" && string(raw.service_account_impersonation_url)) return impersonate(raw.service_account_impersonation_url as string, await exchange(raw.source_credentials as Credential, signal, depth + 1), signal)
    throw fail("credential type is unsupported")
  }

  return {
    quotaProject: () => options.env().GOOGLE_CLOUD_QUOTA_PROJECT?.trim() || quotaProject,
    ready: () => Boolean(options.env()[tokenEnv]?.trim() || exists() || options.allowMetadata),
    async token(signal: AbortSignal): Promise<string> {
      signal.throwIfAborted()
      const supplied = options.env()[tokenEnv]?.trim()
      if (supplied) { if (!visible(supplied)) throw fail("access token is invalid"); quotaProject = undefined; return supplied }
      const target = file()
      // An explicitly named missing/corrupt file must not fall through to instance credentials.
      const text = target && (exists() || options.env().GOOGLE_APPLICATION_CREDENTIALS) ? fileText(target) : undefined
      const raw = text !== undefined ? parse(text) : undefined
      quotaProject = typeof raw?.quota_project_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.quota_project_id) ? raw.quota_project_id : undefined
      const signature = createHash("sha256").update(text ?? "metadata").digest("hex")
      if (cached?.signature === signature && cached.expires - 60_000 > now()) return cached.token
      if (!pending || pending.signature !== signature || pending.controller.signal.aborted) {
        const controller = new AbortController()
        const entry = { signature, controller, users: 0, promise: Promise.resolve({ token: "", expires: 0 }) }
        entry.promise = exchange(raw, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then((token) => { cached = { ...token, signature }; return token }).finally(() => { if (pending === entry) pending = undefined })
        pending = entry
      }
      const entry = pending
      entry.users++
      let abort: () => void = () => {}
      try {
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort() })
        return (await Promise.race([entry.promise, cancelled])).token
      } finally {
        signal.removeEventListener("abort", abort)
        if (--entry.users === 0 && pending === entry) entry.controller.abort()
      }
    },
  }
}
