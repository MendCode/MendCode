import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const EXPIRY_MARGIN_MS = 60_000
const SIGN_IN = "sign in with /connect chatgpt"

type AuthFile = { auth_mode?: string; tokens?: { access_token?: string; account_id?: string } }

function jwtExpiry(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }
    return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined
  } catch {
    return undefined
  }
}

const authFilePath = () => path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json")

/**
 * The state of a ChatGPT login another tool left on this machine, without keeping or returning a token: `valid`, `expired`, or
 * undefined when there is none (no file, or no ChatGPT tokens in it).
 */
export function importedChatgptLogin(options: { authFile?: string; now?: () => number } = {}): { state: "valid" | "expired"; expiresAt?: number } | undefined {
  try {
    const auth = JSON.parse(readFileSync(options.authFile ?? authFilePath(), "utf8")) as AuthFile
    const token = auth.tokens?.access_token
    if (!token || !auth.tokens?.account_id) return undefined
    const expiresAt = jwtExpiry(token)
    const expired = expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS < (options.now ?? Date.now)()
    return { state: expired ? "expired" : "valid", ...(expiresAt !== undefined ? { expiresAt } : {}) }
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
  const file = options.authFile ?? authFilePath()
  const now = options.now ?? Date.now
  return async (): Promise<Record<string, string>> => {
    let auth: AuthFile
    try {
      auth = (await Bun.file(file).json()) as AuthFile
    } catch {
      throw new Error(`[AUTH]: not signed in to ChatGPT; ${SIGN_IN}`)
    }
    const token = auth.tokens?.access_token
    const account = auth.tokens?.account_id
    if (!token || !account) throw new Error(`[AUTH]: the imported login has no ChatGPT account; ${SIGN_IN}`)
    const expiry = jwtExpiry(token)
    if (expiry !== undefined && expiry - EXPIRY_MARGIN_MS < now()) throw new Error(`[AUTH]: ChatGPT sign-in expired (imported from another tool); ${SIGN_IN} again`)
    return { authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "mendcode" }
  }
}
