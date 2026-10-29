import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createAuthStore, type AuthStore, type StoredAuth, type StoredTokens } from "./auth-store"

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** What `McpAuth.state` says about a remote server's credentials. */
export type McpAuthState = "none" | "pending" | "authorized"

/** The parts of a `WWW-Authenticate: Bearer …` challenge that start the flow. */
export type AuthChallenge = { resourceMetadata?: string; scope?: string; error?: string }

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpAuthError"
  }
}

const DISCOVERY_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_METADATA_BYTES = 1024 * 1024
const EXPIRY_SKEW_MS = 60_000
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000
const CALLBACK_PATH = "/callback"
const CLIENT_NAME = "MendCode"

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** Reads `resource_metadata`, `scope` and `error` out of a Bearer challenge (RFC 6750 / RFC 9728 §5.1). */
export function parseChallenge(header: string | null | undefined): AuthChallenge {
  const challenge: AuthChallenge = {}
  if (!header) return challenge
  for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = (match[1] as string).toLowerCase()
    const value = match[2] ?? match[3] ?? ""
    if (key === "resource_metadata" && value) challenge.resourceMetadata = value
    else if (key === "scope" && value) challenge.scope = value
    else if (key === "error" && value) challenge.error = value
  }
  return challenge
}

/** https anywhere; plain http only for the loopback host (local servers and tests). */
function checkEndpoint({ url, what }: { url: string; what: string }): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new McpAuthError(`${what} is not a valid URL`)
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new McpAuthError(`${what} must use https (${parsed.origin})`)
  return parsed.href
}

// Provider-controlled descriptions and unknown codes may contain credentials.
const oauthError = (value: unknown) => typeof value === "string" && ["invalid_request", "unauthorized_client", "access_denied", "unsupported_response_type", "invalid_scope", "server_error", "temporarily_unavailable", "invalid_client", "invalid_grant", "unsupported_grant_type"].includes(value) ? value : "OAuth request failed"

async function readJson({ response }: { response: Response }): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_METADATA_BYTES) throw new McpAuthError("response too large")
  return JSON.parse(text) as unknown
}

async function getJson({ fetch, url, signal }: { fetch: FetchFn; url: string; signal?: AbortSignal | undefined }): Promise<Json | undefined> {
  try {
    checkEndpoint({ url, what: "metadata URL" })
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), ...(signal ? [signal] : [])]) })
    if (!response.ok) return undefined
    const json = await readJson({ response })
    return isRecord(json) ? json : undefined
  } catch {
    return undefined
  }
}

/** `https://h/mcp` → `https://h/.well-known/<suffix>/mcp` (RFC 8414 §3.1 / RFC 9728 §3.1). */
function wellKnown({ base, suffix }: { base: string; suffix: string }): string {
  const url = new URL(base)
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  return `${url.origin}/.well-known/${suffix}${path}`
}

export type AuthorizationServer = {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  /** `token_endpoint_auth_methods_supported`; absent means the default (client_secret_basic). */
  tokenAuthMethods?: string[]
  scopesFromResource?: string[]
  /** RFC 8707 resource indicator sent to the authorization and token endpoints. */
  resource: string
}

/**
 * Finds the authorization server of a remote MCP server: protected resource metadata (RFC 9728, from the challenge or
 * the well-known URLs), then the server's metadata (RFC 8414, with the OpenID configuration as fallback). A server
 * without resource metadata is treated as its own authorization server, as the older MCP revision did.
 */
