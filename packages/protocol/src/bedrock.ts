import { z } from "zod"
import { lazySchema } from "./lazy"

/** Public AWS routing and auth policy; credentials never travel in these options. */
export const BedrockOptions = lazySchema(() => z.strictObject({
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).nullable().optional(),
  profile: z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/).nullable().optional(),
  auth: z.enum(["chain", "bearer"]).optional(),
  allowCredentialProcess: z.boolean().optional(),
  allowMetadata: z.boolean().optional(),
  endpoint: z.string().max(2048).refine((value) => {
    try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) } catch { return false }
  }, "AWS endpoint requires HTTPS or loopback HTTP").nullable().optional(),
}))
export type BedrockOptions = z.infer<typeof BedrockOptions>
