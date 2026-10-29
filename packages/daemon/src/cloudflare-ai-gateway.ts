import { CloudflareAIGatewayConfig, type CloudflareAIGatewayInfo } from "@mendcode/protocol"

type Entry = { cloudflareAiGateway?: CloudflareAIGatewayConfig | undefined; options?: Record<string, unknown> | undefined; headers?: Record<string, string> | undefined }

/** Normalize v1 gateway options without loading its SDK or copying its credential files. */
export function gatewayConfig(entry?: Entry): CloudflareAIGatewayConfig {
  const options = entry?.options ?? {}
  const legacy: Record<string, unknown> = {}
  for (const name of ["accountId", "gatewayId", "metadata", "cacheTtl", "cacheKey", "skipCache", "collectLog"]) if (options[name] !== undefined) legacy[name] = options[name]
  if (options.gateway !== undefined && legacy.gatewayId === undefined) legacy.gatewayId = options.gateway
  if (legacy.metadata === undefined) {
    const headers = { ...(typeof options.headers === "object" && options.headers ? options.headers : {}), ...entry?.headers } as Record<string, unknown>
    const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-aig-metadata")?.[1]
    if (typeof value === "string") try { legacy.metadata = JSON.parse(value) } catch {}
  }
  const parsed = CloudflareAIGatewayConfig.safeParse({ ...legacy, ...entry?.cloudflareAiGateway })
  if (!parsed.success) throw new Error("[PROVIDER]: invalid Cloudflare AI Gateway configuration")
  return parsed.data
}

export function gatewayInfo(config: CloudflareAIGatewayConfig): CloudflareAIGatewayInfo {
  const { metadata, cacheKey, ...routing } = config
  return { ...routing, hasMetadata: Boolean(metadata && Object.keys(metadata).length), hasCacheKey: Boolean(cacheKey) }
}
