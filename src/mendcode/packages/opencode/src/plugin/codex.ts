import type { Hooks, PluginInput } from "@mendcode/plugin"
import * as Log from "@mendcode/core/util/log"
import { Installation } from "../installation"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { OAUTH_DUMMY_KEY } from "../auth"
import os from "os"
import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "http"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const CODEX_COMPATIBILITY_VERSION = "0.144.0"
const CODEX_ORIGINATOR = "codex_cli_rs"
const CODEX_USER_AGENT = `codex_cli_rs/0.0.0 (MendCode; ${os.platform()} ${os.release()}; ${os.arch()})`
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"
const RESPONSES_LITE_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-6-astra",
])

const CODEX_CHATGPT_MODEL_ALIASES: Record<string, string> = {
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.3-codex": "gpt-5.5",
}

const CODEX_CHATGPT_5_6_LIMIT = {
  context: 256_000,
  input: 256_000,
  output: 128_000,
}

const CODEX_CHATGPT_6_ASTRA_LIMIT = {
  context: 1_050_000,
  input: 922_000,
  output: 128_000,
}

const CODEX_CHATGPT_FAST_MODE_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
])

const CODEX_CHATGPT_PRO_MODE_MODELS = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
])

export function normalizeCodexChatGPTModel(modelID: string) {
  const fastBase = modelID.endsWith("-fast") ? modelID.slice(0, -"-fast".length) : undefined
  const proBase = modelID.endsWith("-pro") ? modelID.slice(0, -"-pro".length) : undefined
  const mode =
    fastBase && CODEX_CHATGPT_FAST_MODE_MODELS.has(fastBase)
    ? "fast"
    : proBase && CODEX_CHATGPT_PRO_MODE_MODELS.has(proBase)
      ? "pro"
      : undefined
  const base = mode === "fast" ? fastBase! : mode === "pro" ? proBase! : modelID
  return {
    modelID: CODEX_CHATGPT_MODEL_ALIASES[base] ?? base,
    mode,
  }
}

export function isCodexChatGPTModelSupported(modelID: string) {
  const normalized = normalizeCodexChatGPTModel(modelID).modelID
  if (ALLOWED_MODELS.has(normalized)) return true
  const match = normalized.match(/^gpt-(\d+\.\d+)/)
  return match ? parseFloat(match[1]) > 5.4 : false
}

function codexChatGPTLimit(modelID: string) {
  const normalized = normalizeCodexChatGPTModel(modelID).modelID
  if (normalized === "gpt-6-astra") return CODEX_CHATGPT_6_ASTRA_LIMIT
  if (normalized.startsWith("gpt-5.6")) return CODEX_CHATGPT_5_6_LIMIT
  return undefined
}

export function normalizeCodexChatGPTRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body
  const request = parsed as Record<string, unknown>
  if (typeof request.model !== "string") return body
  const normalized = normalizeCodexChatGPTModel(request.model)
  const reasoning =
    normalized.mode === "pro"
      ? {
          ...(typeof request.reasoning === "object" && request.reasoning !== null ? request.reasoning : {}),
          mode: "pro",
        }
      : request.reasoning
  if (normalized.modelID === request.model && !normalized.mode) return body
  return JSON.stringify({
    ...request,
    model: normalized.modelID,
    ...(normalized.mode === "fast" ? { service_tier: "priority" } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
  })
}

function prepareResponsesLiteRequest(input: {
  body: BodyInit | null | undefined
  headers: Headers
  sessionIDs: Map<string, string>
  sessionPromptFingerprints: Map<string, string>
}) {
  const body = normalizeCodexChatGPTRequestBody(input.body)
  if (typeof body !== "string") return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(parsed) || typeof parsed.model !== "string" || !RESPONSES_LITE_MODELS.has(parsed.model)) return body
  if (!Array.isArray(parsed.input)) throw new Error("Responses Lite requires an input array")
  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new Error("Responses Lite requires a tools array")
  }
  if (parsed.instructions !== undefined && typeof parsed.instructions !== "string") {
    throw new Error("Responses Lite requires string instructions")
  }

  const sourceSessionID = input.headers.get("session-id") ?? input.headers.get("session_id")
  if (sourceSessionID && typeof parsed.instructions === "string") {
    const fingerprint = Bun.hash(parsed.instructions).toString()
    if (input.sessionPromptFingerprints.get(sourceSessionID) !== fingerprint) {
      input.sessionIDs.delete(sourceSessionID)
      input.sessionPromptFingerprints.set(sourceSessionID, fingerprint)
    }
  }
  const sessionID = (sourceSessionID ? input.sessionIDs.get(sourceSessionID) : undefined) ?? Bun.randomUUIDv7()
  if (sourceSessionID) input.sessionIDs.set(sourceSessionID, sessionID)
  parsed.input = [
    { type: "additional_tools", role: "developer", tools: parsed.tools ?? [] },
    ...(parsed.instructions
      ? [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: parsed.instructions }],
          },
        ]
      : []),
    ...parsed.input,
  ]
  delete parsed.tools
  delete parsed.instructions
  parsed.tool_choice = "auto"
  parsed.parallel_tool_calls = false
  parsed.prompt_cache_key = sessionID
  parsed.reasoning = {
    ...(isRecord(parsed.reasoning) ? parsed.reasoning : {}),
    context: "all_turns",
  }
  stripImageDetail(parsed.input)

  input.headers.delete("content-length")
  input.headers.delete("session_id")
  input.headers.set("session-id", sessionID)
  input.headers.set("x-session-affinity", sessionID)
  input.headers.set("version", CODEX_COMPATIBILITY_VERSION)
  input.headers.set(RESPONSES_LITE_HEADER, "true")
  return JSON.stringify(parsed)
}

