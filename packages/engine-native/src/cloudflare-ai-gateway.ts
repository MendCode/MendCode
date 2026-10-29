import type { CloudflareAIGatewayConfig } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import { scrub, type Fetch } from "./provider-http"

export const CLOUDFLARE_GATEWAY_MODEL = /^[A-Za-z0-9_-]+\/[^\s]+$/

export const cloudflareGatewayUrl = (value: string): URL => outboundEndpoint(value, "Cloudflare AI Gateway")

/** The account and gateway ids (user-supplied) select the public gateway route; a full endpoint overrides them. */
export function cloudflareGatewayBaseUrl(value: string, config: CloudflareAIGatewayConfig): string {
  if (!value && (!config.accountId || !config.gatewayId)) throw new Error("[PROVIDER]: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID, or a full endpoint URL")
  return cloudflareGatewayUrl(value || `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat`).href.replace(/\/+$/, "")
}

/** Gateway auth always wins over config, model and hook headers. Upstream BYOK belongs to the proxy. */
export function cloudflareGatewayHeaders(input: HeadersInit | undefined, token: string, config: CloudflareAIGatewayConfig = {}): Headers {
  const headers = new Headers(input)
  for (const name of ["cookie", "proxy-authorization", "x-api-key", "x-auth-key", "x-auth-email", "cf-aig-authorization"]) headers.delete(name)
  headers.set("authorization", `Bearer ${token}`)
  headers.set("cf-aig-authorization", `Bearer ${token}`)
  headers.set("user-agent", "mendcode cloudflare-ai-gateway")
  for (const [field, name] of [["metadata", "cf-aig-metadata"], ["cacheTtl", "cf-aig-cache-ttl"], ["cacheKey", "cf-aig-cache-key"], ["skipCache", "cf-aig-skip-cache"], ["collectLog", "cf-aig-collect-log"]] as const) {
    const value = config[field]
    if (value === null) headers.delete(name)
    else if (value !== undefined) headers.set(name, field === "metadata" ? JSON.stringify(value) : String(value))
  }
  return headers
}

export function createCloudflareGatewayProvider(options: Parameters<typeof createChatCompletionsProvider>[0] & { gateway?: CloudflareAIGatewayConfig }): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key: string): Fetch => async (url, init) => {
    cloudflareGatewayUrl(url)
    return doFetch(url, { ...init, headers: cloudflareGatewayHeaders(init.headers, key, options.gateway), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: async (url, init) => {
    const key = await options.apiKey?.()
    if (!key) throw new Error("[AUTH]: Cloudflare AI Gateway requires a token")
    return guarded(transport, key)(url, init)
  } })
  return {
    ...adapter,
    async *stream(request) {
      if (request.signal.aborted) return
      cloudflareGatewayUrl(options.baseUrl)
      const model = request.model ?? options.model
      if (!CLOUDFLARE_GATEWAY_MODEL.test(model)) throw new Error("[PROVIDER]: Cloudflare AI Gateway model must use provider/model")
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: Cloudflare AI Gateway requires CLOUDFLARE_API_TOKEN, CF_AIG_TOKEN or a stored token")
      try {
        yield* adapter.stream({ ...request, fetch: guarded(request.fetch ?? transport, key), transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }) })
      } catch (error) {
        if (error instanceof Error) error.message = scrub(error.message, [key, ...Object.values(options.headers ?? {}), JSON.stringify(options.gateway?.metadata ?? {}), ...Object.values(options.gateway?.metadata ?? {}).filter((value): value is string => typeof value === "string"), options.gateway?.cacheKey ?? ""])
        throw error
      }
    },
    probe: async () => {
      try {
        cloudflareGatewayUrl(options.baseUrl)
        if (!await options.apiKey?.()) return false
        return await adapter.probe!()
      } catch { return false }
    },
  }
}
