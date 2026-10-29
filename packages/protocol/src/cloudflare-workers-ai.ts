import { z } from "zod"
import { lazySchema } from "./lazy"

/** Public routing metadata. A fully specified proxy endpoint needs no account id. */
export const CloudflareWorkersAIConfig = lazySchema(() => z.strictObject({
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
}))
export type CloudflareWorkersAIConfig = z.infer<typeof CloudflareWorkersAIConfig>