export async function discoverAuthorization({
  serverUrl,
  challenge,
  fetch,
  signal,
}: {
  serverUrl: string
  challenge?: AuthChallenge | undefined
  fetch: FetchFn
  signal?: AbortSignal | undefined
}): Promise<AuthorizationServer> {
  const server = new URL(serverUrl)
  const candidates = [challenge?.resourceMetadata, wellKnown({ base: serverUrl, suffix: "oauth-protected-resource" }), `${server.origin}/.well-known/oauth-protected-resource`].filter((url): url is string => !!url)
  let resourceMeta: Json | undefined
  for (const url of [...new Set(candidates)]) {
    resourceMeta = await getJson({ fetch, url, signal })
    if (resourceMeta) break
  }
  const servers = Array.isArray(resourceMeta?.authorization_servers) ? resourceMeta.authorization_servers.filter((value): value is string => typeof value === "string") : []
  const issuer = servers[0] ?? server.origin
  const resource = str(resourceMeta?.resource) ?? authResource(serverUrl)

  const base = new URL(issuer)
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "")
  const metaUrls = [
    wellKnown({ base: issuer, suffix: "oauth-authorization-server" }),
    ...(path ? [`${base.origin}/.well-known/openid-configuration${path}`] : []),
    `${base.origin}${path}/.well-known/openid-configuration`,
  ]
  let meta: Json | undefined
  for (const url of metaUrls) {
    meta = await getJson({ fetch, url, signal })
    if (meta) break
  }
  if (!meta) throw new McpAuthError(`no OAuth authorization server metadata found for ${base.origin}; is this server OAuth-protected?`)
  const metaIssuer = str(meta.issuer)
  if (metaIssuer && metaIssuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) throw new McpAuthError(`authorization server metadata names issuer ${metaIssuer}, expected ${issuer}`)
  const authorizationEndpoint = str(meta.authorization_endpoint)
  const tokenEndpoint = str(meta.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) throw new McpAuthError("authorization server metadata lacks authorization_endpoint or token_endpoint")
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : undefined
  if (methods && !methods.includes("S256")) throw new McpAuthError("the authorization server does not support PKCE S256")
  const registration = str(meta.registration_endpoint)
  const authMethods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.filter((value): value is string => typeof value === "string") : undefined
  const scopes = Array.isArray(resourceMeta?.scopes_supported) ? resourceMeta.scopes_supported.filter((value): value is string => typeof value === "string") : undefined
  return {
    issuer,
    authorizationEndpoint: checkEndpoint({ url: authorizationEndpoint, what: "authorization_endpoint" }),
    tokenEndpoint: checkEndpoint({ url: tokenEndpoint, what: "token_endpoint" }),
    ...(registration ? { registrationEndpoint: checkEndpoint({ url: registration, what: "registration_endpoint" }) } : {}),
    ...(authMethods ? { tokenAuthMethods: authMethods } : {}),
    ...(scopes ? { scopesFromResource: scopes } : {}),
    resource,
  }
}

/** The canonical resource identifier of an MCP server: its URL without fragment and trailing slash. */
function authResource(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.hash = ""
  return url.href.replace(/\/+$/, "")
}

type ClientCredentials = { clientId: string; clientSecret?: string | undefined }

async function registerClient({ server, redirectUri, scope, fetch, signal }: { server: AuthorizationServer; redirectUri: string; scope: string | undefined; fetch: FetchFn; signal?: AbortSignal | undefined }): Promise<ClientCredentials> {
  if (!server.registrationEndpoint) throw new McpAuthError('this authorization server has no dynamic client registration; register a client and set "oauth": { "clientId": "…" } in mcp.json')
  const response = await fetch(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  }).catch(() => {
    throw new McpAuthError("client registration request failed")
  })
  if (!response.ok) throw new McpAuthError(`client registration failed: HTTP ${response.status}; set "oauth": { "clientId": "…" } in mcp.json to use a client registered by hand`)
  const json = await readJson({ response }).catch(() => undefined)
  const clientId = isRecord(json) ? str(json.client_id) : undefined
  if (!clientId) throw new McpAuthError("client registration returned no client_id")
  return { clientId, clientSecret: isRecord(json) ? str(json.client_secret) : undefined }
}

type Method = StoredAuth["authMethod"]

function chooseMethod({ secret, supported }: { secret: string | undefined; supported: string[] | undefined }): Method {
  if (!secret) return "none"
  // RFC 8414: without the list, the default is client_secret_basic.
  return !supported || supported.includes("client_secret_basic") ? "basic" : "post"
}

