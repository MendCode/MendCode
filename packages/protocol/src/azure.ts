import { z } from "zod"
import { lazySchema } from "./lazy"

/** Public Azure settings. Credentials remain in API-key storage or daemon environment variables. */
export const AzureOptions = lazySchema(() => z.strictObject({
  resourceName: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/).optional(),
  apiVersion: z.string().regex(/^(v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/).optional(),
  useCompletionUrls: z.boolean().optional(),
  useDeploymentBasedUrls: z.boolean().optional(),
  auth: z.enum(["api-key", "entra"]).optional(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
}))
export type AzureOptions = z.infer<typeof AzureOptions>
