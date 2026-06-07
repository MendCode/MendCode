import { createServer } from "http"
import { chmod, mkdir, writeFile } from "fs/promises"
import { spawnSync } from "child_process"
import path from "path"
import { mendPaths } from "../config/paths"
import { providerLoginPlan } from "./readiness"

const MEND_VERSION = "0.2.0-phase2"
const OPENAI_OAUTH_PORT = 1455
const OPENAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000

function base64UrlEncode(buffer: Buffer | Uint8Array) {
  return Buffer.from(buffer).toString("base64url")
}

function openaiOAuthClientID() {
  const value = process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID || process.env.OPENAI_OAUTH_CLIENT_ID
  if (!value) throw new Error("MENDCODE_OPENAI_OAUTH_CLIENT_ID is required for ChatGPT subscription OAuth. Do not hardcode OAuth app ids.")
  return value
}

function openaiOAuthIssuer() {
  return process.env.MENDCODE_OPENAI_OAUTH_ISSUER || process.env.OPENAI_OAUTH_ISSUER || "https://auth.openai.com"
}

function randomBase64Url(bytes = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256Base64Url(text: string) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return base64UrlEncode(new Uint8Array(digest))
}

async function openaiPkce() {
  const verifier = randomBase64Url(32)
  const challenge = await sha256Base64Url(verifier)
  return { verifier, challenge }
}

function openaiAuthorizeUrl(redirectUri: string, pkce: { challenge: string }, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: openaiOAuthClientID(),
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "mendcode",
  })
  return `${openaiOAuthIssuer()}/oauth/authorize?${params.toString()}`
}

async function exchangeOpenAIAuthCode(code: string, redirectUri: string, verifier: string) {
  const response = await fetch(`${openaiOAuthIssuer()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: openaiOAuthClientID(),
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`OpenAI OAuth token exchange failed: ${response.status}`)
  return response.json()
}

function parseJwtClaims(token: string) {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return null
  }
}

function extractOpenAIAccountId(tokens: any) {
  const claims = parseJwtClaims(tokens.id_token) || parseJwtClaims(tokens.access_token) || {}
  return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.organizations?.[0]?.id || null
}

async function writePrivateJson(file: string, data: any) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

function redactedAuthSummary(state: any, root: string) {
  if (!state) return null
  return {
    providerID: state.providerID,
    type: state.type,
    accountIdPresent: Boolean(state.accountId),
    accessTokenPresent: Boolean(state.access),
    refreshTokenPresent: Boolean(state.refresh),
    expires: state.expires || null,
    expired: typeof state.expires === "number" ? state.expires < Date.now() : null,
    source: state.source || null,
    path: path.relative(root, path.join(root, ".mendcode", "auth", "openai.json")),
  }
}

function openBrowser(url: string) {
  const result = spawnSync("open", [url], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`Unable to open browser:\n${result.stderr || result.stdout}`)
}

async function openaiBrowserOAuth({ open = false } = {}) {
  const redirectUri = `http://localhost:${OPENAI_OAUTH_PORT}/auth/callback`
  const pkce = await openaiPkce()
  const state = randomBase64Url(32)
  const authUrl = openaiAuthorizeUrl(redirectUri, pkce, state)
  let server: ReturnType<typeof createServer> | undefined
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server?.close()
      reject(new Error("OAuth callback timeout"))
    }, OPENAI_OAUTH_TIMEOUT_MS)
    server = createServer((req, res) => {
      const url = new URL(req.url || "/", redirectUri)
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404)
        res.end("Not found")
        return
      }
      const error = url.searchParams.get("error")
      if (error) {
        clearTimeout(timeout)
        server?.close()
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("MendCode authorization failed. You can close this window.")
        reject(new Error(url.searchParams.get("error_description") || error))
        return
      }
      if (url.searchParams.get("state") !== state) {
        clearTimeout(timeout)
        server?.close()
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Invalid OAuth state. You can close this window.")
        reject(new Error("Invalid OAuth state"))
        return
      }
      const callbackCode = url.searchParams.get("code")
      if (!callbackCode) {
        clearTimeout(timeout)
        server?.close()
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Missing OAuth code. You can close this window.")
        reject(new Error("Missing OAuth code"))
        return
      }
      clearTimeout(timeout)
      server?.close()
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("MendCode authorization complete. You can close this window.")
      resolve(callbackCode)
    })
    server.listen(OPENAI_OAUTH_PORT, () => {
      console.error(`Open this URL to authorize MendCode:\n${authUrl}\n`)
      console.error(`Waiting for authorization callback on http://localhost:${OPENAI_OAUTH_PORT}/auth/callback ...`)
      if (open) openBrowser(authUrl)
    })
    server.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  return exchangeOpenAIAuthCode(code, redirectUri, pkce.verifier)
}

