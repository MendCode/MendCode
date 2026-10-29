import { z } from "zod"
import { lazySchema } from "./lazy"

const RoutingId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const Metadata = lazySchema(() => z.record(z.string().min(1).max(100), z.union([z.string().max(2048), z.number().finite(), z.boolean()])).refine((value) => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 8000))

/** Routing and per-request gateway options; metadata/cache keys remain private. Null clears an override. */
export const CloudflareAIGatewayConfig = lazySchema(() => z.strictObject({
  accountId: RoutingId.nullable().optional(),
  gatewayId: RoutingId.nullable().optional(),
  metadata: Metadata.nullable().optional(),
  cacheTtl: z.number().int().nonnegative().max(31_536_000).nullable().optional(),
  cacheKey: z.string().min(1).max(2048).regex(/^[\x20-\x7E]+$/).nullable().optional(),
  skipCache: z.boolean().nullable().optional(),
  collectLog: z.boolean().nullable().optional(),
}))
export type CloudflareAIGatewayConfig = z.infer<typeof CloudflareAIGatewayConfig>

export const CloudflareAIGatewayInfo = lazySchema(() => CloudflareAIGatewayConfig.omit({ metadata: true, cacheKey: true }).extend({
  hasMetadata: z.boolean(),
  hasCacheKey: z.boolean(),
}))
export type CloudflareAIGatewayInfo = z.infer<typeof CloudflareAIGatewayInfo>
