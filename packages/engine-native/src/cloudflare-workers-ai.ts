import type { CloudflareWorkersAIConfig } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import { scrub, type Fetch } from "./provider-http"

export function cloudflareWorkersAccount(config: CloudflareWorkersAIConfig = {}, env: Record<string, string | undefined> = {}): string | undefined {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim() || config.accountId || undefined
  if (account && !/^[A-Za-z0-9_-]{1,64}$/.test(account)) throw new Error("[PROVIDER]: invalid Cloudflare account id")
  return account
}

export const cloudflareWorkersUrl = (value: string): URL => outboundEndpoint(value, "Cloudflare Workers AI")

/** The account id (user-supplied) selects the public Cloudflare API route; a full endpoint overrides it. */
export function cloudflareWorkersBaseUrl(value: string, accountId?: string): string {
  if (!value && !accountId) throw new Error("[PROVIDER]: set CLOUDFLARE_ACCOUNT_ID or cloudflareWorkersAi.accountId, or a full endpoint URL")
  const endpoint = value || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
  return cloudflareWorkersUrl(endpoint).href.replace(/\/+$/, "")
}

/** No SDK, anonymous calls or public requests. Hooks cannot replace the current Bearer token. */
export function createCloudflareWorkersProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    cloudflareWorkersUrl(url)
    const token = key ?? await options.apiKey?.()
    if (!token) throw new Error("[AUTH]: no API key for cloudflare-workers-ai; set CLOUDFLARE_API_KEY or use providers.set")
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.delete("cookie")
    headers.delete("x-api-key")
    headers.delete("proxy-authorization")
    headers.delete("x-auth-key")
    headers.delete("x-auth-email")
    return doFetch(url, { ...init, headers, redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      cloudflareWorkersUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for cloudflare-workers-ai; set CLOUDFLARE_API_KEY or use providers.set")
      try {
        yield* adapter.stream({ ...request, fetch: guarded(request.fetch ?? transport, key), transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }) })
      } catch (error) {
        // Preserve retry/abort classification while scrubbing configured headers too.
        if (error instanceof Error) error.message = scrub(error.message, [key, ...Object.values(options.headers ?? {})])
        throw error
      }
    },
    probe: () => {
      try { cloudflareWorkersUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