async function openaiHeadlessOAuth() {
  const issuer = openaiOAuthIssuer()
  const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `mendcode/${MEND_VERSION}` },
    body: JSON.stringify({ client_id: openaiOAuthClientID() }),
  })
  if (!response.ok) throw new Error(`Failed to initiate OpenAI device authorization: ${response.status}`)
  const data = await response.json()
  const interval = Math.max(parseInt(data.interval, 10) || 5, 1) * 1000
  console.error(`Open ${issuer}/codex/device and enter code: ${data.user_code}`)
  const deadline = Date.now() + OPENAI_OAUTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    const poll = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `mendcode/${MEND_VERSION}` },
      body: JSON.stringify({ device_auth_id: data.device_auth_id, user_code: data.user_code }),
    })
    if (poll.ok) {
      const authorized = await poll.json()
      const token = await fetch(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorized.authorization_code,
          redirect_uri: `${issuer}/deviceauth/callback`,
          client_id: openaiOAuthClientID(),
          code_verifier: authorized.code_verifier,
        }).toString(),
      })
      if (!token.ok) throw new Error(`OpenAI device token exchange failed: ${token.status}`)
      return token.json()
    }
    if (poll.status !== 403 && poll.status !== 404) throw new Error(`OpenAI device authorization failed: ${poll.status}`)
    await new Promise((resolve) => setTimeout(resolve, interval + 3000))
  }
  throw new Error("OpenAI device authorization timeout")
}

export async function providerLogin(providerID: string, method?: string | null, options: { execute?: boolean; open?: boolean } = {}, root?: string) {
  const paths = mendPaths(root)
  const execute = options.execute === true
  const open = options.open === true
  if (providerID !== "openai") throw new Error("Only OpenAI subscription OAuth login is implemented. Usage: mend auth login openai --method browser|headless --execute [--open]")
  const resolvedMethod = method || "browser"
  if (!["browser", "headless"].includes(resolvedMethod)) throw new Error("Usage: mend auth login openai --method browser|headless --execute [--open]")
  if (!execute) {
    return {
      ...providerLoginPlan(providerID, resolvedMethod),
      status: "blocked-missing-execute",
      executesNow: false,
      wouldOpenBrowser: false,
      urlDelivery: resolvedMethod === "browser" ? "print-url" : "device-code",
      next: "Re-run with `--execute` only when you intentionally approve network OAuth. Browser mode prints the URL; add `--open` to launch it.",
    }
  }
  const tokens = resolvedMethod === "browser" ? await openaiBrowserOAuth({ open }) : await openaiHeadlessOAuth()
  const state = {
    version: 0,
    providerID: "openai",
    type: "oauth",
    source: "mendcode-openai-codex-oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractOpenAIAccountId(tokens),
    createdAt: new Date().toISOString(),
    donorCompatibility: {
      providerID: "openai",
      type: "oauth",
      evidence: ".agents/vendor/opencode/packages/opencode/src/plugin/codex.ts",
    },
  }
  const file = path.join(paths.root, ".mendcode", "auth", "openai.json")
  await writePrivateJson(file, state)
  return {
    providerID: "openai",
    method: resolvedMethod,
    status: "stored",
    path: path.relative(paths.root, file),
    mode: "0600",
    secretsPrinted: false,
    tokenValuesPrinted: false,
    openedBrowser: resolvedMethod === "browser" && open,
    urlDelivery: resolvedMethod === "browser" ? "print-url" : "device-code",
    auth: redactedAuthSummary(state, paths.root),
    next: "Run `mend auth status openai`; then use `mend run`.",
  }
}
