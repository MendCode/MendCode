import { RetryableProviderError } from "./provider"
import { retryAfter } from "./openai-responses"
import type { Fetch } from "./provider-http"

export const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default"
export const AZURE_TOKEN_ENV = "AZURE_OPENAI_AUTH_TOKEN"
type Env = Record<string, string | undefined>

/** No discovery, credential reads or HTTP until an explicitly enabled Entra provider requests a token. */
export function createAzureEntraCredential(options: { env(): Env; fetch?: Fetch; now?(): number; tokenEnv?: string }) {
  let cached: { signature: string; token: string; expires: number } | undefined
  const tokenEnv = options.tokenEnv ?? AZURE_TOKEN_ENV
  const ready = () => Boolean(options.env()[tokenEnv]?.trim() || ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].every((name) => options.env()[name]?.trim()))
  return {
    ready,
    async token(signal: AbortSignal): Promise<string> {
      signal.throwIfAborted()
      const env = options.env()
      const supplied = env[tokenEnv]?.trim()
      if (supplied) {
        if (!/^[\x21-\x7E]{1,16384}$/.test(supplied)) throw new Error("[AUTH]: invalid Azure Entra access token")
        return supplied
      }
      const tenant = env.AZURE_TENANT_ID?.trim(), client = env.AZURE_CLIENT_ID?.trim(), secret = env.AZURE_CLIENT_SECRET
      if (!tenant || !client || !secret) throw new Error(`[AUTH]: Azure Entra needs ${tokenEnv} or AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET`)
      if (!/^[a-zA-Z0-9.-]{1,253}$/.test(tenant) || ["common", "organizations", "consumers", ".", ".."].includes(tenant)) throw new Error("[AUTH]: Azure Entra needs a tenant id or tenant domain")
      const authority = env.AZURE_AUTHORITY_HOST ?? "https://login.microsoftonline.com"
      let origin: string
      try {
        const url = new URL(authority)
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error()
        origin = url.origin
      } catch { throw new Error("[AUTH]: AZURE_AUTHORITY_HOST must be an HTTPS origin") }
      const signature = JSON.stringify([tenant, client, secret, origin])
      const now = options.now ?? Date.now
      if (cached?.signature === signature && cached.expires - 60_000 > now()) return cached.token
      const body = new URLSearchParams({ client_id: client, client_secret: secret, scope: AZURE_SCOPE, grant_type: "client_credentials" })
      let response: Response
      try {
        response = await (options.fetch ?? fetch)(`${origin}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
      } catch (error) {
        if (signal.aborted) throw error
        // Token endpoints can echo the client secret or returned token: never include their body or transport error.
        throw new RetryableProviderError("[AUTH]: Azure Entra token request failed", undefined, "network")
      }
      if (!response.ok) {
        const message = `[AUTH]: Azure Entra token endpoint returned HTTP ${response.status}`
        if (response.status === 408 || response.status === 429 || response.status >= 500) throw new RetryableProviderError(message, retryAfter(response))
        throw new Error(message)
      }
      const raw = await response.json().catch(() => undefined) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown } | undefined
      if (typeof raw?.access_token !== "string" || !/^[\x21-\x7E]{1,16384}$/.test(raw.access_token) || typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || String(raw.token_type).toLowerCase() !== "bearer") throw new Error("[AUTH]: Azure Entra returned an invalid token response")
      signal.throwIfAborted()
      cached = { signature, token: raw.access_token, expires: now() + raw.expires_in * 1000 }
      return cached.token
    },
  }
}
