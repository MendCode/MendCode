import { z } from "zod"
import { ProviderBaseUrl } from "./providers"
import { lazySchema } from "./lazy"

export const CatalogProvider = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
export const CatalogAuthMode = z.enum(["api-key", "chatgpt-subscription-oauth"])
export const McpConfigInput = lazySchema(() => z.strictObject({
  enabled: z.boolean().optional(),
  timeoutMs: z.int().min(1).max(600_000).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  url: ProviderBaseUrl.optional(),
  oauth: z.union([z.literal(false), z.strictObject({
    clientId: z.string().min(1).max(2048).optional(),
    clientSecret: z.string().min(1).max(4096).optional(),
    scope: z.string().min(1).max(2048).optional(),
    callbackPort: z.number().int().min(1).max(65535).optional(),
    redirectUri: z.string().max(4096).refine((value) => {
      try {
        const url = new URL(value)
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
      } catch { return false }
    }, "must be an HTTP(S) callback URL without credentials or fragment").optional(),
  })]).optional(),
}).refine((input) => Boolean(input.command) !== Boolean(input.url), "set exactly one of command or url")
  .refine((input) => !input.command || input.oauth === undefined, "OAuth applies to remote servers")
  .refine((input) => !input.url || input.args === undefined, "args apply to local servers"))
export type McpConfigInput = z.infer<typeof McpConfigInput>

export type ModelPreset = { name: string; provider: string; model: string; authMode: z.infer<typeof CatalogAuthMode>; available: boolean }
export type ModelsConfigReport = {
  engine: string
  selectable: boolean
  defaults: import("./queries").ModelChoice
  roles: import("./queries").ModelRoles
  effective: Record<string, import("./queries").ModelChoice>
  failures: string[]
  warnings: string[]
  presets: ModelPreset[]
}
export type ProviderAdapter = { id: string; name: string; type: string; configured: boolean; enabled: boolean; authReady: boolean | null; authMode: string; models: number; requiredEnv: string[]; presentEnv: string[]; credentialStored: boolean; error?: string }
export type ProvidersCatalogReport = { providers: ProviderAdapter[]; callsProviders: false; secretsPrinted: false }
export type McpDebugReport = {
  server: string
  url: string
  auth: "none" | "pending" | "authorized" | "expired"
  credentials: { accessToken: boolean; refreshToken: boolean; client: boolean; expiresAt?: number }
  httpStatus?: number
  oauth?: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationAvailable: boolean; clientRegistrationRequired: boolean }
  error?: string
}
