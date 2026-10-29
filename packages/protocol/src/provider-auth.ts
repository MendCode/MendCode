import { z } from "zod"
import { lazySchema } from "./lazy"

export const ProviderAuthMethod = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(100),
  type: z.enum(["api", "oauth"]),
  label: z.string().max(100),
  available: z.boolean(),
  reason: z.string().max(300).optional(),
}))
export type ProviderAuthMethod = z.infer<typeof ProviderAuthMethod>

export type ProviderAuthStatus = {
  provider: string
  state: "none" | "pending" | "authorized" | "expired" | "failed" | "cancelled"
  source: "v2" | "none"
  accessTokenPresent: boolean
  refreshTokenPresent: boolean
  accountIdPresent: boolean
  expiresAt?: number
  error?: string
}
export type ProviderLoginPlan = {
  provider: string
  method: ProviderAuthMethod
  executesNow: false
  callsProvider: false
  writesSecrets: false
  credentialSource: "v2"
  callback: "loopback" | "device" | "none"
}
export type ProviderAuthorization = {
  provider: string
  method: string
  url: string
  instructions: string
  expiresAt: number
}
