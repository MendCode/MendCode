import { homedir } from "node:os"
import path from "node:path"

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const EXPIRY_MARGIN_MS = 60_000

type AuthFile = { auth_mode?: string; tokens?: { access_token?: string; account_id?: string } }

function jwtExpiry(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }
    return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Request headers for the user's ChatGPT subscription, read from the Codex CLI login on every request
 * so Codex's own token refreshes are picked up. Read-only by design: MendCode never refreshes or
 * rewrites this file (rotating the refresh token would log the Codex CLI out), and never stores,
 * logs or forwards the token anywhere but the ChatGPT backend.
 */
export function codexSubscriptionHeaders(options: { authFile?: string; now?: () => number } = {}) {
  const file = options.authFile ?? path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json")
  const now = options.now ?? Date.now
  return async (): Promise<Record<string, string>> => {
    let auth: AuthFile
    try {
      auth = (await Bun.file(file).json()) as AuthFile
    } catch {
      throw new Error("[AUTH]: no Codex login found; run `codex login`")
    }
    const token = auth.tokens?.access_token
    const account = auth.tokens?.account_id
    if (!token || !account) throw new Error("[AUTH]: Codex login has no ChatGPT tokens; run `codex login` with your ChatGPT account")
    const expiry = jwtExpiry(token)
    if (expiry !== undefined && expiry - EXPIRY_MARGIN_MS < now()) throw new Error("[AUTH]: Codex login expired; open `codex` once to refresh it")
    return { authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "mendcode" }
  }
}