export function prepareCodexChatGPTOAuthRequest(input: {
  body: BodyInit | null | undefined
  headers: Headers
  sessionIDs?: Map<string, string>
  sessionPromptFingerprints?: Map<string, string>
  responsesLite?: boolean
}) {
  input.headers.set("originator", CODEX_ORIGINATOR)
  input.headers.set("User-Agent", CODEX_USER_AGENT)
  input.headers.set("Origin", "https://chatgpt.com")
  if (input.responsesLite === false) return normalizeCodexChatGPTRequestBody(input.body)
  const sessionIDs = input.sessionIDs ?? new Map<string, string>()
  const sessionPromptFingerprints = input.sessionPromptFingerprints ?? new Map<string, string>()
  return prepareResponsesLiteRequest({
    body: input.body,
    headers: input.headers,
    sessionIDs,
    sessionPromptFingerprints,
  })
}

function stripImageDetail(input: unknown): void {
  if (Array.isArray(input)) {
    input.forEach(stripImageDetail)
    return
  }
  if (!isRecord(input)) return
  if (input.type === "input_image") delete input.detail
  Object.values(input).forEach(stripImageDetail)
}

function invalidCodexChatGPTRequestResponse(_error: unknown) {
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "invalid_request",
        message: "Invalid Codex request",
      },
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  )
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil((length * 3) / 4)))
  return base64UrlEncode(bytes.buffer).slice(0, length)
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export interface CodexAuthPluginOptions {
  codexApiEndpoint?: string
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

export interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

export async function refreshCodexAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>MendCode - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to MendCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = () => `<!doctype html>
<html>
  <head>
    <title>MendCode - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">Authorization could not be completed safely. Return to MendCode and try again.</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR())
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR())
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR())
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => {
      log.info("codex oauth server started", { port: OAUTH_PORT })
      resolve()
    })
    oauthServer!.on("error", reject)
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {
      log.info("codex oauth server stopped")
    })
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  const codexSessionIDs = new Map<string, string>()
  const codexSessionPromptFingerprints = new Map<string, string>()
  return {
    async event(input) {
      if (input.event.type !== "session.deleted") return
      codexSessionIDs.delete(input.event.properties.info.id)
      codexSessionPromptFingerprints.delete(input.event.properties.info.id)
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              return isCodexChatGPTModelSupported(model.api.id)
            })
            .map(([modelID, model]) => {
              const modelOptions = isRecord(model.options) ? model.options : {}
              const limit = codexChatGPTLimit(model.api.id)
              const usesCompactionThreshold = limit !== undefined
              return [
                modelID,
                {
                  ...model,
                  cost: {
                    input: 0,
                    output: 0,
                    cache: { read: 0, write: 0 },
                  },
                  limit: limit
                    ? limit
                    : model.id.includes("gpt-5.5")
                      ? {
                          context: 400_000,
                          input: 272_000,
                          output: 128_000,
                        }
                      : model.limit,
                  options: usesCompactionThreshold
                    ? {
                        ...modelOptions,
                        compaction: {
                          ...(isRecord(modelOptions.compaction) ? modelOptions.compaction : {}),
                          threshold: 90,
                        },
                      }
                    : model.options,
                },
              ]
            }),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const request = new Request(requestInput, init)
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(request)

            // Cast to include accountId field
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            // Check if token needs refresh
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              log.info("refreshing codex access token")
              const tokens = await refreshCodexAccessToken(currentAuth.refresh)
              const newAccountId = extractAccountId(tokens) || authWithAccount.accountId
              await input.client.auth.set({
                path: { id: "openai" },
                body: {
                  type: "oauth",
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  ...(newAccountId && { accountId: newAccountId }),
                },
              })
              currentAuth.access = tokens.access_token
              authWithAccount.accountId = newAccountId
            }

            const headers = new Headers(request.headers)
            headers.delete("authorization")
            headers.set("authorization", `Bearer ${currentAuth.access}`)

            // Set ChatGPT-Account-Id header for organization subscriptions
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }
            // Rewrite URL to Codex endpoint
            const parsed = new URL(request.url)
            const rewrites = parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
            if (!rewrites) return fetch(request, { headers })
            const url = new URL(codexApiEndpoint)
            const requestBody = request.body ? await request.text() : undefined

            const body = (() => {
              try {
                return prepareCodexChatGPTOAuthRequest({
                  body: requestBody,
                  headers,
                  sessionIDs: codexSessionIDs,
                  sessionPromptFingerprints: codexSessionPromptFingerprints,
                  responsesLite: parsed.pathname.includes("/v1/responses"),
                })
              } catch (error) {
                return invalidCodexChatGPTRequestResponse(error)
              }
            })()
            if (body instanceof Response) return body
            return fetch(url, {
              method: request.method,
              headers,
              body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
              redirect: request.redirect,
              signal: request.signal,
            })
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