/** One token endpoint call (RFC 6749 §4.1.3 / §6); errors carry the server's error code, never a secret. */
async function tokenRequest({
  fetch,
  endpoint,
  params,
  client,
  method,
  now,
  signal,
}: {
  fetch: FetchFn
  endpoint: string
  params: Record<string, string | undefined>
  client: ClientCredentials
  method: Method
  now: number
  signal?: AbortSignal | undefined
}): Promise<{ ok: true; tokens: StoredTokens } | { ok: false; status: number; error: string; invalidGrant: boolean }> {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form.set(key, value)
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
  if (method === "basic" && client.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`
  else {
    form.set("client_id", client.clientId)
    if (method === "post" && client.clientSecret) form.set("client_secret", client.clientSecret)
  }
  let response: Response
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]) })
  } catch {
    return { ok: false, status: 0, error: "token endpoint request failed", invalidGrant: false }
  }
  const json = await readJson({ response }).catch(() => undefined)
  if (!response.ok || !isRecord(json) || json.error !== undefined) {
    const code = isRecord(json) ? str(json.error) : undefined
    const error = code ? oauthError(code) : `HTTP ${response.status}`
    return { ok: false, status: response.status, error, invalidGrant: code === "invalid_grant" }
  }
  const accessToken = str(json.access_token)
  if (!accessToken) return { ok: false, status: response.status, error: "the token response has no access_token", invalidGrant: false }
  const tokenType = str(json.token_type) ?? "Bearer"
  if (tokenType.toLowerCase() !== "bearer") return { ok: false, status: response.status, error: "unsupported token_type", invalidGrant: false }
  const lifetime = Number(json.expires_in)
  const tokens: StoredTokens = { accessToken, tokenType: "Bearer" }
  const refreshToken = str(json.refresh_token)
  if (refreshToken) tokens.refreshToken = refreshToken
  if (Number.isFinite(lifetime) && lifetime > 0) tokens.expiresAt = now + lifetime * 1000
  const scope = str(json.scope)
  if (scope) tokens.scope = scope
  return { ok: true, tokens }
}

const pkceVerifier = () => randomBytes(32).toString("base64url")
const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p>`

export type AuthCallback = { redirectUri: string; done: Promise<string>; close(): void; complete(code: string): void }

/** A one-shot HTTP listener on 127.0.0.1 and a random port that waits for the authorization redirect (RFC 8252 §7.3). */
async function openLoopback({ state, timeoutMs, signal, callbackPort, redirectUri }: { state: string; timeoutMs: number; signal?: AbortSignal | undefined; callbackPort?: number | undefined; redirectUri?: string | undefined }): Promise<AuthCallback> {
  const redirect = redirectUri ? new URL(redirectUri) : undefined
  if (redirect && (!["http:", "https:"].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash)) throw new McpAuthError("OAuth callback must be an HTTP(S) URL without credentials or fragment")
  const listenPort = redirect ? Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80)) : callbackPort ?? 0
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new McpAuthError("invalid OAuth callback port")
  const callbackPath = redirect?.pathname ?? (callbackPort ? "/mcp/oauth/callback" : CALLBACK_PATH)
  let settle!: { resolve(code: string): void; reject(error: Error): void }
  const done = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
  done.catch(() => undefined)
  let server: Server | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const finish = (action: () => void) => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    action()
    setTimeout(() => {
      server?.closeAllConnections?.()
      server?.close()
    }, 50)
  }
  server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store")
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== callbackPath) {
      response.writeHead(404).end()
      return
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return }
    if (finished) { response.writeHead(409).end(); return }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization failed", "The state parameter does not match. Start the authorization again from MendCode."))
      return
    }
    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    if (error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization denied", "Return to MendCode and start the authorization again."))
      finish(() => settle.reject(new McpAuthError(`authorization denied: ${oauthError(error)}`)))
      return
    }
    if (!code || code.length > 4096) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization failed", "The redirect carried no authorization code."))
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE("MendCode is authorized", "You can close this tab and return to MendCode."))
    finish(() => settle.resolve(code))
  })
  await new Promise<void>((resolve, reject) => {
    server?.once("error", () => reject(new McpAuthError("OAuth callback port unavailable")))
    server?.listen(listenPort, redirect?.hostname === "[::1]" ? "::1" : "127.0.0.1", () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  timer = setTimeout(() => finish(() => settle.reject(new McpAuthError(`authorization timed out after ${Math.round(timeoutMs / 1000)} s`))), timeoutMs)
  const onAbort = () => finish(() => settle.reject(new McpAuthError("authorization cancelled")))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  return { redirectUri: redirectUri ?? `http://127.0.0.1:${port}${callbackPath}`, done, close: () => finish(() => settle.reject(new McpAuthError("authorization cancelled"))), complete(code) {
    if (finished || !code || code.length > 4096) throw new McpAuthError("no pending authorization or invalid code")
    finish(() => settle.resolve(code))
  } }
}

export type StartAuthInput = {
  serverName: string
  serverUrl: string
  /** The last 401 challenge the server sent, if a client saw one. */
  challenge?: AuthChallenge | undefined
  /** `oauth` of the server's config. */
  oauth?: { clientId?: string | undefined; clientSecret?: string | undefined; scope?: string | undefined; callbackPort?: number | undefined; redirectUri?: string | undefined } | undefined
  signal?: AbortSignal | undefined
}

export interface McpAuth {
  complete?(serverUrl: string, code: string): Promise<void>
  inspect?(serverUrl: string): Promise<{ accessToken: boolean; refreshToken: boolean; client: boolean; expiresAt?: number }>
  /** A valid access token for the server (refreshed when it expires within a minute), or undefined when there is none. */
  accessToken(serverUrl: string): Promise<string | undefined>
  /** After a 401 with a stored token: one refresh. True when a new token is stored. A rejected refresh token is dropped. */
  refresh(serverUrl: string): Promise<boolean>
  /** "authorized" when tokens are stored (and usable or refreshable), "pending" while a flow waits, otherwise "none". */
  state(serverUrl: string): Promise<McpAuthState>
  /**
   * Starts the authorization-code flow with PKCE. Resolves as soon as the URL is ready: open `url` in a browser.
   * `completion` resolves when the loopback redirect arrived and the tokens are stored, and rejects on denial,
   * timeout or cancel. One flow per server; starting another cancels the first.
   */
  start(input: StartAuthInput): Promise<{ url: string; completion: Promise<void> }>
  /** Cancels a waiting flow. */
  cancel(serverUrl: string): void
  /** Removes the server's stored client and tokens. */
  forget(serverUrl: string): Promise<void>
}

export function createMcpAuth({
  dir,
  store = createAuthStore({ dir }),
  fetch = globalThis.fetch as FetchFn,
  now = Date.now,
  callbackTimeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  startCallback = openLoopback,
}: {
  dir: string
  store?: AuthStore
  fetch?: FetchFn
  now?: () => number
  callbackTimeoutMs?: number
  startCallback?: typeof openLoopback
}): McpAuth {
  const refreshing = new Map<string, Promise<boolean>>()
  const flows = new Map<string, { cancel(): void; complete(code: string): void; completion: Promise<void> }>()
  const keyOf = (serverUrl: string) => new URL(serverUrl).href.replace(/#.*$/, "")

  async function refreshNow(serverUrl: string): Promise<boolean> {
    const entry = await store.get(serverUrl)
    const refreshToken = entry?.tokens?.refreshToken
    if (!entry || !refreshToken) return false
    const result = await tokenRequest({
      fetch,
      endpoint: entry.tokenEndpoint,
      params: { grant_type: "refresh_token", refresh_token: refreshToken, ...(entry.resource ? { resource: entry.resource } : {}) },
      client: { clientId: entry.clientId, clientSecret: entry.clientSecret },
      method: entry.authMethod,
      now: now(),
    })
    if (!result.ok) {
      // A refresh token the server rejects is dead; a network error may pass, so the tokens stay.
      if (result.invalidGrant) {
        const { tokens: _dropped, ...withoutTokens } = entry
        await store.set(serverUrl, withoutTokens)
      }
      return false
    }
    await store.set(serverUrl, { ...entry, tokens: { ...result.tokens, refreshToken: result.tokens.refreshToken ?? refreshToken } })
    return true
  }

  const refresh = (serverUrl: string): Promise<boolean> => {
    const key = keyOf(serverUrl)
    let running = refreshing.get(key)
    if (!running) {
      running = refreshNow(serverUrl).finally(() => refreshing.delete(key))
      refreshing.set(key, running)
    }
    return running
  }

  return {
    async inspect(serverUrl) {
      const entry = await store.get(serverUrl)
      return { accessToken: Boolean(entry?.tokens), refreshToken: Boolean(entry?.tokens?.refreshToken), client: Boolean(entry?.clientId), ...(entry?.tokens?.expiresAt === undefined ? {} : { expiresAt: entry.tokens.expiresAt }) }
    },
    async accessToken(serverUrl) {
      const tokens = (await store.get(serverUrl))?.tokens
      if (!tokens) return undefined
      if (tokens.expiresAt !== undefined && tokens.expiresAt - now() < EXPIRY_SKEW_MS) {
        if (!tokens.refreshToken || !(await refresh(serverUrl))) return undefined
        return (await store.get(serverUrl))?.tokens?.accessToken
      }
      return tokens.accessToken
    },

    refresh,

    async state(serverUrl) {
      if (flows.has(keyOf(serverUrl))) return "pending"
      const tokens = (await store.get(serverUrl))?.tokens
      if (!tokens) return "none"
      const expired = tokens.expiresAt !== undefined && tokens.expiresAt - now() < EXPIRY_SKEW_MS
      return expired && !tokens.refreshToken ? "none" : "authorized"
    },

    async start({ serverUrl, challenge, oauth, signal }) {
      const key = keyOf(serverUrl)
      flows.get(key)?.cancel()
      flows.delete(key)
      const server = await discoverAuthorization({ serverUrl, challenge, fetch, signal })
      const scope = oauth?.scope ?? challenge?.scope ?? (server.scopesFromResource?.length ? server.scopesFromResource.join(" ") : undefined)
      const state = randomBytes(16).toString("base64url")
      const verifier = pkceVerifier()
      const loopback = await startCallback({ state, timeoutMs: callbackTimeoutMs, signal, callbackPort: oauth?.callbackPort, redirectUri: oauth?.redirectUri })
      let client: ClientCredentials
      let url: string
      try {
        client = oauth?.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : await registerClient({ server, redirectUri: loopback.redirectUri, scope, fetch, signal })
        const authorize = new URL(server.authorizationEndpoint)
        authorize.searchParams.set("response_type", "code")
        authorize.searchParams.set("client_id", client.clientId)
        authorize.searchParams.set("redirect_uri", loopback.redirectUri)
        authorize.searchParams.set("code_challenge", pkceChallenge(verifier))
        authorize.searchParams.set("code_challenge_method", "S256")
        authorize.searchParams.set("state", state)
        authorize.searchParams.set("resource", server.resource)
        if (scope) authorize.searchParams.set("scope", scope)
        url = authorize.href
      } catch (error) {
        loopback.close()
        throw error
      }
      const flow = { cancel: () => loopback.close(), complete: loopback.complete, completion: Promise.resolve() }
      flows.set(key, flow)
      const method = chooseMethod({ secret: client.clientSecret, supported: server.tokenAuthMethods })
      const completion = (async () => {
        try {
          const code = await loopback.done
          const result = await tokenRequest({
            fetch,
            endpoint: server.tokenEndpoint,
            params: { grant_type: "authorization_code", code, redirect_uri: loopback.redirectUri, code_verifier: verifier, resource: server.resource },
            client,
            method,
            now: now(),
          })
          if (!result.ok) throw new McpAuthError(`token exchange failed: ${result.error}`)
          if (flows.get(key) !== flow) throw new McpAuthError("authorization replaced or cancelled")
          await store.set(serverUrl, {
            issuer: server.issuer,
            clientId: client.clientId,
            ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
            tokenEndpoint: server.tokenEndpoint,
            authMethod: method,
            resource: server.resource,
            tokens: result.tokens,
          })
        } finally {
          if (flows.get(key) === flow) flows.delete(key)
          loopback.close()
        }
      })()
      completion.catch(() => undefined)
      flow.completion = completion
      return { url, completion }
    },

    async complete(serverUrl, code) {
      const flow = flows.get(keyOf(serverUrl))
      if (!flow) throw new McpAuthError("no pending authorization")
      flow.complete(code)
      await flow.completion
    },

    cancel(serverUrl) {
      const key = keyOf(serverUrl)
      flows.get(key)?.cancel()
      flows.delete(key)
    },

    async forget(serverUrl) {
      const key = keyOf(serverUrl)
      flows.get(key)?.cancel()
      flows.delete(key)
      await store.set(serverUrl, undefined)
    },
  }
}
